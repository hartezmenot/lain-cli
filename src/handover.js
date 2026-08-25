'use strict';

/**
 * THE HANDOVER PACKET — what a REPLACEMENT model needs in order to continue,
 * built from what LAIN OBSERVED rather than from what the previous model said.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT "SEND THE CONVERSATION AGAIN".
 *
 * A transcript is the wrong artefact for a handover twice over. It is enormous,
 * and it is a record of what a model BELIEVED. When a turn dies halfway through
 * a task, the last thing in that transcript is very often a sentence like
 *
 *     "I've updated the loader and the tests pass."
 *
 * which may be true, may be half-true, and may describe a write that never
 * landed. Replaying it hands the next model the dead one's confidence along
 * with its facts, and nothing distinguishes the two.
 *
 * So this is assembled from the places LAIN keeps its own records:
 *
 *   session.task          the objective, and the user's later corrections
 *   session.turns         how the previous turn ENDED, and which model ran it
 *   checkpoints           the bytes on disk now, against the bytes before
 *   session.lifecycle     the last command actually run, and its real exit
 *   session.evidence      which files have already been inspected
 *   memory                what is durably true about this project
 *   session.plan          which steps are genuinely finished
 *
 * ------------------------------------------------------------------------
 * CLAIMED, OBSERVED, VERIFIED — three different words, kept apart.
 *
 *   CLAIMED    the model said it. Carried only when nothing corroborates it,
 *              and labelled as a claim so the next model re-checks rather than
 *              inherits it.
 *   OBSERVED   a tool reported it — an edit returned `mutated`, a command ran.
 *   VERIFIED   LAIN looked at the world just now and it is still so.
 *
 * The interesting case is the disagreement. A file the tool layer recorded as
 * written, whose bytes on disk still equal the pre-edit bytes, is a mutation
 * that did NOT land, and saying so is the entire point of reconciling at
 * handover time instead of trusting the ledger.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A SECOND CONTEXT SYSTEM. Every fact here already existed and was
 * already owned by the module that owns it; this composes them for one specific
 * moment — the model changed, or the last turn did not finish — and prompt.js
 * uses it INSTEAD of the ordinary working context at that moment, never beside
 * it. See prompt.build.
 *
 * SMALL, on purpose. It rides a request that is trying to recover, and a
 * recovery that costs more than the work it saves is not one.
 */

const path = require('path');

/** Rows per section. A handover is a briefing, not an inventory. */
const MAX_FILES = 10;
const MAX_STEERS = 4;
const MAX_MEMORY = 5;
const MAX_STEPS = 6;
const MAX_INSPECTED = 8;
/** Background jobs named in the packet. It is a briefing, not a queue dump. */
const MAX_JOBS = 6;
/** Undelivered sentences carried. All of them, up to a person's realistic limit. */
const MAX_UNDELIVERED = 8;
/** Closed routes named in the packet. Same rule. */
const MAX_ROUTES = 5;
/** Architecture rows: alarms first, then the branch the changed files belong to. */
const MAX_ARCH_ALARMS = 6;
const MAX_ARCH_BRANCH = 6;
/** Concepts and wiring rows the branch pulls in. The packet is a briefing. */
const MAX_CONCEPTS = 6;
const MAX_EDGES = 8;
/** Facts promoted out of scratch, beyond the memory rows. */
const MAX_LAIN_FACTS = 4;
/** Older sessions whose scratch was never collected. */
const MAX_ORPHANS = 3;

/** Why the previous turn stopped, in words a replacement model can act on. */
const WHY = {
  aborted: 'the user interrupted it',
  provider: 'the provider stopped answering',
  'max-steps': 'it reached the step budget',
  'no-credential': 'there was no usable credential',
};

/**
 * WHY THE RUNTIME STOPPED THE SENTENCE, in the same voice.
 *
 * These are the Guardian's words, not the transcript's, and the distinction is
 * the reason they are a separate table. `session.turns` records what a turn
 * REPORTED; a turn whose process was killed reported nothing at all, so the
 * transcript's last entry looks like work still in flight and the only witness
 * to what actually happened is the process that was watching from outside.
 */
