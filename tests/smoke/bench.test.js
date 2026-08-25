'use strict';

/**
 * THE BENCHMARK ITSELF, UNDER SMOKE.
 *
 * The benchmark's whole value is that its numbers REPRODUCE. Two properties
 * are pinned here, through the real runner:
 *
 *   1. MOCK DETERMINISM — the same scripted task, run twice, yields the same
 *      metric core (requests, tools, classifications). Wall time and token
 *      estimates are excluded: they are labelled non-deterministic or
 *      estimated in every report, and pinning them would be pinning noise.
 *
 *   2. FAILURE STILL MEASURES — a run killed before it finishes must leave a
 *      report entry with a FAILED verdict, not a crashed benchmark. Partial
 *      truth beats no truth, and the fallback path is a code path like any
 *      other: untested means broken.
 *
 * The full 8-task suite is not run here — `node bench/run.js` is the
 * benchmark's own entry point, and the smoke tier would double its cost on
 * every suite pass. What runs is the smallest set that proves the machinery
 * reproduces.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const { collect, loadSession, callsOf } = require('../../bench/metrics');
const { traceFromSession, duplicateCalls } = require('../../bench/evidence');

const ROOT = path.join(__dirname, '..', '..');

/** The reproducible core of a run's metrics. */
function metricCore(session) {
  const m = collect({ session, mode: 'mock' });
  const t = traceFromSession(session);
  return JSON.stringify({
    requests: m.llm.providerRequests,
    steps: m.llm.steps,
    tools: m.tools.total,
    byName: m.tools.byName,
    duplicates: duplicateCalls(session).length,
    classification: t.summary,
    mutations: m.implementation.filesModified,
    semanticEdits: m.implementation.semanticEdits,
    fullTests: m.validation.fullTests,
  });
}

async function runBench(args) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bench', 'run.js'), ...args],
      { cwd: ROOT, timeout: 240000, maxBuffer: 32 * 1024 * 1024 },
      (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/** The session JSON of the newest run directory for one task. */
function newestSession(taskId) {
  const base = path.join(ROOT, 'bench', 'out');
  const runs = fs.readdirSync(base).filter((d) => d.startsWith('run-mock-')).sort();
  assert.ok(runs.length, 'a benchmark run directory exists');
  const dir = path.join(base, runs[runs.length - 1], taskId.toLowerCase(), 'home', 'sessions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length, `a session was saved for task ${taskId}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

module.exports = async function () {
  await test('BENCH: a scripted task reproduces its metric core exactly, run to run', async () => {
    const a = await runBench(['--task', 'A', '--quiet']);
    assert.strictEqual(a.code, 0, `runner exited 0 (stderr: ${a.stderr.slice(0, 400)})`);
    const first = newestSession('a');
    const b = await runBench(['--task', 'A', '--quiet']);
    assert.strictEqual(b.code, 0);
    const second = newestSession('a');
    assert.notStrictEqual(first.id, second.id, 'two separate runs, not one read twice');
    assert.strictEqual(metricCore(first), metricCore(second));
  });

  await test('BENCH: the wasteful twin is counted as waste, and only as waste that exists', async () => {
    const r = await runBench(['--task', 'A2', '--quiet']);
    assert.strictEqual(r.code, 0, `A2 is green end to end (stderr: ${r.stderr.slice(0, 400)})`);
    const s = newestSession('a2');
    const t = traceFromSession(s);
    assert.strictEqual(t.summary.rediscoveries, 2, 'the two planted re-acquisitions were counted');
    assert.strictEqual(t.summary.staleInvalidations, 0, 'no false invalidation was raised');
    assert.strictEqual(duplicateCalls(s).length, 3, 'the planted duplicate calls were counted');
    // And the baseline JSON agrees with the records it was projected from.
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'out', 'baseline-mock.json'), 'utf8'));
    const a2 = baseline.tasks.find((x) => x.id === 'A2');
    assert.ok(a2, 'A2 is in the baseline');
    assert.ok(a2.instrumentation && a2.instrumentation.allMatch, 'planted numbers came back out');
    assert.strictEqual(a2.metrics.tools.total, callsOf(s).length, 'reported tool calls equal the transcript');
  });

  await test('BENCH: a run that dies before saving still reports as a failed task, not a crash', async () => {
    // The worst case for the reporting path is a run with NO records at all —
    // killed before a turn, no session saved. The renderer must say FAILED
    // with a metrics-free entry, and the aggregate must tolerate it, because
    // partial truth is the contract and a crash in the reporter loses it.
    const { renderReport } = require('../../bench/report');
    const killed = {
      task: { id: 'X', name: 'KILLED RUN', cls: 'failure', purpose: 'died before any record', live: true },
      mode: 'mock',
      outcome: { ok: false, drifted: [], checks: [{ name: 'the run produced no session record', ok: false }] },
      metrics: null,
      instrumentation: null,
      stdoutTail: '',
      run: { wallMs: 12, exitCode: null, sessionId: null, fixtureDir: 'bench/out/x', resetVerified: true },
    };
    const report = renderReport([killed], 'mock', 12);
    assert.match(report, /KILLED RUN/);
    assert.match(report, /FAILED/);
    assert.match(report, /NONE — the run left no session record/);
    assert.match(report, /1 without records/);
    assert.doesNotThrow(() => renderReport([killed, killed], 'mock', 0), 'the aggregate sums over recordless runs without throwing');
  });
};
