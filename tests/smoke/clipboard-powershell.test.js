'use strict';

/**
 * COPIED FROM LAIN, PASTED INTO POWERSHELL, AND IT RUNS.
 *
 * THE REPORTED FAILURE: a command copied out of LAIN fails when pasted into
 * PowerShell, with an error that does not match anything visible in the text.
 * That is the signature of an INVISIBLE character — a non-breaking space where
 * a separator should be, a zero-width joiner inside a flag, a stray escape
 * sequence, a carriage return in the middle of a line. Every one of them is
 * invisible in a terminal and fatal to a parser.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TEST SPAWNS A REAL SHELL.
 *
 * `copy.sanitize` already has unit tests, and they assert the right things —
 * but they assert them against a REGEX. A regex proves the characters the test
 * author thought of are gone. It cannot prove the result is something
 * PowerShell will accept, which is the actual claim being made when LAIN puts
 * text on the clipboard.
 *
 * So this takes a command line decorated exactly as the terminal decorates it,
 * runs it through the real sanitiser, and then hands the result to a real
 * PowerShell and checks what it printed. If an invisible character survives,
 * PowerShell says so and this fails — which is the whole point.
 *
 * SKIPS ITSELF where there is no PowerShell. A test that cannot run must say
 * so rather than pass quietly; see the note it prints.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { test, tmpdir } = require('../helpers');
const copy = require('../../src/copy');

/** Is there a PowerShell on this machine at all? */
function powershell() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'Write-Output ok'],
      { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && /ok/.test(r.stdout || '')) return exe;
  }
  return null;
}

/**
 * Run a command line through PowerShell exactly as a paste would — IN A CELL.
 *
 * WHY THE CELL, and it is not caution for its own sake. The negative test below
 * hands PowerShell a deliberately mangled line, and PowerShell does not stop at
 * the first thing it cannot resolve: it goes on parsing, and any bare word left
 * standing is looked up as a command. On a machine where `lain` is on PATH, the
 * OSC title (an ESC, then ]0;LAIN) left the word LAIN behind and PowerShell RAN
 * IT — a real LAIN turn, inheriting this process's `LAIN_PROVIDER=mock` and
 * `LAIN_MOCK_SCRIPT`, which executed that script's `write_file` INTO THE
 * REPOSITORY ROOT. Found by bisecting a stray file out of a full suite run.
 *
 * So the child gets a temporary directory to run in and an environment with
 * every `LAIN_*` variable removed. Whatever the garbage resolves to on somebody
 * else's PATH, it cannot reach the working tree and it cannot be steered by
 * this process's state.
 */
function run(exe, command) {
  const cwd = tmpdir('lain-clip-ps-');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('LAIN_')) delete env[k];
  // ---- A DELIBERATELY BROKEN LINE MUST NOT BE ABLE TO WEDGE THE SUITE ----
  //
  // MEASURED, not imagined: this test feeds PowerShell a line decorated with
  // control characters ON PURPOSE, and on one run the shell decided the garbage
  // opened a construct it needed more input to finish. `spawnSync` with no
  // stdin and no timeout then blocked FOREVER — the whole smoke tier stopped at
  // test 83 and stayed there for half an hour with nothing to show for it.
  //
  // `input: ''` closes stdin, so a shell waiting for more gets EOF and exits.
  // The timeout is the belt to that brace: whatever a future PowerShell does
  // with a future decoration, it costs this test twenty seconds rather than the
  // run. A killed child returns a non-zero status, which is exactly what the
  // assertions here already treat as "the broken line did not work".
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', cwd, env, windowsHide: true, input: '', timeout: 20000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, cwd };
}

/**
 * A command line wearing every decoration the terminal puts on one.
 *
 * Each of these is something that really reaches the clipboard: SGR colour from
 * the renderer, the OSC title LAIN writes once a session, the bracketed-paste
 * markers the input layer emits, a non-breaking space from column alignment, a
 * zero-width space, and a CR from a Windows line ending.
 */
const DECORATED = '\x1b]0;LAIN — proj\x07'
  + '\x1b[200~'
  + '\x1b[32mWrite-Output\x1b[0m "lain​-ok"\r'
  + '\x1b[201~\x1b[K';

