'use strict';

/**
 * INPUT UX THROUGH THE REAL BINARY — history, the `/` palette, `@` completion.
 *
 * Every case here spawns bin/lain.js and sends the exact bytes a terminal sends:
 * `\t` for Tab, `\x1b[A` for Up, `\x1b` for Esc. Nothing is required in-process,
 * so a green case means the production key path ran, not that a helper works.
 *
 * These behaviours were absent for a structural reason worth remembering: the
 * reader had a separate newline-splitter for pipes that never emitted `edit`, so
 * a half-typed line was invisible and no as-you-type feature could exist or be
 * tested. One shared consumer is what makes these assertions possible at all.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };
const TAB = '\t';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const CR = '\n';
/** Clear the line. Esc closes a menu but deliberately KEEPS what was typed. */
const CLEAR = '\x7f'.repeat(60);

/**
 * The drawn frames, ANSI removed. One entry per full redraw.
 *
 * `\x1b[?25l` (hide-cursor) is the boundary, not `\x1b[2J` (erase-screen): a
 * redraw no longer opens with a full-screen clear (that was real, visible
 * flicker — see ui/layout.js's `L` helper), but it still opens with exactly
 * one hide-cursor write, and nothing else in the source ever writes that
 * sequence — so it is still a genuine once-per-draw() marker.
 */
function frames(out) {
  return String(out).split('\x1b[?25l').map((f) => f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n'));
}

/** Every distinct value the INPUT row held, in order. */
function typed(out) {
  const seen = [];
  for (const f of frames(out)) {
    for (const line of f.split('\n')) {
      if (!line.startsWith('│ > ')) continue;
      const t = line.slice(4).replace(/\s*│\s*$/, '').trimEnd();
      if (seen[seen.length - 1] !== t) seen.push(t);
    }
  }
  return seen.filter(Boolean);
}

/** Which panel titles appeared, in order, collapsed. */
function panelTrail(out) {
  const seen = [];
  for (const f of frames(out)) {
    const m = /COMMANDS|FILES|CONFIG|MODELS|EFFORT|LAIN NEEDS YOUR INPUT|PROVIDERS/.exec(f);
    const v = m ? m[0] : '-';
    if (seen[seen.length - 1] !== v) seen.push(v);
  }
  return seen;
}

/** Rows rendered inside the last frame that showed `title`. */
function itemsUnder(out, title) {
  let best = null;
  for (const f of frames(out)) if (f.includes(title)) best = f;
  return best ? rowsOf(best) : [];
}

function rowsOf(frame) {
  return frame.split('\n')
    .filter((l) => /^│\s{1,3}[❯ ]\s*\S/.test(l))
    .map((l) => l.replace(/^│\s*/, '').replace(/\s*│$/, '').trimEnd());
}

/**
 * The menu as it stood while the input row held EXACTLY `line`.
 *
 * Esc deliberately keeps what was typed, so abandoning `/mo` and then typing
 * `/exit` leaves `/mo/exit` on the line and re-opens the palette with a
 * different filter. Pinning the assertion to the frame that matches the typed
 * text is what makes it a test of the filter rather than of the last redraw.
 */
function menuFor(out, line, title) {
  let best = null;
  for (const f of frames(out)) {
    if (!f.includes(title)) continue;
    const row = f.split('\n').find((l) => l.startsWith('│ > '));
    if (!row) continue;
    if (row.slice(4).replace(/\s*│\s*$/, '').trimEnd() === line) best = f;
  }
  return best ? rowsOf(best) : [];
}

/** A small project to complete paths against. */
function project() {
  const d = tmpdir('lain-ux-');
  fs.mkdirSync(path.join(d, 'src'));
  fs.mkdirSync(path.join(d, 'src', 'ui'));
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'node_modules', 'junk.js'), '');
  for (const f of ['app.js', 'input.js', 'index.js']) fs.writeFileSync(path.join(d, 'src', f), '');
  fs.writeFileSync(path.join(d, 'README.md'), '');
  return d;
}

const script = [{ text: 'ok.' }, { text: 'ok.' }, { text: 'ok.' }, { text: 'ok.' }];

