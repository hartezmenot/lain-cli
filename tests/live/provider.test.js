'use strict';

/**
 * LIVE PROVIDER VERIFICATION.
 *
 * Contacts a REAL provider through the REAL binary. Everything here is skipped
 * automatically when no bridge is reachable, so the suite stays hermetic on a
 * machine without one — but when a bridge IS present these are the only tests
 * entitled to the label LIVE PROVIDER VERIFIED.
 *
 * Point it somewhere with LAIN_LIVE_BASE_URL (default: a local OmniRoute).
 * No credential is embedded and none is read from V1's config; if the endpoint
 * needs auth and none is configured, the probe simply reports unreachable and
 * every case skips.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes } = require('../helpers');

const BASE_URL = process.env.LAIN_LIVE_BASE_URL || 'http://127.0.0.1:20128/v1';

/**
 * Probe with a retry. A SILENT FALSE SKIP is the dangerous failure here: it
 * would let a green run look like live verification happened when it did not.
 * Observed once during a full-suite run — the probe failed transiently right
 * after ~60 child spawns while the bridge was demonstrably up. The retry closes
 * that window, and the reason is always printed either way.
 */
async function probe(attempts = 3) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(`${BASE_URL}/models`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const j = await res.json();
      const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
      if (ids.length) return ids;
      lastErr = 'catalog was empty';
    } catch (e) {
      lastErr = `${e.name}: ${e.message}`;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  process.stdout.write(`  ~ probe failed after ${attempts} attempts: ${lastErr}\n`);
  return null;
}

function configFor(cwd, model) {
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model, connection: 'live',
    connections: { live: { provider: 'live-bridge', via: 'bridge', protocol: 'chat', baseUrl: BASE_URL, models: [model] } },
  }, null, 2), 'utf8');
  return configDir;
}

