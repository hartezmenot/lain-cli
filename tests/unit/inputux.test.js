'use strict';

/**
 * Input history, path completion and the two completion adapters — the pure
 * parts, in isolation. The behaviour that matters is proved through the real
 * binary in smoke/inputux.test.js; these pin the rules that are cheap to state
 * exactly (bounds, de-duplication, directory boundaries, filter semantics).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { Input } = require('../../src/input');
const project = require('../../src/project');
const panel = require('../../src/ui/panel');

/** An Input wired to nothing: history is pure state, no terminal required. */
function reader() {
  const { PassThrough } = require('stream');
  return new Input({ stdin: new PassThrough(), stdout: new PassThrough() });
}

module.exports = async function () {
  // ---- history -----------------------------------------------------------

  await test('HISTORY: up walks back, down walks forward', () => {
    const i = reader();
    i._emitInput('one', false);
    i._emitInput('two', false);
    assert.strictEqual(i.recallPrev(), true);
    assert.strictEqual(i.line, 'two', 'newest first');
    i.recallPrev();
    assert.strictEqual(i.line, 'one');
    i.recallNext();
    assert.strictEqual(i.line, 'two');
  });

  await test('HISTORY: down past the newest restores the draft being typed', () => {
    const i = reader();
    i._emitInput('stored', false);
    i.line = 'half typed';
    i.recallPrev();
    assert.strictEqual(i.line, 'stored');
    i.recallNext();
    assert.strictEqual(i.line, 'half typed', 'the unsent draft came back');
  });

  await test('HISTORY: editing a recalled prompt does not rewrite the stored one', () => {
    const i = reader();
    i._emitInput('original', false);
    i.recallPrev();
    i.line += ' EDITED';
    assert.strictEqual(i.history[0], 'original');
  });

  await test('HISTORY: blanks never enter, consecutive duplicates collapse', () => {
    const i = reader();
    i._emitInput('   ', false);
    i._emitInput('same', false);
    i._emitInput('same', false);
    i._emitInput('other', false);
    i._emitInput('same', false);
    assert.deepStrictEqual(i.history, ['same', 'other', 'same'],
      'a repeat right after itself is dropped; a repeat later is not');
  });

  await test('HISTORY: bounded — it cannot grow without limit', () => {
    const i = reader();
    for (let n = 0; n < 500; n++) i._emitInput('p' + n, false);
    assert.ok(i.history.length <= 200, `history grew to ${i.history.length}`);
    assert.strictEqual(i.history[i.history.length - 1], 'p499', 'the newest is kept');
  });

  await test('HISTORY: a paste is never added', () => {
    const i = reader();
    i._emitInput('line1\nline2\nline3', true);
    assert.deepStrictEqual(i.history, []);
  });

  await test('HISTORY: recall at either end reports that it did not move', () => {
    const i = reader();
    assert.strictEqual(i.recallPrev(), false, 'nothing to recall');
    assert.strictEqual(i.recallNext(), false);
  });

  // ---- @ path completion --------------------------------------------------

  await test('FILES: lists one level, directories first', () => {
    const d = tmpdir('lain-complete-');
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src', 'app.js'), '');
    fs.writeFileSync(path.join(d, 'README.md'), '');
    const top = project.completePath(d, '').map((e) => e.path);
    assert.deepStrictEqual(top, ['src/', 'README.md']);
  });

  await test('FILES: typing more characters filters', () => {
    const d = tmpdir('lain-complete-');
    fs.mkdirSync(path.join(d, 'src'));
    for (const f of ['app.js', 'input.js', 'index.js']) fs.writeFileSync(path.join(d, 'src', f), '');
    const got = project.completePath(d, 'src/in').map((e) => e.path);
    assert.deepStrictEqual(got, ['src/index.js', 'src/input.js']);
  });

  await test('FILES: generated directories are never offered', () => {
    const d = tmpdir('lain-complete-');
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.mkdirSync(path.join(d, '.git'));
    fs.mkdirSync(path.join(d, 'src'));
    const got = project.completePath(d, '').map((e) => e.path);
    assert.deepStrictEqual(got, ['src/'], 'node_modules and .git stay out of the menu');
  });

  await test('FILES: completion cannot escape the project', () => {
    const d = tmpdir('lain-complete-');
    fs.mkdirSync(path.join(d, 'src'));
    assert.deepStrictEqual(project.completePath(d, '../'), []);
    assert.deepStrictEqual(project.completePath(d, '../../'), []);
  });

  await test('FILES: a missing directory yields nothing rather than throwing', () => {
    const d = tmpdir('lain-complete-');
    assert.deepStrictEqual(project.completePath(d, 'nope/deeper/'), []);
  });

  await test('FILES: the list is capped', () => {
    const d = tmpdir('lain-complete-');
    for (let n = 0; n < 400; n++) fs.writeFileSync(path.join(d, 'f' + n + '.txt'), '');
    assert.ok(project.completePath(d, '').length <= project.MAX_COMPLETIONS);
  });

  // ---- adapters -----------------------------------------------------------

  await test('PALETTE: filters by prefix and carries the real command names', () => {
    const commands = require('../../src/commands');
    const all = [...commands.REGISTRY.values()];
    const a = panel.commandPaletteAdapter({ commands: all, filter: '/mo' });
    const names = a.items.map((i) => i.command);
    assert.ok(names.includes('/models') && names.includes('/model'), `got ${names.join(',')}`);
    assert.ok(!names.includes('/exit'), 'unrelated commands are filtered out');
    assert.strictEqual(a.kind, panel.KIND.COMMAND_PALETTE);
  });

  await test('PALETTE: the source of truth is the command registry, not a copy', () => {
    const commands = require('../../src/commands');
    const all = [...commands.REGISTRY.values()];
    const a = panel.commandPaletteAdapter({ commands: all, filter: '/' });
    assert.strictEqual(a.items.length, commands.REGISTRY.size,
      'every registered command is offered and nothing else is');
  });

  await test('PALETTE: /effort is offered exactly once and /efforts does not exist', () => {
    const commands = require('../../src/commands');
    const all = [...commands.REGISTRY.values()];
    const names = panel.commandPaletteAdapter({ commands: all, filter: '/eff' }).items.map((i) => i.command);
    assert.deepStrictEqual(names, ['/effort']);
  });

  await test('PALETTE: no match says so instead of offering something wrong', () => {
    const a = panel.commandPaletteAdapter({ commands: [], filter: '/zzz' });
    assert.strictEqual(a.items[0].selectable, false);
  });

  // ---- the panel state machine -------------------------------------------

  await test('PANEL: replace() swaps content without resolving the caller', () => {
    const p = new panel.InteractionPanel();
    let settled = false;
    p.open(panel.commandPaletteAdapter({ commands: [{ name: '/a', desc: '' }, { name: '/b', desc: '' }], filter: '/' }))
      .then(() => { settled = true; });
    p.move(1, 10);
    p.replace(panel.commandPaletteAdapter({ commands: [{ name: '/a', desc: '' }], filter: '/a' }));
    assert.strictEqual(p.visible, true, 'still open');
    assert.strictEqual(p.cursor, 0, 'cursor clamped to the shorter list');
    assert.strictEqual(settled, false, 'filtering must never resolve the panel');
  });

  await test('PANEL: /models carries readiness and availability into the route view', () => {
    // They are separate questions — credentials vs reachability — and the route
    // view showed neither until the caller passed them, which no test caught.
    const catalog = { models: [{ id: 'm1', displayName: 'M One', connections: [
      { connectionId: 'live:nvidia', baseConnectionId: 'live', route: 'nvidia', provider: 'bridge', via: 'bridge', auth: 'none', efforts: [] },
    ] }] };
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog,
      readinessOf: () => 'AUTHENTICATED',
      availabilityOf: () => 'UNKNOWN',
    }));
    // `→` is the drill now — Enter on a single-route model commits it outright.
    p.select({ key: 'right' });   // model → routes
    p.select();                   // route → detail, where these fields now live
    const body = p.render(90, 16).join('\n');
    assert.ok(body.includes('readiness') && body.includes('AUTHENTICATED'), body);
    assert.ok(body.includes('availability') && body.includes('UNKNOWN'), body);
    assert.ok(body.includes('credential'), 'credential is still its own field');
  });

  await test('PANEL: kind separates transient completion from modal pickers', () => {
    const p = new panel.InteractionPanel();
    assert.strictEqual(p.kind, panel.KIND.IDLE);
    p.open(panel.fileCompletionAdapter({ entries: [{ path: 'a.js', isDir: false }], filter: '' }));
    assert.strictEqual(p.isCompletion, true);
    p.close(null);
    p.open(panel.askAdapter({ question: 'q', options: ['x'] }));
    assert.strictEqual(p.kind, panel.KIND.ASK_USER);
    assert.strictEqual(p.isCompletion, false, 'typing must not disturb a modal panel');
  });
};
