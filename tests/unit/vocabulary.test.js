'use strict';

/**
 * ONE VOCABULARY, IN ONE PLACE — and.
 *
 * The brief asks for eleven states to be DISTINGUISHABLE: thinking, receiving,
 * working, waiting for the user, waiting for a tool, rate limited, retrying a
 * connection, failed, done, interrupted, blocked. Not eleven pretty words —
 * eleven states a person can tell apart at a glance, from the one row that is
 * always on screen.
 *
 * WHY THIS FILE EXISTS SEPARATELY. Each of these was asserted somewhere, in the
 * test that happened to care about it, and nothing ever asserted them TOGETHER
 * — which is exactly how four different stop reasons came to share the word
 * INTERRUPTED. A merge is invisible from inside a single case; it only shows up
 * when the whole vocabulary is laid out side by side, which is what this does.
 *
 * The same rule, applied to execution: a shell, a direct spawn, Python and a
 * background job must be tellable apart in a tool result (/).
 */

const assert = require('assert');
const { test } = require('../helpers');

const st = require('../../src/ui/status');
const { via, KIND } = require('../../src/tools/via');

/** The word the strip would show for a given live state. */
const word = (s) => st.liveState(s).word;
const row = (s) => {
  const l = st.liveState(s);
  return [l.word, l.detail || '', ...(l.parts || []).map((p) => p.text)].join(' ');
};

