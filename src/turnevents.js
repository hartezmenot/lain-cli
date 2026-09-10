'use strict';

/**
 * TURN EVENTS → SCREEN.
 *
 * `runTurn` yields a normalized stream of what is happening; this is the one
 * place that decides what each event does to the renderer and the UI. It was a
 * fifty-line switch inside `app.submit`, which made the REPL shell the owner of
 * both "run the turn" and "draw every kind of thing a turn can produce" — two
 * jobs, and the second is this file's.
 *
 * Everything here is a REDRAW of something that already happened. Nothing
 * contacts a provider, nothing costs a token, and nothing decides what the turn
 * does next.
 */

const { describeTarget } = require('./turn');
// THE ONE FIRST-LINE RULE — see `note:` below for what two copies of it cost.
const describe = require('./describe');
const { EVENT, busOf } = require('./events');

/**
 * How long a compaction notice stays before clearing itself.
 *
 * Matches the machinery default in commands.js. It is stated here rather than
 * imported because the two are the same NUMBER for the same reason, not one
 * concept with two callers - and commands.js requiring turnevents (or the
 * reverse) to share a constant would be a cycle for four characters.
 */
const COMPACT_FLASH_MS = 1500;

/** Tools whose results belong in the OUTPUT view. */
const SHELL_TOOLS = new Set(['run_bash', 'run_powershell', 'run_cmd']);
/** A result at or under this length is a message to the user, not data. */
const BRIEF = 160;

/**
 * Tools whose result is the CONTENT OF A FILE, and therefore worth looking at.
 *
 * Deliberately not "every tool with a path": a write has a path and its result
 * is a confirmation, a delete has a path and its result is nothing. These are
 * the calls where the output IS the code, which is the only case a window
 * travelling down it says anything true about.
 */
const READ_TOOLS = new Set(['read_file', 'read_symbol']);

/**
 * Apply one event.
 *
 * @param {App}    app
 * @param {object} ev   the event from runTurn
 * @param {object} ctx  mutable across the turn — { liveText, record }
 */
/**
 * AN EDIT LANDED — hand its real change to the activity timeline.
 *
 * Both halves come from the CHECKPOINT, which is the same source the DIFF pane
 * reads, so the counters that animate and the rows that are revealed describe
 * the change that is actually on disk. A tool that reported success while
 * changing nothing produces no window at all, which is itself worth seeing.
 *
 * SYNCHRONOUS AND UNAWAITED. It pushes to a presentation queue and returns; the
 * turn loop is already on the next call. Anything that goes wrong in here is
 * swallowed by the caller, because a drawing problem must never end a turn.
 */
function noteEdit(app, changedPath) {
  if (!app.ui || !app.ui.enabled || !app.ui.showDiff) return;
  const panes = require('./ui/panes');
  const path = require('path');
  const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd });
  if (!files.length) return;
  const want = path.resolve(app.session.cwd, String(changedPath));
  const f = files.find((x) => path.resolve(x.path || '') === want) || null;
  if (!f) return;
  app.ui.noteEditCounts(f.added, f.removed);
  // THE TWO TEXTS, NOT A RENDERED DIFF. The window performs the change as a
  // sequence of edits, and where those edits ARE is exactly what a list of
  // rendered rows has already thrown away — see ui/diffscript.js.
  app.ui.showDiff(f.rel, f.before, f.after);
}