module.exports = async function () {
  const exe = powershell();

  await test('CLIP → PS: the sanitised line RUNS, and prints what it should', () => {
    if (!exe) {
      // NOT A PASS. Said out loud, because a skipped check that reads as green
      // is how an untested path ships.
      process.stdout.write('      (no PowerShell on this machine — NOT VERIFIED here)\n');
      return;
    }
    const clean = copy.sanitize(DECORATED);
    const r = run(exe, clean);
    assert.strictEqual(r.code, 0, `PowerShell refused the sanitised line:\n  ${JSON.stringify(clean)}\n${r.out}`);
    assert.match(r.out, /lain-ok/, `the command ran but printed the wrong thing:\n${r.out}`);
  });

  await test('CLIP → PS: THE UNSANITISED LINE REALLY DOES FAIL — the bug is real', () => {
    // Without this the test above proves nothing: a sanitiser that did nothing
    // at all would pass it if PowerShell happened to tolerate the input.
    if (!exe) {
      process.stdout.write('      (no PowerShell on this machine — NOT VERIFIED here)\n');
      return;
    }
    const r = run(exe, DECORATED);
    const broken = r.code !== 0 || !/lain-ok/.test(r.out);
    assert.ok(broken, 'the decorated line was accepted, so this test is no longer measuring anything');
    // AND IT STAYED IN ITS CELL. Whatever PowerShell made of the garbage, it
    // must not have reached the working tree — see `run` for the day it did.
    const repo = path.join(__dirname, '..', '..');
    assert.ok(!fs.existsSync(path.join(repo, 'out')),
      'the decorated line executed something that wrote into the repository');
  });

  await test('CLIP → PS: the visible text is preserved exactly — only the invisible goes', () => {
    // A sanitiser that fixed the paste by mangling the command would be worse
    // than the bug. The characters a person can SEE must survive unchanged.
    // The lone CR becomes a real newline rather than vanishing — a line ending
    // is content, and swallowing it would join two commands into one.
    const clean = copy.sanitize(DECORATED);
    assert.strictEqual(clean, 'Write-Output "lain-ok"\n', JSON.stringify(clean));
  });

  await test('CLIP → PS: nothing invisible survives, whatever the decoration', () => {
    const clean = copy.sanitize(DECORATED);
    assert.ok(!/\x1b/.test(clean), 'an escape sequence survived');
    assert.ok(!/[​-‏⁠-⁤﻿]/.test(clean), 'a zero-width character survived');
    assert.ok(!/ /.test(clean), 'a non-breaking space survived');
    assert.ok(!/\r/.test(clean), 'a carriage return survived');
  });

  // -------------------------------------------------- the transport itself --

  /**
   * THE GAP EVERY TEST ABOVE LEFT OPEN, and a real user fell into it.
   *
   * Everything in this file, and everything in tests/unit/clipboard.test.js,
   * asserts on `sanitize`. `sanitize` was right — it strips U+FEFF, and one of
   * those tests is literally called "zero-width characters and the BOM are
   * removed". Then `toClipboard` prepended a fresh U+FEFF as a UTF-16 byte-order
   * mark for clip.exe, which does not consume one, so the clipboard held an
   * invisible character the sanitiser had just removed. What the user got was
   *
   *     powershell : The term 'powershell' is not recognized...
   *
   * with U+FEFF glued to the front of the command. Fifteen passing tests, and
   * not one of them looked at the clipboard.
   *
   * So this asserts on the CLIPBOARD, which is the thing being promised.
   */
  await test('CLIP → PS: what actually lands on the clipboard carries NO byte-order mark', () => {
    if (!exe) {
      process.stdout.write('      (no PowerShell on this machine — NOT VERIFIED here)\n');
      return;
    }
    // POLITE ABOUT SOMEBODY ELSE'S CLIPBOARD. It belongs to the person running
    // the suite; whatever is on it is put back.
    const before = copy.fromClipboard();
    try {
      const CMD = 'powershell -NoProfile -Command "Write-Output lain-clip-ok"';
      const put = copy.toClipboard(CMD);
      if (!put.ok) {
        process.stdout.write(`      (no clipboard on this machine: ${put.error} — NOT VERIFIED here)\n`);
        return;
      }
      const back = copy.fromClipboard();
      assert.ok(back.ok, `the clipboard could not be read back: ${back.error}`);
      assert.notStrictEqual(back.text.charCodeAt(0), 0xfeff,
        'a byte-order mark reached the clipboard as CONTENT — this is the reported bug');
      assert.strictEqual(back.text, CMD,
        `the clipboard must hold exactly what was copied: ${JSON.stringify(back.text.slice(0, 60))}`);
      // AND IT RUNS, which is the claim the clipboard is making.
      const r = run(exe, back.text);
      assert.strictEqual(r.code, 0, `PowerShell refused what LAIN copied:\n${r.out}`);
      assert.match(r.out, /lain-clip-ok/);
    } finally {
      if (before && before.ok && before.text) copy.toClipboard(before.text);
    }
  });

  await test('CLIP → PS: and non-ASCII survives the trip, which is why the BOM was there', () => {
    // The BOM was not arbitrary: piping UTF-8 to clip.exe turns an arrow into
    // three console-codepage letters. Removing it must not bring that back, so
    // the replacement is asserted rather than assumed — including on text with
    // no ASCII in it at all, where a byte-pattern heuristic has nothing to see.
    if (!exe) {
      process.stdout.write('      (no PowerShell on this machine — NOT VERIFIED here)\n');
      return;
    }
    const before = copy.fromClipboard();
    try {
      for (const sample of ['npm test → café ✓', '日本語のテキスト']) {
        const put = copy.toClipboard(sample);
        if (!put.ok) return;
        const back = copy.fromClipboard();
        assert.ok(back.ok, back.error);
        assert.strictEqual(back.text, sample,
          `mangled on the way to the clipboard: ${JSON.stringify(back.text)}`);
      }
    } finally {
      if (before && before.ok && before.text) copy.toClipboard(before.text);
    }
  });

};
