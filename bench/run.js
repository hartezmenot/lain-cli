'use strict';

/**
 * THE RUNNER.
 *
 *   node bench/run.js                 mock mode (default, deterministic, required)
 *   node bench/run.js --live          live mode (explicit opt-in; also LAIN_BENCH_LIVE=1)
 *   node bench/run.js --task A,C,E,F  a subset
 *   node bench/run.js --quiet         metrics + verdicts only, no per-task checks
 *
 * ------------------------------------------------------------------------
 * HOW A RUN WORKS. For every task: copy the pristine version-controlled
 * fixture (bench/fixture) into a fresh working directory, apply the task's
 * deterministic scenario if it has one, hash the goalpost files, spawn the
 * REAL BINARY (`lain -p "<prompt>"`) through the same isolated-home harness
 * the smoke tier uses, then project the metrics out of the records the run
 * itself left behind (the persisted session + the opt-in request ledger).
 * Nothing about the task is measured by watching the process; everything is
 * read from what it wrote.
 *
 * MOCK runs replay a scripted tool sequence against the real tool layer and
 * validate the MEASUREMENT against numbers planted on purpose. LIVE runs
 * contact a real provider through the real CLI and produce the actual
 * baseline; they are opt-in because they cost money and are not
 * reproducible, and the benchmark must never require them.
 *
 * The follow-up task F resumes E's session in E's working copy — the same
 * config home, the same fixture directory, `--resume <E's session>` — so the
 * only difference between E and F is the evidence the conversation already
 * holds. F's numbers are scoped to F's own turns; its evidence trace is
 * classified over the whole conversation, because that is what the model
 * actually had.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runCli } = require('../tests/helpers');
const { TASKS, FIXTURE, helpers } = require('./tasks');
const { collect, loadSession, loadReqtrace, callsOf } = require('./metrics');
const { traceFromSession, duplicateCalls } = require('./evidence');
const { renderReport } = require('./report');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'bench', 'out');
const LIVE_BASE = process.env.LAIN_LIVE_BASE_URL || 'http://127.0.0.1:20128/v1';

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const wantsLive = argv.includes('--live') || process.env.LAIN_BENCH_LIVE === '1';
const mode = wantsLive ? 'live' : 'mock';
const only = argv.includes('--task') ? argv[argv.indexOf('--task') + 1].split(',').map((s) => s.trim().toUpperCase()) : null;
const quiet = argv.includes('--quiet');

const TIMEOUT = { mock: 120000, live: 600000 }[mode];

// ------------------------------------------------------------- helpers ----
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Copy the pristine fixture and PROVE the copy is byte-identical: the reset
 *  guarantee is a measured property here, not an assumption. */
function resetFixture(dest) {
  fs.cpSync(FIXTURE, dest, { recursive: true });
  const mismatches = [];
  const walk = (rel) => {
    const src = path.join(FIXTURE, rel);
    const dst = path.join(dest, rel);
    if (fs.statSync(src).isDirectory()) {
      for (const e of fs.readdirSync(src)) walk(path.join(rel, e));
      return;
    }
    if (!fs.existsSync(dst) || sha(src) !== sha(dst)) mismatches.push(rel);
  };
  for (const e of fs.readdirSync(FIXTURE)) walk(e);
  return { ok: mismatches.length === 0, mismatches };
}

