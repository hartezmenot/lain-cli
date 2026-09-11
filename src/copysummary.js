'use strict';

/**
 * WHAT A PERSON ACTUALLY PASTES SOMEWHERE ELSE — the task summary, and the
 * diagnostic context.
 *
 * ------------------------------------------------------------------------
 * BOTH ARE BUILT FROM RECORDS. NEITHER READS THE SCREEN.
 *
 * The rule the blueprint states as "do not scrape rendered terminal pixels" is
 * not fastidiousness. A rendered line has been wrapped to the terminal's width,
 * truncated to fit a column, painted with SGR sequences, and interleaved with
 * a spinner that was overwriting itself four times a second. Everything that
 * makes it readable on screen makes it wrong in a paste — and the parts worth
 * having (what was asked, what changed, what was proved) are all in
 * `session.turns`, the checkpoint ledger and the Harness record already.
 *
 * So the authorities are: `session.turns` (turnclose.js writes it),
 * `session.plan`, `session.lifecycle`, the checkpoint ledger via ui/panes, and
 * the Harness task record. Nothing here re-runs work and nothing asks a model.
 *
 * ------------------------------------------------------------------------
 * WHAT IS DELIBERATELY LEFT OUT, AND WHY EACH ONE.
 *
 *   reasoning        A turn record keeps `reasoning` so a turn that said
 *                    nothing is not a blank pane. It is the model's private
 *                    working, it is not addressed to anyone, and putting it in
 *                    a paste sends it somewhere it was never meant to go. It
 *                    is excluded HERE rather than filtered later, so no future
 *                    section can accidentally include it.
 *   activity         A spinner's worth of "READING file.js" at four frames a
 *                    second. It described a moment that has passed.
 *   token telemetry  Answers a question nobody pasting this is asking.
 *   the timer        Same.
 *   READY / status   Transient by construction.
 *   the command menu, anchors, dividers, decoration — drawing, not content.
 *
 * ------------------------------------------------------------------------
 * TWO SHAPES BECAUSE THERE ARE TWO QUESTIONS.
 *
 *   `summary`   "what happened, and where does it stand" — for a colleague, a
 *               commit message, a status update. Compressed and current.
 *   `context`   "here is everything you need to diagnose this" — for another
 *               model. Chronological, from the initiating request forward, and
 *               it keeps the durable tool results a diagnosis needs.
 */

const MAX_ANSWER = 4000;
const MAX_TOOL_RESULT = 2000;
const MAX_STEER = 400;

/** The turn a summary is about: the most recent one that a person started. */
function initiatingTurn(session) {
  const turns = (session && session.turns) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    // A CONTINUATION IS NOT AN INITIATION. `from` marks a turn LAIN started on
    // its own behalf (a recovery, an advisory continuation); summarising one of
    // those reports the machinery's request instead of the person's.
    if (!turns[i].from || turns[i].from === 'user') return turns[i];
  }
  return turns[turns.length - 1] || null;
}

/** Every turn from the initiating one to the end — the span a task occupies. */
function turnSpan(session) {
  const turns = (session && session.turns) || [];
  const start = initiatingTurn(session);
  if (!start) return [];
  const i = turns.indexOf(start);
  return i < 0 ? turns.slice(-1) : turns.slice(i);
}

function trim(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
}

/**
 * THE PUBLIC TEXT OF A RECORD, OR NOTHING AT ALL.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR, QUOTED FROM A REAL EXPORT:
 *
 *     USER (mid-turn)
 *     [object Object]
 *
 *     USER (mid-turn)
 *     [object Object]
 *
 * `steerTexts` is named for what it used to hold and not for what it holds:
 * turn.js pushes `{ step, text }` records, so a projection that treated each
 * entry as a string produced `String({…})` — the one output a diagnostic
 * export must never contain, because it discards the very sentence the export
 * exists to carry.
 *
 * MY OWN FIXTURE HID IT. The test for this put plain strings in `steerTexts`,
 * which is not what the writer writes, so it passed against a shape that does
 * not occur. The regressions below now use the REAL record shape.
 *
 * ------------------------------------------------------------------------
 * OMISSION IS THE FALLBACK, NEVER STRINGIFICATION.
 *
 * An object with no public text is internal — a marker, a counter, a shape
 * nobody outside LAIN was meant to read. There is no honest rendering of it,
 * so it does not appear. Emitting `[object Object]`, or a JSON dump, would
 * hand somebody debugging their own code a fact about LAIN's internals in
 * place of the sentence they typed.
 *
 * `TEXT_KEYS` is ordered by how likely a field is to be what a person actually
 * said, and every one of them is a field a HUMAN authored — never `reasoning`,
 * never a system prompt, never a tool payload.
 */
