'use strict';

/**
 * THE MODEL BOUNDARY — the runtime half, against the real binary.
 *
 * ------------------------------------------------------------------------
 * WHAT IS TRUE TODAY, and this file is the honest record of it.
 *
 * The runtime CAN admit, identify and close a model request, and CAN refuse one
 * for the two things only it knows. Every assertion below drives the real
 * supervisor over the real socket.
 *
 * THE TURN LOOP CALLS IT NOW. requestadmission.test.js proves the wire half —
 * admission lands BEFORE provider.chat, a denial means ZERO provider calls, and
 * every retry is its own request lifecycle. The parked regression that delayed
 * this for a pass — admission stalling on the supervisor BOOT WINDOW, so a
 * background job parked its question seconds late — is fixed in guardian.js
 * (a booting runtime is not a request authority) and guarded by the fourth
 * test there. This file keeps proving the runtime's half directly.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const guardian = require('../../src/guardian');

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-rqb-'));
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  guardian.forgetLocal();
  try {
    await supervisor.ensure();
    return await fn(home);
  } finally {
    try { await supervisor.shutdown(); } catch { /* never started */ }
    guardian.forgetLocal();
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

const call = (msg) => supervisor.call(msg, { timeoutMs: 5000 });

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('REQBOUND: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  await test('REQBOUND: a request is admitted under an id the runtime issued', async () => {
    await withHome(async () => {
      const s = 'sess-admit';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      const a = await call({ op: 'request_begin', session: s, connection_id: 'lain:open' });
      assert.strictEqual(a.ok, true);
      assert.strictEqual(a.allow, true);
      assert.match(a.request_id, /^rq-\d+-\d+$/, 'the id comes from the runtime, not the caller');
      // AND THE SESSION KNOWS ONE IS OPEN. That is what makes a second request
      // against the same identity visible rather than a convention.
      assert.strictEqual(a.state.open_request, a.request_id);

      const b = await call({ op: 'request_end', session: s, request_id: a.request_id });
      assert.strictEqual(b.state.open_request, '', 'and closed when it ends');
    });
  });

  await test('REQBOUND: ids are distinct, and a stale close cannot clear a live request', async () => {
    await withHome(async () => {
      const s = 'sess-ids';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      const first = await call({ op: 'request_begin', session: s });
      const second = await call({ op: 'request_begin', session: s });
      assert.notStrictEqual(first.request_id, second.request_id);

      // A LATE REPLY FROM AN ABANDONED REQUEST must not close the one that
      // replaced it — otherwise the runtime would believe nothing is in flight
      // while something is.
      const stale = await call({ op: 'request_end', session: s, request_id: first.request_id });
      assert.strictEqual(stale.state.open_request, second.request_id, 'the live request stayed open');
      const proper = await call({ op: 'request_end', session: s, request_id: second.request_id });
      assert.strictEqual(proper.state.open_request, '');
    });
  });

  await test('REQBOUND: a turn whose owner is gone is refused', async () => {
    await withHome(async () => {
      const s = 'sess-lost';
      // A pid that cannot be running: claimed by a process that does not exist.
      // This is the case a NEW LAIN cannot know from its own memory.
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: 999999 });
      const a = await call({ op: 'request_begin', session: s });
      assert.strictEqual(a.allow, false, 'a turn nobody will finish must not be built on');
      assert.match(a.reason, /TURN_LOST/);
      assert.strictEqual(a.request_id, '', 'and no id is issued for a refused request');
    });
  });

  await test('REQBOUND: a route recorded as shut with a future reset is refused', async () => {
    await withHome(async () => {
      const s = 'sess-shut';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      await call({
        op: 'provider_note',
        connection_id: 'lain:shut',
        ok: false,
        kind: 'RATE_LIMITED',
        reset_at: Date.now() + 3_600_000,
      });
      const refused = await call({ op: 'request_begin', session: s, connection_id: 'lain:shut' });
      assert.strictEqual(refused.allow, false);
      assert.match(refused.reason, /ROUTE_SHUT/);
      assert.match(refused.reason, /rate limited for another \d+m/, 'and it says for how long');

      // ANOTHER ROUTE IS UNAFFECTED. The refusal is about the door, not the session.
      const other = await call({ op: 'request_begin', session: s, connection_id: 'lain:open' });
      assert.strictEqual(other.allow, true);
    });
  });

  await test('REQBOUND: a limit with no stated reset does NOT refuse', async () => {
    // ---- NULL IS NOT A CLOCK ---------------------------------------------
    //
    // A generic 429 with no reset time is not evidence that the door is still
    // shut. Refusing on it would strand a session on a route that may already
    // be open — the same refusal `reset_at: null` makes in providers.rs.
    await withHome(async () => {
      const s = 'sess-noreset';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      await call({ op: 'provider_note', connection_id: 'lain:vague', ok: false, kind: 'RATE_LIMITED' });
      const a = await call({ op: 'request_begin', session: s, connection_id: 'lain:vague' });
      assert.strictEqual(a.allow, true, 'a limit with no clock is not a durable refusal');
    });
  });

  await test('REQBOUND: the cost travels with the ending', async () => {
    await withHome(async () => {
      const s = 'sess-cost';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      const a = await call({ op: 'request_begin', session: s });
      const b = await call({
        op: 'request_end',
        session: s,
        request_id: a.request_id,
        input_tokens: 1200,
        output_tokens: 36,
        requests: 1,
      });
      assert.strictEqual(b.state.usage.input_tokens, 1200);
      assert.strictEqual(b.state.usage.output_tokens, 36);
      // AND A CACHE NOBODY REPORTED IS STILL UNKNOWN, not zero.
      assert.strictEqual(b.state.usage.cache_reported, false);
    });
  });

  await test('REQBOUND: an open request survives a supervisor restart', async () => {
    // The point of the runtime holding this: a request that was in flight when
    // the CLI died is still recorded as open, which is how the next process can
    // tell "nothing was happening" from "something was, and nobody finished it".
    await withHome(async () => {
      const s = 'sess-restart';
      await call({ op: 'guardian_turn_begin', session: s, turn_id: 't1', model: 'm', owner_pid: process.pid });
      const a = await call({ op: 'request_begin', session: s });

      await supervisor.shutdown();
      guardian.forgetLocal();
      await supervisor.ensure();

      const st = await call({ op: 'guardian_state', session: s });
      assert.strictEqual(st.state.open_request, a.request_id, 'the open request survived');
    });
  });
};
