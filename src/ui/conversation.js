'use strict';

/**
 * THE CONVERSATION — one task, replayed as it happened.
 *
 * Split out of ui/views.js, which had reached the god-object guard. The seam is
 * the one the whole UI is organised around: this builds the STORY (who said
 * what, in what order, and what was run), while views.js builds the CHROME
 * around it — the header, the task banner, the plan pane, the progress bar.
 *
 * It reads a session and returns lines. It holds no state, draws no borders and
 * knows nothing about regions or cursors, which is what lets the CONTEXT pane,
 * the dashboard and the tests all consume the same account of the work rather
 * than three that can disagree.
 */

const T = require('./text');
const { P } = require('./paint');
const { MARK, phrase } = require('./phrasing');
// THE ONE WRAPPER. Command output is evidence and may not be clipped — see the
// note at the transcript tail for why. `wrapIndented` rather than `wrap`:
// output layout is information, and `wrap` alone would rejoin it into prose.
const { wrapIndented, MAX_WRAPPED_ROWS } = require('./doc');
const {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, pushLines, renderFeed, compactRuns, spokenCount,
} = require('./feed');

const clip = T.clip;

/**
 * HOW FAR BACK THE CONVERSATION CAN BE SCROLLED.
 *
 * This was 60 ENTRIES, with a comment saying "the workspace scrolls for the
 * rest". It did not, and could not: `scrollWorkspace` bounds scrolling to the
 * number of lines this function RETURNS, so anything trimmed here was not
 * merely off-screen — it was unreachable. On a long session the user could
 * scroll up a few screens and hit a wall, with the beginning of their own
 * conversation still on disk and no way to reach it.
 *
 * Raised to a bound no real session reaches, and measured rather than guessed:
 * a full redraw of the longest session in this machine's history costs a couple
 * of milliseconds, and a redraw happens on a keystroke rather than on a frame
 * clock. The cap now exists only to stop a pathological session from making the
 * interface unresponsive — and when it IS hit, it SAYS SO, because a silent cap
 * is how somebody concludes their history is gone.
 */
const MAX_FEED_ENTRIES = 2000;
const MAX_TRANSCRIPT_LINES = 2000;
/**
 * HOW MANY TURNS THE FEED IS BUILT FROM — the ceiling that actually bit.
 *
 * This was 6. Not a display detail: the feed was CONSTRUCTED from the last six
 * turns, so the entry cap, the line cap and the scroll bounds were all
 * operating on a list that had already thrown the conversation away.
 */
const MAX_TURNS_SHOWN = 400;

/**
 * Two pieces of user text that are the same message, whitespace aside.
 *
 * There were TWO of these, twenty lines apart, and the second silently shadowed
 * the first — the duplicate-implementation defect this project's architecture
 * guard exists to catch, sitting in the UI where the guard does not look. They
 * were behaviourally identical, so nothing ever failed; what it cost was the
 * comment on the first one, which records that `\s+` here once lost its
 * backslash and became a normaliser that deleted every letter "s".
 *
 * `\s+`, NOT `s+`.
 */
function sameText(a, b) {
  const n = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase();
  const x = n(a);
  return Boolean(x) && x === n(b);
}

/**
 * WHO ASKED FOR A TURN, AND WHY THE FEED HAS TO KNOW.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, seen in the real binary and in no unit test.
 *
 * An external consultation hands its advice back to the local agent as an
 * ordinary turn — `app.submit(brief, { sameTask: true, from: 'external-advice' })`
 * — which is right, and is the whole of the handoff. But the brief is six
 * hundred characters of framing that NOBODY TYPED, and the feed drew it the way
 * it draws anything submitted:
 *
 *     USER REQUEST
 *     ❯ [pasted text #1]
 *
 * A user request the user never made, compacted as a paste that was never
 * pasted. On screen it reads as the thing the whole advisory design exists to
 * prevent — LAIN stopping, and a new unrelated task starting — when what
 * actually happened is that one investigation carried on.
 *
 * So a turn LAIN asked itself for is drawn as what it is: a quiet line saying
 * the work is continuing, in the same register as every other thing the program
 * says about itself. The brief is not lost — it is in `session.messages`, on
 * the wire, and in the saved session. Only the DRAWING changes.
 */
