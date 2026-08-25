'use strict';

/**
 * THE REQUEST BOUNDARY — the wire half, against the real loop and supervisor.
 *
 * requestboundary.test.js proves what the RUNTIME can do. This file proves the
 * other half of the contract, the one that was parked for a whole pass because
 * wiring it reproducibly broke a parked question:
 *
 *   1. A provider call cannot happen through the turn path without the runtime
 *      having FIRST admitted it — proved by reading the runtime's own state
 *      from inside a wrapped provider call and finding the open request id.
 *   2. A Guardian denial means the provider is NOT CALLED AT ALL — zero wire
 *      calls, a turn that ends with the runtime's own reason.
 *   3. A retry is a REQUEST, not a turn: three wire attempts, three distinct
 *      runtime-issued request ids, one turn.
 *
 * THE PARKED REGRESSION, and why this file exists to guard its fix: the first
 * wiring waited out the supervisor BOOT WINDOW inside admission, so a turn's
 * first request could stall for seconds and a background job parked on its
 * question far later than anything waiting on it expected. The fix — a booting
 * runtime is not a request authority — is asserted here by running a turn with
 * NO supervisor up and proving the question parks immediately (case 4).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const supervisor = require('../../src/supervisor');
const guardian = require('../../src/guardian');

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-reqadm-'));
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  guardian.forgetLocal();
  try {
    return await fn(home);
  } finally {
    try { await supervisor.shutdown(); } catch { /* never started */ }
    guardian.forgetLocal();
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

/** Drive a turn to its end and collect the record. */
async function drain(gen) {
  let record = null;
  for await (const ev of gen) if (ev.type === 'done') record = ev.record;
  return record;
}

/**
 * Wrap provider.chat so every real wire call records what the RUNTIME believed
 * at the moment of the call. `guardian.state` joins the session's ordered
 * chain, so what it returns is what has already landed — an empty open_request
 * here means the provider was invoked without admission.
 */