const RUNTIME_WHY = {
  RATE_LIMITED: 'the route LAIN was using is rate limited, so your message was not sent to it',
  PROVIDER_FAILED: 'the previous turn did not finish — the provider stopped answering',
  TURN_LOST: 'the LAIN process running the previous turn no longer exists; it was killed or it crashed '
    + 'mid-turn, so nothing recorded how far it got',
  HANDOVER_PENDING: 'the model changed part-way through this task',
};

function rel(cwd, p) {
  try {
    const r = path.relative(cwd || process.cwd(), p);
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p;
  } catch { return p; }
}

/**
 * WHAT THE PROJECT'S OWN RECORDS SAY — the `.lain` sections of the packet.
 *
 * The session is one process's memory; `.lain` is the project's. It holds the
 * three things a replacement model cannot get from the transcript and should
 * not pay a re-read for: the INTENDED architecture (so a file that vanished is
 * a named component with a purpose, not a mystery), the vocabulary (so the
 * task's own words mean what they meant to the model that defined them), and
 * the findings the dead turn had already made (scratch — written as they were
 * found, never as conclusions).
 *
 * EVERY SECTION HERE IS OPTIONAL and every one is skipped silently when its
 * slot is empty: a handover for a project with no `.lain/` must produce
 * exactly the packet it produced before this existed. All reads are local and
 * synchronous; `reconcile.run` re-measures the disk (§12: remeasure before
 * handover) over recorded node locations only, never the whole tree.
 *
 * @returns {{alarms:string, branch:string}} two sections, either possibly ''
 */
function lainSections(root, changedNames) {
  const out = { alarms: '', branch: '' };
  try {
    const architecture = require('./architecture');
    const model = architecture.load(root);
    if (!Object.keys(model.nodes).length) return out;
    const reconcile = require('./reconcile');
    const { report } = reconcile.run(root, { model });

    // ---- INTENT vs DISK, remeasured now ---------------------------------
    if (report.alarms.length) {
      const rows = report.alarms.slice(0, MAX_ARCH_ALARMS)
        .map((a) => `- ${a.kind}: ${a.say}`);
      out.alarms = 'The intended architecture disagrees with the disk (re-measured just now):\n'
        + rows.join('\n')
        + (report.alarms.length > MAX_ARCH_ALARMS ? `\n- (+${report.alarms.length - MAX_ARCH_ALARMS} more)` : '')
        + '\nTheir purpose and last verification are recorded in .lain and did not go anywhere.';
    }

    // ---- THE BRANCH THE WORK IS INSIDE -----------------------------------
    //
    // The changed files, read as ARCHITECTURE rather than as bytes: what each
    // one is FOR, what it is called, and how it connects — the orientation a
    // replacement model would otherwise pay a repository re-read for.
    const branch = Object.values(model.nodes)
      .filter((n) => n.location && changedNames.has(n.location))
      .slice(0, MAX_ARCH_BRANCH);
    if (!branch.length) return out;
    const lines = ['The work is inside these recorded components:'];
    for (const n of branch) {
      const bits = [`- ${n.name} (${n.id})`];
      if (n.purpose) bits.push(String(n.purpose).replace(/\s+/g, ' ').slice(0, 160));
      if (n.verification && n.verification.at) {
        bits.push(`last verified by ${n.verification.how}`);
      }
      lines.push(bits.join(' — '));
    }

    const dict = require('./dictionary').load(root);
    const concepts = new Map();
    for (const n of branch) {
      for (const e of require('./dictionary').forNode(dict, n.id)) concepts.set(e.term, e);
    }
    if (concepts.size) {
      lines.push('', 'Vocabulary these components use (defined here, not inferred):');
      let shown = 0;
      for (const e of concepts.values()) {
        if (shown >= MAX_CONCEPTS) { lines.push('  [more — ask the concept tool]'); break; }
        lines.push(`  ${e.term} — ${String(e.purpose || '').replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0]}`);
        shown += 1;
      }
    }

    const graph = require('./wiring').load(root);
    if (graph.edges.length) {
      const edges = [];
      const ids = new Set(branch.map((n) => n.id));
      for (const e of graph.edges) {
        if (edges.length >= MAX_EDGES) break;
        if (ids.has(e.from) || ids.has(e.to)) edges.push(e);
      }
      if (edges.length) {
        lines.push('', 'How they are wired:');
        for (const e of edges) lines.push(`  ${require('./wiring').sayEdge(e, { model })}`);
      }
    }
    out.branch = lines.join('\n');
  } catch { /* no .lain, or an unreadable one: the packet is complete without it */ }
  return out;
}

