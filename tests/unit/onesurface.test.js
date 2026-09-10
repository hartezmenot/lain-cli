'use strict';

/**
 * ONE SURFACE — the invariant, asserted structurally.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE REPLACES, AND WHY IT IS SHAPED THE WAY IT IS.
 *
 * `tests/unit/taborder.test.js` and `tests/smoke/tabs-nav.test.js` proved that
 * nine panes could be numbered, cycled, clicked and opened consistently. They
 * were good tests of a design that is gone, and deleting them without putting
 * something in their place would leave the replacement unguarded: the failure
 * mode of a subtraction is that it grows back one pane at a time.
 *
 * SO THIS ASSERTS ABSENCE, and asserts it where absence is checkable:
 *
 *   1. the tab MODULE does not exist
 *   2. the Screen has no `view` and no way to change one
 *   3. `workspaceLines` gives the SAME answer whatever is asked of it
 *   4. no source file spells a pane list or a pane-switching key
 *
 * DELIBERATELY NOT COORDINATE-BASED. "Row 4 column 12 is not a tab label" is a
 * test of a layout, and every honest change to the layout would fail it. These
 * are statements about the program's structure, which is what actually has to
 * stay true.
 * ------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Every .js under src/, as {file, text}. */
function sources(dir = SRC, base = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(sources(p, rel));
    else if (e.name.endsWith('.js')) out.push({ file: rel, text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/**
 * Comments are where the removal is EXPLAINED, so they must not be searched:
 * every file that used to switch panes now carries a paragraph saying it does
 * not, and a naive grep would read those paragraphs as the machinery itself.
 */
function code(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

module.exports = async () => {
  await test('SURFACE: there is no tab module', () => {
    assert.ok(!fs.existsSync(path.join(SRC, 'ui', 'tabs.js')),
      'src/ui/tabs.js is the pane order, the cycle and the numbering — it must not exist');
    assert.throws(() => require('../../src/ui/tabs'), /Cannot find module/,
      'nothing may resolve it either');
  });

  await test('SURFACE: no source file requires a tab module', () => {
    const guilty = sources().filter((f) => /require\(['"][./]*(?:ui\/)?tabs['"]\)/.test(code(f.text)));
    assert.deepStrictEqual(guilty.map((f) => f.file), [],
      'a module reaching for the pane list is the machinery coming back');
  });

  await test('SURFACE: the Screen has no view, and no way to change one', () => {
    const { Screen } = require('../../src/ui/layout');
    const out = { columns: 100, rows: 30, write() {}, on() {}, removeListener() {} };
    const s = new Screen({ out });
    assert.strictEqual(s.view, undefined, 'a Screen that knows which pane it is on has panes');
    assert.strictEqual(typeof s.setView, 'undefined', 'setView is the switch itself');
    assert.strictEqual(typeof s.tabsLine, 'undefined', 'tabsLine is the strip');
    assert.strictEqual(typeof s.bannerLines, 'undefined', 'the pinned banner was a fifth region');
  });

  await test('SURFACE: the UI cannot cycle or select a view', () => {
    const { UI } = require('../../src/ui');
    assert.strictEqual(typeof UI.prototype.nextView, 'undefined', 'Tab cycled the panes through this');
    assert.strictEqual(typeof UI.prototype.ensureReport, 'undefined',
      'per-pane report passes were triggered by navigation, and there is no navigation');
  });

  await test('SURFACE: the workspace has ONE answer, whatever it is asked', () => {
    const panesource = require('../../src/ui/panesource');
    // A screen double with the whole of what `workspaceLines` reads. The point
    // is that adding a `view` to it changes nothing.
    const base = {
      completion: null,
      state: {
        session: { task: { objective: 'fix the router' }, turns: [] },
        cwd: process.cwd(), transcript: [], liveActions: [], liveNarration: [],
        liveNotes: [], extras: [],
      },
    };
    const one = panesource.workspaceLines(base, 80, 20);
    for (const view of ['plan', 'diff', 'files', 'output', 'tokens', 'memory', 'context', 'detail']) {
      const other = panesource.workspaceLines({ ...base, view }, 80, 20);
      assert.deepStrictEqual(other, one,
        `asking for '${view}' produced different content — a pane survived`);
    }
  });

  await test('SURFACE: no pane-switching key is bound anywhere', () => {
    const keys = code(fs.readFileSync(path.join(SRC, 'ui', 'keys.js'), 'utf8'));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      assert.ok(!keys.includes(`'alt-${n}'`), `alt-${n} still opens something`);
      assert.ok(!keys.includes(`'ctrl-${n}'`), `ctrl-${n} still opens something`);
    }
    const repl = code(fs.readFileSync(path.join(SRC, 'repl.js'), 'utf8'));
    assert.ok(!/nextView/.test(repl), 'Tab must no longer cycle anything');
  });

  await test('SURFACE: the help text does not promise a key that does nothing', () => {
    const { KEYS } = require('../../src/helpcommand');
    const named = KEYS.map(([k, what]) => `${k} ${what}`).join(' ').toLowerCase();
    // `panel` is a real thing Esc closes and must not be caught here — the
    // word to find is the PANE, which no key reaches any more.
    assert.ok(!/\bpanes?\b/.test(named), 'help offers a pane switch that cannot happen');
    assert.ok(!/alt\+1/.test(named), 'help offers Alt+1');
    assert.ok(!/switch/.test(named), 'help offers a way to switch surfaces');
  });

  await test('SURFACE: the four regions, and nothing permanent beside them', () => {
    // The geometry is the contract: a header, the conversation, one live row,
    // the input — plus two regions that are ZERO unless something is happening.
    const { regions } = require('../../src/ui/geometry');
    const screen = {
      rows: 30, cols: 100, panel: null, state: {},
      _wrapped: () => [{ text: '' }], _pasteSummary: () => '',
    };
    const g = regions(screen);
    assert.strictEqual(g.headerRows, 2, 'the header is one row of metadata and one rule');
    assert.strictEqual(g.statusRows, 1, 'the live row is ONE row — never a panel, never a trail');
    assert.strictEqual(g.pendingRows, 0, 'nothing is waiting, so it costs nothing');
    assert.strictEqual(g.jobRows, 0, 'nothing is in the background, so it costs nothing');
    assert.strictEqual(g.panelRows, 0, 'no panel is open');
    // Everything that is left belongs to the conversation.
    assert.strictEqual(g.headerRows + g.workspace + g.statusRows + g.inputRows, 30,
      'the regions must tile the terminal exactly');
    assert.ok(g.workspace >= 20, `the conversation should get most of the screen, got ${g.workspace}`);
  });

  await test('SURFACE: the removed panes are all reachable as commands', () => {
    // §12: move visibility behind commands, do not delete capability. Each of
    // these renderers used to BE a pane; every one of them still has a door.
    const { REGISTRY } = require('../../src/commands');
    for (const name of ['/plan', '/changes', '/token', '/note', '/brief', '/jobs']) {
      assert.ok(REGISTRY.has(name), `${name} is how one of the removed panes is now reached`);
    }
  });
};