const TEXT_KEYS = ['text', 'message', 'content', 'value'];

function publicText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (Array.isArray(entry)) {
    // An array of parts: keep the textual ones, drop the rest.
    return entry.map(publicText).filter(Boolean).join(' ').trim();
  }
  if (typeof entry !== 'object') return '';
  for (const k of TEXT_KEYS) {
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // One level of nesting only — `{ text: { text: … } }` happens; deeper is
    // a structure nobody meant to be read as a sentence.
    if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) return v.text.trim();
  }
  return '';
}

/** Files this session changed, from the ledger that already tracks them. */
function changed(app) {
  try {
    return require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }) || [];
  } catch { return []; }
}

/**
 * WHAT WAS PROVED, from the Harness rather than from anything the model said.
 *
 * A verification is the one part of a summary that must not come from prose:
 * "I ran the tests and they pass" is a sentence, and PASSED/FAILED with a
 * reason is a verdict. Where there is no Harness record this says nothing at
 * all rather than reporting the absence as a pass.
 */
function verification(app) {
  const out = [];
  try {
    const harness = require('./harnesslink').existing(app);
    const task = harness && harness.runtime && typeof harness.runtime.latest === 'function'
      ? harness.runtime.latest() : null;
    for (const v of (task && task.verifications ? task.verifications : []).slice(-4)) {
      out.push(`${v.verdict || 'UNKNOWN'}  ${v.why || ''}`.trim());
    }
  } catch { /* no harness in this session */ }
  try {
    const last = app.session.lifecycle && app.session.lifecycle.lastCommand;
    if (last && last.command) {
      out.push(`${last.ok === false ? 'FAILED' : 'PASSED'}  ${last.command}`);
    }
  } catch { /* no lifecycle */ }
  return out;
}

/** What is still outstanding — plan steps and the completion gate's reason. */
function remaining(app) {
  const out = [];
  const plan = app.session.plan;
  if (plan && Array.isArray(plan.steps)) {
    for (const s of plan.steps) {
      if (s.status !== 'done' && s.status !== 'DONE') out.push(`[${s.status}] ${s.text}`);
    }
  }
  if (app.pendingCompletion) out.push(String(app.pendingCompletion));
  return out;
}

/** What this project itself says would run it. Derived, never guessed. */
function howToRun(app) {
  try {
    const profile = require('./harness/profile').forProject(app.session.cwd || process.cwd());
    return profile && !profile.empty ? (profile.found || []) : [];
  } catch { return []; }
}

/**
 * `/copy` — THE TASK SUMMARY.
 *
 * Sections appear only when they have something in them. An empty `CHANGED`
 * heading over nothing tells a reader that the section exists; leaving it out
 * tells them nothing changed, which is the true statement.
 */
