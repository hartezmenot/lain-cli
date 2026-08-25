'use strict';

/**
 * THE INVESTIGATION PACKET, AND THE BOUNDED RELAY AROUND IT.
 *
 * `/troubleshoot` already gathered local evidence and ran a LAIN turn. This is
 * the loop that puts a SECOND model in front of that work:
 *
 *     USER → LAIN local investigation → PACKET → EXTERNAL review
 *          → LAIN acts and verifies → updated PACKET → EXTERNAL review → …
 *
 * WHAT MAKES IT SAFE TO RUN AT ALL:
 *
 *   BOUNDED. `maxRounds` (default 3, hard cap 6). Every exit is named, and the
 *   reason is reported: verified fixed, still unresolved, you interrupted it,
 *   the round limit, the external model being unavailable, or a permission
 *   refusal. There is no path that loops.
 *
 *   ONE CONTROLLER. LAIN executes; the external model advises. The reviewer
 *   gets no tools (see external.js) and its RECOMMENDATION is handed to LAIN's
 *   ordinary turn loop as a request — the same path a typed instruction takes,
 *   with the same checkpoints, the same undo and the same verification.
 *
 *   NOTHING IS INVENTED. Every field of the packet is read from state that
 *   already exists: the session, the lifecycle, the checkpoints, the evidence
 *   ledger, the local scan. A field with nothing in it says so; the packet never
 *   fills a gap with a plausible sentence, because the whole point of showing it
 *   to a second model is that the second model can trust it.
 */

const path = require('path');

const external = require('./external');
const troubleshoot = require('./troubleshoot');
const actors = require('./actors');

/** Why a relay ended. Every exit has one, and it is always reported. */
const STOP = Object.freeze({
  FIXED: 'verified fixed',
  UNRESOLVED: 'verified unresolved',
  INTERRUPTED: 'you stopped it',
  ROUNDS: 'round limit reached',
  EXTERNAL_DOWN: 'the external model is unavailable',
  NOT_CONFIGURED: 'no external model is configured',
  DENIED: 'permission denied',
});

const MAX_LIST = 10;

/**
 * Everything the second investigator needs, and nothing it cannot verify.
 *
 * @param {App} app
 * @param {object} report   the troubleshoot report (problem + local evidence)
 * @param {object} state    { round, of, lastExternal }
 */
