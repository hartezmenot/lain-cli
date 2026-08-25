'use strict';

/**
 * THE REPORT — PART 7 of the brief: human-readable, terminal, no dashboard.
 *
 * Rules baked into the formatting:
 *   - every number says where it came from (MEASURED / DERIVED / ESTIMATED);
 *   - UNKNOWN is printed as UNKNOWN, never as 0;
 *   - mock token figures are always labelled as accounting validation, never
 *     as provider cost;
 *   - instrumentation checks print expected vs actual, so a MISMATCH is a
 *     sentence about the detector, not a silent gap.
 */

const ms = (n) => (n == null ? 'UNKNOWN' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

function line(ch = '─', n = 74) { return ch.repeat(n); }

function classifyMark(ok) { return ok ? 'VERIFIED' : 'FAILED'; }

/** One task block. */
function taskBlock(r) {
  const t = r.task;
  const m = r.metrics;
  const out = [];
  out.push(` ${t.id.padEnd(3)} ${t.name}${t.live ? '' : '  (mock-only)'} ${'.'.repeat(Math.max(2, 46 - t.name.length - (t.live ? 0 : 11)))} ${classifyMark(r.outcome.ok)}`);
  out.push(`     ${t.cls} — ${t.purpose}`);
  if (!m) {
    // A run that died before writing a session has no records to project.
    // The failure is the finding; the report must still stand.
    out.push(`     metrics  NONE — the run left no session record (crashed, killed, or never started a turn)`);
    for (const chk of r.outcome.checks) out.push(`     ${chk.ok ? '✓' : '✗'} ${chk.name}`);
    if (r.stdoutTail) for (const l of r.stdoutTail.split('\n').slice(-6)) if (l.trim()) out.push(`       ${l.slice(0, 110)}`);
    return out.join('\n');
  }
  if (r.mode === 'mock' && r.instrumentation && !r.instrumentation.allMatch) {
    out.push(`     ⚠ INSTRUMENTATION MISMATCH — the planted numbers did not all come back out`);
  }
  out.push(`     llm      requests ${m.llm.providerRequests} (attempts ${m.llm.providerAttempts}, retries ${m.llm.retries}, refits ${m.llm.refits}) · steps ${m.llm.steps}`);
  if (m.mode === 'mock') {
    out.push(`     tokens   ${m.llm.inputTokens} in / ${m.llm.outputTokens} out — MOCK-SCRIPTED, accounting only, NOT provider cost`);
  } else {
    out.push(`     tokens   ${m.llm.inputTokens} in / ${m.llm.outputTokens} out / cache ${m.llm.cacheReadTokens} read + ${m.llm.cacheWriteTokens} written — MEASURED-PROVIDER${m.llm.unknownCacheReceipts ? ` (${m.llm.unknownCacheReceipts} receipts without cache figures)` : ''}`);
  }
  out.push(`     tools    ${m.tools.total} calls (${Object.entries(m.tools.byName).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'})${m.tools.duplicateToolCalls ? ` · DUPLICATE CALLS: ${m.tools.duplicateToolCalls}` : ''}`);
  const c = m.evidence.classification;
  out.push(`     evidence first ${c.firsts} · reuse ${c.reuse} · valid-recheck ${c.validRechecks} · stale ${c.staleInvalidations} · REDISCOVERY ${c.rediscoveries}`);
  if (m.evidence.redundantKeys && m.evidence.redundantKeys.length) {
    for (const k of m.evidence.redundantKeys) out.push(`              rediscovered: ${k}`);
  }
  out.push(`     edits    ${m.implementation.semanticEdits} semantic / ${m.implementation.textEdits} text over ${m.implementation.filesModified} file(s)`);
  out.push(`     tests    full-suite runs ${m.validation.fullTests} · targeted ${m.validation.targetedTests} · diagnostics ${m.validation.diagnosticsRuns === null ? `UNKNOWN (at least ${m.validation.diagnosticsAtLeast}, silent when clean)` : m.validation.diagnosticsRuns} · findings ${m.validation.diagnosticFindings}`);
  out.push(`     time     wall ${ms(m.time.wallMs)} · provider ${ms(m.time.providerMs)} · tools ${ms(m.time.toolMs)}`);
  if (m.context) {
    out.push(`     context  ~${m.context.total} tokens at the last request (ESTIMATED from characters) · cacheable prefix ~${m.context.cacheablePrefix}`);
  } else {
    out.push(`     context  UNKNOWN (no payload audit survived in the turn records)`);
  }
  for (const chk of r.outcome.checks) {
    out.push(`     ${chk.ok ? '✓' : '✗'} ${chk.name}${chk.ok || chk.detail == null ? '' : ` — ${chk.detail}`}`);
  }
  if (r.outcome.drifted && r.outcome.drifted.length) {
    out.push(`     ✗ PROTECTED FILES CHANGED BY THE RUN: ${r.outcome.drifted.join(', ')} — goalposts moved, run failed`);
  }
  if (r.instrumentation) {
    const rows = r.instrumentation.rows.map((x) => `       ${x.match ? '✓' : '✗ MISMATCH'} ${x.field}: expected ${x.expected}, measured ${x.actual}`).join('\n');
    out.push(`     instrumentation (planted vs measured): ${r.instrumentation.allMatch ? 'ALL MATCH' : 'SEE BELOW'}`);
    if (!r.instrumentation.allMatch) out.push(rows);
  }
  if (!r.outcome.ok && r.stdoutTail) {
    out.push(`     ── last output from the run ──`);
    for (const l of r.stdoutTail.split('\n').slice(-12)) if (l.trim()) out.push(`       ${l.slice(0, 110)}`);
  }
  return out.join('\n');
}

/** The aggregate block. */
function aggregateBlock(results, mode, wallMs) {
  const n = results.length;
  const ok = results.filter((r) => r.outcome.ok).length;
  const measured = results.filter((r) => r.metrics);
  const sum = (f) => measured.reduce((a, r) => a + (f(r.metrics) || 0), 0);
  const avgWall = measured.length ? sum((m) => m.time.wallMs) / measured.length : 0;
  const cls = {
    firsts: sum((m) => m.evidence.classification.firsts),
    reuse: sum((m) => m.evidence.classification.reuse),
    validRechecks: sum((m) => m.evidence.classification.validRechecks),
    staleInvalidations: sum((m) => m.evidence.classification.staleInvalidations),
    rediscoveries: sum((m) => m.evidence.classification.rediscoveries),
  };
  const inst = mode === 'mock' ? results.filter((r) => r.instrumentation && r.instrumentation.allMatch).length : null;
  const out = [];
  out.push(line('═'));
  out.push(` AGGREGATE — ${mode.toUpperCase()} MODE — ${n} task runs, ${ok} verified, ${n - ok} failed, ${n - measured.length} without records`);
  out.push(line());
  out.push(`   provider requests      ${sum((m) => m.llm.providerRequests)}   (attempts ${sum((m) => m.llm.providerAttempts)}, retries ${sum((m) => m.llm.retries)}, refits ${sum((m) => m.llm.refits)})`);
  out.push(`   model steps            ${sum((m) => m.llm.steps)}`);
  out.push(`   tool calls             ${sum((m) => m.tools.total)}   (duplicates ${sum((m) => m.tools.duplicateToolCalls)})`);
  out.push(`   evidence acquisitions  ${cls.firsts + cls.reuse + cls.validRechecks + cls.staleInvalidations + cls.rediscoveries}`);
  out.push(`     FIRST                ${cls.firsts}`);
  out.push(`     REUSE (ledger)       ${cls.reuse}`);
  out.push(`     VALID RECHECK        ${cls.validRechecks}   (legitimate — never waste)`);
  out.push(`     STALE INVALIDATION   ${cls.staleInvalidations}   (must be 0 in a hermetic fixture)`);
  out.push(`     REDISCOVERY          ${cls.rediscoveries}   (the waste the benchmark exists to count)`);
  out.push(`   full-suite test runs   ${sum((m) => m.validation.fullTests)}   (targeted ${sum((m) => m.validation.targetedTests)})`);
  out.push(`   edits                  ${sum((m) => m.implementation.semanticEdits)} semantic / ${sum((m) => m.implementation.textEdits)} text`);
  out.push(`   mean wall per task     ${ms(avgWall)}   (whole run ${ms(wallMs)})`);
  if (inst !== null) out.push(`   instrumentation        ${inst}/${n} tasks reproduced their planted numbers exactly`);
  out.push('');
  out.push(`   HONESTY NOTES`);
  out.push(`   - mock token figures validate ACCOUNTING ONLY; they are not provider cost${mode === 'mock' ? ' (this run is mock mode — no provider was contacted)' : ''}.`);
  out.push(`   - context figures are ESTIMATES from characters (tokenaudit CHARS_PER_TOKEN), not provider receipts.`);
  out.push(`   - diagnostics run count is UNKNOWN (silent when clean); only the at-least bound and any findings are reported.`);
  if (mode === 'mock') {
    out.push(`   - A2 is a WASTEFUL TWIN planted on purpose: its rediscoveries and duplicates are the detectors firing, not model behaviour.`);
    out.push(`   - D and F plant ledger REUSE deliberately: those must count as reuse, never as waste.`);
  }
  out.push(line('═'));
  return out.join('\n');
}

function renderReport(results, mode, wallMs) {
  return `\n${line('═')}\n LAIN CLI v2 — REPRESENTATIVE BENCHMARK BASELINE — ${new Date().toISOString()}\n ${mode === 'mock'
    ? 'MOCK MODE (deterministic; validates the measurement machinery, not intelligence)'
    : 'LIVE MODE (a real provider through the real CLI; opt-in)'}\n${line('═')}\n\n`
    + results.map(taskBlock).join('\n\n') + '\n\n'
    + aggregateBlock(results, mode, wallMs) + '\n';
}

module.exports = { renderReport, aggregateBlock, taskBlock };