/** Everything a run produced, scoped to THIS task's turns and calls. */
function scopedMetrics({ session, reqtrace, wallMs, turnsFrom, callsFrom }) {
  const m = collect({ session, reqtrace, wallMs, mode, turnsFrom });
  // Evidence classification runs over the WHOLE conversation (that is the
  // context the model had), then the report keeps only this run's events —
  // for a fresh session that is everything; for the follow-up it is the
  // acquisitions this run made.
  const trace = traceFromSession(session);
  const events = trace.events.filter((e) => e.idx >= (callsFrom || 0));
  const counts = { FIRST: 'firsts', REUSE: 'reuse', VALID_RECHECK: 'validRechecks', STALE_INVALIDATION: 'staleInvalidations', REDISCOVERY: 'rediscoveries' };
  const classification = { firsts: 0, reuse: 0, validRechecks: 0, staleInvalidations: 0, rediscoveries: 0 };
  const redundantKeys = [];
  for (const e of events) {
    classification[counts[e.class]] += 1;
    if (e.class === 'REDISCOVERY') redundantKeys.push(`${e.tool} ${e.key}`);
  }
  const fileEvents = events.filter((e) => e.tool === 'read_file');
  const uniq = new Set(fileEvents.map((e) => e.key.replace(/^(file|range):/, '').split(':')[0].toLowerCase()));
  m.evidence.filesRead = fileEvents.length;
  m.evidence.uniqueFilesRead = uniq.size;
  m.evidence.duplicateFileReads = fileEvents.filter((e) => e.class === 'REDISCOVERY').length;
  m.evidence.symbolsInspected = events.filter((e) => e.tool === 'read_symbol' || e.tool === 'locate').length;
  m.evidence.duplicateSymbolInspections = events.filter((e) => e.tool === 'read_symbol' && e.class === 'REDISCOVERY').length;
  m.evidence.classification = classification;
  m.evidence.redundantKeys = redundantKeys.slice(0, 12);
  // Duplicate CALLS, likewise scoped to this run.
  const dups = duplicateCalls(session).filter((d) => d.idx >= (callsFrom || 0));
  m.tools.duplicateToolCalls = dups.length;
  const scopedCalls = callsOf(session).slice(callsFrom || 0);
  m.tools.totalFromTranscript = scopedCalls.length;
  const byName = {};
  for (const c of scopedCalls) byName[c.name] = (byName[c.name] || 0) + 1;
  m.tools.byName = byName;
  // Implementation, likewise: a resumed session's earlier edits belong to the
  // predecessor's numbers, not this run's.
  const scopedOk = scopedCalls.filter((c) => c.result && !c.result.isError);
  m.implementation.semanticEdits = scopedOk.filter((c) => c.name === 'replace_symbol' || c.name === 'insert_near_symbol' || c.name === 'remove_symbol' || c.name === 'rename_symbol').length;
  m.implementation.textEdits = scopedOk.filter((c) => c.name === 'edit_file' || c.name === 'apply_patch' || c.name === 'write_file' || c.name === 'append_file' || c.name === 'insert_at' || c.name === 'delete_range' || c.name === 'move_file' || c.name === 'delete_file').length;
  // And validation: every run_tests call this run made, passing or failing.
  let full = 0; let targeted = 0;
  for (const c of scopedCalls.filter((x) => x.name === 'run_tests')) {
    const which = String((c.input && c.input.which) || 'project');
    const command = String((c.input && c.input.command) || '');
    if (which === 'smoke' || /\.(test|spec)\.[cm]?js/.test(command)) targeted += 1; else full += 1;
  }
  m.validation.fullTests = full;
  m.validation.targetedTests = targeted;
  m.trace = events;
  return m;
}

/** Compare a mock run's measured metrics against the numbers it planted. */
const EXPECT_PATHS = {
  requests: (m) => m.llm.providerRequests,
  attempts: (m) => m.llm.providerAttempts,
  steps: (m) => m.llm.steps,
  toolCalls: (m) => m.tools.total,
  rediscoveries: (m) => m.evidence.classification.rediscoveries,
  duplicates: (m) => m.tools.duplicateToolCalls,
  semanticEdits: (m) => m.implementation.semanticEdits,
  textEdits: (m) => m.implementation.textEdits,
  fullTests: (m) => m.validation.fullTests,
  ledgerReuse: (m) => m.evidence.ledgerReuse,
  reuseClass: (m) => m.evidence.classification.reuse,
  validRechecks: (m) => m.evidence.classification.validRechecks,
  retries: (m) => m.llm.retries,
};