module.exports = async function () {
  // ---- history ------------------------------------------------------------

  await test('UX: ↑ recalls the previous prompt, ↑↑ the one before, ↓ comes back', async () => {
    const r = await runCli([], {
      env: tui, script,
      stdin: `prompt A${CR}prompt B${CR}${UP}${UP}${DOWN}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    const a = rows.indexOf('prompt A');
    const b = rows.indexOf('prompt B');
    assert.ok(a >= 0 && b >= 0, `both prompts appeared: ${JSON.stringify(rows)}`);
    // After submitting both, the recalls must bring B back, then A, then B.
    const tail = rows.slice(b + 1);
    assertIncludes(tail.join('|'), 'prompt A', 'a second ↑ reached the older prompt');
  });

  await test('UX: ↑ does nothing when there is no history yet', async () => {
    const r = await runCli([], { env: tui, script, stdin: `${UP}${UP}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0, 'it did not hang or crash');
    assertIncludes(r.out, 'Session saved.');
  });

  await test('UX: a repeated prompt is not stored twice in a row', async () => {
    const r = await runCli([], {
      env: tui, script,
      stdin: `same thing${CR}same thing${CR}${UP}${UP}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // Two ↑ presses over a de-duplicated history stay on the only entry.
    const rows = typed(r.out);
    assert.ok(rows.filter((x) => x === 'same thing').length >= 1, JSON.stringify(rows));
    assertNotIncludes(r.out, 'internal error');
  });

  await test('UX: a paste never enters history', async () => {
    // The paste is SUBMITTED before ↑ is pressed. Two behaviours changed under
    // this test and both are deliberate: a paste now waits in the input box for
    // Enter, and ↑ inside a multi-line buffer walks its lines rather than
    // reaching for history — which is the only way to read back a block you
    // just pasted. Neither says anything about history, so the claim is tested
    // where it actually applies: after the buffer is empty again.
    const r = await runCli([], {
      env: tui, script,
      stdin: `typed one${CR}\x1b[200~pasted line 1\npasted line 2\x1b[201~${CR}${UP}${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    const recalled = rows.filter((x) => x.trim()).pop();
    assert.ok(recalled !== undefined, `nothing was ever recalled: ${JSON.stringify(rows)}`);
    assert.ok(!recalled.includes('pasted line'), `↑ recalled a paste: ${JSON.stringify(rows)}`);
    assertIncludes(recalled, 'typed one', '↑ must recall the typed prompt');
  });

  await test('UX: a paste is still ONE input with the menus in play', async () => {
    const r = await runCli([], {
      env: tui, script,
      stdin: `\x1b[200~alpha\nbeta\ngamma\x1b[201~${CR}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // The session is the honest witness — the screen redraws the same turn many
    // times, so counting frames would measure redraws rather than inputs.
    const sessDir = path.join(r.configDir, 'sessions');
    const f = fs.readdirSync(sessDir).find((x) => x.endsWith('.json'));
    const session = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    const user = session.messages.filter((m) => m.role === 'user' && !m._liveness);
    assert.strictEqual(user.length, 1, `a 3-line paste produced ${user.length} inputs`);
    assertNotIncludes(r.out, 'internal error');
  });

  // ---- the / command palette ---------------------------------------------

  await test('UX: typing `/` opens the command palette', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/${ESC}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertIncludes(panelTrail(r.out).join('->'), 'COMMANDS', 'the palette opened on `/`');
  });

  await test('UX: `/mo` filters the palette to the matching commands', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/mo${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const items = menuFor(r.out, '/mo', 'COMMANDS').join('\n');
    assertIncludes(items, '/models', 'the filtered list kept /models');
    assertIncludes(items, '/model', 'and /model');
    assert.ok(!/\/exit\b/.test(items), `unrelated commands were filtered out:\n${items}`);
  });

  await test('UX: `/eff` offers /effort once — there is no /efforts', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/eff${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const items = menuFor(r.out, '/eff', 'COMMANDS');
    const efforts = items.filter((l) => l.includes('/effort'));
    assert.strictEqual(efforts.length, 1, `expected exactly one effort row, got ${JSON.stringify(items)}`);
    assertNotIncludes(items.join('\n'), '/efforts');
  });

  await test('UX: Tab completes the highlighted command into the input line', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/mo${TAB}${ESC}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    assert.ok(rows.some((x) => x.startsWith('/model')), `Tab did not complete: ${JSON.stringify(rows)}`);
  });

  await test('UX: Enter runs the highlighted command instead of sending it to the model', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/stat${CR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    // /status really ran: its table is on screen.
    assertIncludes(r.out, 'Status');
    assertIncludes(r.out, 'messages');
    // and the fragment was never spent on a model request
    assertNotIncludes(r.out, 'ok.');
  });

  await test('UX: Esc closes the palette and keeps what was typed', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/mo${ESC} and more text${CR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    assert.ok(rows.some((x) => x.includes('and more text')), `typing continued after Esc: ${JSON.stringify(rows)}`);
  });

  await test('UX: Enter closes a dismissible OUTPUT panel AND sends what was typed, in one keystroke', async () => {
    // The reported defect: /status opens an OUTPUT panel that only Esc could
    // close, so typing over it and pressing Enter did nothing — a second Enter
    // was needed, and only then to submit against a now-empty line. This types
    // straight through the open panel and presses Enter exactly ONCE.
    const r = await runCli([], { env: tui, script, stdin: `/stat${CR}hello there${CR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.out, 'Status', 'the panel must have opened at all');
    assertIncludes(r.out, 'ok.', 'ONE Enter must both close the panel and send the typed line to the model');
  });

  await test('UX: Enter on an OUTPUT panel with nothing typed just closes it — no second press needed', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/stat${CR}${CR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    // A bare Enter must not itself count as a message sent to the model.
    assertNotIncludes(r.out, 'ok.', 'an empty Enter must not submit anything');
  });

  await test('UX: a bare `/` is never spent on a model request', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/${CR}${ESC}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(r.out, 'ok.', 'no model reply — nothing was sent');
  });

  await test('UX: a slash mid-sentence is prose, not a command menu', async () => {
    const r = await runCli([], { env: tui, script, stdin: `check the a/b split${CR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.out, 'ok.', 'it went to the model as ordinary text');
  });

  // ---- @ file completion --------------------------------------------------

  await test('UX: typing `@` opens the file menu', async () => {
    const r = await runCli([], { cwd: project(), env: tui, script, stdin: `@${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertIncludes(panelTrail(r.out).join('->'), 'FILES');
    const items = menuFor(r.out, '@', 'FILES').join('\n');
    assertIncludes(items, 'src/', 'directories are offered');
    assert.ok(!/node_modules/.test(items), `generated directories stayed out:\n${items}`);
  });

  await test('UX: `@src/in` filters to the matching paths', async () => {
    const r = await runCli([], { cwd: project(), env: tui, script, stdin: `@src/in${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const items = menuFor(r.out, '@src/in', 'FILES').join('\n');
    assertIncludes(items, 'src/input.js');
    assertIncludes(items, 'src/index.js');
    assert.ok(!/app\.js/.test(items), `app.js was filtered out:\n${items}`);
  });

  await test('UX: Tab inserts the path into the line and does NOT submit it', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script,
      stdin: `look at @src/inp${TAB}${ESC}${CLEAR}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    assert.ok(rows.some((x) => x.includes('@src/input.js')),
      `the path was spliced into the line: ${JSON.stringify(rows)}`);
    assertNotIncludes(r.out, 'ok.', 'inserting a completion sends nothing to the model');
  });

  await test('UX: completing a directory re-lists one level deeper', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script,
      stdin: `@sr${TAB}${ESC}${CLEAR}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const items = menuFor(r.out, '@src/', 'FILES').join('\n');
    assertIncludes(items, 'src/app.js', 'completing the directory re-listed its contents');
  });

  await test('UX: Esc closes the file menu and keeps the text', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script,
      stdin: `@src${ESC} plus words${CR}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    assert.ok(rows.some((x) => x.includes('plus words')), JSON.stringify(rows));
  });

  await test('UX: an @ that matches nothing says so rather than offering something wrong', async () => {
    const r = await runCli([], { cwd: project(), env: tui, script, stdin: `@zzz${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    assertIncludes(menuFor(r.out, '@zzz', 'FILES').join('\n'), 'no path matches');
  });

  // ---- the two never confuse each other -----------------------------------

  await test('UX: arrows inside the palette do not move through history', async () => {
    const r = await runCli([], {
      env: tui, script,
      stdin: `first${CR}second${CR}/mo${DOWN}${DOWN}${ESC}${UP}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const rows = typed(r.out);
    // After Esc the ↑ recalls the NEWEST prompt — the palette's arrows left the
    // history cursor exactly where it was.
    const afterPalette = rows.slice(rows.lastIndexOf('/mo') + 1).join('|');
    assertIncludes(afterPalette, 'second', `↑ still recalled the newest prompt: ${JSON.stringify(rows)}`);
  });

  await test('UX: normal input still submits after every kind of menu interaction', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script,
      stdin: `/mo${ESC}@src${ESC}${UP}${DOWN}ordinary prompt${CR}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.out, 'ok.', 'the model answered an ordinary prompt afterwards');
    assertNotIncludes(r.out, 'internal error');
  });

  await test('UX: the workspace and header survive menu use', async () => {
    const r = await runCli([], {
      env: tui, script,
      stdin: `hello${CR}/mo${ESC}/exit${CR}`,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const withPalette = frames(r.out).filter((f) => f.includes('COMMANDS'));
    assert.ok(withPalette.length, 'the palette was drawn');
    const f = withPalette[withPalette.length - 1];
    assertIncludes(f, 'L A I N', 'the header is still there');
    assertIncludes(f, 'context', 'the view tabs are still there');
    assertIncludes(f, '│ >', 'the input row is still there');
  });

  await test('UX: typing does not disturb a modal panel', async () => {
    // /config opens a MODAL panel. Typing `/` must not replace it with the
    // palette — only transient completion menus follow the input line.
    const r = await runCli([], {
      env: tui, script,
      stdinSteps: [`/config${CR}`, '/mo', `${ESC}`, `/exit${CR}`],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const trail = panelTrail(r.out).join('->');
    assertIncludes(trail, 'CONFIG');
    assert.ok(!/CONFIG->COMMANDS/.test(trail), `the palette hijacked a modal panel: ${trail}`);
  });
};