function buildPacket(app, report, { round = 1, of = 3, lastExternal = null } = {}) {
  const s = app.session;
  const life = s.lifecycle;
  const ev = report && report.evidence ? report.evidence : { hits: [], markers: [], terms: [] };

  const filesInspected = [];
  const commands = [];
  const failures = [];
  for (const turn of (s.turns || []).slice(-6)) {
    for (const a of turn.actions || []) {
      if (a.file && a.target && !filesInspected.includes(a.target)) filesInspected.push(a.target);
      if (/^run_/.test(a.name) && a.target) commands.push(`${a.target} — ${a.ok ? 'ok' : 'FAILED'}`);
      if (a.ok === false) failures.push(`${a.name} ${a.target || ''}: ${a.note || 'failed'}`.trim());
    }
    for (const e of turn.errors || []) failures.push(`${e.kind}: ${e.message}`);
  }

  let changed = [];
  try {
    changed = require('./ui/panes')
      .changedFiles({ checkpoints: app.checkpoints, cwd: s.cwd })
      .map((f) => `${f.rel} (+${f.added} -${f.removed})`);
  } catch { changed = []; }

  const unknowns = [];
  if (!ev.hits || !ev.hits.length) unknowns.push('no file in the tree matched the words in the problem');
  if (report && report.audit && !report.audit.entries.length) unknowns.push('no entry point was recognisable');
  if (!life || !life.lastCommand) unknowns.push('nothing has been run, so nothing is verified');
  for (const t of (ev.terms || [])) {
    if (!(ev.hits || []).some((h) => (h.matched || []).includes(t))) unknowns.push(`"${t}" appears nowhere in the source`);
  }

  const list = (label, rows, empty) => {
    const items = (rows || []).filter(Boolean).slice(0, MAX_LIST);
    return `${label}\n` + (items.length ? items.map((r) => `  - ${r}`).join('\n') : `  (${empty})`);
  };

  const verification = life && life.lastCommand
    ? `${life.lastCommand.command} — ${life.lastCommand.ok ? 'PASSED' : 'FAILED'}`
    : null;

  const hypothesis = lastExternal && lastExternal.sections && lastExternal.sections.hypothesis.length
    ? lastExternal.sections.hypothesis.join(' ')
    : null;

  return [
    `INVESTIGATION PACKET — round ${round} of ${of}`,
    '',
    `PROBLEM AS STATED BY THE USER`,
    `  ${String(report.problem || '').replace(/\s+/g, ' ')}`,
    '',
    `PROJECT`,
    `  path: ${s.cwd}`,
    `  name: ${path.basename(s.cwd)}`,
    report.audit && report.audit.languages ? `  languages: ${report.audit.languages.join(', ') || 'unknown'}` : null,
    '',
    `CURRENT TASK`,
    `  ${s.task ? String(s.task.objective).replace(/\s+/g, ' ') : '(none)'}`,
    `  lifecycle state: ${life ? life.state : 'none'}`,
    '',
    list('LOCAL SCAN — FILES MATCHING THE PROBLEM',
      (ev.hits || []).map((h) => `${h.file} — ${h.score} match(es): ${(h.matched || []).join(', ')}`),
      'nothing in the tree matched'),
    '',
    list('LOCAL SCAN — MARKERS FOUND',
      (ev.markers || []).map((m) => `${m.count} ${m.plain}`),
      'none of the tracked markers apply to this problem'),
    '',
    list('FILES INSPECTED SO FAR', filesInspected, 'none yet'),
    '',
    list('COMMANDS RUN SO FAR', commands, 'none yet'),
    '',
    list('FAILURES OBSERVED', failures, 'none observed'),
    '',
    list('CHANGES ALREADY MADE THIS SESSION', changed, 'nothing has been changed'),
    '',
    `VERIFICATION`,
    `  ${verification || '(nothing has been run, so nothing is verified)'}`,
    '',
    `CURRENT HYPOTHESIS`,
    `  ${hypothesis || '(none established yet)'}`,
    '',
    list('UNKNOWNS', unknowns, 'nothing outstanding that the scan could name'),
    '',
    lastExternal && lastExternal.ok ? `YOUR PREVIOUS RECOMMENDATION\n  ${lastExternal.sections.recommendation.join(' ') || '(none)'}` : null,
    lastExternal && lastExternal.ok ? '' : null,
    'WHAT IS ASKED OF YOU',
    '  Review the above. Do not claim to have inspected anything yourself.',
    '  Answer with FACT / EVIDENCE / HYPOTHESIS / RECOMMENDATION.',
  ].filter((x) => x !== null).join('\n');
}

/**
 * Did the round LAIN just ran actually settle it?
 *
 * The only evidence accepted is a command that RAN and PASSED after a change
 * was made. A model saying it is fixed is not evidence, and a green check with
 * nothing changed is not a fix either.
 */
function verdictAfterAction(app, changedBefore) {
  const life = app.session.lifecycle;
  const last = life && life.lastCommand;
  let changedNow = changedBefore;
  try {
    changedNow = require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }).length;
  } catch { /* keep the previous count */ }
  if (!last) return { settled: false, why: 'nothing was run, so nothing is verified' };
  if (!last.ok) return { settled: false, why: `${last.command} is still failing` };
  if (changedNow <= changedBefore) return { settled: false, why: `${last.command} passed, but nothing was changed` };
  return { settled: true, why: `${last.command} passed after ${changedNow - changedBefore} file(s) changed` };
}

/**
 * Run the relay. Returns the report, with `rounds` and a named `stop`.
 *
 * @param {App} app
 * @param {string} problem
 * @param {object} deps  { C, onPhase } — onPhase is the UI status hook
 */