function instrumentationCheck(task, metrics) {
  const rows = Object.entries(task.expect || {})
    .filter(([k]) => EXPECT_PATHS[k])
    .map(([k, expected]) => {
      const actual = EXPECT_PATHS[k](metrics);
      return { field: k, expected, actual, match: actual === expected };
    });
  return { rows, allMatch: rows.every((r) => r.match) };
}

// ------------------------------------------------------------ live setup ----
async function probeLive() {
  for (let i = 0; i < 3; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(`${LIVE_BASE}/models`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
      if (ids.length) return ids;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

// ---------------------------------------------------------------- main ----
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(OUT_ROOT, `run-${mode}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  let liveModel = null;
  if (mode === 'live') {
    const ids = await probeLive();
    if (!ids) {
      process.stderr.write(`live mode requested but no provider is reachable at ${LIVE_BASE}\n`
        + `point LAIN_LIVE_BASE_URL at a bridge, or run without --live for the mock baseline\n`);
      process.exitCode = 2;
      return;
    }
    liveModel = ids.find((m) => /mini|flash|fast/i.test(m)) || ids[0];
    process.stdout.write(`live provider at ${LIVE_BASE} — model ${liveModel}\n`);
  }

  const suite = TASKS.filter((t) => (only ? only.includes(t.id) : true))
    .filter((t) => mode === 'live' ? t.live !== false : true);
  if (suite.some((t) => t.followUpOf && !suite.some((o) => o.id === t.followUpOf))) {
    process.stderr.write('the follow-up task (F) needs its predecessor (E) in the same run\n');
    process.exitCode = 2;
    return;
  }

  const results = [];
  const carried = {};   // id -> { configDir, fixtureDir, sessionId, turnCount, callCount }
  const t0 = Date.now();

  for (const task of suite) {
    const isFollowUp = Boolean(task.followUpOf);
    const prev = isFollowUp ? carried[task.followUpOf] : null;
    if (isFollowUp && !prev) throw new Error(`task ${task.id} needs ${task.followUpOf} to have run first`);

    const fixtureDir = isFollowUp ? prev.fixtureDir : path.join(outDir, task.id.toLowerCase(), 'fixture');
    const configDir = isFollowUp ? prev.configDir : path.join(outDir, task.id.toLowerCase(), 'home');
    if (!isFollowUp) fs.mkdirSync(path.dirname(fixtureDir), { recursive: true });

    // ---- reset (a carried fixture is NOT reset: the follow-up's whole point
    // is the state its predecessor left behind) ----
    let reset = { ok: true, mismatches: [], note: isFollowUp ? 'carried from E by design' : '' };
    if (!isFollowUp) reset = resetFixture(fixtureDir);

    // ---- scenario + goalposts ----
    let protectedHashes = null;
    if (task.scenario) {
      const r = task.scenario(fixtureDir);
      protectedHashes = new Map(r.protect.map((f) => [f, sha(f)]));
    }

    // ---- live wiring (mock wiring arrives via runCli's script option) ----
    if (mode === 'live') {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
        model: liveModel,
        connection: 'live',
        maxSteps: 40,
        trustedPaths: [{ path: fixtureDir, level: 'TRUSTED', at: new Date().toISOString() }],
        connections: { live: { provider: 'live-bridge', via: 'bridge', protocol: 'chat', baseUrl: LIVE_BASE, models: [liveModel] } },
      }, null, 2), 'utf8');
    }

    const reqtraceFile = path.join(outDir, task.id.toLowerCase(), `reqtrace-${mode}.jsonl`);
    fs.mkdirSync(path.dirname(reqtraceFile), { recursive: true });
    const args = isFollowUp ? ['--resume', prev.sessionId, '-p', task.prompt] : ['-p', task.prompt];

    const tStart = Date.now();
    const run = await runCli(args, {
      cwd: fixtureDir,
      configDir,
      ...(mode === 'mock' ? { script: task.mockScript } : {}),
      env: { LAIN_REQTRACE: reqtraceFile },
      timeoutMs: TIMEOUT,
    });
    const wallMs = Date.now() - tStart;

    // ---- the records the run left behind ----
    const session = loadSession(configDir, run.stdout);
    const reqtrace = loadReqtrace(reqtraceFile);

    // ---- ground truth ----
    // A verifier that throws is a finding about the verifier, not a reason to
    // lose the run: the brief requires that a failing task still produce its
    // partial metrics, so the crash is caught and reported as a failed check.
    let outcome = { ok: false, checks: [{ name: 'the run produced no session record', ok: false }], drifted: [] };
    if (session) {
      try {
        outcome = task.verify(fixtureDir);
      } catch (e) {
        outcome = { ok: false, drifted: [], checks: [{ name: 'verifier threw', ok: false, detail: String(e && e.message) }] };
      }
      outcome.drifted = outcome.drifted || [];
      if (protectedHashes) {
        for (const [f, h] of protectedHashes) {
          if (sha(f) !== h) outcome.drifted.push(path.relative(fixtureDir, f));
        }
        if (outcome.drifted.length) outcome.ok = false;
      }
    }
    if (!reset.ok) {
      outcome.ok = false;
      outcome.checks.push({ name: 'fixture copy was byte-identical at reset', ok: false, detail: reset.mismatches.join(', ') });
    }

    // ---- metrics ----
    let metrics = null;
    let instrumentation = null;
    if (session) {
      metrics = scopedMetrics({
        session,
        reqtrace,
        wallMs,
        turnsFrom: isFollowUp ? prev.turnCount : 0,
        callsFrom: isFollowUp ? prev.callCount : 0,
      });
      if (mode === 'mock') instrumentation = instrumentationCheck(task, metrics);
      // Carry the state a follow-up needs — captured NOW, before any later
      // task appends to this session.
      carried[task.id] = {
        configDir,
        fixtureDir,
        sessionId: session.id,
        turnCount: (session.turns || []).length,
        callCount: callsOf(session).length,
      };
    }

    results.push({
      task: { id: task.id, name: task.name, cls: task.cls, purpose: task.purpose, live: task.live !== false },
      mode,
      outcome,
      metrics,
      instrumentation,
      stdoutTail: !outcome.ok ? String(run.stdout || run.out || '').slice(-2000) : '',
      run: {
        wallMs, exitCode: run.code, sessionId: session && session.id,
        fixtureDir: path.relative(ROOT, fixtureDir), resetVerified: reset.ok,
      },
    });

    const flag = outcome.ok ? 'VERIFIED' : 'FAILED';
    process.stdout.write(`  ${task.id} ${task.name}: ${flag}${instrumentation ? (instrumentation.allMatch ? ' · instrumentation MATCH' : ' · instrumentation MISMATCH') : ''}\n`);
  }

  const wallMs = Date.now() - t0;

  // ---- the report ----
  const report = renderReport(results, mode, wallMs);
  if (!quiet) process.stdout.write(report);

  const jsonFile = path.join(OUT_ROOT, `baseline-${mode}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({
    mode, stamp, liveModel, wallMs,
    tasks: results.map((r) => ({
      id: r.task.id, name: r.task.name, cls: r.task.cls,
      outcome: r.outcome, metrics: r.metrics, instrumentation: r.instrumentation, run: r.run,
    })),
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.txt'), report, 'utf8');
  process.stdout.write(`\n  raw records : ${path.relative(ROOT, outDir)}\n`);
  process.stdout.write(`  json        : ${path.relative(ROOT, jsonFile)}\n`);

  const failed = results.filter((r) => !r.outcome.ok).length;
  const mismatched = results.filter((r) => r.instrumentation && !r.instrumentation.allMatch).length;
  process.exitCode = (failed || mismatched) ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`bench: ${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
});
