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
  await test('TITLE: idle is the PROJECT and nothing else', () => {
    // ------------------------------------------------------------------
    // THIS FILE HAS ASSERTED BOTH SIDES OF THE BRANDING QUESTION, twice each,
    // because it is a preference and the person looking at the taskbar owns it.
    // The current answer: the product name is not in the title. Which program
    // is running is answered by looking at the window; WHICH PROJECT and
    // WHETHER IT IS STILL GOING are not.
    // ------------------------------------------------------------------
    assert.strictEqual(title.compose({ folder: 'scalppbot' }), 'scalppbot');
    assert.ok(!/LAIN/.test(title.compose({ folder: 'scalppbot' })), 'no branding in the title');
    assert.strictEqual(title.compose({ folder: '' }), 'LAIN',
      'with no project at all the title has to say something, and this is the one place it says LAIN');
  });

  await test('TITLE: working is a SPINNER, and it turns', () => {
    const a = title.compose({ folder: 'p', state: title.STATE.WORKING, now: 0 });
    const b = title.compose({ folder: 'p', state: title.STATE.WORKING, now: title.SPIN_MS });
    assert.notStrictEqual(a, b, 'consecutive frames must differ, or it is not a spinner');
    assert.ok(title.SPIN.includes(a.split(' ')[0]), 'and the glyph comes from the one cycle');
    assert.strictEqual(a.split(' ')[1], 'p', 'the folder follows the glyph');
    // The verbose state word is deliberately NOT in it — that lives on the row
    // above the caret, where there is room for a sentence.
    for (const w of ['VERIFYING', 'READING', 'THINKING', 'Verifying', 'Reading']) {
      assert.ok(!a.includes(w), 'the title must not carry the state word: ' + w);
    }
  });

  await test('TITLE: success, paused and failure each get their own mark', () => {
    assert.strictEqual(title.compose({ folder: 'p', state: title.STATE.SUCCESS }), title.TICK + ' p');
    assert.strictEqual(title.compose({ folder: 'p', state: title.STATE.PAUSED }), title.PAUSE + ' p');
    assert.strictEqual(title.compose({ folder: 'p', state: title.STATE.ERROR }), title.CROSS + ' p');
    assert.strictEqual(title.compose({ folder: 'p', state: title.STATE.IDLE }), 'p');
  });

  await test('TITLE: the five states are classified from the LIVE ROW, in precedence order', () => {
    const S = title.STATE;
    // WORKING — the operational phases, all of which arrive with `spin`.
    for (const word of ['READING', 'THINKING', 'WRITING', 'RUNNING', 'VERIFYING', 'OBSERVING', 'SEARCHING']) {
      assert.strictEqual(title.stateOf({ word, spin: true, colour: 'info' }), S.WORKING, word);
    }
    // PAUSED OUTRANKS WORKING, and the rate limit is the case that proves it:
    // a retry wait carries `spin: true` because on the status row it is a live
    // countdown you can watch. A glyph rotating for four hours while every
    // request is refused is the most misleading thing this could show.
    for (const word of ['RATE LIMITED', 'WAITING FOR LIMIT RESET', 'RETRYING', 'NETWORK']) {
      assert.strictEqual(title.stateOf({ word, spin: true, colour: 'warn' }), S.PAUSED, word);
    }
    // And the rest of stopped: the user stopped it, or it is waiting on them.
    for (const word of ['INTERRUPTED', 'INTERRUPTING', 'BLOCKED', 'STOPPED', 'WAITING FOR YOU', 'ASKING USER']) {
      assert.strictEqual(title.stateOf({ word, colour: 'warn' }), S.PAUSED, word);
    }
    // ERROR OUTRANKS EVERYTHING. `bad` is the live row's own colour for the
    // states that are over and went wrong.
    for (const word of ['ERROR', 'FAILED', 'NOT AUTHENTICATED', 'CONTEXT FULL']) {
      assert.strictEqual(title.stateOf({ word, colour: 'bad' }), S.ERROR, word);
    }
    // SUCCESS IS THE TURN RECORD SAYING SO — `tick` is set on exactly one
    // branch of liveState, and never because output merely stopped arriving.
    assert.strictEqual(title.stateOf({ word: 'DONE', tick: true, colour: 'ok' }), S.SUCCESS);
    assert.strictEqual(title.stateOf({ word: 'NOT VERIFIED', colour: 'warn' }), S.IDLE,
      'a turn that ended with a failing check is neither a success nor stopped');
    // IDLE.
    assert.strictEqual(title.stateOf({ word: 'READY', colour: 'meta' }), S.IDLE);
    assert.strictEqual(title.stateOf(null), S.IDLE);
  });

  await test('TITLE: a spinner cannot invent work — the state decides the glyph', () => {
    // The animation is a consequence of redraws, and redraws happen while the
    // turn loop has a phase. Asking for a spinner frame of an IDLE state must
    // produce nothing at all, at any clock value.
    for (const now of [0, 250, 500, 1e9]) {
      assert.strictEqual(title.glyph(title.STATE.IDLE, now), '');
      assert.strictEqual(title.compose({ folder: 'p', state: title.STATE.IDLE, now }), 'p');
    }
  });

  await test('TITLE: a background job does not hold the spinner', () => {
    // The title represents the FOREGROUND interaction. A `/bg` task and a
    // running dev server do not set `ui.phase`, so the live row rests on READY
    // and the title goes quiet — which is what the projection reads.
    const { liveState } = require('../../src/ui/status');
    const idleWithJobs = liveState({
      phase: null,
      jobs: [{ id: '3', primary: false, state: 'RUNNING', request: 'the integration suite' }],
    });
    assert.strictEqual(title.stateOf(idleWithJobs), title.STATE.IDLE,
      'a taskbar glyph rotating for an hour because Vite is up is exactly the failure');
  });

  await test('TITLE: the success mark is transient — it hands the window back', () => {
    assert.ok(title.SUCCESS_MS > 0 && title.SUCCESS_MS <= 10000,
      'long enough to notice, short enough not to become the permanent title');
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'termtitle.js'), 'utf8');
    assert.match(src, /successTimer/, 'a single shot returns the title to idle');
    assert.match(src, /unref/, 'and it can never be the reason the process stays up');
  });

  await test('TITLE: an unusable terminal never affects execution', () => {
    // A title is chrome on someone else's window. Every failure path — no TTY,
    // a dumb TERM, a writer that throws — must be silent and must return.
    const realTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const prevTerm = process.env.TERM;
    process.env.TERM = 'xterm';
    try {
      title.setWriter(() => { throw new Error('the terminal hung up'); });
      assert.doesNotThrow(() => title.update({ folder: 'p', state: title.STATE.WORKING }));
      assert.strictEqual(title.update({ folder: 'q', state: title.STATE.ERROR }), false,
        'a rejected write is reported as "not written", never thrown');
    } finally {
      title.setWriter(null);
      if (realTTY) Object.defineProperty(process.stdout, 'isTTY', realTTY);
      else delete process.stdout.isTTY;
      if (prevTerm === undefined) delete process.env.TERM; else process.env.TERM = prevTerm;
    }
  });

  await test('TITLE: control characters and newlines can never reach the terminal', () => {
    // The folder name is not LAIN's to trust — it is whatever directory the
    // user launched in. An unescaped ESC in a title is a terminal injection,
    // not a cosmetic problem.
    const t = title.compose({ folder: 'a\x1b]0;pwned\x07b\nc' });
    assert.ok(!/[\x00-\x1f\x7f]/.test(t), JSON.stringify(t));
  });

  await test('TITLE: long text is clipped rather than filling the tab bar', () => {
    const t = title.compose({ folder: 'x'.repeat(200), state: title.STATE.WORKING });
    assert.ok(t.length <= 80, `${t.length} chars`);
  });

  await test('TITLE: both OSC 0 and OSC 2 are sent, BEL-terminated', () => {
    // Terminals disagree about which a TAB reads; BEL is the form all of them
    // accept. Forced past the TTY check, which a test process never satisfies.
    const prev = process.env.LAIN_NO_TITLE;
    const prevTerm = process.env.TERM;
    process.env.TERM = 'xterm';
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
      if (prevTerm === undefined) delete process.env.TERM; else process.env.TERM = prevTerm;
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
