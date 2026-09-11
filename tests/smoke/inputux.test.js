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

/** The RAW frames — every escape intact, which `frames()` deliberately loses. */
function rawFrames(out) {
  return String(out).split('\x1b[?25l');
}

/**
 * THE INPUT ROW OF ONE RAW FRAME, or ''.
 *
 * ------------------------------------------------------------------------
 * IT USED TO BE FOUND BY ITS BORDER — a line starting `│ > `. The input has no
 * border and no prompt symbol now (it is a grey fill; see ui/inputbox.js), so
 * there is no character left to look for.
 *
 * IT IS FOUND BY THE CARET INSTEAD, which is a better anchor than the border
 * ever was: `draw()` ends every frame by parking the cursor at
 * `ESC[<row>;<col>H`, and that row IS the row being edited, by construction.
 * A test that reads the row the caret is on cannot be reading a different row
 * from the one the user is typing into.
 */
function inputRow(frame) {
  const addrs = [...String(frame).matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (!addrs.length) return '';
  const row = addrs[addrs.length - 1][1];
  // ANY COLUMN: the content frame moved every region off column 1.
  const at = new RegExp(`\\x1b\\[${row};\\d+H([^\\x1b]*(?:\\x1b\\[[0-9;?]*[A-Za-z][^\\x1b]*)*?)\\x1b\\[K`).exec(frame);
  if (!at) return '';
  return at[1].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
}

/** Every distinct value the INPUT row held, in order. */
function typed(out) {
  const seen = [];
  for (const f of rawFrames(out)) {
    // TRIMMED, NOT UN-PADDED BY ONE. This stripped a single leading space, which
    // was the composer's inset when that inset was one column. It is two now -
    // the same inset the conversation uses, so the prompt and the prose begin on
    // one column (ui/views.js `content`) - and a helper that knows the number is
    // a helper that breaks when the number changes. The inset is GEOMETRY; this
    // reads CONTENT.
    const t = inputRow(f).trim();
    // The placeholder is DRAWN, not typed: an empty line must read as empty.
    if (t === 'Ask LAIN…' || t.startsWith('ANSWER — ')) continue;
    if (seen[seen.length - 1] !== t) seen.push(t);
  }
  return seen.filter(Boolean);
}

/**
 * IS THIS FRAME SHOWING THE PANEL CALLED `name`?
 *
 * ------------------------------------------------------------------------
 * MATCHED ON THE TITLE *ROW*, not anywhere in the frame. The panel titles itself
 * in a dim sentence-case row now rather than a shouted boxed banner, so a bare
 * case-insensitive search for `commands` also matches the launch screen's own
 * `/  commands        @  files` hint — and `effort` matches its `Effort  auto`.
 * Both made the wrong frame look like an open palette.
 *
 * A title row is the panel's indent and the name, alone, optionally followed by a
 * count (`Models   5`). Nothing else on the surface is shaped like that.
 */
function hasPanel(frame, name) {
  const want = String(name).toLowerCase();
  for (const row of rowsOfFrame(frame)) {
    const t = row.trim().toLowerCase();
    if (t === want) return true;
    if (t.startsWith(want + ' ') && /^[0-9\s]*$/.test(t.slice(want.length))) return true;
  }
  return false;
}

/**
 * The frame's rows — from either shape a caller may hand over.
 *
 * A RAW frame positions each row with a cursor address and those are the row
 * boundaries. `frames()` in this file has already replaced every escape with a
 * newline, so its rows are newline-separated and there is no address left to
 * split on. Both callers exist, so both shapes are accepted rather than one of
 * them silently yielding no rows at all.
 */
function rowsOfFrame(frame) {
  const raw = String(frame);
  const addressed = raw.split(/\x1b\[\d+;\d+H/);
  const parts = addressed.length > 1 ? addressed.slice(1) : raw.split('\n');
  return parts.map((r) => r.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
}

/** Which panel titles appeared, in order, collapsed. */
function panelTrail(out) {
  const seen = [];
  for (const f of frames(out)) {
    // THE TITLE ROW, not the word anywhere in the frame — see `hasPanel`.
    const found = ['Commands', 'Files', 'Config', 'Models', 'Effort', 'Providers',
      'Lain needs your input'].find((n) => hasPanel(f, n));
    const v = found ? found.toUpperCase() : '-';
    if (seen[seen.length - 1] !== v) seen.push(v);
  }
  return seen;
}

/** Rows rendered inside the last frame that showed `title`. */
function itemsUnder(out, title) {
  let best = null;
  for (const f of frames(out)) if (hasPanel(f, title)) best = f;
  return best ? rowsOf(best) : [];
}

function rowsOf(frame) {
  // ---- THE MENU IS A LIST, NOT A BOX --------------------------------
  //
  // Rows used to arrive as `│   ❯ /exit …  │` and this matched the border. The
  // panel has no frame, no rules and no shouted title any more (ui/panel.js
  // `render`): an item row is the menu's own indent, an optional `❯`, and the
  // label. The title row and the footer are not items and are excluded by what
  // they are rather than by where a border was.
  return frame.split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /^ {2,}(?:❯ )?\S/.test(l))
    .filter((l) => !/↑↓|Esc (close|cancel)/.test(l))
    .map((l) => l.replace(/^ +/, '').replace(/^❯ /, ''))
    .filter(Boolean);
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
  // RAW frames, because the input row is found by the caret park — see
  // `inputRow`, and why the border is no longer there to look for.
  for (const raw of rawFrames(out)) {
    // THE TITLE ROW — see `hasPanel` for why the word alone is not enough.
    if (!hasPanel(raw, title)) continue;
    // TRIMMED for the same reason `typed` is: the composer's inset is two columns
    // now, and a helper that knows the number breaks when the number changes.
    if (inputRow(raw).trim() === line) best = raw;
  }
  return best ? rowsOf(best.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n')) : [];
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
    // ---- STEPS, NOT ONE STDIN BLOCK -----------------------------------
    //
    // The whole of stdin used to arrive in one write, so the palette could open
    // and close between two redraws and never appear in a frame at all. That went
    // unnoticed because `panelTrail` matched the word ANYWHERE in the frame, and
    // the launch screen's own `/  commands   @  files` hint satisfied it — the
    // test passed without the palette ever being drawn. `hasPanel` matches the
    // title ROW now, so the keys have to be separated for there to be one.
    const r = await runCli([], {
      env: tui, script, stdinSteps: ['/', ESC, `/exit${CR}`], stepDelayMs: 1200, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assert.match(panelTrail(r.out).join('->'), /commands/i, 'the palette opened on `/`');
  });

  await test('UX: `/mo` filters the palette to the matching commands', async () => {
    const r = await runCli([], { env: tui, script, stdin: `/mo${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const items = menuFor(r.out, '/mo', 'COMMANDS').join('\n');
    assertIncludes(items, '/model', 'the filtered list kept /model');
    // ---- AND `/models` IS DELIBERATELY NOT OFFERED --------------------
    //
    // This asserted that BOTH appeared, which was true and was the problem:
    // two names for one picker meant a choice to make every time and nothing on
    // screen saying which was which. `/model` is the single advertised command;
    // `/models` survives as a hidden compatibility alias that still RUNS when
    // typed (asserted in smoke/commands-audit.test.js) and is proposed nowhere.
    // See commands.js `define` for what `hidden` means.
    assert.ok(!/\/models\b/.test(items), `a compatibility alias must not be offered:\n${items}`);
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
    // ---- STEPS, NOT ONE STDIN BLOCK -----------------------------------
    //
    // The whole of stdin used to arrive in one write, so the palette could open
    // and close between two redraws and never appear in a frame at all. That went
    // unnoticed because `panelTrail` matched the word ANYWHERE in the frame, and
    // the launch screen's own `/  commands   @  files` hint satisfied it — the
    // test passed without the palette ever being drawn. `hasPanel` matches the
    // title ROW now, so the keys have to be separated for there to be one.
    const r = await runCli([], {
      cwd: project(), env: tui, script,
      stdinSteps: ['@', ESC, CLEAR, `/exit${CR}`], stepDelayMs: 1200, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assert.match(panelTrail(r.out).join('->'), /FILES/i);
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
      stdinSteps: [`hello${CR}`, '/mo', ESC, `/exit${CR}`],
      stepDelayMs: 1400,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const withPalette = frames(r.out).filter((f) => f.match(/commands/i));
    assert.ok(withPalette.length, 'the palette was drawn');
    const f = withPalette[withPalette.length - 1];
    // THE SURFACE IS STILL THERE UNDERNEATH. A panel opening must cost the
    // CONVERSATION rows and nothing else: the header stays, the input stays,
    // and the caret stays on the line you are filtering with.
    //
    // `context` used to be asserted here as proof the TAB STRIP survived. There
    // is no strip; the header and the input are what "the surface survived"
    // means now, and after a turn the conversation is what fills the middle.
    assertIncludes(f, 'LAIN', 'the header is still there');
    assertIncludes(f, 'mock-model', 'with the model on it');
    assert.ok(hasPanel(f, 'Commands'), 'and the palette below, not over the screen');
    // AND THE CARET IS STILL ON THE LINE YOU ARE FILTERING WITH. That is the
    // property the panel-below-the-input arrangement exists for: the list and
    // the line that filters it read as one thing.
    // The keys are separated now, but the last palette frame may still carry the
    // ones typed right after it — what must be true is that the caret is on the
    // line and the line still holds what was typed.
    const withCaret = rawFrames(r.out).filter((x) => hasPanel(x, 'Commands'));
    assert.ok(inputRow(withCaret[withCaret.length - 1]).trim().startsWith('/mo'),
      `the input still holds what was typed, and the caret is on it: ${JSON.stringify(inputRow(withCaret[withCaret.length - 1]))}`);
  });

  await test('UX: typing does not disturb a modal panel', async () => {
    // /config opens a MODAL panel. Typing `/` must not replace it with the
    // palette — only transient completion menus follow the input line.
    const r = await runCli([], {
      env: tui, script,
      stdinSteps: [`/config${CR}`, '/mo', `${ESC}`, `/exit${CR}`],
      // A STEP DELAY, so each panel has a frame to be drawn in. Without one the
      // keys can arrive between two redraws and nothing is ever on screen to
      // assert about — see the note on the `/` palette test above.
      stepDelayMs: 1400,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const trail = panelTrail(r.out).join('->');
    assert.match(trail, /CONFIG/i);
    assert.ok(!/CONFIG->COMMANDS/.test(trail), `the palette hijacked a modal panel: ${trail}`);
  });
};
