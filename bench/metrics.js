'use strict';

/**
 * METRICS — a projection of the records the run already produced.
 *
 * ------------------------------------------------------------------------
 * EVERY NUMBER NAMES ITS SOURCE, because the benchmark brief is explicit: a
 * measured figure, an estimate and an unknown must never be confused.
 *
 *   MEASURED  read straight out of a record the runtime wrote
 *             (turn record fields, reqtrace rows, the transcript itself)
 *   DERIVED   computed deterministically from measured records
 *             (counts and classifications over the transcript)
 *   ESTIMATED a character count divided by tokenaudit's CHARS_PER_TOKEN —
 *             labelled everywhere it appears; never a provider receipt
 *   UNKNOWN   the runtime does not record it; reported as null with a note,
 *             never guessed
 *
 * The one thing that needs saying loudest: in MOCK mode the token figures are
 * whatever the script said (100/20 by default). They validate that receipts
 * are COLLECTED and ACCOUNTED, and nothing else. Comparing them to provider
 * costs is forbidden by the brief and they are labelled to prevent it.
 */

const fs = require('fs');
const path = require('path');
const evidence = require('./evidence');

/** Edit-tool families, for classifying HOW the change was made. */
const SEMANTIC_EDITS = new Set(['replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol']);
const TEXT_EDITS = new Set(['edit_file', 'apply_patch', 'write_file', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file']);

/** Which tools count as test validation, and which of those are the whole suite. */
const TEST_TOOLS = new Set(['run_tests']);
const DISCOVERY_MARKERS = [
  /\nSYNTAX ERROR — /g,
  /\nUNRESOLVED NAMES? — /g,
];

/**
 * Read the session a run left behind.
 *
 * The session id is printed by one-shot mode (`session <id> · resume with:`);
 * parsing it is exact. Falling back to the newest file in the sessions dir is
 * the same thing one race later, and only ever sees this run's isolated home.
 */
function loadSession(configDir, stdout) {
  const dir = path.join(configDir, 'sessions');
  let id = null;
  const m = /session\s+([0-9a-z-]+)\s+·\s+resume with:/i.exec(String(stdout || ''));
  if (m) id = m[1];
  let file = id ? path.join(dir, `${id}.json`) : null;
  if (!file || !fs.existsSync(file)) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
        f, mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      })).sort((a, b) => b.mtime - a.mtime)
      : [];
    if (!files.length) return null;
    file = path.join(dir, files[0].f);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The request ledger this run appended, oldest first. */
function loadReqtrace(file) {
  if (!file || !fs.existsSync(file)) return [];
  return String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Tool calls with their results, paired, in conversation order. DERIVED. */
function callsOf(session) {
  const out = [];
  const messages = (session && Array.isArray(session.messages) ? session.messages : []);
  const results = new Map(messages.filter((m) => m.role === 'tool' && m.tool_call_id)
    .map((m) => [String(m.tool_call_id), m]));
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      let input = {};
      try { input = tc.arguments && String(tc.arguments).trim() ? JSON.parse(tc.arguments) : {}; } catch { input = {}; }
      out.push({ name: String(tc.name || ''), input, result: results.get(String(tc.id || '')) || null });
    }
  }
  return out;
}

/**
 * Collect the full metric block for one finished task run.
 *
 * @param {object} o
 *   session    the persisted session JSON (REQUIRED — the primary truth)
 *   reqtrace   reqtrace rows for this run (may be empty: the sink is opt-in)
 *   wallMs     measured by the runner around the child process
 *   mode       'mock' | 'live'
 *   turnsFrom  index of the first turn that belongs to THIS run — a resumed
 *              session carries its predecessor's turns, and the follow-up's
 *              numbers must be its own, not the sum of both. The transcript
 *              stays whole (evidence classification is over the conversation
 *              the model actually had); only the turn-derived sums are cut.
 */