/**
 * ASK EVERY CONFIGURED PROVIDER, THEN LET THE USER PICK.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. The relay asked ONE actor, pulled the RECOMMENDATION out
 * of its reply, and submitted an instruction of LAIN's own composition built
 * around it. Three things were wrong with that and they compound:
 *
 *   · there was never more than one answer, so there was nothing to choose
 *   · the external model's words never reached the user
 *   · what LAIN acted on was LAIN's paraphrase, not the answer
 *
 * Here the answers are shown, the user picks one (or both), and the CHOSEN
 * TEXT becomes the next input — the user's own, not a wrapper around it.
 * ------------------------------------------------------------------------
 *
 * Returns null when no panel is configured, so the single-actor path below is
 * untouched for anyone who has not set one up.
 */
async function panelRound(app, packet, { images = [], C = null } = {}) {
  const col = C || { dim: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s };
  const w = (s) => app.render.write(s);
  const panel = require('./externalpanel');
  const blocks = require('./ui/blocks');
  const providers = panel.providersFrom(app.cfg);
  if (!providers.length) return null;

  const width = (app.render && app.render.width) || 80;
  const say = (rows) => w(rows.join('\n') + '\n');

  // ---- ONE VISUAL LANGUAGE, shared with every other action LAIN takes ----
  //
  // Not bespoke markup for the external flow: these are the same primitives
  // the rest of the interface uses (ui/blocks.js), so agent activity looks
  // like agent activity wherever it happens.
  w('\n');
  say(blocks.actionBlock(`Ask ${providers.join(' and ')} for a second opinion`, {
    width,
    detail: images.length ? `${images.length} image(s) attached` : null,
  }));
  const result = await panel.ask(app, packet, { images, session: app.session });

  // EVERY CALL IS REPORTED, answered or not. A provider that failed is named
  // with its real reason rather than being quietly absent from the choices.
  for (const c of result.calls) {
    w('\n');
    say(blocks.toolBlock(`browser → ${c.provider}`, {
      width,
      ok: c.answered,
      status: c.answered
        ? `${c.state} · ${c.response.length} chars${c.continued ? ' · same conversation' : ''}`
        : `${c.state}`,
      detail: c.answered ? null : c.error,
    }));
  }
  if (!result.answered.length) {
    w('\n');
    say(blocks.failureBlock(`EXTERNAL: ${result.overall}`, 'Nothing was captured. The local investigation stands.',
      { width }));
    return { ...result, chosen: null, text: null };
  }

  const options = panel.choicesFrom(result.calls);
  w('\n');
  say(blocks.externalChoiceBlock(options, { width, question: 'Choose which answer to continue with:' }));
  let chosen = options[0];
  if (app.ui && app.ui.enabled && options.length > 1) {
    // THE ONE QUESTION SURFACE — ui/answer.js's panel, the same one every other
    // choice in LAIN uses. A second picker is what this project removed once.
    const picked = await app.ui.askUser({
      question: 'Which external answer should become your next input?',
      options: options.map((o) => ({ label: o.label, value: o.id })),
    });
    chosen = options.find((o) => o.id === picked) || null;
  }
  if (!chosen) {
    panel.settle(result.calls, null);
    w('\n');
    say(blocks.contextBlock('No answer was taken. Every reply was recorded as DISCARDED.',
      { width, title: 'DISCARDED' }));
    return { ...result, chosen: null, text: null };
  }
  panel.settle(result.calls, chosen.id);
  // WHAT WAS CHOSEN AND WHAT BECOMES OF IT, said out loud — otherwise the next
  // thing that happens is LAIN working on something the user never typed, which
  // reads as the system quietly rewriting their input.
  w('\n');
  say(blocks.selectedBlock(chosen.provider, { width, becameInput: true }));
  return { ...result, chosen, text: chosen.text };
}