/**
 * WHAT ACTUALLY LANDED ON DISK.
 *
 * `checkpoints.diff` compares the bytes captured before each mutating call
 * against the bytes that are there now, so this is the one section of the
 * packet that is not anybody's report — it is a measurement taken at the moment
 * the handover is written.
 *
 * `unchanged` is the row that matters most and is the easiest to omit: it means
 * a write was attempted and the file is byte-identical to before it. Whether
 * that is a failed edit, a reverted one, or an edit that was never reached, the
 * next model must not be told the change is in place.
 */
function onDisk(checkpoints, cwd) {
  const changed = [];
  const notLanded = [];
  if (!checkpoints || !Array.isArray(checkpoints.entries)) return { changed, notLanded };
  for (const entry of checkpoints.entries) {
    let rows = [];
    try { rows = checkpoints.diff(entry) || []; } catch { rows = []; }
    for (const r of rows) {
      const name = rel(cwd, r.path);
      if (r.kind === 'created' || r.kind === 'modified' || r.kind === 'deleted') {
        if (!changed.some((c) => c.name === name)) changed.push({ name, kind: r.kind });
      } else if (r.kind === 'unchanged' || r.kind === 'absent') {
        if (!notLanded.some((c) => c.name === name)) notLanded.push({ name, kind: r.kind });
      }
    }
  }
  // A path that later genuinely changed is not a failed write, whatever an
  // earlier checkpoint saw. The last word about a file is the one on disk.
  return { changed, notLanded: notLanded.filter((n) => !changed.some((c) => c.name === n.name)) };
}

/**
 * Build the packet. Returns '' when there is nothing worth handing over, which
 * is the ordinary case for a session that is simply continuing.
 *
 * @param {object} session
 * @param {{cwd?:string, checkpoints?:object, toModel?:string}} opts
 */