function apply(app, ev, ctx) {
  switch (ev.type) {
    case 'text':
      app.render.text(ev.chunk);
      // ---- THE HEADER'S OUTPUT COUNTER -----------------------------------
      //
      // Counted from what actually arrived, on the one event that carries the
      // model's answer. No redraw here: the ticker is already running for the
      // duration of a turn, so the number climbs on the next frame either way,
      // and repainting per chunk is the redraw storm the buffering below
      // exists to avoid. See ui/index.js `noteOutputChars`.
      if (app.ui.enabled) app.ui.noteOutputChars((ev.chunk || '').length);
      // Buffered, not rendered per chunk: the feed shows sentences, and
      // repainting the screen on every token would be a redraw storm.
      ctx.liveText += ev.chunk || '';
      // BUT A COMPLETE THOUGHT GOES UP IMMEDIATELY.
      //
      // It only ever flushed at the next tool_result, so a model that wrote
      // three paragraphs and then searched showed NOTHING for the whole time
      // it was writing, and then showed the prose and the call together. Long
      // stretches of a real session were therefore silent while the model was
      // demonstrably producing — which is the reported failure, from the other
      // end. A finished paragraph is not a partial state and does not need to
      // wait for a tool that may never come.
      if (app.ui.enabled) ctx.liveText = flushParagraphs(app, ctx.liveText);
      break;

    // ---- THE MODEL THINKING ALOUD ----------------------------------------
    //
    // Shown so that a model which streams ONLY reasoning — some do, through
    // OpenRouter-shaped gateways — does not produce a blank Context and a DONE.
    // It goes to the narration channel, which is where LAIN's own prose goes,
    // and NOT into `record.text`: the transcript records what the model said,
    // not what it thought on the way there.
    case 'reasoning':
      ctx.reasoning = (ctx.reasoning || '') + (ev.chunk || '');
      // REASONING IS BILLED AS OUTPUT, so it is counted as output. A model that
      // thinks for four thousand tokens and answers in twenty has produced four
      // thousand and twenty, and a counter that showed twenty would be hiding
      // the part of the bill a person most needs to see.
      if (app.ui.enabled) app.ui.noteOutputChars((ev.chunk || '').length);
      if (!app.ui.enabled) { app.render.text(ev.chunk); break; }
      // ---- THINKING IS NOT SPEECH, AND IT IS NOT IN THE CONVERSATION ------
      //
      // It used to be flushed through `flushParagraphs`, which calls
      // `noteNarration` — THE SAME CHANNEL AS THE MODEL'S PUBLIC PROSE. So a
      // provider that streams its reasoning had that reasoning rendered in the
      // conversation, indistinguishable from an answer, and every "Actually…",
      // "Let me…", "One more consideration…" and "Call 1 / Call 2" in it appeared
      // as though the model had said it to the user. That is the single largest
      // source of execution narration on the screen, and none of it was addressed
      // to anybody.
      //
      // WHAT REPLACES IT. The live row above the caret already says `◐ Thinking`
      // for exactly as long as this is arriving, with the work clock beside it, so
      // liveness is answered without quoting the model's working-out. The text is
      // still accumulated on the turn record (`record.reasoning`, see turn.js), so
      //   · a turn that said and did NOTHING still shows what it thought, which is
      //     the one case where the reasoning IS the only answer there is
      //     (ui/conversation.js), and
      //   · `LAIN_SHOW_THINKING=1` puts it back on screen as it streams, for
      //     anybody debugging a model rather than using one.
      //
      // IT IS STILL COUNTED ABOVE. Reasoning is billed as output and the header's
      // figure says so; hiding it from the screen must not hide it from the bill.
      if (process.env.LAIN_SHOW_THINKING === '1') {
        ctx.reasoning = flushParagraphs(app, ctx.reasoning);
      }
      break;

    // ---- WHAT THE OPEN REQUEST HAS COST SO FAR ---------------------------
    //
    // The input side of a request that has started and not finished. It is the
    // one figure that is genuinely live: the model cannot read more of the
    // prompt later, so this number is final from the first frame — while the
    // OUTPUT side does not exist yet and is drawn as absent rather than as
    // zero. See provider.js at `message_start`.
    //
    // NOT ADDED TO ANYTHING. `record.usage` is accumulated from the receipt at
    // the end of the request; this is a reading, and adding it would count the
    // same tokens twice.
    case 'usage_live':
      if (app.ui.enabled) {
        app.ui.liveUsage = {
          inputTokens: ev.inputTokens || 0,
          cacheReadTokens: ev.cacheReadTokens || 0,
          cacheCreationTokens: ev.cacheCreationTokens || 0,
        };
        app.ui.refresh();
      }
      // AND TO THE RUNTIME, which is what lets a client that is not this
      // terminal — /dash today, an adapter later — read the same figure without
      // a second accounting path. Fire-and-forget; free with no supervisor.
      require('./guardian').noteUsage(app.session.id, ev, { live: true });
      break;

    case 'tool_start':
      app.render.toolStart(ev.name, ev.input);
      // TWO FACTS, NOT ONE. "The model asked for this" and "this is running"
      // are different events to a companion: the first is a decision, the
      // second is work, and a window that conflates them cannot show a call
      // that was requested and refused.
      busOf(app).emit(EVENT.MODEL_TOOL_CALL, { tool: ev.name, target: describeTarget(ev.name, ev.input) });
      busOf(app).emit(EVENT.TOOL_STARTED, { tool: ev.name, target: describeTarget(ev.name, ev.input) });
      // Show the call in flight, so the workspace is never silent while the
      // model works. Pure redraw — no request, no extra token.
      if (app.ui.enabled) app.ui.setRunning(ev.name, describeTarget(ev.name, ev.input));
      break;

    case 'tool_result': {
      app.render.toolResult(ev.name, ev.output, ev.isError);
      busOf(app).emit(EVENT.TOOL_COMPLETED, {
        tool: ev.name,
        ok: !ev.isError,
        summary: firstLine(ev.output),
      });
      if (!app.ui.enabled) break;
      // The prose that PRECEDED this call, then the call itself — the same
      // interleaving the persisted record uses, so the feed does not reorder
      // itself when the turn ends and the two swap over.
      if (ctx.liveText.trim()) { app.ui.noteNarration(ctx.liveText.trim()); ctx.liveText = ''; }
      const out = String(ev.output == null ? '' : ev.output);
      app.ui.noteAction({
        name: ev.name,
        target: describeTarget(ev.name, ev.input),
        ok: !ev.isError,
        // ---- THE ONE FIRST-LINE RULE, NOT A SECOND COPY OF IT -----------
        //
        // This was an inline `split/map/find` — the same idea as describe.js's
        // `firstLine` and therefore the same idea in two places. When that one
        // learned to skip the `[via shell: … cwd=…]` stamp (which is addressed to
        // the model, and put an absolute temp path under every command the user
        // ran), this one did not: the live row kept quoting it, and only the
        // SETTLED row was clean. Two spellings of one rule, disagreeing for
        // exactly as long as the turn lasted.
        note: describe.firstLine(out),
        brief: out.length <= BRIEF,
        file: Boolean(ev.input && ev.input.path),
        // Whether this call's result went to the OUTPUT surface, so Context can
        // point at it instead of repeating it.
        output: SHELL_TOOLS.has(ev.name),
        // WHO DID THIS. A `computer` call is the bridge acting on the machine,
        // not LAIN reading a file, and the status strip colours them apart.
        // (This used to test the retired `desktop` name and the removed `probe`
        // one; `computer` replaced both, and this is the line that missed it.)
        actor: ev.name === 'computer' ? 'MCP' : 'TOOL',
      });
      // ---- AN EDIT SHOWS ITS CHANGE, ONCE -----------------------------------
      //
      // The counters on the timeline card and the diff window under it both
      // come from the CHECKPOINT — the same source the DIFF pane reads — so
      // what is animated is the real change rather than anything the model
      // said about it. A tool that reported success while changing nothing
      // produces no window, which is itself worth seeing.
      //
      // PRESENTATION ONLY, AND NEVER AWAITED. This hands rows to a queue and
      // returns; the turn loop is already moving on to the next call.
      // ---- ONLY A CALL THAT MUTATES SHOWS A CHANGE -------------------------
      //
      // THE DEFECT THIS GATE REPLACES, reported from a real screen: a READ and
      // a SEARCH were drawing the diff editor, with green `+` lines, as though
      // the file were being written.
      //
      // The gate was "the tool has a path", which is true of `read_file`,
      // `read_symbol` and a `grep` scoped to one file. `noteEdit` then looks the
      // path up among the session's CHANGED files — so reading a file LAIN had
      // edited earlier replayed that earlier edit's whole diff, attributing an
      // addition to a call that added nothing. The animation was of a real
      // change; it was simply not this call's, which is the same lie.
      //
      // `isMutating` is the registry's own answer, and the same authority
      // turn.js uses to decide whether to take a checkpoint at all — so what
      // may be drawn as a change is exactly what may have caused one.
      const mutating = require('./tools').isMutating(ev.name);
      if (!ev.isError && mutating && ev.input && ev.input.path) {
        try { noteEdit(app, ev.input.path); } catch { /* the turn is unaffected */ }
      }
      // ---- A READ SHOWS THE FILE, AND ONLY LOOKS AT IT ---------------------
      //
      // Same surface as an edit, none of the performance. The code was already
      // on disk before LAIN opened it, so animating it as though it were being
      // typed would be the presentation layer inventing an event — the window
      // travels down content that is there from the first frame. See
      // ui/diffreel.js `read`.
      //
      // THE CONTENT IS THE TOOL'S OWN OUTPUT, which is what was actually put in
      // front of the model. Nothing is re-read from disk to draw it, so the
      // window cannot show something the model did not see.
      if (!ev.isError && READ_TOOLS.has(ev.name) && ev.input && ev.input.path && app.ui.showRead) {
        try { app.ui.showRead(describeTarget(ev.name, ev.input), ev.output); } catch { /* presentation only */ }
      }
      app.ui.setRunning(null);
      // A computer call is the BRIDGE acting on the machine, not LAIN reading
      // a file, and Context labels it so.
      if (ev.name === 'computer' && !ev.isError) {
        const first = String(ev.output || '').split('\n')[0];
        app.ui.noteActor('mcp', first.slice(0, 120));
      }
      if (SHELL_TOOLS.has(ev.name)) {
        app.ui.noteOutput((ev.input && ev.input.command) || ev.name, ev.output, ev.exitCode);
      }
      break;
    }

    // ---- IT HAS BEEN DOING THE SAME THING FOR A WHILE ---------------------
    //
    // Raised WITHOUT AWAITING, which is the entire difference between this and
    // every other panel in the program: the turn is still running underneath
    // it, the model has not been told anything, and the user is free to ignore
    // it completely. See looping.js.
    case 'looping': {
      const looping = require('./looping');
      if (!app.ui.enabled) {
        // Piped or `-p`: no panel to raise, and the run must not become
        // interactive. One line, so what happened is still on the record.
        app.render.notice('warn', looping.line(ev));
        break;
      }
      // A QUESTION OUTRANKS AN OBSERVATION. An `ask_user` waiting for an answer
      // is not replaced by this — that would resolve somebody's question with
      // silence, and the advisory is the less urgent of the two by definition.
      if (app.ui.panel.visible && !app.ui.panel.isPassive) break;
      const life = app.session && app.session.lifecycle;
      app.ui.panel.open(looping.adapter(ev, {
        onLet: () => { if (life) life.letRun(ev.key); },
        // "SAY SOMETHING" JUST GETS OUT OF THE WAY. The input was never taken
        // away, so there is nothing to hand back — closing the advisory is the
        // whole action, and what gets typed goes through the ordinary steer
        // path like any other correction.
        onSay: () => {},
        onStop: () => { if (app.abort && !app.abort.signal.aborted) app.abort.abort(); },
      }));
      app.ui.refresh();
      break;
    }
    // AND IT TAKES ITSELF DOWN. The model did something new, so the thing the
    // advisory was about is no longer true. Only ever closes the advisory: if
    // the user has since opened something else, that is theirs.
    case 'looping_clear':
      if (app.ui.enabled && app.ui.panel.isAdvisory) {
        app.ui.panel.close(null);
        app.ui.refresh();
      }
      break;

    // A NOTICE IS THE PROGRAM SPEAKING, and in TUI mode it must not arrive as
    // raw transcript. `render.notice` writes through `render.write`, which the
    // Screen captures and prints BELOW the entire feed at full weight — so a
    // three-line liveness warning outshouted the conversation it was about and
    // sat underneath its own cause. As a NOTE it lands in order, dimmed, and
    // compacts with everything else.
    case 'notice':
      // A NOTICE ADDRESSED TO A SURFACE goes to the bottom of the screen, never
      // into the conversation. Compaction is the case that drove this: it is
      // LAIN's own housekeeping, nobody said it to the model, and "Nothing to
      // elide — 291k chars" wedged permanently between two things the user
      // actually said outlives its usefulness by an entire session.
      //
      // `working` holds the surface in its busy state so the fold is visible
      // WHILE it runs rather than only once it has finished.
      // ---- A TRANSIENT NOTICE GOES WHERE TRANSIENTS GO -------------------
      //
      // A provider retry, the end of a wait, a recovery step: real events that are
      // over the moment they have been read. On a TUI they take the one operation
      // row above the caret and are superseded by the next thing (ui/operation.js);
      // on a PIPE there is no such row, so they are written as one dim line —
      // because a silent sixty-second pause is the hang this exists to prevent.
      //
      // EITHER WAY THEY ARE NOT IN THE CONVERSATION. That is the whole point: a
      // condition LAIN recovered from, which the user never had to act on, leaves
      // no durable trace.
      if (ev.transient) {
        require('./ui/operation').say(app, ev.message, ev.level || 'info');
        break;
      }
      if (ev.surface && app.ui.enabled) {
        app.render.openSurface(ev.surface, { busy: Boolean(ev.working) });
        app.render.write(`${ev.message}\n`);
        // IT CLEARS ITSELF WHEN THE WORK IS DONE. Auto-compaction is not
        // something the user asked for and not something they need to
        // acknowledge — it happens mid-turn, on LAIN's initiative, and leaving
        // "296k → 294k" sitting over the conversation until somebody presses
        // Esc puts LAIN's housekeeping in the way of the work it was making
        // room for. While `working` it stays, because it is still happening.
        if (!ev.working) app.render.doneSurface({ closeAfterMs: COMPACT_FLASH_MS });
        break;
      }
      if (app.ui.enabled) app.ui.noteSystem(ev.message, ev.level);
      else app.render.notice(ev.level, ev.message);
      break;
    // ---- THE PROVIDER SPEAKING, AT THE BOTTOM -----------------------------
    //
    // This wrote straight into the transcript, so "Provider omniroute is not
    // answering… retry in 4 hours… Your session is intact" was glued into the
    // conversation permanently — several wrapped lines of machinery sitting
    // between two things the user actually said, for the rest of the session.
    //
    // CONTEXT ALREADY CARRIES THE CLASSIFICATION. `RATE LIMITED`, `PROVIDER
    // REFUSED` and `TOO MANY MESSAGES` are drawn there in LAIN's own words by
    // ui/status.failureRow — that is the part belonging with the work, because
    // it says why the turn stopped. THIS is the provider's own sentence and the
    // way out of it, which is machinery about a route.
    //
    // IT DOES NOT AUTO-CLOSE. "Rate limited, retry in 4 hours" is a fact you
    // need to read and may want to act on; clearing it after a second and a
    // half would make the one number that matters the thing you missed.
    case 'provider_failure':
      if (app.ui.enabled) {
        app.render.openSurface('PROVIDER');
        app.render.providerFailure(ev);
        app.render.doneSurface();
      } else {
        app.render.providerFailure(ev);
      }
      break;
    case 'done':
      ctx.record = ev.record;
      // THE TURN ENDING ENDS THE ADVISORY TOO. Its offers are about a turn that
      // is running — "stop the turn", "it lands at the next step" — and there
      // is no longer one, so leaving it up advertises two actions that would do
      // nothing. It also answers the user's condition directly: the model has
      // stopped doing that stuff, so the question stops being asked.
      if (app.ui.enabled && app.ui.panel.isAdvisory) app.ui.panel.close(null);
      // ---- A LAST THOUGHT WITH NO PARAGRAPH AFTER IT ----------------------
      //
      // `flushParagraphs` only releases COMPLETE paragraphs, so a reasoning
      // stream ending without a blank line was still in the buffer when the
      // turn finished — and a one-sentence reply, which is exactly the "hello"
      // case, never has one. The pane stayed empty for the same reason the
      // whole defect existed: the words were held somewhere nobody drew.
      //
      // The ordinary text path already does this at `tool_result`; a turn with
      // no tools has only this ending, which is why the gap showed up here.
      if (app.ui.enabled && ctx.reasoning && ctx.reasoning.trim()) {
        app.ui.noteNarration(ctx.reasoning.trim());
        ctx.reasoning = '';
      }
      noteInterruption(app, ev.record);
      // COMPLETED AND FAILED ARE DIFFERENT ANSWERS, and a companion that shows
      // one word for both is the "it says DONE and nothing worked" problem in
      // another window. `stopReason` is the turn's own account, not a guess.
      busOf(app).emit(
        ev.record && (ev.record.stopReason === 'provider' || ev.record.stopReason === 'no-credential')
          ? EVENT.TASK_FAILED
          : EVENT.TASK_COMPLETED,
        {
          stopReason: (ev.record && ev.record.stopReason) || 'end',
          toolCalls: (ev.record && ev.record.toolCalls) || 0,
          text: (ev.record && ev.record.text) || '',
        },
      );
      break;
    default: break;
  }
  return ctx;
}

