'use strict';

/**
 * THE FILESYSTEM GATE, THROUGH THE REAL DISPATCHER.
 *
 * trust.test.js checks the RULES in isolation. These check that the rules are
 * actually reached: every tool call goes through `tools.execute`, and the gate
 * lives there rather than at the six `resolve()` sites it would otherwise have
 * to be repeated across.
 *
 * Driven through `tools.execute` on purpose. A test that called `gate.check`
 * directly would keep passing on the day the dispatcher stopped calling it,
 * which is the failure that matters.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const tools = require('../../src/tools');
const trust = require('../../src/trust');
const rejected = require('../../src/rejected');

/** A project, somewhere else, and an app that has decided about the project. */
function world({ level = trust.LEVEL.TRUSTED, auto = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-gate-'));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-away-'));
  fs.writeFileSync(path.join(root, 'inside.txt'), 'ok');
  fs.writeFileSync(path.join(away, 'other.txt'), 'elsewhere');
  const app = {
    cfg: { trustedPaths: [{ path: root, level }], autoOutsideProject: auto },
    session: { cwd: root },
    // ---- A UI THAT EXISTS AND SAYS NO -------------------------------------
    //
    // This was `{ enabled: false }`, which is now exactly the case where the
    // gate deliberately stands down: on a pipe nobody was ever asked the trust
    // question, and refusing everything there would punish the user for a
    // question the program never put to them. Seven of these tests turned green
    // for that reason and stopped testing anything.
    //
    // The real scenario is this one: there IS somebody at the keyboard, they
    // were asked, and they declined. `ask` returning null is a declined panel.
    ui: { enabled: true, refresh() {}, ask: async () => null },
  };
  return { root, away, app, ctx: { cwd: root, app } };
}

const SYSTEM_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/passwd';

module.exports = async function () {
  await test('GATE: a read INSIDE a trusted project just works', async () => {
    const { ctx } = world();
    const r = await tools.execute('read_file', { path: 'inside.txt' }, ctx);
    assert.ok(!r.isError, `an ordinary read was refused: ${r.output}`);
  });

  await test('GATE: STRICT refuses a path outside the project, and says why', async () => {
    const { away, ctx } = world({ auto: false });
    const r = await tools.execute('read_file', { path: path.join(away, 'other.txt') }, ctx);
    assert.ok(r.isError, 'it must be refused');
    assert.match(r.output, /refused/);
    assert.match(r.output, /outside this project/);
    // AND IT MUST SAY WHAT TO DO. A refusal with no route out is a dead end the
    // user has to go and read source code to escape.
    assert.match(r.output, /\/permissions|\/trust/);
  });

  await test('GATE: AUTO allows an ordinary path outside the project', async () => {
    const { away, ctx } = world({ auto: true });
    const r = await tools.execute('read_file', { path: path.join(away, 'other.txt') }, ctx);
    assert.ok(!r.isError, `auto mode should allow an ordinary outside path: ${r.output}`);
  });

  await test('GATE: AUTO still refuses a SYSTEM path — the rule that does not bend', async () => {
    // This is the whole safety argument for auto mode being acceptable at all.
    const { ctx } = world({ auto: true });
    const r = await tools.execute('read_file', { path: SYSTEM_PATH }, ctx);
    assert.ok(r.isError, `${SYSTEM_PATH} must never be automatic`);
    assert.match(r.output, /system or credential/);
  });

  await test('GATE: READ_ONLY lets reads through and stops writes', async () => {
    const { ctx } = world({ level: trust.LEVEL.READ_ONLY });
    const read = await tools.execute('read_file', { path: 'inside.txt' }, ctx);
    assert.ok(!read.isError, 'reading is the point of read-only');
    const write = await tools.execute('write_file', { path: 'new.txt', content: 'x' }, ctx);
    assert.ok(write.isError, 'a write must be refused');
    assert.match(write.output, /read-only/);
  });

  await test('GATE: an UNDECIDED directory refuses rather than assuming yes', async () => {
    const { ctx, app } = world();
    app.cfg.trustedPaths = [];
    const r = await tools.execute('read_file', { path: 'inside.txt' }, ctx);
    assert.ok(r.isError, 'nothing decided is not consent');
  });

  await test('GATE: a refused write NEVER reaches the disk', async () => {
    // The refusal has to happen BEFORE the tool runs, or it is a report about
    // damage rather than a gate.
    const { root, ctx } = world({ level: trust.LEVEL.READ_ONLY });
    const target = path.join(root, 'must-not-exist.txt');
    const r = await tools.execute('write_file', { path: target, content: 'x' }, ctx);
    assert.ok(r.isError);
    assert.strictEqual(fs.existsSync(target), false, 'the file was written despite the refusal');
  });

  await test('GATE: every refusal is RECORDED, so it can be reconsidered', async () => {
    const { away, ctx, app } = world({ auto: false });
    await tools.execute('read_file', { path: path.join(away, 'a.txt') }, ctx);
    await tools.execute('read_file', { path: path.join(away, 'b.txt') }, ctx);
    assert.strictEqual(rejected.pending(app), 2, 'two distinct paths are two entries');
    // THE SAME PATH TWICE IS ONE ENTRY WITH A COUNT. A model that is refused
    // retries, and forty identical rows hide the one that matters.
    await tools.execute('read_file', { path: path.join(away, 'a.txt') }, ctx);
    assert.strictEqual(rejected.pending(app), 2, 'a retry must not add a row');
    assert.strictEqual(rejected.all(app).find((e) => e.target.endsWith('a.txt')).count, 2);
  });

  await test('GATE: allowing a refusal really opens it, through trust.js', async () => {
    // And through trust.js rather than a second exception list here — two
    // places that say what is permitted is how they come to disagree.
    const { away, ctx, app } = world({ auto: false });
    const target = path.join(away, 'other.txt');
    const first = await tools.execute('read_file', { path: target }, ctx);
    assert.ok(first.isError);

    const entry = rejected.all(app)[0];
    const r = rejected.allow(app, entry.id);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(trust.levelOf(app.cfg, away), trust.LEVEL.TRUSTED, 'the DIRECTORY is now trusted');

    const second = await tools.execute('read_file', { path: target }, ctx);
    assert.ok(!second.isError, `after allowing, it must work: ${second.output}`);
  });

  await test('GATE: with no app there is no gate — a headless turn is not crippled', async () => {
    // The gate is about asking a PERSON. A unit test or a piped one-shot has
    // nobody to ask, and gating it would make the whole tool surface untestable.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-headless-'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'ok');
    const r = await tools.execute('read_file', { path: 'f.txt' }, { cwd: root });
    assert.ok(!r.isError, `a headless call was gated: ${r.output}`);
  });
};