async function relay(app, problem, { C = null, maxRounds = null } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s, bold: (s) => s };
  const w = (s) => app.render.write(s);
  const cfg = external.settings(app.cfg);
  const of = Math.max(1, Math.min(6, Number(maxRounds) || cfg.maxRounds));

  // THE USER'S PROBLEM IS THE TASK. The relay drives the turn loop itself, so
  // no turn ever carried the problem statement — and the first thing LAIN
  // submitted was its OWN instruction ("a second model recommends this next
  // step…"), which then became the task in the banner. The user's words were
  // replaced by LAIN's, in the one place that is supposed to say what they
  // asked for. Established here, before any round, using the ordinary
  // classifier; no turn is run by this.
  if (!app.session.task) app.identify(problem, false, 'TROUBLESHOOT');

  // ROUND 0 — the local scan, before anything is asked of anyone.
  const report = await troubleshoot.begin(app, problem);
  report.rounds = [];
  report.external = { model: null, connection: null };
  w('\n');
  for (const l of troubleshoot.reportLines(report, app.render.width)) w(l + '\n');

  // WHO IS REVIEWING — an ACTOR, not a model id. See actors.js: a model LAIN
  // reaches itself, a browser page the user drives, or a person with the packet
  // on their clipboard. The relay below is identical for all of them, because
  // the only thing that differs is how the packet TRAVELS; LAIN still executes
  // and the reviewer still only advises.
  const actor = actors.create(app);
  const st = actor ? actor.status() : null;
  if (!actor || !st.ok) {
    const why = actor ? st.why : (cfg.why || 'NOT CONFIGURED');
    report.stop = /NOT CONFIGURED/.test(why) ? STOP.NOT_CONFIGURED : STOP.EXTERNAL_DOWN;
    report.stopDetail = why;
    w('\n' + col.yellow('  EXTERNAL ACTOR') + '\n');
    w(col.yellow(`  ✕ ${why}`) + col.dim(' — continuing with local troubleshooting only.\n'));
    w(col.dim('  /external to choose one. Nothing was sent anywhere.\n'));
    return report;
  }
  report.external = {
    actor: st.kind,
    automated: st.automated,
    model: st.model || st.label,
    connection: st.connection || null,
  };

  let changedBefore = 0;
  try { changedBefore = require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }).length; } catch { changedBefore = 0; }
  let last = null;

  for (let round = 1; round <= of; round++) {
    if (app.wantExit) { report.stop = STOP.INTERRUPTED; break; }

    // ---- EXTERNAL REVIEW ---------------------------------------------------
    const packet = buildPacket(app, report, { round, of, lastExternal: last });
    w('\n' + col.dim(`  ── round ${round}/${of} ──────────────────────────────`) + '\n');

    // ---- THE PANEL PATH, when more than one provider is configured --------
    //
    // Tried first and returns null when there is no panel, so the original
    // single-actor path below is reached unchanged for an existing setup.
    const panelled = await panelRound(app, packet, { C: col });
    if (panelled) {
      report.rounds.push({ round, packetChars: packet.length, panel: panelled.calls.map((c) => c.summary()) });
      report.external = { ...report.external, panel: panelled.providers, state: panelled.overall };
      if (!panelled.text) {
        report.stop = STOP.EXTERNAL_DOWN;
        report.stopDetail = `no external answer was used (${panelled.overall})`;
        break;
      }
      // THE CHOSEN ANSWER BECOMES THE USER'S NEXT INPUT — verbatim, not wrapped
      // in an instruction of LAIN's. That is the whole point of asking.
      w('\n  ' + col.bold('LAIN') + col.dim(`  continuing from ${panelled.chosen.provider}…`) + '\n');
      const rec = await app.submit(panelled.text, { forceMode: 'TROUBLESHOOT', sameTask: true });
      troubleshoot.conclude(app, rec);
      if (rec && rec.stopReason === 'aborted') { report.stop = STOP.INTERRUPTED; break; }
      const verdict = verdictAfterAction(app, changedBefore);
      w('  ' + (verdict.settled ? col.green('✓ ') : col.yellow('· ')) + col.dim(verdict.why) + '\n');
      if (verdict.settled) { report.stop = STOP.FIXED; report.stopDetail = verdict.why; break; }
      report.stopDetail = verdict.why;
      if (round >= of) { report.stop = STOP.ROUNDS; break; }
      continue;
    }
    w('  ' + col.bold('EXTERNAL') + col.dim(`  ${report.external.model} · reviewing the investigation…`) + '\n');

    // A controller of our own, so Ctrl+C reaches the external request too — a
    // wait the user cannot cancel is a hang however good the reason for it.
    app.abort = new AbortController();
    let analysis;
    try {
      // send THEN receive. For an API actor the two are one request; for a
      // browser or a human they are separated by however long reading takes,
      // and `handOver` is what tells the user the packet has left and what to
      // do with it. Hiding that behind one call would make the manual case look
      // automated, which is the one thing this must never do.
      const handed = await actor.send(packet);
      handOver(app, actor, handed, { C: col });
      analysis = handed && handed.ok === false
        ? handed
        : await actor.receive({
          signal: app.abort.signal,
          onStatus: app.ui && app.ui.enabled ? (p) => app.ui.setPhase(p) : null,
        });
    } finally {
      const cancelled = Boolean(app.abort && app.abort.signal.aborted);
      app.abort = null;
      if (app.ui && app.ui.enabled) app.ui.setPhase(null);
      if (cancelled) { report.stop = STOP.INTERRUPTED; }
    }
    if (report.stop) break;

    if (!analysis.ok) {
      report.stop = STOP.EXTERNAL_DOWN;
      report.stopDetail = analysis.error;
      w(col.yellow(`  ✕ external review failed: ${analysis.error}`) + col.dim(' — the local investigation stands.\n'));
      break;
    }

    report.rounds.push({ round, packetChars: packet.length, analysis });
    writeAnalysis(app, analysis, { C: col });
    last = analysis;

    if (round >= of) { report.stop = STOP.ROUNDS; break; }

    // ---- LAIN ACTS ---------------------------------------------------------
    const rec = analysis.sections.recommendation.join(' ').trim();
    if (!rec) {
      report.stop = STOP.UNRESOLVED;
      report.stopDetail = 'the external model recommended no next action';
      break;
    }
    w('\n  ' + col.bold('LAIN') + col.dim('  acting on the recommendation…') + '\n');
    const record = await app.submit(
      `A second model reviewed the investigation and recommends this next step:\n\n${rec}\n\n`
      + 'Carry it out if you agree with it, using your own judgement and your own tools. '
      + 'If you disagree, say why and do what the evidence supports instead. '
      + 'Then run something that would fail if the problem were still there, and report the real result.',
      // The SAME task: this is LAIN acting on a review of the user's problem,
      // not a new request. Without this the banner showed LAIN's own prompt
      // back to the user and the relay's earlier rounds were cleared from
      // Context as belonging to a previous task.
      { forceMode: 'TROUBLESHOOT', sameTask: true },
    );
    troubleshoot.conclude(app, record);

    if (record && record.stopReason === 'aborted') { report.stop = STOP.INTERRUPTED; break; }

    const v = verdictAfterAction(app, changedBefore);
    w('  ' + (v.settled ? col.green('✓ ') : col.yellow('· ')) + col.dim(v.why) + '\n');
    if (v.settled) { report.stop = STOP.FIXED; report.stopDetail = v.why; break; }
    report.stopDetail = v.why;
  }

  if (!report.stop) report.stop = STOP.ROUNDS;
  if (report.stop === STOP.ROUNDS && !report.stopDetail) report.stopDetail = 'the rounds ran out before it was settled';

  w('\n');
  for (const l of troubleshoot.reportLines(report, app.render.width)) w(l + '\n');
  const good = report.stop === STOP.FIXED;
  w('\n  ' + (good ? col.green(`✓ STOPPED — ${report.stop}`) : col.yellow(`· STOPPED — ${report.stop}`))
    + (report.stopDetail ? col.dim(`: ${report.stopDetail}`) : '') + '\n');
  w(col.dim('  The full tool log is in the ACTIVITY view. /copy troubleshoot takes this report.\n'));
  return report;
}