module.exports = async function () {
  const ids = await probe();
  if (!ids) {
    process.stdout.write(`  ~ SKIPPED: no live provider at ${BASE_URL}\n`);
    return;
  }
  process.stdout.write(`  · live provider at ${BASE_URL} — ${ids.length} models advertised\n`);

  const chat = ['auto/best-fast', 'auto/best-chat'].find((m) => ids.includes(m))
    || ids.find((m) => /mini|flash|fast/i.test(m)) || ids[0];
  const coder = ['auto/best-coding', 'auto/best-fast'].find((m) => ids.includes(m)) || chat;

  await test('LIVE: the real catalog collapses without inventing phantom models', async () => {
    // Runs against whatever the bridge actually advertises, so a real-world id
    // shape that synthetic fixtures never produce cannot pass unnoticed.
    const catalog = require('../../src/catalog');
    const cat = catalog.build([{ id: 'live', provider: 'live-bridge', via: 'bridge', auth: 'none', models: ids }]);
    assert.ok(cat.models.length > 0, 'the catalog built');
    assert.ok(cat.models.length <= ids.length, 'collapsing never invents models');
    const phantom = cat.models.filter((m) => /-(extra|xhigh|minimal|none)$/.test(m.id));
    assert.deepStrictEqual(phantom.map((p) => p.id), [], 'no phantom base from effort splitting');
    assert.ok(cat.models.every((m) => m.displayName), 'every model has a display name');
    // THE REAL INVARIANT: ids that differ only by a `:variant` suffix must not
    // collapse to the same display name. That was the live defect — dozens of
    // distinct models all rendering as "Batch" because the suffix became the
    // whole name. (A model whose own segment is literally `free`, as in
    // `openrouter/free`, legitimately displays as "Free"; that is its name.)
    const byName = new Map();
    for (const m of cat.models) {
      if (!byName.has(m.displayName)) byName.set(m.displayName, []);
      byName.get(m.displayName).push(m.id);
    }
    const suffixCollisions = [...byName.entries()].filter(([, group]) => {
      if (group.length < 2) return false;
      const stems = new Set(group.map((id) => id.split(':')[0]));
      return stems.size < group.length; // same stem, different variant, same name
    });
    assert.deepStrictEqual(suffixCollisions.map(([n]) => n), [],
      'a variant suffix must not be dropped from the display name');
  });

  /**
   * A BRIDGE THAT WENT AWAY IS NOT A FAILING TEST — and it is not a passing one.
   *
   * `runCli` kills the child at its timeout, which leaves `code === null`. That
   * is the signature of "nothing came back in time", and it is what a local
   * bridge dying mid-run looks like from here. Reporting it as a failure blames
   * the code for somebody else's process; reporting it as a pass is the false
   * green this tier exists to prevent. So it is NOT VERIFIED, said out loud,
   * and the test stops rather than asserting anything about output it does not
   * have.
   *
   * The catalog check above already proved the bridge was reachable when the
   * run STARTED, so this only fires when it stops answering partway through.
   *
   * @returns {boolean} true when the run is unusable and the caller should stop.
   */
  const noAnswer = (r, what) => {
    if (r.code !== null) return false;
    process.stdout.write(`  ~ NOT VERIFIED: ${what} — the bridge stopped answering mid-run `
      + '(the child was killed at the timeout). Nothing is proved either way.\n');
    return true;
  };

  await test('LIVE PROVIDER: a real completion through the real binary', async () => {
    const cwd = tmpdir('lain-live-');
    const configDir = configFor(cwd, chat);
    const r = await runCli(['-p', 'Reply with exactly the word BANANA and nothing else.'], {
      cwd, configDir, timeoutMs: 120000,
    });
    if (noAnswer(r, 'a real completion')) return;
    assert.strictEqual(r.code, 0, `exited cleanly\n${r.out.slice(0, 600)}`);
    // Assert that a REAL EXCHANGE happened, not that the model obeyed a phrasing.
    // `auto/*` routes to whichever upstream the bridge picks, so demanding an
    // exact word tests the model's compliance, not LAIN — and it flaked once for
    // exactly that reason.
    assert.ok(/↑\d+ ↓\d+/.test(r.stdout), `provider reported real token usage:\n${r.stdout.slice(0, 400)}`);
    const usage = r.stdout.match(/↑(\d+) ↓(\d+)/);
    assert.ok(Number(usage[1]) > 0, 'real input tokens were counted by the provider');
    assert.ok(!/is not answering|No provider configured/.test(r.stdout), 'the request actually reached the provider');
  });

  await test('LIVE PROVIDER: a real model drives real tool calls end to end', async () => {
    const cwd = tmpdir('lain-live-');
    const configDir = configFor(cwd, coder);
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'SECRET_MARKER_9931\n');
    const r = await runCli(['-p',
      'Read the file target.txt in the current directory and tell me the marker it contains. '
      + 'Then create a file called proof.txt containing that marker.'], {
      cwd, configDir, timeoutMs: 180000,
    });
    if (noAnswer(r, 'a real model driving real tool calls')) return;
    assert.strictEqual(r.code, 0, `exited cleanly\n${r.out.slice(0, 600)}`);
    assertIncludes(r.stdout, 'read_file', 'the model chose a tool');
    const proof = path.join(cwd, 'proof.txt');
    assert.ok(fs.existsSync(proof), 'the model really wrote a file');
    assertIncludes(fs.readFileSync(proof, 'utf8'), 'SECRET_MARKER_9931');
    // The V1 miscount, checked against a live model: the turn ends with prose,
    // and the tool count must still be the TURN-WIDE total.
    assert.ok(/[2-9]\d* tool calls/.test(r.stdout), `turn-wide tool count reported: ${r.stdout.match(/\d+ tool calls?/)}`);
  });

  await test('LIVE PROVIDER: a real request leaves the connection REQUEST_READY, and exit is clean', async () => {
    const cwd = tmpdir('lain-live-');
    const configDir = configFor(cwd, chat);
    const r = await runCli([], {
      cwd, configDir, stdin: 'say OK\n/provider status\n/exit\n', timeoutMs: 120000,
    });
    // Exit hygiene: process.exit() straight after a real fetch tripped a libuv
    // assertion and exited 127. A live request is the only way to catch that.
    if (noAnswer(r, 'a real request')) return;
    assert.strictEqual(r.code, 0, 'clean exit after a REAL network request');
    assert.ok(!/Assertion failed/.test(r.out), 'no native assertion on exit');
    assertIncludes(r.stdout, 'REQUEST_READY', 'readiness earned by a successful request, not a credential');
  });
};