function instrumentProvider(seen) {
  const provider = require('../../src/provider');
  const orig = provider.chat;
  provider.chat = async function* patched(...args) {
    let open = '';
    try {
      const st = await guardian.state(seen.session);
      open = (st && st.open_request) || '';
    } catch { /* no supervisor: the degraded case is case 4's business */ }
    seen.calls.push({ open });
    yield* orig.apply(provider, args);
  };
  return () => { provider.chat = orig; };
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('REQADM: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  await test('REQADM: the provider wire is unreachable without admission landing first', async () => {
    await withHome(async (home) => {
      await supervisor.ensure();
      const { Session } = require('../../src/session');
      const { runTurn } = require('../../src/turn');
      const script = path.join(home, 's.json');
      fs.writeFileSync(script, JSON.stringify([{ text: 'Done.' }]), 'utf8');
      process.env.LAIN_PROVIDER = 'mock';
      require('../../src/mockprovider')._reset();
      process.env.LAIN_MOCK_SCRIPT = script;
      try {
        const s = new Session({ cwd: home });
        const seen = { session: s.id, calls: [] };
        const restore = instrumentProvider(seen);
        try {
          const record = await drain(runTurn(s, 'go', { cfg: {} }));
          assert.strictEqual(record.stopReason, 'end');
          assert.strictEqual(seen.calls.length, 1, 'exactly one wire call');
          assert.match(seen.calls[0].open, /^rq-/,
            'the runtime had an OPEN request id at the moment the provider was invoked');
          const st = await guardian.state(s.id);
          assert.strictEqual(st.open_request, '', 'and it was closed when the request ended');
        } finally { restore(); }
      } finally {
        delete process.env.LAIN_MOCK_SCRIPT;
        delete process.env.LAIN_PROVIDER;
      }
    });
  });

  await test('REQADM: a Guardian denial never reaches the provider — zero wire calls', async () => {
    await withHome(async (home) => {
      await supervisor.ensure();
      // A route the DURABLE store knows is limited, with a stated future reset —
      // the one limit request_begin refuses on, and the runtime's own evidence.
      await supervisor.noteProvider({
        connectionId: 'mock', ok: false, kind: 'RATE_LIMITED',
        reason: 'seeded for the denial proof', resetAt: Date.now() + 60 * 60 * 1000,
      });
      const { Session } = require('../../src/session');
      const { runTurn } = require('../../src/turn');
      const script = path.join(home, 's.json');
      fs.writeFileSync(script, JSON.stringify([{ text: 'never reached' }]), 'utf8');
      process.env.LAIN_PROVIDER = 'mock';
      require('../../src/mockprovider')._reset();
      process.env.LAIN_MOCK_SCRIPT = script;
      try {
        const s = new Session({ cwd: home });
        const seen = { session: s.id, calls: [] };
        const restore = instrumentProvider(seen);
        try {
          const record = await drain(runTurn(s, 'go', { cfg: {} }));
          assert.strictEqual(seen.calls.length, 0,
            'a denied request must mean the provider is not called at all');
          assert.strictEqual(record.stopReason, 'provider');
          assert.strictEqual(record.providerFailure.kind, 'ROUTE_SHUT',
            'the runtime\'s own word for the refusal');
          assert.match(record.providerFailure.message, /mock is rate limited/);
          assert.strictEqual(record.usage.requests, 0, 'and nothing was billed as a request');
        } finally { restore(); }
      } finally {
        delete process.env.LAIN_MOCK_SCRIPT;
        delete process.env.LAIN_PROVIDER;
      }
    });
  });

  await test('REQADM: a retry is a REQUEST, not a turn — three attempts, three ids, one turn', async () => {
    await withHome(async (home) => {
      await supervisor.ensure();
      const { Session } = require('../../src/session');
      const { runTurn } = require('../../src/turn');
      const fail = { error: { status: 502, message: 'Bad Gateway' } };
      const script = path.join(home, 's.json');
      fs.writeFileSync(script, JSON.stringify([fail, fail, { text: 'Recovered.' }]), 'utf8');
      process.env.LAIN_PROVIDER = 'mock';
      require('../../src/mockprovider')._reset();
      process.env.LAIN_MOCK_SCRIPT = script;
      try {
        const s = new Session({ cwd: home });
        const seen = { session: s.id, calls: [] };
        const restore = instrumentProvider(seen);
        try {
          const record = await drain(runTurn(s, 'go', { cfg: {} }));
          assert.strictEqual(record.stopReason, 'end', 'the turn recovered after its retries');
          assert.strictEqual(seen.calls.length, 3, 'three real wire attempts');
          const ids = seen.calls.map((c) => c.open);
          for (const id of ids) assert.match(id, /^rq-/, 'every attempt was admitted');
          assert.strictEqual(new Set(ids).size, 3,
            'each retry is its own request lifecycle with its own runtime-issued id');
          assert.strictEqual(record.usage.requests, 3, 'and counted as three requests');
          const st = await guardian.state(s.id);
          assert.strictEqual(st.open_request, '', 'nothing left open');
          // ONE TURN over three requests: the turn did not restart between them
          // — record.steps is 1, the retries re-entered the same step.
          assert.strictEqual(record.steps, 1, 'retries are not fake turns');
        } finally { restore(); }
      } finally {
        delete process.env.LAIN_MOCK_SCRIPT;
        delete process.env.LAIN_PROVIDER;
      }
    });
  });

  await test('REQADM: with no runtime up, admission degrades instantly and a question parks on time', async () => {
    // THE PARKED REGRESSION, AS A TEST. The first wiring waited out the
    // supervisor boot window inside admission, so the first request of a turn
    // could stall for seconds — and a background job parked on its question
    // far later than the moment anything waiting for it expected. The fix is
    // that a booting runtime is not a request authority; this asserts the
    // timing property directly, with no supervisor and wake() armed.
    await withHome(async (home) => {
      const { App } = require('../../src/app');
      const script = path.join(home, 's.json');
      fs.writeFileSync(script, JSON.stringify([
        { text: 'asking', tool_calls: [{ name: 'ask_user', input: { question: 'Which provider?', options: ['a', 'b'] } }] },
      ]), 'utf8');
      process.env.LAIN_PROVIDER = 'mock';
      require('../../src/mockprovider')._reset();
      process.env.LAIN_MOCK_SCRIPT = script;
      try {
        const a = new App({ interactive: false, cwd: home });
        a.render.write = () => {};
        a.render.notice = () => {};
        a.session.save = () => {};
        const job = a.startBackground('inspect the work');
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(job.needsInput, true,
          'the job parked on its question within a tick — admission degraded, it did not stall');
        assert.strictEqual(job.question && job.question.question, 'Which provider?');
      } finally {
        delete process.env.LAIN_MOCK_SCRIPT;
        delete process.env.LAIN_PROVIDER;
      }
    });
  });
};
