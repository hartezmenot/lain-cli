'use strict';

/**
 * WHAT SURVIVED — compaction and resume, said out loud.
 *
 * Both of these silently rewrite the thing the model is about to read, and both
 * used to report only their own mechanics: "elided 40k chars", "resumed abc123
 * — 214 messages". Neither answers the question the user actually has, which is
 * whether the work is still intact.
 *
 * THE RULE HERE IS THE HARD ONE: never claim something was preserved without
 * looking. Each line below is a check against the session as it now stands, and
 * a thing that is not there reads as not there. "✓ decisions preserved" printed
 * unconditionally is worse than silence — it is a reassurance that survives
 * exactly until the model contradicts it.
 *
 * In particular, a restored TRANSCRIPT is not a restored context. The messages
 * always come back; the objective, the corrections the user made, the files
 * already changed and the state of the last check are separate facts, and this
 * says which of them really did.
 */

const path = require('path');

/** `189k` — sizes at the scale a person reads them. */
function k(n) {
  return `${Math.round((Number(n) || 0) / 1000)}k`;
}

/**
 * What a compaction just did, and what it kept.
 *
 * @param {Session} session  AFTER the compaction
 * @param {object}  fit      the compact() result — { before, after, elided }
 * @returns {{ headline: string, kept: string[] }}
 */
function compactionSummary(session, fit = {}) {
  const kept = [];
  const task = session && session.task;
  const life = session && session.lifecycle;

  if (task && task.objective) kept.push('the objective');
  // The user's own corrections are the one thing that cannot be recovered by
  // re-reading the repository, so they are named first and by count.
  const steers = (task && Array.isArray(task.steers) && task.steers.length) || 0;
  if (steers) kept.push(`${steers} correction${steers === 1 ? '' : 's'} you made`);
  const plan = session && session.plan;
  if (plan && plan.steps && plan.steps.length) {
    kept.push(`the plan (${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} done)`);
  }
  if (life && life.evidence) {
    const files = [...(life.evidence.filesChanged || [])];
    if (files.length) kept.push(`${files.length} changed file${files.length === 1 ? '' : 's'}`);
    if (life.lastCommand) kept.push(`the last check (${life.lastCommand.ok ? 'passed' : 'FAILED'})`);
  }

  const headline = `CONTEXT COMPACTION  ${k(fit.before)} → ${k(fit.after)} chars`;
  return { headline, kept };
}

/**
 * What a resume genuinely restored, and what it could not.
 *
 * @returns {Array<{ok: boolean, text: string}>}
 */
function resumeSummary(session, app = null) {
  const out = [];
  const task = session && session.task;
  const life = session && session.lifecycle;
  const plan = session && session.plan;

  const say = (ok, text) => out.push({ ok, text });

  say(true, `${(session.messages || []).length} messages, ${(session.turns || []).length} turns`);
  if (task && task.objective) say(true, `objective: ${String(task.objective).replace(/\s+/g, ' ').slice(0, 70)}`);
  else say(false, 'no objective was recorded — this session had no active task');

  const steers = (task && Array.isArray(task.steers) && task.steers.length) || 0;
  if (steers) say(true, `${steers} correction${steers === 1 ? '' : 's'} you made, still overriding the original request`);
  else say(false, 'no corrections recorded');

  if (plan && plan.steps && plan.steps.length) {
    say(true, `plan: ${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} steps done`);
  } else say(false, 'no plan — this session did not use one');

  const files = life && life.evidence ? [...(life.evidence.filesChanged || [])] : [];
  if (files.length) say(true, `files changed: ${files.slice(0, 4).map((f) => path.basename(f)).join(', ')}${files.length > 4 ? ` +${files.length - 4}` : ''}`);
  else say(false, 'no files were changed in that session');

  if (life && life.lastCommand) {
    say(life.lastCommand.ok, `last check: ${life.lastCommand.command} — ${life.lastCommand.ok ? 'passed' : 'FAILED, and it is still red'}`);
  } else say(false, 'no check had been run, so nothing is verified');

  // ---- WHAT ELSE THIS SESSION HAD IN FLIGHT --------------------------------
  //
  // The conclusions of a troubleshooting relay, and whether anything holds
  // desktop permission, are exactly the things a person would otherwise have to
  // rediscover — and the second is a safety fact, not a convenience. Both are
  // read from the LIVE app rather than the saved session: a bridge grant cannot
  // survive a restart by design, so saying "it is gone" is the true answer.
  if (!app) return out;

  // (A TROUBLESHOOTING-RELAY SECTION stood here — which round the external
  // reviewer had reached, its last recommendation, and why the relay stopped.
  // Its only writer was investigation.relay, which went with `/external` in this
  // pass and had been unreachable before that. Nothing set `app._troubleshoot`
  // any more, so the section could only ever report the absence of a thing that
  // could not happen.)

  try {
    // WHICH MODEL ANSWERS A CHAT TURN — a session fact, and one a person
    // resuming needs: a session that was consulting ChatGPT.com and comes back
    // silently answering from LAIN's runtime would attribute the change to
    // nobody. Read from the registry rather than from a config key, because the
    // selection is per session. Coding is unaffected and is not claimed here.
    const reg = require('./modelsource/registry');
    const src = reg.selectedId(app);
    const model = ((app.session && app.session.sourceSelections) || {})[src] || null;
    const web = reg.usingWeb(app);
    say(!web || Boolean(model), web
      ? `chat source: ${reg.LABEL[src]}${model ? ` · ${model}` : ' — no model chosen yet'}`
      : 'chat source: LAIN\'s own runtime');
  } catch { /* the registry is unreadable — say nothing rather than guess */ }

  try {
    const d = app.desktop().bridge.status();
    const active = d.permissions && d.permissions.active;
    say(!active, active
      ? `desktop permission is GRANTED right now${d.target ? ` for ${d.target}` : ''} — /mcp revoke ends it`
      : 'desktop permission: nothing granted (a restart always clears it)');
  } catch { /* no bridge — nothing to say */ }

  return out;
}

/** Render either summary through a renderer. Shared so both look alike. */
function writeRows(app, rows, { C } = {}) {
  const col = C || { green: (s) => s, dim: (s) => s, yellow: (s) => s };
  for (const r of rows) {
    app.render.write((r.ok ? col.green('  ✓ ') : col.dim('  · ')) + (r.ok ? r.text : col.dim(r.text)) + '\n');
  }
}

module.exports = { compactionSummary, resumeSummary, writeRows, k };
