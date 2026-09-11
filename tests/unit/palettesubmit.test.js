'use strict';

/**
 * A LINE THE COMMAND PALETTE CANNOT OFFER MUST STILL RUN.
 *
 * The palette opens on `/`, and while it is open the READER stops submitting:
 * input.js `_consume` asks `enterGoesToUI()` and, when a menu is up, emits
 * Enter as a KEY rather than sending the line. That is correct — `/stat<Enter>`
 * means "run the highlighted command", not "send the fragment to a model".
 *
 * But it makes ui/menus.js the only thing that can send the line, and it did
 * not. With nothing highlighted it closed the menu and consumed the key, so a
 * `/` line the palette had no entry for did NOTHING: the text stayed on the
 * input row, and pressing Enter again did nothing again.
 *
 * WHAT MADE IT REACHABLE was `hidden`. commands.js `define` documents hidden as
 * "A COMPATIBILITY ALIAS: it still runs when typed", and `offered()` — which
 * fills this palette — excludes exactly those. So `/models` had a registry
 * entry, an empty palette, and a swallowed Enter: the promise held through a
 * pipe and broke in the TUI.
 *
 * These test the RULE rather than that one alias, because the next hidden
 * command, typo, or command added after the palette filtered would all land on
 * the same defect. The rule: a completion menu may EDIT the line; only an
 * accepted item may replace it; and Enter always leaves the line somewhere it
 * gets an answer — its command, or `Unknown command`.
 */

const assert = require('assert');
const { test } = require('../helpers');

const menus = require('../../src/ui/menus');
const panelMod = require('../../src/ui/panel');
const commands = require('../../src/commands');

/**
 * The real InteractionPanel and the real adapters, with a recording input.
 *
 * Only stdout, the app and the redraw are doubles: everything the assertions
 * are about — which items the palette holds, what `panel.current` is, what
 * `completionKey` decides — is production code.
 */
function wired(line) {
  const panel = new panelMod.InteractionPanel();
  const input = {
    line,
    submitted: null,
    setLine(s) { this.line = s; },
    submitLine() { this.submitted = this.line; this.line = ''; return this.submitted; },
  };
  const ui = {
    enabled: true,
    panel,
    app: { input, abort: null, render: { notice() {} }, session: { cwd: process.cwd() } },
    refresh() {},
    setInput() {},
    get isCompletion() { return panel.isCompletion; },
  };
  menus.updateMenus(ui, line);
  return { ui, panel, input };
}

module.exports = async function () {
  // ------------------------------------------------- the defect itself ------

  await test('PALETTE: Enter on a line with NO match still submits it', () => {
    // `/zzzznope` matches no command at all — the same shape as a hidden one.
    const { ui, panel, input } = wired('/zzzznope');
    assert.ok(panel.visible && panel.isCompletion, 'the palette opens for any `/` line');
    assert.strictEqual(panel.current, null, 'and has nothing to highlight');

    const consumed = menus.completionKey(ui, 'enter');

    assert.strictEqual(consumed, true, 'Enter is handled here, not left dangling');
    assert.strictEqual(input.submitted, '/zzzznope',
      'the typed line must reach the command layer — silence is the one wrong answer');
    assert.ok(!panel.visible, 'and the menu gets out of the way');
  });

  await test('PALETTE: a HIDDEN command is typable, exactly as define promises', () => {
    // The concrete case. If a future refactor makes `/models` visible again
    // this still holds, because it asserts the OUTCOME and not the emptiness.
    const hidden = [...commands.REGISTRY.values()].filter((c) => c.hidden);
    assert.ok(hidden.length, 'this test needs at least one compatibility alias to mean anything');
    for (const c of hidden) {
      // REGISTRY keys ALREADY CARRY THE SLASH — `/models`, not `models`. Written
      // as `'/' + c.name` this typed `//models`, which the palette also cannot
      // offer, so it passed while proving nothing about the alias. It is taken
      // from the registry verbatim now, and `looksLikeCommand` is asked whether
      // the string is really runnable rather than assumed.
      assert.ok(commands.looksLikeCommand(c.name), `${c.name} must be a runnable line as written`);
      assert.ok(!commands.offered().some((o) => o.name === c.name),
        `${c.name} is hidden, so the palette must not propose it`);
      const { ui, panel, input } = wired(c.name);
      assert.strictEqual(panel.current, null, `${c.name} leaves the palette with nothing to highlight`);
      menus.completionKey(ui, 'enter');
      assert.strictEqual(input.submitted, c.name,
        `${c.name} is documented as running when typed, and must actually run`);
    }
  });

  // ------------------------------- what must NOT change while fixing it ------

  await test('PALETTE: Enter on a HIGHLIGHTED item still runs that item', () => {
    const { ui, panel, input } = wired('/mod');
    assert.ok(panel.current, 'a real prefix highlights a real command');
    const chosen = panel.current.command;
    assert.strictEqual(menus.completionKey(ui, 'enter'), true);
    assert.strictEqual(input.submitted, chosen + ' ',
      'the accepted item replaces the fragment — that is what the palette is for');
  });

  await test('PALETTE: Tab and Right with nothing to accept do nothing at all', () => {
    // They are COMPLETION keys. With no item there is nothing to complete, so
    // they stay consumed — a Tab that submitted would be a keystroke sending
    // work nobody asked to send.
    for (const key of ['tab', 'right']) {
      const { ui, panel, input } = wired('/zzzznope');
      assert.strictEqual(menus.completionKey(ui, key), true, `${key} belongs to the menu`);
      assert.strictEqual(input.submitted, null, `${key} must never submit`);
      assert.strictEqual(input.line, '/zzzznope', `${key} must not edit the line either`);
      assert.ok(panel.visible, `${key} leaves the menu open`);
    }
  });

  await test('PALETTE: Tab on a real prefix completes rather than submits', () => {
    const { ui, input } = wired('/mod');
    menus.completionKey(ui, 'tab');
    assert.strictEqual(input.submitted, null, 'Tab accepts; it does not send');
    assert.match(input.line, /^\/mod/, 'and what it accepted is on the line, ready to edit');
  });

  await test('FILES: Enter on an `@token` matching nothing sends the line as written', () => {
    // The same rule through the other menu. `@` opens a file picker; a token
    // matching no path leaves it empty, and the sentence someone typed is
    // still a sentence. It must go, unmodified.
    const { ui, input } = wired('read @zzzz-no-such-path');
    assert.strictEqual(menus.completionKey(ui, 'enter'), true);
    assert.strictEqual(input.submitted, 'read @zzzz-no-such-path',
      'a menu may not eat a prompt just because it had nothing to offer');
  });

  await test('NOTHING OPEN: completionKey declines every key', () => {
    // The guard above all of this. With no completion menu the reader submits
    // normally, and menus.js must not reach for the line.
    const { ui, input } = wired('just a sentence');
    assert.ok(!ui.panel.visible, 'prose opens no menu');
    for (const key of ['enter', 'tab', 'right']) {
      assert.strictEqual(menus.completionKey(ui, key), false, `${key} is not ours`);
    }
    assert.strictEqual(input.submitted, null, 'and nothing was submitted behind the reader');
  });
};