function collect({ session, reqtrace = [], wallMs = null, mode = 'mock', turnsFrom = 0 } = {}) {
  const turns = (session && Array.isArray(session.turns) ? session.turns : []).slice(turnsFrom);
  const calls = callsOf(session);
  const okCalls = calls.filter((c) => c.result && !c.result.isError);
  const byName = {};
  for (const c of calls) byName[c.name] = (byName[c.name] || 0) + 1;

  // ---- LLM -----------------------------------------------------------------
  const usageTotals = turns.reduce((a, t) => {
    const u = (t && t.usage) || {};
    a.inputTokens += u.inputTokens || 0;
    a.outputTokens += u.outputTokens || 0;
    a.cacheReadTokens += u.cacheReadTokens || 0;
    a.cacheCreationTokens += u.cacheCreationTokens || 0;
    a.requests += u.requests || 0;
    return a;
  }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 });
  const withReceipt = reqtrace.filter((r) => r.receipt);
  const unknownCache = withReceipt.filter((r) => r.receipt.cacheReadTokens == null).length;

  // ---- EVIDENCE (DERIVED, via bench/evidence.js) ----------------------------
  const trace = evidence.traceFromSession(session);
  const dups = evidence.duplicateCalls(session);
  const fileReads = trace.events.filter((e) => e.tool === 'read_file');
  const uniqueFiles = new Set(fileReads.map((e) => e.key.replace(/^(file|range):/, '').split(':').slice(0, 1)[0].toLowerCase()));
  const symbolsInspected = trace.events.filter((e) => e.tool === 'read_symbol' || e.tool === 'locate').length;

  // ---- IMPLEMENTATION (DERIVED over the transcript) -------------------------
  const semanticEdits = okCalls.filter((c) => SEMANTIC_EDITS.has(c.name)).length;
  const textEdits = okCalls.filter((c) => TEXT_EDITS.has(c.name)).length;
  const filesModified = new Set(turns.flatMap((t) => (t && Array.isArray(t.mutations) ? t.mutations : []))
    .map((p) => String(p).toLowerCase()));

  // ---- VALIDATION -----------------------------------------------------------
  // Diagnostics/lint run automatically after every mutation but are SILENT when
  // clean, so the run count is not recoverable — only the findings they raised.
  const mutatedCalls = okCalls.filter((c) => (evidence.MUTATING.has(c.name)));
  const diagnosticFindings = okCalls.reduce((n, c) => {
    const text = String((c.result && c.result.content) || '');
    for (const re of DISCOVERY_MARKERS) n += (text.match(re) || []).length;
    return n;
  }, 0);
  let targetedTests = 0;
  let fullTests = 0;
  // Counted over ALL test-tool calls, not only successful ones: the run that
  // SHOWED the failure is a validation run too — it is how the model saw the
  // bug — and dropping it would make a bug-fix task look cheaper than it was.
  for (const c of calls.filter((t) => TEST_TOOLS.has(t.name))) {
    const which = String((c.input && c.input.which) || 'project');
    const command = String((c.input && c.input.command) || '');
    if (which === 'smoke' || /\.(test|spec)\.[cm]?js/.test(command)) targetedTests += 1;
    else fullTests += 1;
  }

  // ---- TIME -----------------------------------------------------------------
  const providerMs = reqtrace.reduce((a, r) => a + (r.ms || 0), 0);
  const toolMs = turns.reduce((a, t) => a + ((t && Array.isArray(t.actions)) ? t.actions.reduce((x, y) => x + (y.ms || 0), 0) : 0), 0);

  // ---- CONTEXT (ESTIMATED — from the payload audits the turns kept) ---------
  const audits = turns.flatMap((t) => (t && Array.isArray(t.audits)) ? t.audits : []);
  const last = audits[audits.length - 1] || null;
  const ctx = last ? {
    note: 'estimated from characters (tokenaudit CHARS_PER_TOKEN); source: the last request\'s payload audit',
    fixed: { system: last.estTokens.system, toolSchemas: last.estTokens.toolSchemas },
    task: {
      user: last.estTokens.user, assistant: last.estTokens.assistant,
      toolResults: last.estTokens.toolResults, other: last.estTokens.other,
    },
    total: last.estTokens.total,
    duplicateInOneRequest: last.estTokens.duplicate,
    cacheablePrefix: last.estTokens.stablePrefix,
    requestsMeasured: audits.length,
  } : null;

  // ---- AMPLIFICATION --------------------------------------------------------
  const steps = turns.reduce((a, t) => a + (t.steps || 0), 0);
  const retries = reqtrace.filter((r) => r.reason === 'transport-retry').length;
  const refits = reqtrace.filter((r) => r.reason === 'refit-after-fold').length;
  const toolCallsMeasured = turns.reduce((a, t) => a + (t.toolCalls || 0), 0);

  return {
    mode,
    llm: {
      providerRequests: usageTotals.requests,      // MEASURED (turn records)
      providerAttempts: reqtrace.length,            // MEASURED (request ledger)
      steps,                                        // MEASURED (turn records)
      retries,                                      // MEASURED (request ledger)
      refits,                                       // MEASURED (request ledger)
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      cacheReadTokens: usageTotals.cacheReadTokens,
      cacheWriteTokens: usageTotals.cacheCreationTokens,
      unknownCacheReceipts: unknownCache,
      tokenTruth: mode === 'mock' ? 'MOCK-SCRIPTED (validates accounting only; not provider cost)'
        : 'MEASURED-PROVIDER',
      countMismatch: reqtrace.length ? (reqtrace.length !== usageTotals.requests) : null,
    },
    tools: {
      total: toolCallsMeasured,                     // MEASURED (turn records)
      totalFromTranscript: calls.length,            // DERIVED (cross-check)
      byName,                                       // DERIVED
      duplicateToolCalls: dups.length,              // DERIVED
    },
    evidence: {
      filesRead: fileReads.length,
      uniqueFilesRead: uniqueFiles.size,
      duplicateFileReads: trace.events.filter((e) => e.tool === 'read_file' && e.class === 'REDISCOVERY').length,
      symbolsInspected,
      duplicateSymbolInspections: trace.events.filter((e) => e.tool === 'read_symbol' && e.class === 'REDISCOVERY').length,
      locatorCalls: byName.locate || 0,
      understandCalls: byName.understand || 0,
      // REDISCOVERY events already include repeated acquisition calls, so the
      // duplicate-call figures added here are only the ones the evidence
      // classifier does NOT see: identical non-acquisition calls (a second
      // run_tests with nothing in between, a repeated mutation). Adding the
      // raw duplicate count would count the same wasted call twice.
      repositoryRediscoveryEvents: trace.summary.rediscoveries
        + dups.filter((d) => !evidence.ACQUISITIONS.has(d.name)).length,
      ledgerReuse: turns.reduce((a, t) => a + (t.evidenceReuse || 0), 0),  // MEASURED
      classification: {
        firsts: trace.summary.firsts,
        reuse: trace.summary.reuse,
        validRechecks: trace.summary.validRechecks,
        staleInvalidations: trace.summary.staleInvalidations,
        rediscoveries: trace.summary.rediscoveries,
      },
      redundantKeys: (trace.summary.keysByClass.REDISCOVERY || []).slice(0, 12),
    },
    implementation: {
      filesModified: filesModified.size,
      semanticEdits,
      textEdits,
    },
    validation: {
      diagnosticsRuns: null,                        // UNKNOWN — silent when clean
      diagnosticsAtLeast: mutatedCalls.length,      // runs once per mutation
      diagnosticFindings,                           // MEASURED (raised findings)
      targetedTests,
      fullTests,
    },
    time: {
      wallMs,                                       // MEASURED by the runner
      providerMs,                                   // MEASURED (request ledger)
      toolMs,                                       // MEASURED (turn actions)
    },
    context: ctx,                                   // ESTIMATED (payload audits)
    amplification: {
      requestsPerTurn: turns.length ? usageTotals.requests / turns.length : null,
      retriesPerTask: retries,
      toolCallsPerTask: toolCallsMeasured,
    },
    trace: trace.events,
  };
}

module.exports = { collect, loadSession, loadReqtrace, callsOf, SEMANTIC_EDITS, TEXT_EDITS };
