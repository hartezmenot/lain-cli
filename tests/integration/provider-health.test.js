'use strict';

/**
 * A RATE LIMIT OUTLIVES THE PROCESS THAT LEARNED IT — proved against a real
 * supervisor, not a mock.
 *
 * ------------------------------------------------------------------------
 * WHAT FAILED BEFORE THIS EXISTED. Provider health lived in a `Map` on the App
 * object, described in a comment as in-memory by design because "a restart
 * legitimately knows nothing". True of a circuit breaker; false of the thing
 * that actually costs a user their afternoon.
 *
 * Measured live against a real router: `retry in 4 hours`. Restart LAIN five
 * minutes later and that number is gone. The next turn calls the closed route
 * and is refused; the model picker — the one screen where "which of these can I
 * use right now" is asked — shows the shut door as untried; and nothing in the
 * handover can tell a replacement model which road not to take.
 *
 * ------------------------------------------------------------------------
 * WHY A REAL PROCESS. The property under test is precisely that the fact
 * survives the death of the thing that recorded it, so the tests below kill and
 * restart the store rather than asserting about a Map. A stub would prove the
 * shape of the API and none of the guarantee.
 *
 * THEY SKIP THEMSELVES when the Rust binary is not built. LAIN is a
 * zero-dependency Node program and its suite may not become conditional on a
 * toolchain — see supervisor.probe().
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const { Availability, STATUS } = require('../../src/availability');

const HOUR = 3600_000;

/** A private LAIN home, so a test never touches the user's real supervisor. */
function isolate(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-health-${tag}-`));
}

async function withHomeAsync(home, fn) {
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('PROVIDER HEALTH: skipped — the Rust binary is not built', () => {
      // Declared rather than silent: a skipped guarantee is not a kept one.
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  // ---- THE PROPERTY THE WHOLE MIGRATION EXISTS FOR -----------------------

  await test('HEALTH: a four-hour limit learned by one process is known to the next', async () => {
    const home = isolate('survive');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      const resetAt = Date.now() + 4 * HOUR;

      // ---- process one: a turn hits a rate limit and dies -----------------
      const a = new Availability();
      a.sink = (id, ev) => supervisor.noteProvider({
        connectionId: id, ok: ev.ok, kind: ev.kind, reason: ev.reason,
        provider: 'omniroute', model: 'gemini', resetAt: ev.resetAt,
      });
      a.noteFailure('omniroute-main', {
        kind: 'RATE_LIMITED', message: '429 too many requests', retryAfterMs: 4 * HOUR,
      });
      // The push is fire-and-forget by design, so settle it before asserting.
      await supervisor.noteProvider({
        connectionId: 'omniroute-main', ok: false, kind: 'RATE_LIMITED',
        reason: '429 too many requests', provider: 'omniroute', model: 'gemini', resetAt,
      });

      // ---- LAIN DIES. The supervisor does not. ----------------------------
      const fresh = new Availability();
      assert.strictEqual(fresh.shouldAttempt('omniroute-main').allow, true,
        'a brand-new Availability starts knowing nothing — that is the bug');

      const rows = await supervisor.providers();
      assert.ok(rows.ok, `provider_list failed: ${rows.error}`);
      const took = fresh.hydrate(rows.providers);

      assert.strictEqual(took.limited, 1, 'the limit was still there to be read');
      const gate = fresh.shouldAttempt('omniroute-main');
      assert.strictEqual(gate.allow, false, 'and the new process knows the door is shut');
      assert.ok(gate.retryAfterMs > 3.9 * HOUR, `with the real time left, got ${gate.retryAfterMs}`);

      await supervisor.shutdown();
    });
  });

  await test('HEALTH: it survives the SUPERVISOR restarting too, not just LAIN', async () => {
    // The store is on disk, not in the supervisor's memory. Killing the process
    // that owns the state is the strongest form of the same question.
    const home = isolate('supdie');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      const resetAt = Date.now() + 2 * HOUR;
      await supervisor.noteProvider({
        connectionId: 'r', ok: false, kind: 'RATE_LIMITED', reason: '429', resetAt,
      });
      await supervisor.shutdown();

      await supervisor.ensure();
      const rows = await supervisor.providers();
      const row = (rows.providers || []).find((p) => p.id === 'r');
      assert.ok(row, 'the row outlived the process that wrote it');
      assert.strictEqual(row.reset_at, resetAt, 'to the millisecond');
      assert.strictEqual(row.limited_now, true);
      await supervisor.shutdown();
    });
  });

  // ---- WHAT IT REFUSES TO INVENT -----------------------------------------

  await test('HEALTH: a limit with no stated reset never grows a countdown in transit', async () => {
    // §9: "Do not invent a countdown." The null has to survive Node, the wire,
    // the store, and the wire again — a zero appearing anywhere along that path
    // renders as a door that has already reopened.
    const home = isolate('noclock');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.noteProvider({ connectionId: 'r', ok: false, kind: 'RATE_LIMITED', reason: 'slow down' });
      const rows = await supervisor.providers();
      const row = (rows.providers || []).find((p) => p.id === 'r');
      assert.strictEqual(row.reset_at, null, 'nobody said when');
      assert.strictEqual(row.resets_in_ms, null, 'and it is null, never 0');
      assert.strictEqual(row.limited_now, true, 'the supervisor still calls it shut');

      // And the Node side declines to adopt it across a restart, because a
      // limit with no clock cannot be aged. See availability.hydrate.
      const fresh = new Availability();
      assert.strictEqual(fresh.hydrate(rows.providers).limited, 0);
      assert.strictEqual(fresh.shouldAttempt('r').allow, true);
      await supervisor.shutdown();
    });
  });

  await test('HEALTH: only a request that WORKED clears the flag — time passing does not', async () => {
    const home = isolate('clear');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.noteProvider({ connectionId: 'r', ok: false, kind: 'RATE_LIMITED', resetAt: Date.now() + HOUR });
      let row = (await supervisor.providers()).providers.find((p) => p.id === 'r');
      assert.strictEqual(row.rate_limited, true);

      await supervisor.noteProvider({ connectionId: 'r', ok: true });
      row = (await supervisor.providers()).providers.find((p) => p.id === 'r');
      assert.strictEqual(row.rate_limited, false, 'a 200 is the proof');
      assert.strictEqual(row.reset_at, null, 'and the countdown goes with it');
      assert.strictEqual(row.status, 'AVAILABLE');
      await supervisor.shutdown();
    });
  });

  // ---- THE CONTROLS MUST STILL WORK ACROSS THE BOUNDARY ------------------

  await test('HEALTH: /provider retry is not undone by the next launch', async () => {
    // The bug this prevents is the one availability._clear already records,
    // one process boundary further out: clear the limit, restart, and hydrate
    // puts it straight back from a countdown the user explicitly dismissed.
    const home = isolate('retry');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.noteProvider({ connectionId: 'r', ok: false, kind: 'RATE_LIMITED', resetAt: Date.now() + 4 * HOUR });

      const a = new Availability();
      a.sink = (id, ev) => (ev.decision === 'CLEAR' ? supervisor.clearProvider(id) : undefined);
      a.retry('r');
      await supervisor.clearProvider('r'); // settle the fire-and-forget push

      const fresh = new Availability();
      const took = fresh.hydrate((await supervisor.providers()).providers);
      assert.strictEqual(took.limited, 0, 'the dismissed limit did not come back');
      assert.strictEqual(fresh.shouldAttempt('r').allow, true);
      await supervisor.shutdown();
    });
  });

  await test('HEALTH: a route a person disabled is still disabled after a restart', async () => {
    const home = isolate('disabled');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.setProvider('r', STATUS.DISABLED, 'disabled by you');

      const fresh = new Availability();
      fresh.hydrate((await supervisor.providers()).providers);
      const gate = fresh.shouldAttempt('r');
      assert.strictEqual(gate.allow, false);
      assert.strictEqual(gate.status, STATUS.DISABLED, 'a decision does not expire because a process did');
      await supervisor.shutdown();
    });
  });

  await test('HEALTH: a disabled route is not re-enabled by a request that succeeds', async () => {
    // §19: an observation may not overrule a decision. Enforced on BOTH sides
    // of the socket, because either one could be the last word.
    const home = isolate('override');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.setProvider('r', STATUS.DISABLED, 'by you');
      await supervisor.noteProvider({ connectionId: 'r', ok: true });
      const row = (await supervisor.providers()).providers.find((p) => p.id === 'r');
      assert.strictEqual(row.status, 'DISABLED');
      await supervisor.shutdown();
    });
  });

  // ---- IT IS NEVER ALLOWED TO BECOME A DEPENDENCY ------------------------

  await test('HEALTH: with no supervisor reachable, every call answers rather than throws', async () => {
    // The hard rule from supervisor.js. A missing or dead supervisor is a
    // normal state, and the in-memory path must behave exactly as it always did.
    const home = isolate('absent');
    await withHomeAsync(home, async () => {
      const bad = { ...process.env };
      const prevBin = process.env.LAIN_SUPERVISOR_BIN;
      process.env.LAIN_SUPERVISOR_BIN = path.join(home, 'no-such-binary');
      try {
        const r = await supervisor.providers();
        assert.strictEqual(r.ok, false, 'an answer, not an exception');
        assert.ok(r.error, 'and it says why');
        const n = await supervisor.noteProvider({ connectionId: 'r', ok: false, kind: 'RATE_LIMITED' });
        assert.strictEqual(n.ok, false);
      } finally {
        if (prevBin === undefined) delete process.env.LAIN_SUPERVISOR_BIN;
        else process.env.LAIN_SUPERVISOR_BIN = prevBin;
        void bad;
      }
    });
  });

  await test('HEALTH: a note with no connection id is refused, not filed under ""', async () => {
    // Otherwise every unattributable failure in the process collects under one
    // blank key and is then reported as a real closed door.
    const home = isolate('noid');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      const local = await supervisor.noteProvider({ ok: false, kind: 'RATE_LIMITED' });
      assert.strictEqual(local.ok, false, 'the client refuses it without a round trip');
      const rows = await supervisor.providers();
      assert.strictEqual((rows.providers || []).length, 0, 'and nothing was stored');
      await supervisor.shutdown();
    });
  });

  // ---- WHAT THE REPLACEMENT MODEL IS ACTUALLY TOLD ------------------------

  await test('HANDOVER-14: the model taking over is told which road is closed, and until when', async () => {
    // The §10/§15 scenario end to end: model A is rate limited, LAIN hands over
    // to model B, and B must not spend its first turn rediscovering the limit
    // or planning around a route it cannot use.
    const home = isolate('handover');
    await withHomeAsync(home, async () => {
      await supervisor.ensure();
      await supervisor.noteProvider({
        connectionId: 'omniroute-main', ok: false, kind: 'RATE_LIMITED',
        reason: '429', provider: 'omniroute', model: 'model-a', resetAt: Date.now() + 3 * HOUR,
      });
      const rows = (await supervisor.providers()).providers;

      const packet = require('../../src/handover').build({
        cwd: process.cwd(),
        task: { objective: 'finish the data loader' },
        turns: [{ model: 'model-a', stopReason: 'provider', steps: 4, actions: [] }],
      }, { toModel: 'model-b', providers: rows });

      assert.ok(/taking over this task from a different model/.test(packet));
      assert.ok(/Routes that are closed right now/.test(packet), 'the section is present');
      assert.ok(/omniroute-main/.test(packet), 'and names the route');
      assert.ok(/clears in (2h|3h)/.test(packet), `with a real clock: ${packet}`);
      assert.ok(/LAIN observed these/.test(packet),
        'and marks them as observed, not as the dead model\'s report');
      await supervisor.shutdown();
    });
  });
};
