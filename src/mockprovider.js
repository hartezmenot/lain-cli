'use strict';

/**
 * A SCRIPTED PROVIDER, for testing the real binary.
 *
 * This exists for one reason: rule 26 requires smoke tests that launch the
 * actual executable, and a real provider makes those tests slow, non-hermetic,
 * credential-dependent and expensive. This double replaces the NETWORK CALL and
 * nothing else — the binary, argv parsing, REPL, session, turn loop, tool
 * dispatch, filesystem and shell tools, rendering and error handling are all
 * the real thing.
 *
 * A run using this is LIVE CLI VERIFIED. It is never LIVE PROVIDER VERIFIED.
 *
 * Script format — LAIN_MOCK_SCRIPT points at a JSON array; each element is one
 * model response, consumed in order:
 *
 *   { "text": "hello" }
 *   { "text": "reading it", "tool_calls": [ { "name": "read_file",
 *                                             "input": { "path": "a.txt" } } ] }
 *   { "error": { "status": 503, "message": "upstream down" } }
 *   { "error": { "code": "ECONNREFUSED" } }
 *   { "text": "slow", "delayMs": 800 }        the provider took a while
 *
 * Running past the end of the script yields a plain closing message, so a loop
 * that takes more steps than expected terminates instead of hanging.
 */

const fs = require('fs');

// Per-PROCESS cursor. Each smoke test spawns its own binary, so this is the
// natural lifetime; within one process, multi-turn scripts sequence across
// turns in call order. It is test-double state, not application state, and no
// App instance reads it.
//
// A NOTE ON LEAKS, because two wrong fixes lived here briefly: a turn leaked
// from an earlier test CAN consume a later test's steps, and keying cursors by
// conversation text both broke multi-turn sequencing and misfired on reused
// input texts (measured: 12 integration failures). The correct place to stop a
// leaked turn is where it tries to reach the provider: turn.js refuses to admit
// a request for an aborted turn, cancelled at the boundary. Tests that leave
// slow turns alive must wait for them — the harness's contract, not the mock's.
let cursor = 0;
let script = null;

function loadScript() {
  if (script) return script;
  const p = process.env.LAIN_MOCK_SCRIPT;
  if (!p) { script = []; return script; }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    script = Array.isArray(data) ? data : [];
  } catch (e) {
    process.stderr.write(`lain: mock script unreadable (${p}): ${e.message}\n`);
    script = [];
  }
  return script;
}

async function* chat(pc, messages, opts = {}) {
  // MEASUREMENT SEAM. `LAIN_MOCK_WIRELOG` appends one line per request with the
  // size of the payload that was actually about to be sent. That number is the
  // only honest answer to "did context management change anything" — the
  // persisted session is measured after the fact, and the request is the thing
  // a provider accepts or refuses.
  if (process.env.LAIN_MOCK_WIRELOG) {
    const chars = messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
    try { fs.appendFileSync(process.env.LAIN_MOCK_WIRELOG, `${messages.length}\t${chars}\n`); } catch { /* measurement must never break a run */ }
  }
  const steps = loadScript();
  const step = steps[cursor];
  cursor++;

  if (!step) {
    yield { type: 'text', chunk: 'Nothing further to do.' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    return;
  }

  // ---- A PROVIDER THAT TAKES TIME -------------------------------------
  //
  // `{ "delayMs": 800 }` holds the response open. Every other field scripts
  // WHAT the model said; this scripts that saying it was not instantaneous,
  // which is the one property a test of NON-BLOCKING behaviour needs and the
  // only way to get it without spawning a process and depending on a shell.
  //
  // IT HONOURS THE SIGNAL, so a cancelled turn unwinds here immediately rather
  // than sitting out its delay — which is also what makes cancellation
  // observable at a known point. No polling: one timer, one abort listener.
  if (step.delayMs > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, step.delayMs);
      const sig = opts && opts.signal;
      if (!sig) return;
      if (sig.aborted) { clearTimeout(t); resolve(); return; }
      sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (opts && opts.signal && opts.signal.aborted) return;
  }

  if (step.error) {
    const e = new Error(step.error.message || step.error.code || 'mock provider failure');
    if (step.error.status) e.status = step.error.status;
    if (step.error.code) e.code = step.error.code;
    if (step.error.retryAfter) e.retryAfter = step.error.retryAfter;
    throw e;
  }

  // A REASONING-ONLY RESPONSE, which is what a real route did and what left
  // Context empty. `{ "reasoning": "..." }` with no `text` reproduces it
  // exactly: the model produced prose, and none of it in `content`.
  if (typeof step.reasoning === 'string' && step.reasoning) {
    for (const part of step.reasoning.match(/\S+\s*|\s+/g) || [step.reasoning]) {
      if (opts.signal && opts.signal.aborted) break;
      yield { type: 'reasoning', chunk: part };
    }
  }

  if (typeof step.text === 'string' && step.text) {
    // Stream in chunks so the renderer's streaming path is genuinely exercised.
    for (const part of step.text.match(/\S+\s*|\s+/g) || [step.text]) {
      if (opts.signal && opts.signal.aborted) break;
      yield { type: 'text', chunk: part };
    }
  }

  if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
    yield {
      type: 'tool_calls',
      calls: step.tool_calls.map((c, i) => ({
        id: c.id || `mock_${cursor}_${i}`,
        name: String(c.name || ''),
        input: c.input && typeof c.input === 'object' ? c.input : {},
      })),
    };
  }

  yield {
    type: 'usage',
    inputTokens: step.inputTokens || 100,
    outputTokens: step.outputTokens || 20,
  };
}

/** Test hook — resets the cursor within one process. */
function _reset() { cursor = 0; script = null; }

module.exports = { chat, _reset };