/**
 * THE PACKET HAS LEFT — say where it went and what is now expected of whom.
 *
 * For an API actor this is one dim line, because nothing is expected of the
 * user. For a browser or a human it is the whole interaction: the packet is on
 * the clipboard, the page is open, and LAIN is now WAITING for a person. A
 * manual step that is not announced is a hang.
 */
function handOver(app, actor, handed, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s };
  const w = (s) => app.render.write(s);
  if (!handed) return;
  if (!handed.ok) { w('  ' + col.yellow(`✕ ${handed.error}`) + '\n'); return; }
  if (handed.delivered === 'api') return;                 // nothing is asked of the user

  if (handed.delivered === 'clipboard') w('  ' + col.green('✓ ') + col.dim('the packet is on your clipboard\n'));
  else if (handed.delivered === 'file') {
    w('  ' + col.yellow(`clipboard unavailable (${handed.why})`) + col.dim(` — the packet is at\n    ${handed.file}\n`));
  }
  if (handed.url) {
    w(handed.opened
      ? col.dim(`  opened ${handed.url}\n`)
      : col.yellow(`  could not open ${handed.url}`) + col.dim(` (${handed.openError}) — open it yourself\n`));
    // SAID OUT LOUD, because the alternative is a user who believes LAIN is
    // reading the page. It is not, it cannot, and nothing here tries.
    w(col.dim('  LAIN does not read that page. Paste the packet in, then paste the reply back here.\n'));
  } else {
    w(col.dim('  Paste it to your reviewer, then paste the reply back here.\n'));
  }
  w(col.dim('  Ask for FACT / EVIDENCE / HYPOTHESIS / RECOMMENDATION. Esc or Ctrl+C cancels the wait.\n'));
  if (app.ui && app.ui.enabled) app.ui.setPhase({ phase: 'EXTERNAL', actor: 'EXTERNAL', word: 'AWAITING YOUR PASTE' });
}