/**
 * Draw whatever started this turn: the person's words, or — when LAIN asked
 * itself — the one line that says so. The words are in ui/phrasing.js, with the
 * dashboard's copy of this decision.
 */
function sayInput(out, text, from) {
  if (!String(text || '').trim()) return;
  const note = require('./phrasing').selfAskedCaption(from);
  if (note) { pushNote(out, note, 'info'); return; }
  pushUser(out, text);
}

function activity({ session, current = null, width = 80, transcript = null, liveActions = [], liveNarration = [], liveNotes = [], liveUser = null, liveFrom = null, extras = [], reveal = null }) {
  // A PARAGRAPH OF THE TURN IN FLIGHT IS PRESENTED, NOT DUMPED — see
  // ui/reveal.js. Applied ONLY to the live narration: everything above it
  // already happened and settled, and re-resolving history on every redraw
  // would be an effect for its own sake.
  //
  // NO CLOCK IS READ HERE. The caller hands in a function that already knows
  // whether animation is on, so this file stays a pure rendering of state and
  // a pipe, a test and the dashboard get the settled text with no argument.
  //
  // CONDENSED FIRST, THEN RESOLVED — in that order and not the other one. Run
  // the other way round, the narration filter would be deciding whether to drop
  // a line while half of it was still unsettled glyphs, so a sentence could be
  // kept on one frame and dropped on the next. What is presented is exactly
  // what will be left standing when it settles.
  // WHICH LIVE PARAGRAPH IS THE MOST RECENT THING SAID. The one the model is
  // still on is its current last word and is kept even if it is pure
  // announcement — a turn that appears to have said nothing reads as a failure.
  // Everything BEFORE it had the timeline speaking underneath it and goes.
  const lastLive = liveNarration.length ? liveNarration[liveNarration.length - 1] : null;
  const sayText = (n) => {
    // ---- `last` WAS NEVER PASSED, SO IT DEFAULTED TO TRUE ---------------
    //
    // THE DEFECT, and it is the same shape as the paragraph one: the RECORDED
    // path passes `{ last: n === lastSaid }` (ui/feed.js `pushModel`) and this
    // one passed nothing. `prose` defaults `last` to true — deliberately, as
    // the cautious value — so mid-turn announcements that the classifier had
    // correctly marked SUPPRESS were KEPT while the turn streamed, and vanished
    // the moment the turn was recorded and the other path drew it.
    //
    //     "Let me check the loader."   visible while working, gone afterwards
    //
    // Which is to say the narration filter was off during the only period a
    // person is watching it work.
    const shown = require('./condense').prose(n.text, { last: n === lastLive });
    return typeof reveal === 'function' ? reveal(shown, n.at) : shown;
  };
  // RESOLVED ONCE, UP FRONT — because the cache key below has to contain the
  // text that is about to be drawn, and computing it twice is how the key and
  // the render come to disagree.
  const liveTexts = liveNarration.map(sayText);
  const textOf = new Map(liveNarration.map((n, i) => [n, liveTexts[i]]));
  /**
   * ONE PARAGRAPH OF LIVE PROSE, WITH THE BREAK BEFORE IT.
   *
   * ------------------------------------------------------------------------
   * THE DEFECT, and it is why the renderer kept testing correct while the real
   * screen looked wrong.
   *
   * `turnevents.flushParagraphs` splits streamed prose ON `

` and trims both
   * halves, so the blank line that made the boundary is consumed by the split
   * and each paragraph arrives here as a SEPARATE narration entry with nothing
   * between them. ui/feed.js `pushModel` knows this and puts the blank row back.
   *
   * This path did not go through `pushModel`. It called `pushLines` directly —
   * which trims its own leading and trailing blanks — so LIVE prose was drawn
   * as one slab and the same text separated correctly the moment the turn ended
   * and the RECORDED path drew it instead.
   *
   * Which is to say: it was glued together exactly while somebody was reading
   * it, and fixed itself once they had stopped. Every isolated test rendered
   * the recorded path and passed.
   *
   * ONE BLANK ROW, the same rule and the same reason as `pushModel`: one blank
   * line is what the model wrote, and the separator has to go BETWEEN the calls
   * because `pushLines` trims inside them.
   */
  const say = (out, n) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'model' && String(prev.text || '').trim()) {
      out.push({ kind: 'model', text: '' });
    }
    pushLines(out, textOf.get(n), 'model');
  };

  const turns = (session && session.turns) || [];

  // ---- THE PARAGRAPH THAT WAS STILL RESOLVING WHEN THE TURN ENDED --------
  //
  // THE DEFECT, and it is the "magician effect" the brief names: prose begins
  // to resolve, and a fraction of a second later the rest of it is simply
  // there. Half a paragraph presented, half a paragraph dumped.
  //
  // It is not in ui/reveal.js, which is a pure function of (text, said-at,
  // now) and behaves perfectly. It is in the HANDOVER. The live copy of the
  // turn's prose lives in ui/story.js and is cleared by `endTurn` the instant
  // the turn record lands; from that frame on the same words are drawn from
  // `session.turns`, which carried no stamp — so the presentation lost the one
  // input it is a function of and the text snapped to full.
  //
  // src/turn.js now stamps the record too, so the LAST turn's prose keeps
  // resolving across the boundary from exactly where it had got to. Nothing
  // else changes: `resolve` returns the whole string the moment its duration
  // has passed, so every older turn is settled text and pays one arithmetic
  // check for it.
  //
  // THE LAST TURN ONLY. Anything before it finished resolving long ago, and
  // walking every turn's prose through the clock on every frame would be an
  // effect for its own sake — the same argument that keeps history out of the
  // live reveal in the first place.
  //
  // RESOLVED UP FRONT, for the same reason `liveTexts` is: the cache key below
  // has to contain the text that is about to be drawn. A paragraph resolving on
  // screen changes without changing LENGTH, and the key describes a recorded
  // turn by lengths — so a cached frame would freeze it half-resolved, which is
  // the very snap this exists to remove, arrived at from the other side.
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const lastNarration = (lastTurn && Array.isArray(lastTurn.narration)) ? lastTurn.narration : [];
  const settledTexts = (reveal && lastNarration.length)
    ? lastNarration.map((n) => (n && n.at ? reveal(String(n.text || ''), n.at) : String((n && n.text) || '')))
    : [];
  // KEYED ONLY WHEN THERE IS SOMETHING TO KEY. Built from an empty
  // `settledTexts` — which is what a caller with no `reveal` (a pipe, the
  // dashboard, every test) produces — every entry mapped to `undefined`, and
  // `settled` then handed the feed an empty string for prose that was really
  // there. A map whose keys outnumber its values is not a lookup.
  const settledOf = new Map(settledTexts.length
    ? lastNarration.map((n, i) => [n, settledTexts[i]])
    : []);
  const settled = (t, n) => (t === lastTurn && settledOf.has(n)
    ? settledOf.get(n)
    : String((n && n.text) || ''));
  const plan = session && session.plan;

  // ---- BUILT ONCE PER CHANGE, NOT ONCE PER FRAME ------------------------
  //
  // The 60Hz redraw composes the whole frame, and the whole frame is almost
  // entirely this. Between two animation frames none of it has changed. See
  // ui/feedcache.js for the measurements and for why the key is derived from
  // the content rather than from a flag somebody has to remember to set.
  const cache = require('./feedcache');
  const ck = cache.key({
    width, turns, extras, plan, liveActions, liveNotes, liveUser, liveFrom, transcript, current,
    liveTexts, settledTexts, objective: session && session.task && session.task.objective,
  });
  const hit = cache.get(ck);
  if (hit) return hit;

  const lines = [];

  // The task objective and its progress are PINNED above this feed by the
  // screen (see taskBanner), so they are not repeated here — the feed is the
  // scrolling account of the plan and what happened.
  if (plan && plan.steps.length) {
    for (const st of plan.steps) {
      if (st.status === 'dropped') continue;
      lines.push(`  ${MARK[st.status] || MARK.todo} ${clip(st.text, width - 6)}`);
    }
    lines.push('');
  }

  // Prose and calls INTERLEAVED, in the order they happened: what LAIN said,
  // then what it did about it. Two stacked lists — all the narration, then all
  // the calls — is a log; this is an account.
  const said = [];

  // WHAT THE OTHER ACTORS SAID, PLACED WHERE THEY SAID IT.
  //
  // An external review and a desktop action happen BETWEEN turns, so they
  // belong to no turn record. They used to be appended after every turn had
  // been rendered, which put round 1 of a relay BELOW the LAIN turn that acted
  // on it — the review arrived on screen after its own consequences, and the
  // conversation read backwards. Each line carries the turn count as it stood
  // when it was spoken (see ui/index.js), so it can be flushed in its place.
  //
  // A line with NO recorded position is placed at the END, which is where every
  // one of them was drawn before this existed. That is not a default chosen for
  // convenience: sessions saved by an earlier build have no anchor, and guessing
  // `0` for them would silently move an old review to the top of its own story.
  // Unknown means unknown.
  const at = (e) => (Number.isFinite(e.afterTurns) ? e.afterTurns : Number.MAX_SAFE_INTEGER);
  const pending = [...extras].sort((a, b) => at(a) - at(b));
  const flushActors = (upTo) => {
    while (pending.length && at(pending[0]) <= upTo) {
      const e = pending.shift();
      if (e.kind === 'external') pushExternal(said, e.text);
      else if (e.kind === 'mcp') pushMcp(said, e.text);
      // A NOTE IS THE PROGRAM SPEAKING, not a model. An interruption is a
      // durable fact about the task, so it persists here with everything else
      // rather than vanishing with the turn that was interrupted.
      //
      // AND SO IS EVERYTHING ELSE THAT REACHES HERE. The fallthrough used to be
      // `pushModel`, which drew an actor line as though the MODEL had said it —
      // no label, no indent, indistinguishable from the assistant's own prose.
      // Adding `web` for the research lookups found it: `read · Node.js docs`
      // appeared in the feed as a sentence LAIN had written. An unrecognised
      // kind is by definition not the model talking, so the safe default is the
      // one that says the program is.
      else pushNote(said, e.text, e.level);
    }
  };

  // ---- THE ACTUAL SCROLLBACK CEILING, and it was SIX TURNS ---------------
  //
  // This is what a user hit when they could not scroll back to the start of
  // their own conversation. Everything downstream — the feed cap, the scroll
  // bounds — was operating on a list that had already been cut to the last six
  // turns, so no amount of scrolling could reach a seventh. The session on disk
  // had all of it.
  //
  // Bounded still, because a redraw walks this list, but bounded by a number no
  // real session reaches rather than by one every session passes in a minute.
  // Measured on the longest sessions on this machine: a full render is about
  // two milliseconds, and a redraw happens on a keystroke, not on a clock.
  const start = Math.max(0, turns.length - MAX_TURNS_SHOWN);
  if (start > 0) {
    lines.push(P.meta(`  ⋮ ${start} earlier turn(s) not shown `
      + '— the full transcript is in the saved session'));
  }
  for (let ti = start; ti < turns.length; ti++) {
    const t = turns[ti];
    // Anything said BEFORE this turn began belongs above it.
    flushActors(ti);
    // WHAT THE USER SAID, first, because it is what everything under it is a
    // response to. This was missing entirely: the feed rendered the model's
    // prose and LAIN's calls and nothing else, so the only message a person
    // could see was their FIRST one — and that only because the pinned banner
    // happens to carry the task objective. Their second sentence, and every one
    // after it, existed in the session and on the wire and nowhere on screen.
    //
    // ...EXCEPT THE ONE THE PINNED BANNER IS ALREADY SHOWING. The task
    // objective IS the first message, so drawing both put it on screen twice,
    // three rows apart, for the whole task:
    //
    //     TASK  find the bug
    //       USER
    //         ❯ find the bug
    //
    // Only the FIRST turn can collide. A later message that happens to repeat
    // the objective is the user saying it again, which is real and stays.
    if (!(ti === 0 && sameText(t.userInput, session && session.task && session.task.objective))) {
      sayInput(said, t.userInput, t.from);
    }
    const actions = Array.isArray(t.actions) ? t.actions : [];
    const narration = Array.isArray(t.narration) ? t.narration : null;

    // WHAT THE USER SAID WHILE IT WAS WORKING —.
    //
    // A steer arrives mid-turn and is delivered between steps, so it belongs IN
    // the turn, at the step it reached. Only the COUNT used to be recorded, so
    // the sentence was on screen while the turn ran and gone the moment it
    // ended: the model had been told and the conversation no longer showed that
    // anything had been said. A correction the user made is the one thing that
    // cannot be recovered by re-reading the repository.
    const steers = Array.isArray(t.steerTexts) ? t.steerTexts : [];

    if (narration) {
      const steps = [...new Set([
        ...narration.map((n) => n.step),
        ...actions.map((a) => a.step),
        ...steers.map((s) => s.step),
      ])].sort((x, y) => x - y);
      // WHICH PARAGRAPH WAS THE LAST THING THIS TURN SAID. Every one before it
      // had the timeline speaking underneath it and can be dropped whole if it
      // was pure announcement; the final one is the turn's answer and stays.
      const lastSaid = narration.length ? narration[narration.length - 1] : null;
      for (const st of steps) {
        // BEFORE the step's own output, because that is the order it happened
        // in: the model was handed the correction, and then did what follows.
        for (const s of steers.filter((x) => x.step === st)) pushUser(said, s.text);
        for (const n of narration.filter((x) => x.step === st)) {
          pushModel(said, settled(t, n), { last: n === lastSaid });
        }
        for (const a of actions.filter((x) => x.step === st)) pushAction(said, a);
      }
      // Calls from a turn recorded before steps were tracked.
      for (const a of actions.filter((x) => x.step === undefined)) pushAction(said, a);
    } else {
      for (const s of steers) pushUser(said, s.text);
      // ONE CALL, so a turn recorded before narration existed is laid out by
      // the same rule as every other message. Splitting and trimming here threw
      // away the blank lines between paragraphs — the same formatting loss,
      // arrived at from the other direction.
      pushModel(said, t.text);
      if (actions.length) for (const a of actions) pushAction(said, a);
      else for (const n of t.toolNames || []) said.push({ kind: 'action', text: `${MARK.done} ${phrase(n, '')}` });
    }
    // ---- WHAT IT THOUGHT, WHEN IT SAID NOTHING AT ALL --------------------
    //
    // Reported with a screenshot: a reasoning model was asked "hello" and the
    // pane was empty. Some models put all their prose in `reasoning` and leave
    // `content` empty, so the turn genuinely had nothing in `text`.
    //
    // AFTER BOTH BRANCHES, deliberately. The first version sat inside the
    // `else` and was unreachable: `t.narration` is always an array, so every
    // turn takes the branch above it. Placed here it applies to whichever
    // layout the turn used, which is what "the model said nothing" means
    // regardless of how the turn was recorded.
    //
    // Drawn ONLY when nothing was said and nothing was done. Thinking is not
    // speech: a turn with a real answer must not have its working-out replayed
    // underneath, which would bury the answer in the reasoning that led to it.
    if (!said.length && String(t.reasoning || '').trim()) pushModel(said, t.reasoning);
    // A failed CALL is already in the feed, in order, as `✗ Read a.js` with its
    // reason. Replaying `t.errors` here appended a second, differently-worded
    // copy of the same failure at the end of the turn — the same event told
    // twice, out of order, which is what made the feed read as a raw event log.
    // Only errors with no call of their own (a provider failure) are added.
    for (const e of (t.errors || []).slice(0, 2)) {
      if (e.kind === 'TOOL') continue;
      // NOT AS AN ACTION. It was pushed with the same ✗ a failed tool call
      // wears, so it landed directly beneath the call that had just SUCCEEDED
      // and read as that call failing:
      //
      //     ✓ Ran cd probot && sed -n ... runner.py
      //     ✗ 413 Payload Too Large - {"error": {"message": "Chat history …
      //
      // The shell command was fine. The next model REQUEST was refused, which
      // is a different actor failing for a different reason —. It is a note
      // now, in LAIN's own failure vocabulary rather than the raw body the
      // provider happened to send.
      const f = require('./status').failureRow(e);
      pushNote(said, `${f.word} — ${f.detail}`, 'error');
    }
  }

  // Everything said after the last recorded turn — including a review that has
  // just come back and is the reason the next turn is about to happen.
  flushActors(Number.MAX_SAFE_INTEGER);

  // The message being worked on RIGHT NOW, which has no turn record yet.
  sayInput(said, liveUser, liveFrom);

  // THE TURN IN FLIGHT. `session.turns` only gains an entry when a turn ENDS,
  // so without this the feed was empty for the entire time the work was
  // happening — a ten-call turn showed a status line above nothing until the
  // moment it finished. Same records, shown while they are still true.
  for (let i = 0; i < liveActions.length; i++) {
    for (const n of liveNarration.filter((x) => x.after === i)) say(said, n);
    for (const n of liveNotes.filter((x) => x.after === i)) pushNote(said, n.text, n.level);
    pushAction(said, liveActions[i]);
  }
  for (const n of liveNarration.filter((x) => x.after >= liveActions.length)) say(said, n);
  for (const n of liveNotes.filter((x) => x.after >= liveActions.length)) pushNote(said, n.text, n.level);

  if (said.length) {
    // NO `CONTEXT` HEADING HERE. The tab strip one row above already reads
    // `[1 context]`, so this printed the name of the pane inside the pane — a
    // row of chrome that said something the user could already see, directly
    // above the conversation it was pushing down.
    //
    // COMPACT FIRST, THEN TAKE THE TAIL. The other order throws away the
    // conversation to keep rows of tool calls — which is the failure this is
    // here to fix, performed by the fix itself.
    const feed = compactRuns(said);
    const shown = feed.length > MAX_FEED_ENTRIES ? feed.slice(-MAX_FEED_ENTRIES) : feed;
    // A CAP THAT IS HIT SAYS SO. Silently dropping the top of somebody's own
    // conversation is how they conclude it is gone; the session on disk still
    // has all of it, and the line says where to get it.
    if (shown.length < feed.length) {
      lines.push(P.meta(`  ⋮ ${feed.length - shown.length} earlier entries not shown `
        + '— the full transcript is in the saved session'));
    }
    // WHERE EACH USER MESSAGE LANDED, carried through to the Screen so a click
    // in the feed can put that message back on the input line. The indices are
    // rebased: renderFeed numbers from its own first row, and this feed starts
    // partway down the pane. See ui/feed.js `userBlock` and ui/mouse.js.
    const feedLines = renderFeed(shown, width);
    const base = lines.length;
    if (feedLines.userAt) {
      if (!lines.userAt) {
        Object.defineProperty(lines, 'userAt', { value: Object.create(null), enumerable: false, writable: true });
      }
      for (const k of Object.keys(feedLines.userAt)) lines.userAt[base + Number(k)] = feedLines.userAt[k];
    }
    // AND WHERE EACH FILE-NAMING ACTION ROW LANDED, rebased the same way, so a
    // click on `Read src/loader.js` can open src/loader.js. See ui/mouse.js.
    if (feedLines.fileAt) {
      if (!lines.fileAt) {
        Object.defineProperty(lines, 'fileAt', { value: Object.create(null), enumerable: false, writable: true });
      }
      for (const k of Object.keys(feedLines.fileAt)) lines.fileAt[base + Number(k)] = feedLines.fileAt[k];
    }
    for (const l of feedLines) lines.push(l);
  }

  // HOW MANY MESSAGES THIS FEED CONTAINS, carried on the result.
  //
  // The scroll indicator needs to say "3 new" and mean three MESSAGES, not
  // three rows — thirty reads scrolling past is not somebody saying something.
  // Counted here, from the same list that was just rendered, rather than
  // re-derived by the Screen from session state: a second count built out of
  // different inputs is free to disagree with this one, and the day they
  // disagree the indicator lies. See ui/layout.js.
  lines.spoken = spokenCount(said);

  // THE LIVE ROW IS NOT HERE. It used to be appended at the foot of this feed
  // whenever the pinned banner was not already showing it — two owners for one
  // sentence, both at the top of the screen. The status strip above the INPUT
  // is now the single owner; this region is the ACCOUNT of what happened, which
  // is what the design asks to keep visible and complete.

  for (const step of (current && current.steps) || []) {
    const m = step.done ? MARK.done : step.active ? MARK.active : MARK.todo;
    lines.push(`  ${m} ${clip(step.label, width - 6)}`);
  }

  // What commands printed. In TTY mode stdout belongs to the Screen, so command
  // output is captured and shown HERE — where the user is already looking when
  // they type `/status` — rather than painted over the drawn regions.
  if (transcript && transcript.length) {
    if (said.length) lines.push('');
    // Same reasoning as the feed above: this was 40 lines, so the output of a
    // command that printed more than that could not be scrolled back to.
    const tail = transcript.length > MAX_TRANSCRIPT_LINES
      ? transcript.slice(-MAX_TRANSCRIPT_LINES) : transcript;
    if (tail.length < transcript.length) {
      lines.push(P.meta(`  ⋮ ${transcript.length - tail.length} earlier output lines not shown`));
    }
    // ---- WRAPPED, NOT CLIPPED -------------------------------------------
    //
    // The same anti-pattern as the how-to callout, on the surface that carries
    // EVIDENCE. `clip` ended a long output line with an ellipsis, so the tail
    // of a stack frame, a failing assertion's actual value, or a path deep in a
    // tree was destroyed at draw time and could not be recovered by widening
    // the terminal. Command output is the thing a person reads to decide
    // whether the work is right; it is not a label.
    //
    // BOUNDED, because a minified bundle printed to stdout is one line of forty
    // thousand characters, and wrapping that unconditionally would turn a
    // scrollable pane into a wall. A line that needs more than
    // `MAX_WRAPPED_ROWS` says how much of it is not drawn — the same shape the
    // two caps above use, and an honest count rather than a silent cut.
    for (const l of tail) {
      const parts = wrapIndented(String(l == null ? '' : l), Math.max(12, width));
      if (parts.length <= MAX_WRAPPED_ROWS) { for (const p of parts) lines.push(p); continue; }
      for (const p of parts.slice(0, MAX_WRAPPED_ROWS)) lines.push(p);
      lines.push(P.meta(`  ⋮ ${parts.length - MAX_WRAPPED_ROWS} more wrapped row(s) of this line`));
    }
  }
  // REMEMBERED, AND A COPY HANDED BACK. The pane appends the live timeline rows
  // to what it gets, so returning the cached array itself would grow a tail of
  // stale cards into the next frame's history.
  return cache.put(ck, lines);
}

module.exports = {
  activity, sameText, MAX_FEED_ENTRIES, MAX_TRANSCRIPT_LINES, MAX_TURNS_SHOWN,
};