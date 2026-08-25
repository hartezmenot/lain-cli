'use strict';

/**
 * WHAT ACTUALLY LANDS ON THE CLIPBOARD.
 *
 * THE FAILURE: text copied out of LAIN and pasted into PowerShell fails to run,
 * with an error that names a character nobody can see.
 *
 * The cause is that `/copy` stripped the wrong thing. `ui/text.strip` removes
 * SGR colour — `\x1b[32m` — and NOTHING ELSE, because that is all it was ever
 * written to do: it exists so `width()` can count columns. Everything else LAIN
 * or a subprocess emits survived it:
 *
 *   OSC        `\x1b]0;LAIN — proj\x07`   termtitle.js writes one per session,
 *              and it is visible in captured output as `]0;LAIN — …`
 *   CSI        `\x1b[K`, `\x1b[2J`        cursor and erase, from any subprocess
 *   PASTE      `\x1b[200~` / `\x1b[201~`  bracketed-paste markers
 *   ZERO WIDTH U+200B, U+FEFF            invisible, and a parse error each
 *   NBSP       U+00A0                     looks like a space, is not one
 *
 * Worse, only three of the ten `/copy` sections were passed through `strip` at
 * all — `output`, `last`, `diff` and `context` went to the clipboard entirely
 * raw, and `output` is the one that carries a subprocess's own escapes.
 *
 * So the sanitising moved to the ONE place every section passes through on its
 * way out. What is asserted here is the property that matters: what reaches the
 * clipboard contains only what the user can see and meant to copy.
 */

const assert = require('assert');
const { test } = require('../helpers');

const copy = require('../../src/copy');

/** Anything invisible that would reach a shell and break it. */
const INVISIBLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/;

module.exports = async function () {
  await test('CLIP: SGR colour is removed, as it always was', () => {
    assert.strictEqual(copy.sanitize('\x1b[32mnpm test\x1b[0m'), 'npm test');
  });

  await test('CLIP: an OSC title is removed — LAIN writes one every session', () => {
    // termtitle.js sets the terminal title. It shows up in captured output as
    // `]0;LAIN — proj`, and pasted into PowerShell it is a parse error.
    assert.strictEqual(copy.sanitize('\x1b]0;LAIN — proj\x07npm test'), 'npm test');
    assert.strictEqual(copy.sanitize('\x1b]2;LAIN\x1b\\npm test'), 'npm test');
  });

  await test('CLIP: non-SGR CSI escapes are removed — strip() kept every one', () => {
    // The exact gap: `strip` matches `\x1b[...m` only, so erase, cursor motion
    // and everything else came through untouched.
    assert.strictEqual(copy.sanitize('npm test\x1b[K'), 'npm test');
    assert.strictEqual(copy.sanitize('\x1b[2J\x1b[Hnpm test'), 'npm test');
    assert.strictEqual(copy.sanitize('npm test\x1b[1;31;40m'), 'npm test');
  });

  await test('CLIP: bracketed-paste markers never reach the clipboard', () => {
    assert.strictEqual(copy.sanitize('\x1b[200~npm test\x1b[201~'), 'npm test');
  });

  await test('CLIP: zero-width characters and the BOM are removed', () => {
    // Invisible on screen, and each one its own "unexpected token" in a shell.
    assert.strictEqual(copy.sanitize('npm\u200btest'), 'npmtest');
    assert.strictEqual(copy.sanitize('\ufeffnpm test'), 'npm test');
    assert.strictEqual(copy.sanitize('npm\u2060 test'), 'npm test');
  });

  await test('CLIP: a non-breaking space becomes a REAL space, not nothing', () => {
    // It is a word separator that looks exactly like one and is not one.
    // Deleting it would silently join two arguments into a different command,
    // so it is replaced rather than removed.
    assert.strictEqual(copy.sanitize('npm\u00a0test'), 'npm test');
    assert.strictEqual(copy.sanitize('npm\u2009run\u3000dev'), 'npm run dev');
  });

  await test('CLIP: CRLF is normalised so a pasted block is not double-spaced', () => {
    assert.strictEqual(copy.sanitize('a\r\nb\rc'), 'a\nb\nc');
  });

  await test('CLIP: what the user can SEE is never touched', () => {
    // The sanitiser must not become a second, silent editor of the content.
    // Box drawing, punctuation, symbols and non-ASCII prose are all things
    // somebody deliberately copied.
    for (const keep of [
      'npm run dev  # starts on :3000',
      'PS C:\\Users\\me> Get-ChildItem -Path . -Recurse',
      '┌─ DIFF ─┐  │ +72 -40 │  └────────┘',
      'echo "héllo wörld — ✓ 100% ≥ 5"',
      "grep -rn 'foo|bar' src/ | head -20",
      'a\tb\nc',
    ]) {
      assert.strictEqual(copy.sanitize(keep), keep, `must pass through unchanged: ${keep}`);
    }
  });

  await test('CLIP: the result carries NOTHING invisible, whatever went in', () => {
    // The property, stated once over everything above at the same time.
    const nasty = '\x1b]0;t\x07\x1b[32m\x1b[200~npm\u00a0run\u200b dev\x1b[201~\x1b[0m\x1b[K\r\n\ufeffnpm test\x07';
    const out = copy.sanitize(nasty);
    assert.ok(!INVISIBLE.test(out), `something invisible survived: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('\x1b'), 'no escape may survive');
    assert.strictEqual(out, 'npm run dev\nnpm test');
  });

  await test('CLIP: it is total — null, undefined and numbers do not throw', () => {
    // It sits on the one path every section leaves by, so it must never be the
    // thing that turns "copy this" into a stack trace.
    for (const v of [null, undefined, 0, 42, '', false]) {
      assert.strictEqual(typeof copy.sanitize(v), 'string');
    }
  });


  await test('CLIP: EVERY section is sanitised, not the three that used to be', async () => {
    // `activity`, `audit` and `health` called `plain()`; `output`, `last`,
    // `diff` and `context` went out RAW — and `output` is the one carrying a
    // subprocess's own escape sequences. Asserted through `collect`, which is
    // the door every section actually leaves by.
    const app = {
      session: {
        cwd: process.cwd(),
        turns: [{ text: '\x1b[32mdone\x1b[0m​' }],
        messages: [{ role: 'user', content: '\x1b]0;x\x07hello' }],
        task: null, plan: null, lifecycle: null,
      },
      render: { transcript: [] },
      checkpoints: null,
      ui: {
        outputs: [{ command: '\x1b[1mnpm test\x1b[0m', output: 'ok\x1b[K', exitCode: 0 }],
        liveActions: [], liveNarration: [],
      },
    };
    for (const name of ['last', 'output', 'context']) {
      const r = await copy.collect(app, name);
      assert.ok(r.text, `${name} should have produced something`);
      assert.ok(!r.text.includes('\x1b'), `${name} let an escape through`);
      assert.ok(!INVISIBLE.test(r.text), `${name} let something invisible through`);
    }
  });
};