function build(session, opts = {}) {
  const { cwd = '', checkpoints = null, toModel = '', runtime = null } = opts;
  if (!session) return '';
  const root = cwd || session.cwd || process.cwd();
  const parts = [];

  // ---- WHY YOU ARE READING THIS -------------------------------------------
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const last = turns[turns.length - 1] || null;
  const from = last && last.model;
  const opening = [];
  // THE RUNTIME'S ACCOUNT GOES FIRST, when there is one, because it is the only
  // one that can describe a failure the transcript did not survive. A Node
  // process killed mid-turn wrote no `stopReason`, so every clause below this
  // one reads that session as a turn still happily in flight.
  //
  // It is also the only account that can name the PREVIOUS MODEL after a switch
  // decided in a process that has since exited.
  const rt = runtime && typeof runtime === 'object' ? runtime : null;
  if (rt) {
    const why = RUNTIME_WHY[rt.kind] || 'the previous turn did not complete';
    const st = rt.state || {};
    const prev = st.previous_model && st.previous_model !== toModel ? st.previous_model : '';
    opening.push(`LAIN's runtime stopped this message reaching the model directly: ${why}.`
      + (prev ? ` The work up to this point was done by ${prev}.` : ''));
  }
  if (from && toModel && from !== toModel) {
    opening.push(`You are taking over this task from a different model (${from}).`);
  }
  if (last && last.stopReason && last.stopReason !== 'end') {
    const why = WHY[last.stopReason] || last.stopReason;
    const acts = Array.isArray(last.actions) ? last.actions : [];
    const inFlight = acts.length ? acts[acts.length - 1] : null;
    opening.push(`The previous turn did NOT finish: ${why}, after ${last.steps || 0} step(s)`
      + (inFlight ? `, last call \`${inFlight.name}${inFlight.target ? ' ' + inFlight.target : ''}\`` : '')
      + '. Nothing after that point happened.');
  }
  if (!opening.length) return '';
  parts.push(opening.join(' '));

  // ---- THE TASK, AND THE USER'S OWN WORDS ---------------------------------
  //
  // First, because it is the one thing in the packet that cannot be recovered
  // by looking at the repository. Everything below can be re-measured; a
  // correction the user made an hour ago cannot.
  const task = session.task;
  if (task && task.objective) parts.push(`Task: ${String(task.objective).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (task && Array.isArray(task.steers) && task.steers.length) {
    const rows = task.steers.slice(-MAX_STEERS)
      .map((s) => `- ${String(s.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    parts.push(`The user has since said (these override the original request):\n${rows.join('\n')}`);
  }

  // ---- WHAT IS TRUE ON DISK RIGHT NOW -------------------------------------
  const disk = onDisk(checkpoints, root);
  if (disk.changed.length) {
    const rows = disk.changed.slice(0, MAX_FILES).map((c) => `- ${c.name} (${c.kind})`);
    parts.push(`VERIFIED changed on disk (checked just now, not reported):\n${rows.join('\n')}`
      + (disk.changed.length > MAX_FILES ? `\n- (+${disk.changed.length - MAX_FILES} more)` : ''));
  }
  if (disk.notLanded.length) {
    const rows = disk.notLanded.slice(0, MAX_FILES).map((c) => `- ${c.name}`);
    parts.push('A write was attempted on these and they are UNCHANGED — the edit did not land. '
      + `Do not assume it is in place:\n${rows.join('\n')}`);
  }

  // ---- WHAT THE PROJECT'S OWN RECORDS SAY ABOUT THAT DISK STATE ------------
  //
  // The two `.lain` sections: the reconciler's alarms (intent vs disk, measured
  // just now) and the architecture branch the changed files sit inside, with
  // its vocabulary and wiring. Both are '' for a project with no `.lain/`, and
  // the packet is then exactly what it was before the layer existed.
  const lain = lainSections(root, new Set([
    ...disk.changed.map((c) => c.name),
    ...disk.notLanded.map((c) => c.name),
  ]));
  if (lain.alarms) parts.push(lain.alarms);
  if (lain.branch) parts.push(lain.branch);

  // ---- FILES THE LEDGER BELIEVES CHANGED, THAT DISK DOES NOT CONFIRM ------
  //
  // Only when there is no checkpoint evidence at all. With checkpoints present
  // the section above is strictly better, and printing both would be the same
  // fact twice in two voices.
  const life = session.lifecycle;
  if (!checkpoints && life && life.evidence && life.evidence.filesChanged) {
    const files = [...life.evidence.filesChanged].slice(0, MAX_FILES).map((f) => rel(root, f));
    if (files.length) {
      parts.push(`Reported changed by the tools, NOT re-checked against disk:\n${files.map((f) => `- ${f}`).join('\n')}`);
    }
  }

  // ---- THE LAST CHECK THAT ACTUALLY RAN -----------------------------------
  //
  // An exit code, not a sentence. This is the section that most often
  // contradicts what the dead turn said about itself.
  if (life && life.lastCommand) {
    const c = life.lastCommand;
    parts.push(`Last check actually run: \`${String(c.command).slice(0, 120)}\` — `
      + `${c.ok ? 'PASSED' : `FAILED${c.exitCode != null ? ` (exit ${c.exitCode})` : ''}`}.`);
  } else {
    parts.push('No check has been run in this session yet — nothing here is verified by execution.');
  }

  // ---- WHAT THE PREVIOUS MODEL CLAIMED, IF IT IS NOT BORNE OUT ------------
  if (life && life.state && life.state !== 'ACTIVE' && life.state !== 'DONE') {
    parts.push(`This task is ${life.state}${life.reason ? `: ${life.reason}` : ''}. Resolve that before anything else.`);
  }

  // ---- THE PLAN, IF ONE IS BEING KEPT -------------------------------------
  //
  // Position from the plan's own status field, not prose: `completed` and
  // `remaining` are the same getters every other projection of the plan uses,
  // so the packet can never disagree with `/plan` about where the work stands.
  // DROPPED steps are counted, never listed — a step the session deliberately
  // abandoned is not work for the next entry to pick up.
  const plan = session.plan;
  if (plan && Array.isArray(plan.steps) && plan.steps.length) {
    const remaining = plan.remaining.map((s) =>
      `- ${String(s.text || s.title || '').replace(/\s+/g, ' ').slice(0, 120)}`).slice(0, MAX_STEPS);
    const dropped = plan.steps.filter((s) => s.status === 'dropped').length;
    parts.push(`Plan: ${plan.completed.length}/${plan.steps.length} steps done.`
      + (dropped ? ` ${dropped} dropped.` : '')
      + (remaining.length ? `\nStill outstanding:\n${remaining.join('\n')}` : ''));
  }

  // ---- WHAT THE DEAD TURN HAD ALREADY FOUND OUT ----------------------------
  //
  // Scratch, read at the exact moment it exists for: the turn died, so its
  // findings were never spent. THIS session's notes are the half-checked leads
  // the replacement would otherwise rediscover; OLDER orphans are whole other
  // sessions nobody came back for. Findings, not conclusions — each one says
  // what was observed, and the next model re-checks what matters.
  try {
    const scratch = require('./scratch');
    const mine = scratch.notes(root, session.id);
    if (mine.length) {
      const rows = mine.slice(-8).reverse().map((n) => `- ${n.text}${n.by ? `  [${n.by}]` : ''}`);
      parts.push(`The previous turn had already found (half-checked findings, its scratch):\n${rows.join('\n')}`);
    }
    const others = scratch.orphans(root, { exclude: session.id }).slice(-MAX_ORPHANS);
    for (const o of others) {
      const said = scratch.say(o);
      if (said) parts.push(said);
    }
  } catch { /* no .lain, or unreadable: fine */ }

  // ---- WHAT IS DURABLY TRUE ABOUT THIS PROJECT ----------------------------
  try {
    const mem = require('./memory');
    const groups = mem.grouped(root);
    const rows = [];
    for (const g of groups) {
      for (const it of g.items) {
        if (rows.length >= MAX_MEMORY) break;
        rows.push(`- ${g.kind}: ${String(it.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    if (rows.length) parts.push(`Runtime notes about this project (observations, not evidence-gated facts; do not re-derive):\n${rows.join('\n')}`);
  } catch { /* no store, or unreadable */ }
  // ---- AND WHAT SOMETHING ACTUALLY CHECKED ---------------------------------
  //
  // Distinct from the rows above on purpose: a promoted fact names the
  // EVIDENCE that established it, so the replacement can weigh it as an
  // observation rather than an opinion. Only the newest few — the packet is a
  // briefing, and `/lain` lists the rest.
  try {
    const facts = require('./scratch').facts(root).slice(-MAX_LAIN_FACTS);
    if (facts.length) {
      const rows = facts.map((f) => `- ${String(f.text).replace(/\s+/g, ' ').slice(0, 160)}`
        + `  [evidence: ${String(f.evidence || '').slice(0, 100)}]`);
      parts.push(`Checked facts about this project (each names what established it):\n${rows.join('\n')}`);
    }
  } catch { /* no .lain, or unreadable: fine */ }

  // ---- WORK THAT DID NOT DIE WITH THE PREVIOUS MODEL ----------------------
  //
  // The one section here whose facts come from OUTSIDE this process. A job
  // owned by the supervisor kept running while the model failed — and may have
  // finished while nothing was connected to hear it — so its state is neither
  // in the transcript nor in the session, and no amount of reading either would
  // recover it. Passed in rather than fetched, because building a handover must
  // stay synchronous and must never wait on a socket. See supervisor.js.
  const jobs = Array.isArray(opts.jobs) ? opts.jobs : [];
  if (jobs.length) {
    const rows = jobs.slice(0, MAX_JOBS).map((j) => {
      const bits = [`- ${j.id}: ${j.state}`];
      if (j.command) bits.push(`\`${String(j.command).slice(0, 80)}\``);
      if (j.exit_code !== null && j.exit_code !== undefined) bits.push(`exit ${j.exit_code}`);
      return bits.join(' ');
    });
    const unresolved = jobs.filter((j) => j.state === 'running' || j.state === 'unknown').length;
    parts.push(`Background work owned by the supervisor, NOT by the previous model:\n${rows.join('\n')}`
      + (unresolved
        ? '\nSome of these are still going or could not be collected — ask for their status before assuming either way.'
        : ''));
  }

  // ---- WHICH ROUTES ARE SHUT, AND UNTIL WHEN -------------------------------
  //
  // A handover is very often caused by exactly this — the previous model's
  // route was rate limited — so the replacement arrives on a machine where at
  // least one door is known to be closed, and it is the only section of the
  // packet whose facts can make a suggested next step impossible.
  //
  // OBSERVED, LIKE THE JOBS ABOVE, and from the same place. Availability lives
  // in a Map that dies with the process; these rows come from the supervisor,
  // so a limit stated three hours ago by a LAIN that has since exited is still
  // known here. Passed in rather than fetched, because building a packet stays
  // synchronous. See supervisor.providers() and app.refreshProviderHealth.
  const routes = Array.isArray(opts.providers) ? opts.providers : [];
  const shut = routes.filter((r) => r && (r.limited_now || r.status === 'DISABLED' || r.status === 'MAINTENANCE'));
  if (shut.length) {
    const rows = shut.slice(0, MAX_ROUTES).map((r) => {
      const who = [r.provider, r.id].filter(Boolean).join(' · ') || r.id;
      if (!r.limited_now) return `- ${who}: ${String(r.status).toLowerCase()}`;
      // NO INVENTED CLOCK. `resets_in_ms` is null when the provider never said
      // when, and saying "unknown reset" is the honest row — a made-up
      // countdown here would be a number the next model plans around.
      const left = r.resets_in_ms === null || r.resets_in_ms === undefined
        ? 'unknown reset'
        : `clears in ${require('./ratelimit').human(r.resets_in_ms)}`;
      return `- ${who}: rate limited, ${left}`;
    });
    parts.push('Routes that are closed right now — LAIN observed these, they are not the previous '
      + `model's report:\n${rows.join('\n')}\n`
      + 'Do not plan around a route in this list, and do not spend a turn rediscovering that it is shut.');
  }

  // ---- WHAT NOT TO DO AGAIN ------------------------------------------------
  //
  // The section that pays for the packet. Without it a replacement model starts
  // where any model starts — by finding out what the project is — and the whole
  // point of a handover is that this has already been done once.
  const seen = session.evidence && typeof session.evidence.digest === 'function'
    ? session.evidence.digest(MAX_INSPECTED)
    : '';
  if (seen) parts.push(seen);

  // ---- WHAT THE PERSON SAID THAT NEVER REACHED A MODEL ---------------------
  //
  // THE SECTION THIS WHOLE MECHANISM WAS BUILT FOR. The user typed something at
  // a runtime that could not deliver it, and it arrives here as the turn's
  // message as well — so this is not the text, it is the FRAME around it.
  //
  // The distinction it draws is the entire point. `continue` is INTENT: one
  // word, meaningless on its own, and the reason a replacement model used to
  // re-read a repository it had already been told about. It is not context, and
  // the context it appears to be missing is the eight sections above it.
  //
  // Timing is stated because it changes the reading. "Typed while the turn was
  // dying" and "typed after the failure was reported" are different requests
  // with the same words.
  const undelivered = rt && Array.isArray(rt.input) ? rt.input.filter((h) => h && h.text) : [];
  if (undelivered.length) {
    const rows = undelivered.slice(0, MAX_UNDELIVERED)
      .map((h) => `- "${String(h.text).replace(/\s+/g, ' ').slice(0, 300)}"`);
    parts.push(`The user typed this while the runtime could not deliver it${undelivered.length > 1
      ? `, ${undelivered.length} message(s), oldest first` : ''}:\n${rows.join('\n')}\n`
      + 'This is the INTENT of the request you are answering — it is not the context for it. '
      + 'The context is everything above. Interpret it against the verified state in this briefing, '
      + 'and do not re-run project orientation to work out what it refers to unless the evidence here '
      + 'genuinely does not answer it.');
  }
  // THE WORDING IS THE ONE workingContext ALREADY USED, deliberately. This
  // packet REPLACES that block on a handover turn, so the guarantee it carried —
  // continue, do not restart — has to survive the substitution verbatim rather
  // than be re-stated in words that happen to mean the same thing.
  parts.push('Continue this task from where it stopped — do not restart it, do not re-run project '
    + 'discovery, and do not re-inspect what is listed above. Re-verify anything the previous turn '
    + 'only claimed rather than inheriting it.');

  return parts.join('\n\n');
}

module.exports = { build, onDisk, RUNTIME_WHY, MAX_FILES, MAX_MEMORY, MAX_JOBS, MAX_ROUTES, MAX_UNDELIVERED };