function summary(app) {
  const s = app.session;
  const start = initiatingTurn(s);
  const span = turnSpan(s);
  if (!start && !(s.task && s.task.objective)) return null;

  const out = [];
  const section = (title, lines) => {
    const rows = (Array.isArray(lines) ? lines : [lines]).filter((l) => String(l || '').trim());
    if (!rows.length) return;
    if (out.length) out.push('');
    out.push(title, ...rows);
  };

  section('USER REQUEST', trim((start && start.userInput) || (s.task && s.task.objective) || '', 1500));

  // MID-TURN CORRECTIONS ARE PART OF THE REQUEST. They are the least
  // recoverable thing in the record — a tool result can be produced again by
  // running the tool; a sentence somebody typed an hour ago cannot.
  const steers = [];
  for (const t of span) {
    for (const st of (t.steerTexts || [])) {
      // A RECORD, NOT A STRING — see publicText. One with no public text is
      // internal and is omitted rather than rendered as [object Object].
      const said = publicText(st);
      if (said) steers.push(`⚑ ${trim(said, MAX_STEER)}`);
    }
  }
  section('STEERS', steers.slice(-6));

  // THE RESULT IS THE LAST THING LAIN SAID, not a digest of everything it said.
  const answers = span.map((t) => t.text).filter((x) => String(x || '').trim());
  section('RESULT', trim(answers[answers.length - 1] || '', MAX_ANSWER));

  const files = changed(app);
  section('CHANGED', files.map((f) => `${f.rel}  ${f.kind}  +${f.added} -${f.removed}`));

  section('VERIFICATION', verification(app));
  section('REMAINING', remaining(app));
  section('HOW TO RUN', howToRun(app));

  // A TURN THAT DID NOT FINISH SAYS SO. Reporting a cut-short turn's answer
  // as a plain RESULT is the one way this summary could actively mislead.
  const last = span[span.length - 1];
  if (last && last.stopReason && last.stopReason !== 'end') {
    section('NOTE', `the last turn ended early: ${last.stopReason}`);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * `/copy context` — THE DIAGNOSTIC EXPORT.
 *
 * ------------------------------------------------------------------------
 * IT IS FOR ANOTHER MODEL, AND THAT DECIDES EVERY INCLUSION.
 *
 * The person is going somewhere else to ask "why did this happen". So it starts
 * at the request that began this, runs forward in time, and keeps the things a
 * diagnosis is actually made from: what was asked, what LAIN said in public,
 * what the tools actually did, what errors came back, what was steered.
 *
 * `session.messages` — what `/copy context` used to dump — is the wrong source
 * even though it looks like the right one. It is the provider's wire format:
 * system prompts, tool-call plumbing, full file bodies re-sent for cache
 * alignment. It is enormous, it is mostly not conversation, and it contains
 * the assembled prompt rather than the exchange.
 */
function context(app, { all = false } = {}) {
  const s = app.session;
  const span = all ? ((s.turns || []).slice()) : turnSpan(s);
  if (!span.length) return null;

  const out = [];
  const push = (head, body) => {
    const text = trim(body, MAX_ANSWER);
    if (!text) return;
    if (out.length) out.push('');
    out.push(head, text);
  };

  out.push(`# LAIN diagnostic context — ${span.length} turn(s)`);
  if (s.cwd) out.push(`# project: ${s.cwd}`);
  if (s.task && s.task.objective) out.push(`# objective: ${trim(s.task.objective, 300)}`);

  for (const t of span) {
    // The person's words first, because they are what everything after is a
    // response to. An advisory continuation is labelled as one rather than
    // presented as something the user typed.
    const who = t.from && t.from !== 'user' ? `USER (via ${t.from})` : 'USER';
    push(who, t.userInput);

    for (const st of (t.steerTexts || [])) {
      const said = publicText(st);
      if (said) push('USER (mid-turn)', said);
    }

    // WHAT THE TOOLS DID. Summaries, not bodies: an `actions` entry already
    // carries the shape a diagnosis needs — which tool, on what, and what came
    // back — without the file contents that make a raw transcript unusable.
    for (const a of (t.actions || [])) {
      const label = [a.verb || a.tool, a.target].filter(Boolean).join(' ');
      const detail = a.summary || a.detail || a.result || '';
      if (!label && !detail) continue;
      push('TOOL', `${label}${detail ? `\n${trim(detail, MAX_TOOL_RESULT)}` : ''}`);
    }

    for (const e of (t.errors || [])) push('ERROR', typeof e === 'string' ? e : (e.message || JSON.stringify(e)));

    // AND WHAT LAIN SAID IN PUBLIC. `t.reasoning` is deliberately not read
    // here or anywhere in this file — see the header.
    push('LAIN', t.text);

    if (t.stopReason && t.stopReason !== 'end') push('LAIN (turn ended early)', String(t.stopReason));
  }
  return out.join('\n');
}

module.exports = { summary, context, publicText, initiatingTurn, turnSpan, changed, verification, remaining, howToRun };