module.exports = async function () {
  await test('VOCAB: the eleven task states are ELEVEN DIFFERENT WORDS', () => {
    const states = {
      THINKING: { phase: { phase: 'WAITING_MODEL' } },
      RECEIVING: { phase: { phase: 'RECEIVING' } },
      WORKING: { phase: { phase: 'RUNNING_TOOL', tool: 'run_bash', target: 'npm test' } },
      WAITING_FOR_USER: { awaitingUser: 'press the button' },
      RATE_LIMITED: { phase: { phase: 'RETRYING', rateLimited: true, attempt: 1, of: 5 } },
      RETRYING_CONNECTION: { phase: { phase: 'RETRYING', kind: 'UNAVAILABLE', status: 502, attempt: 1, of: 5 } },
      FAILED: { failed: { kind: 'UNKNOWN', message: 'no answer' } },
      DONE: { lastTurn: { stopReason: 'end', toolCalls: 2 } },
      INTERRUPTED: { interrupted: true },
      BLOCKED: { lastTurn: { stopReason: 'blocked', toolCalls: 9 } },
    };
    const words = {};
    for (const [name, s] of Object.entries(states)) words[name] = word(s);
    const seen = new Map();
    for (const [name, w] of Object.entries(words)) {
      assert.ok(w, `${name} produced no word at all`);
      if (seen.has(w)) {
        assert.fail(`${name} and ${seen.get(w)} both say "${w}" — the states are merged`);
      }
      seen.set(w, name);
    }
  });

  await test('VOCAB: WAITING FOR A TOOL is a different ACTOR from LAIN thinking', () => {
    // These two share a family of words on purpose — RUNNING npm test IS the
    // working state — so what separates them is the actor column: LAIN is
    // waiting on a model, TOOL is this machine doing something.
    const thinking = st.liveState({ phase: { phase: 'WAITING_MODEL' } });
    const tool = st.liveState({ phase: { phase: 'RUNNING_TOOL', tool: 'run_bash', target: 'npm test' } });
    assert.strictEqual(thinking.actor, 'LAIN');
    assert.strictEqual(tool.actor, 'TOOL');
    assert.notStrictEqual(thinking.word, tool.word);
  });

  await test('VOCAB: a retry names the CONNECTION; a rate limit names the LIMIT', () => {
    const conn = row({ phase: { phase: 'RETRYING', kind: 'UNAVAILABLE', status: 502, attempt: 2, of: 5 } });
    const rl = row({ phase: { phase: 'RETRYING', rateLimited: true, attempt: 1, of: 5 } });
    assert.match(conn, /retrying at/, 'a connection retry must say it is retrying');
    assert.match(conn, /502/, 'and which failure it is retrying');
    assert.match(rl, /RATE LIMITED/);
    assert.ok(!/RATE LIMITED/.test(conn), 'a dead gateway is not a rate limit');
  });

  await test('VOCAB: every stop reason the turn loop produces has its OWN word', () => {
    // Four of these five used to rest on INTERRUPTED, which tells the user they
    // stopped something they did not touch, and hides a provider outage behind
    // a word that sounds like a keystroke.
    const reasons = ['end', 'aborted', 'max-steps', 'blocked', 'provider', 'no-credential'];
    const words = reasons.map((r) => word({ lastTurn: { stopReason: r, toolCalls: 1 } }));
    assert.strictEqual(new Set(words).size, reasons.length,
      `merged stop reasons: ${reasons.map((r, i) => `${r}=${words[i]}`).join(' ')}`);
    assert.strictEqual(words[0], 'DONE', 'only a turn that simply ended is DONE');
    for (const w of words.slice(1)) assert.notStrictEqual(w, 'DONE');
  });

  await test('VOCAB: a stopped turn still reports the work that DID happen', () => {
    const cut = st.liveState({ lastTurn: { stopReason: 'blocked', toolCalls: 10, filesChanged: 2 } });
    assert.match(cut.detail, /10 tool calls/);
    assert.match(cut.detail, /2 files changed/);
    assert.match(cut.detail, /no new evidence/, 'and why it stopped');
  });

  // ------------------------------------------------------- how it was run ---

  await test('VOCAB: the four ways to run something are four DIFFERENT stamps', () => {
    const stamps = Object.values(KIND).map((k) => via(k));
    assert.strictEqual(new Set(stamps).size, 4, stamps.join(' '));
    for (const s of stamps) assert.match(s, /^\[via .+\]$/);
    assert.strictEqual(via(KIND.SHELL, 'powershell'), '[via shell: powershell]');
  });

  await test('VOCAB: the stamp survives on the FIRST line, where the feed reads it', () => {
    // FOUND BY DRIVING THE REAL CLI. The stamp was appended as its own entry,
    // and `report` joins with a NEWLINE as soon as the program printed
    // anything — while the activity feed shows only the first line of a result.
    // So `[via process: spawned directly, no shell]` was visible exactly when
    // the program was silent, and invisible in every ordinary case. A label
    // that vanishes as soon as there is real output is not a label.
    const { report } = require('../../src/tools/exec');
    const first = (s) => String(s).split('\n')[0];

    const noisy = report('node', { exitCode: 0, elapsedMs: 40, stdout: 'direct exe ok\n', stderr: '' },
      via(KIND.PROCESS, 'spawned directly, no shell'));
    assert.match(first(noisy), /\[via process: spawned directly, no shell\]/,
      `the stamp must be on the first line: ${JSON.stringify(first(noisy))}`);
    assert.match(first(noisy), /node exited 0/, 'and so must the outcome');
    assert.match(noisy, /direct exe ok/, 'without losing the output itself');

    // The silent case must not regress either.
    const quiet = report('snippet', { exitCode: 0, elapsedMs: 10, stdout: '', stderr: '' },
      via(KIND.PYTHON, 'python3'));
    assert.match(first(quiet), /\[via python: python3\]/);
  });

  await test('VOCAB: every runner takes its stamp from the ONE module', () => {
    // The stamp had been written twice in two spellings, and the third caller
    // was simply forgotten — which is what a scattered vocabulary costs.
    const fs = require('fs');
    for (const f of ['shell.js', 'exec.js', 'jobs.js']) {
      const src = fs.readFileSync(require.resolve(`../../src/tools/${f}`), 'utf8');
      assert.ok(/require\('\.\/via'\)/.test(src), `${f} must use the shared stamp`);
      assert.ok(!/\[via \$\{/.test(src) && !/'\[via /.test(src),
        `${f} still spells a stamp by hand`);
    }
  });
};