/** The first line of a tool result — all a companion's status row can show. */
function firstLine(text) {
  const s = String(text == null ? '' : text);
  const at = s.indexOf('\n');
  return (at < 0 ? s : s.slice(0, at)).trimEnd().slice(0, 200);
}

/**
 * Move every COMPLETED paragraph out of the buffer and onto the screen.
 *
 * A paragraph break is the boundary, not a sentence: models write in
 * paragraphs, and flushing per sentence would turn one thought into four feed
 * entries. A very long unbroken stretch is flushed at its last sentence end so
 * a model that never presses Enter twice is not invisible either.
 *
 * @returns {string} what is left in the buffer — always the incomplete tail.
 */
const LONG = 600;
function flushParagraphs(app, buf) {
  let rest = String(buf || '');
  let cut = rest.lastIndexOf('\n\n');
  if (cut < 0 && rest.length > LONG) {
    // The last sentence end that is not the very tail: the tail is probably
    // still being written, and flushing it would split a sentence in two.
    const m = rest.slice(0, -40).match(/[\s\S]*[.!?]["')\]]?\s/);
    if (m) cut = m[0].length - 1;
  }
  if (cut < 0) return rest;
  const whole = rest.slice(0, cut).trim();
  if (whole) app.ui.noteNarration(whole);
  return rest.slice(cut).replace(/^\s+/, '');
}

/**
 * MODEL INTERRUPTED — said plainly, with the reason, in the conversation.
 *
 * A turn that stopped because it ran out of steps, was blocked for producing no
 * new evidence, or lost the provider used to leave the header showing a state
 * word and the transcript showing nothing about it. "It stopped and I do not
 * know why" is the worst thing this UI can say, and it was saying it by
 * omission. Written to session.actors rather than the story because it is a
 * fact about the TASK: it must survive the turn ending, and `/resume`.
 */
/** Who stopped the turn, in the words the note uses. */
const WHO = {
  aborted: 'TURN STOPPED',
  provider: 'PROVIDER REFUSED',
  'no-credential': 'NOT AUTHENTICATED',
  blocked: 'TASK BLOCKED',
  'max-steps': 'STEP LIMIT',
};

const WHY = {
  // YOUR limit, not LAIN's. With maxSteps unset this never happens.
  'max-steps': 'it reached the step limit you configured',
  aborted: 'you interrupted it',
  provider: 'the provider stopped answering',
  blocked: 'it was blocked for producing no new evidence',
  'no-credential': 'there is no usable credential',
};
function noteInterruption(app, record) {
  if (!app.ui.enabled || !record) return;
  const why = record.stopReason;
  if (!why || why === 'end') return;
  // WHO ACTUALLY STOPPED, because "MODEL INTERRUPTED — the provider stopped
  // answering" names the wrong one twice over: the model did not interrupt
  // anything and nobody interrupted it. — a provider failure must not read
  // as a model failure.
  const who = WHO[why] || 'MODEL INTERRUPTED';
  app.ui.noteActor('note', `${who} — ${WHY[why] || why}`);
}

module.exports = { apply, flushParagraphs, noteInterruption, SHELL_TOOLS, BRIEF, WHY };