/** One external analysis, labelled so it can never read as LAIN's own finding. */
function writeAnalysis(app, a, { C } = {}) {
  const col = C || { dim: (s) => s, bold: (s) => s, yellow: (s) => s };
  const w = (s) => app.render.write(s);
  const section = (label, rows) => {
    if (!rows || !rows.length) return;
    w('    ' + col.bold(label) + '\n');
    for (const l of rows.slice(0, 8)) w('      ' + String(l).slice(0, 400) + '\n');
  };
  // INTO THE STORY, not just the log. The reviewer's own words belong in
  // Context under the EXTERNAL label, in magenta, so "which model said this"
  // is answerable at a glance. Without this it arrived as unlabelled dim
  // transcript text and read as leftover logging.
  if (app.ui && app.ui.enabled) {
    const say = [
      a.sections.fact.length ? 'FACT: ' + a.sections.fact.join(' ') : '',
      a.sections.hypothesis.length ? 'HYPOTHESIS: ' + a.sections.hypothesis.join(' ') : '',
      a.sections.recommendation.length ? 'RECOMMENDATION: ' + a.sections.recommendation.join(' ') : '',
    ].filter(Boolean);
    for (const line of (say.length ? say : a.sections.rest.slice(0, 3))) app.ui.noteActor('external', line);
  }
  section('FACT', a.sections.fact);
  section('EVIDENCE', a.sections.evidence);
  section('HYPOTHESIS', a.sections.hypothesis);
  section('RECOMMENDATION', a.sections.recommendation);
  if (!a.sections.fact.length && !a.sections.recommendation.length && a.sections.rest.length) {
    // It answered without using the headings. Show what it said rather than
    // silently dropping it, and do not pretend it was structured.
    section('(unstructured reply)', a.sections.rest);
  }
  if (a.overclaim) {
    // The external model has no tools here. A sentence claiming otherwise is
    // reported, not passed through as though something had happened.
    w('    ' + col.yellow(`⚠ the external model wrote "${a.overclaim}" — it has no tools here and ran nothing`) + '\n');
  }
}

module.exports = { relay, buildPacket, verdictAfterAction, writeAnalysis, handOver, STOP };
