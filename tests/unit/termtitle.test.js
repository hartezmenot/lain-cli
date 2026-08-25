'use strict';

/**
 * THE TERMINAL TAB TITLE.
 *
 * A side effect on someone else's window, so the rules are about restraint:
 * name the PROJECT, write only to a real terminal, never repeat yourself, and
 * hand the tab back on the way out.
 */

const assert = require('assert');
const { test } = require('../helpers');

const title = require('../../src/termtitle');

/** Capture what would be written, without touching the real terminal. */
function capture(fn) {
  const seen = [];
  title.setWriter((s) => seen.push(s));
  try { fn(); } finally { title.setWriter(null); }
  return seen.join('');
}

module.exports = async function () {
  await test('TITLE: it is LAIN — <project>, and the project is always there', () => {
    // This asserted the opposite until the user asked, twice, for the product
    // name to lead. What a row of tabs should say is their preference, not a
    // correctness question — but the PROJECT must still be in it, or the tabs
    // stop being distinguishable, which is the whole point of the feature.
    assert.strictEqual(title.compose({ folder: 'scalppbot' }), 'LAIN — scalppbot');
    assert.strictEqual(title.compose({ folder: '' }), 'LAIN', 'with no project, just the name');
  });

  await test('TITLE: the task is appended when there is one', () => {
    assert.strictEqual(
      title.compose({ folder: 'scalppbot', topic: 'fix the telegram toggle' }),
      'LAIN — scalppbot — fix the telegram toggle'
    );
  });

  await test('TITLE: a running turn is marked, so a backgrounded tab still says so', () => {
    assert.match(title.compose({ folder: 'p', busy: true }), /^● /);
    assert.ok(!/^● /.test(title.compose({ folder: 'p', busy: false })));
  });

  await test('TITLE: control characters and newlines can never reach the terminal', () => {
    // The topic is user text. An unescaped ESC in a title is a terminal
    // injection, not a cosmetic problem.
    const t = title.compose({ folder: 'p', topic: 'a\x1b]0;pwned\x07b\nc' });
    assert.ok(!/[\x00-\x1f\x7f]/.test(t), JSON.stringify(t));
  });

  await test('TITLE: long text is clipped rather than filling the tab bar', () => {
    const t = title.compose({ folder: 'x'.repeat(80), topic: 'y'.repeat(200) });
    assert.ok(t.length <= 80, `${t.length} chars`);
  });

  await test('TITLE: both OSC 0 and OSC 2 are sent, BEL-terminated', () => {
    // Terminals disagree about which a TAB reads; BEL is the form all of them
    // accept. Forced past the TTY check, which a test process never satisfies.
    const prev = process.env.LAIN_NO_TITLE;
    delete process.env.LAIN_NO_TITLE;
    const realTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const out = capture(() => title.set('demo-project'));
      assert.match(out, /\x1b\]0;demo-project\x07/);
      assert.match(out, /\x1b\]2;demo-project\x07/);
    } finally {
      if (realTTY) Object.defineProperty(process.stdout, 'isTTY', realTTY);
      else delete process.stdout.isTTY;
      if (prev !== undefined) process.env.LAIN_NO_TITLE = prev;
      title.restore();
    }
  });

  await test('TITLE: nothing is written to a pipe or a dumb terminal', () => {
    const realTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      assert.strictEqual(capture(() => title.set('should-not-appear')), '');
    } finally {
      if (realTTY) Object.defineProperty(process.stdout, 'isTTY', realTTY);
      else delete process.stdout.isTTY;
    }
  });

  await test('TITLE: LAIN_NO_TITLE turns it off entirely', () => {
    const prev = process.env.LAIN_NO_TITLE;
    process.env.LAIN_NO_TITLE = '1';
    try { assert.strictEqual(title.enabled(), false); }
    finally { if (prev === undefined) delete process.env.LAIN_NO_TITLE; else process.env.LAIN_NO_TITLE = prev; }
  });

  await test('TITLE: the UI drives it from the same state it draws', () => {
    // Not a second source of truth: if it could describe a different session
    // than the screen, it would be worse than having no title at all.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'ui', 'index.js'), 'utf8');
    assert.match(src, /_title\(s\)/, 'the title is composed from the draw snapshot');
    assert.match(src, /termtitle\.restore\(\)/, 'and the tab is handed back on disable()');
  });
};
