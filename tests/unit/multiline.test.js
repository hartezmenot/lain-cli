'use strict';

/**
 * MULTILINE INPUT —.
 *
 * THE DEFECT: there was no way to type a newline. `\r` and `\n` both submitted,
 * so a multi-line prompt could only ever arrive by PASTE. Everything downstream
 * was already ready for one — the editor could move through, edit and delete
 * across the lines of a pasted buffer — and only the keystroke was missing.
 *
 * THREE SPELLINGS, because terminals genuinely disagree and there is no
 * portable one:
 *
 *     Ctrl+J          a bare LF. Every terminal can send it. TTY ONLY.
 *     Alt/Shift+Enter ESC CR / ESC LF — xterm, iTerm, VS Code.
 *     CSI-u           ESC[13;2u — Windows Terminal, kitty, foot, WezTerm.
 *
 * THE TTY CONDITION ON CTRL+J IS THE DANGEROUS PART and has its own test. Piped
 * input is a stream of lines separated by exactly that byte: if LF meant
 * "insert a newline" on a pipe, nothing would ever submit and every test in the
 * suite that pipes a prompt would hang.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');

const { Input } = require('../../src/input');
const views = require('../../src/ui/views');
const { Screen } = require('../../src/ui/layout');

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function reader({ tty = true } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = tty;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};
  const written = [];
  const input = new Input({ stdin, stdout: { write: (s) => written.push(s) } });
  input.echo = false;
  input.start();
  const sent = [];
  input.on('input', (ev) => sent.push(ev));
  return {
    input, sent, written,
    type: (s) => stdin.emit('data', Buffer.from(s, 'utf8')),
  };
}

module.exports = async function () {
  // --------------------------------------------------- TYPING A NEW LINE --

  await test('MULTILINE: Ctrl+J inserts a newline and does NOT submit', () => {
    const r = reader();
    r.type('one');
    r.type(LF);
    r.type('two');
    assert.strictEqual(r.input.line, `one${LF}two`);
    assert.strictEqual(r.sent.length, 0, 'nothing may be sent until Enter');
    r.type(CR);
    assert.deepStrictEqual(r.sent.map((s) => s.text), [`one${LF}two`]);
    assert.strictEqual(r.sent[0].lines, 2, 'and it arrives as ONE input of two lines');
  });

  await test('MULTILINE: Alt/Shift+Enter (ESC CR) inserts a newline', () => {
    const r = reader();
    r.type(`a${ESC}${CR}b${ESC}${LF}c${CR}`);
    assert.deepStrictEqual(r.sent.map((s) => s.text), [`a${LF}b${LF}c`]);
  });

  await test('MULTILINE: the CSI-u report inserts a newline, whatever the modifier', () => {
    // `;2` is Shift, `;3` Alt, `;5` Ctrl. All of them mean "you asked for a
    // break" — refusing the others would be a key that works on one terminal's
    // configuration and not the next.
    for (const mod of ['2', '3', '5']) {
      const r = reader();
      r.type(`x${ESC}[13;${mod}uy${CR}`);
      assert.deepStrictEqual(r.sent.map((s) => s.text), [`x${LF}y`], `modifier ${mod}`);
    }
  });

  await test('MULTILINE: on a PIPE a bare LF still ends the line', () => {
    // The dangerous half. A pipe has no Ctrl+J to press, and every prompt the
    // test suite pipes is separated by exactly this byte.
    const r = reader({ tty: false });
    r.type(`first${LF}second${LF}`);
    assert.deepStrictEqual(r.sent.map((s) => s.text), ['first', 'second']);
  });

  await test('MULTILINE: an ESC newline works on a pipe too, so it stays testable', () => {
    const r = reader({ tty: false });
    r.type(`a${ESC}${CR}b${LF}`);
    assert.deepStrictEqual(r.sent.map((s) => s.text), [`a${LF}b`]);
  });

  // --------------------------------------------------------- EDITING IT --

  await test('MULTILINE: backspace deletes across a line break', () => {
    const r = reader();
    r.type(`ab${LF}`);
    r.type('\x7f');                      // backspace over the newline
    assert.strictEqual(r.input.line, 'ab');
  });

  await test('MULTILINE: Home and End work on the CURRENT line, not the buffer', () => {
    const r = reader();
    r.type(`alpha${LF}beta`);
    r.input.cursorHome();
    assert.strictEqual(r.input.cursor, 6, 'the start of "beta", not of the buffer');
    r.input.cursorEnd();
    assert.strictEqual(r.input.cursor, 10, 'the end of "beta"');
  });

  await test('MULTILINE: up and down move between lines BEFORE reaching history', () => {
    const r = reader();
    // Through the real API. Pushing onto `history` directly leaves `histIndex`
    // at 0, and `recallPrev` refuses at 0 — so the test would have "proved"
    // that history never fires, which is not what the reader does.
    r.input.remember('an older prompt');
    r.type(`one${LF}two`);
    assert.strictEqual(r.input.editKey('up'), true);
    assert.ok(r.input.line.startsWith('one'), `history stole the key: ${JSON.stringify(r.input.line)}`);
    assert.ok(r.input.cursor <= 3, 'the caret moved to the first line');
    // At the TOP of the buffer there is nowhere further to go, so ↑ is history.
    r.input.editKey('up');
    assert.strictEqual(r.input.line, 'an older prompt');
  });

  await test('MULTILINE: a pasted buffer stays multi-line and is one input', () => {
    const r = reader();
    r.type(`${ESC}[200~one${LF}two${LF}three${ESC}[201~`);
    assert.strictEqual(r.input.line, `one${LF}two${LF}three`);
    r.type(CR);
    assert.strictEqual(r.sent.length, 1);
    assert.strictEqual(r.sent[0].text, `one${LF}two${LF}three`);
    assert.strictEqual(r.sent[0].isPaste, true, 'and it is still known to be a paste');
  });

  await test('MULTILINE: a multi-line prompt can never be read as a command', () => {
    // `looksLikeCommand` already refuses anything containing a newline, which
    // is what stops `/help\nmore text` from running a command.
    const commands = require('../../src/commands');
    assert.strictEqual(commands.looksLikeCommand(`/help${LF}and more`), false);
    assert.strictEqual(commands.looksLikeCommand('/help'), true);
  });

  // -------------------------------------------------------- SHOWING IT --

  await test('BOX: the input box grows with the buffer, and is bounded', () => {
    const screen = new Screen({ out: { columns: 90, rows: 40, write() {} } });
    screen.inputText = 'one';
    const one = screen.geometry().inputRows;
    screen.inputText = `one${LF}two${LF}three`;
    const three = screen.geometry().inputRows;
    // ---- THE REGION HAS A THREE-ROW FLOOR -------------------------------
    //
    // So a one-line prompt already occupies three rows, with the text centred in
    // them (ui/inputbox.js `topPad`). The floor is what gives a borderless composer
    // a shape without drawing anything around it, and the centring is what stops
    // that shape reading as a box that failed to fill. It still GROWS past the
    // floor — see the long-prompt case below.
    assert.strictEqual(one, 3, 'the composer is never a single-row strip');
    assert.strictEqual(three, 3, 'and three lines of text fill the three rows it has');
    // AND IT STILL GROWS PAST THE FLOOR, which is the property this test is named
    // for. Three lines FILL the three rows the floor already gave; four need a
    // fourth.
    screen.inputText = `one${LF}two${LF}three${LF}four`;
    assert.ok(screen.geometry().inputRows > three, 'the region grows with the buffer');

    screen.inputText = new Array(200).fill('x').join(LF);
    const huge = screen.geometry().inputRows;
    assert.ok(huge <= 11, `a 200-line paste took ${huge} rows and would eat the conversation`);
  });

  await test('BOX: it never takes so much that the workspace disappears', () => {
    for (const rows of [8, 10, 14, 24, 40, 60]) {
      const screen = new Screen({ out: { columns: 80, rows, write() {} } });
      screen.inputText = new Array(50).fill('line').join(LF);
      const g = screen.geometry();
      assert.ok(g.workspace >= 1, `at ${rows} rows the workspace vanished`);
      assert.ok(g.headerRows + g.workspace + g.statusRows + g.inputRows + g.panelRows <= rows,
        `at ${rows} rows the regions total more than the terminal`);
    }
  });

  await test('BOX: there is no summary row — the region is one region', () => {
    // ------------------------------------------------------------------
    // `pasteSummary` DREW AN EXTRA ROW UNDER THE INPUT BOX reading
    // `⎘ 1,200 lines · 41.2 KB · "Traceback…"`, because the box drew the whole
    // paste and a person could not tell how much of it there was.
    //
    // The composer collapses the paste instead (ui/composer.js), so there is
    // no wall to describe: the marker says a block is there and its size rides
    // beside it on the caret's own row. A region that is one region does not
    // need a second row about itself.
    // ------------------------------------------------------------------
    assert.strictEqual(typeof views.pasteSummary, 'undefined', 'the summary row must not come back');
    assert.strictEqual(typeof require('../../src/ui/viewport').pasteSummary, 'undefined');
    // AND THE REGION IS THE ROWS ITS TEXT OCCUPIES, with no border either.
    const { Screen } = require('../../src/ui/layout');
    const s2 = new Screen({ out: { columns: 80, rows: 30, isTTY: true, write() {}, on() {}, removeListener() {} } });
    s2.inputText = 'one short prompt';
    // THREE ROWS, which is the composer's floor and not three rows ABOUT the
    // composer. Nothing here describes the region; it is simply less cramped.
    assert.strictEqual(s2.geometry().inputRows, 3, 'one line of text sits in a three-row region');
  });

  await test('BOX: lineCount is the one answer to "how many lines"', () => {
    assert.strictEqual(views.lineCount(''), 1, 'an empty buffer still has a row to draw');
    assert.strictEqual(views.lineCount('a'), 1);
    assert.strictEqual(views.lineCount(`a${LF}b${LF}c`), 3);
    assert.strictEqual(views.lineCount(`trailing${LF}`), 2);
  });

  // -------------------------------------------------------- COPYING IT --

  await test('COPY: a multi-line prompt keeps its newlines', () => {
    //. Whatever `/copy` hands to the clipboard must be the text itself.
    const T = require('../../src/ui/text');
    const prompt = `line one${LF}line two${LF}line three`;
    assert.strictEqual(T.strip(prompt), prompt, 'stripping colour must not touch structure');
  });
};
