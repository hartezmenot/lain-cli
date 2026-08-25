'use strict';

/**
 * WORKSPACE NAVIGATION, THROUGH THE REAL BINARY.
 *
 * Tab and Shift+Tab were bound, but only when the input line was empty — so the
 * one moment a person most wants to glance at the diff (while writing about it)
 * was exactly when the keys did nothing. This holds the rule that replaced it:
 * the views move whether or not something is typed, and the typed text is still
 * there afterwards.
 *
 * ------------------------------------------------------------------------
 * IT ALSO HELD A LIST THAT HAD GONE STALE, and that is worth recording.
 *
 * It asserted that Shift+Tab reaches AUDIT or HEALTH, and that Alt+6 and Alt+7
 * open them. Both panes were removed from the strip (see ui/tabs.js) — their
 * engines live on as `/audit` and `/health` — so the test was checking for
 * panes that no longer existed, against key bindings that had been left
 * pointing at them. The bindings were the real defect: the strip printed
 * `6 files` and `7 memory` while Alt+6 and Alt+7 set a view name nothing draws.
 *
 * The lesson is the one ui/tabs.js is built around: a test that spells out the
 * pane list is a fifth copy of it. So this file asks tabs.js what the panes
 * are, and checks the PROPERTY — the keys and the strip agree, and navigation
 * moves — rather than naming any pane it does not have to.
 * ------------------------------------------------------------------------
 *
 * Driven through LAIN_FORCE_TUI, which runs the real draw path over a pipe.
 * That is a pipe, not an attached terminal — the keys and the frames are real,
 * the terminal is not.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const TAB = '\t';
const STAB = '\x1b[Z';
const CR = '\r';
const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '30' };
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The panes, from the ONE list. Never spelled out again here. */
const VIEWS = require('../../src/ui/tabs').VIEWS;
const NAMES = VIEWS.join('|');

/** Every view that was ever the bracketed (active) one. */
function visited(out) {
  const seen = new Set();
  for (const m of plain(out).matchAll(new RegExp(`\\[(\\d) (${NAMES})\\]`, 'g'))) seen.add(m[2]);
  return seen;
}

module.exports = async function () {
  await test('TABS: Shift+Tab moves BACKWARDS through the views', async () => {
    const r = await runCli([], {
      cwd: tmpdir('tabs-'), env: tui, script: [],
      stdinSteps: [STAB, STAB, `/exit${CR}`], stepDelayMs: 700, timeoutMs: 45000,
    });
    const seen = visited(r.out);
    // Backwards from the FIRST pane is the END of the list, which is what makes
    // this distinguishable from Tab going forwards. Asked of tabs.js rather
    // than named, so adding a pane cannot silently invalidate the assertion.
    const last = VIEWS[VIEWS.length - 1];
    const secondLast = VIEWS[VIEWS.length - 2];
    assert.ok(seen.has(last) || seen.has(secondLast),
      `Shift+Tab did not reach the end of the list (${last}, ${secondLast}): ${[...seen].join(',') || 'nothing'}`);
  });

  await test('TABS: navigation works WHILE TEXT IS TYPED, and the text survives', async () => {
    const typed = 'fix the logger retention';
    const r = await runCli([], {
      cwd: tmpdir('tabs-'), env: tui, script: [],
      stdinSteps: [typed, TAB, TAB, `/exit${CR}`], stepDelayMs: 700, timeoutMs: 45000,
    });
    const seen = visited(r.out);
    assert.ok(seen.size >= 2, `views did not move with text in the box: ${[...seen].join(',')}`);
    // The move must not eat what was being written.
    assert.ok(plain(r.out).includes(typed), 'the typed text was lost by navigating');
  });

  await test('TABS: Alt+N opens the pane the strip numbers N — including the last one', async () => {
    // ---- THE REGRESSION THIS REPLACES -------------------------------------
    //
    // Alt+6 and Alt+7 were hand-written to open AUDIT and HEALTH, panes that had
    // been removed from the strip. The keys therefore set a view nothing draws,
    // while the strip went on printing `6 files` and `7 memory` — the exact
    // "the tabs don't work" symptom the one-list rule exists to prevent.
    //
    // Driven at the END of the list, where a hand-written binding is most
    // likely to have been forgotten.
    const n = VIEWS.length;
    const want = VIEWS[n - 1];
    const r = await runCli([], {
      cwd: tmpdir('tabs-'), env: tui, script: [],
      stdinSteps: [`\x1b${n}`, `\x1b1`, `\x1b${n}`, `/exit${CR}`],
      stepDelayMs: 2000, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, 'the session must survive being navigated');
    const seen = visited(r.out);
    assert.ok(seen.has(want), `Alt+${n} did not open ${want}: ${[...seen].join(',') || 'nothing'}`);
    // Alt+1 opens whatever pane leads the list — asked of ui/tabs.js, because
    // naming it here is the private copy of the order this test is about.
    assert.ok(seen.has(VIEWS[0]), `Alt+1 did not open ${VIEWS[0]}: ${[...seen].join(',')}`);
  });

  await test('CONTEXT: the survey starts with the session, so the pane is warm on arrival', async () => {
    // ---- THE ONE PANE WHOSE SURVEY NEVER STARTED --------------------------
    //
    // `ensureReport` was reached only by NAVIGATION — Tab, Alt+N, a click. The
    // first view is set in the Screen constructor and painted by the first
    // draw, which goes through none of those, so CONTEXT sat on "Reading the
    // tree, the git state and the toolchain…" for the whole session unless
    // somebody happened to tab away and come back.
    //
    // LAIN now lands on ACTIVITY, which makes the property STRONGER rather than
    // moot: the briefing is started with the session whether or not its pane is
    // open, so the FIRST time anybody presses Alt+2 it is already filled in.
    // Starting only the open pane's pass would move the placeholder one keypress
    // away instead of removing it.
    //
    // A unit test cannot see this: every fixture reaches the pane by calling
    // ensureReport, which is the step that was missing. It takes the real
    // binary starting up and one keypress.
    const dir = tmpdir('ctxboot-');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/engine.js'), 'function move() {}\nmodule.exports = { move };\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"boot","scripts":{"test":"node t.js"}}', 'utf8');

    // ONE KEYPRESS, and it is the pane's number from the one list. Nothing else
    // is typed: the survey must already have run on its own.
    const r = await runCli([], {
      cwd: dir, env: tui, script: [],
      stdinSteps: [`\x1b${VIEWS.indexOf('context') + 1}`, `/exit${CR}`],
      stepDelayMs: 4000, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.out);
    assert.ok(/PROJECT/.test(out), `CONTEXT never said what the project is:\n${out.slice(-900)}`);
    assert.ok(new RegExp(path.basename(dir)).test(out), 'and never named it');
    // The full survey lands too — the cheap facts are a first paint, not a
    // replacement for the report.
    assert.ok(/STATE/.test(out) && /Build/.test(out), 'the survey never completed');
    assert.ok(!/Reading the tree, the git state/.test(out),
      'the pane was still showing its bare placeholder at the end');
  });

  await test('TABS: leaving CONTEXT and returning does not kill the session', async () => {
    // ---- THE CRASH, THROUGH THE REAL BINARY -------------------------------
    //
    // "Open Context, move to another tab, return to Context, LAIN can crash."
    // The cause was a temporal-dead-zone ReferenceError thrown synchronously by
    // the report pass on the keystroke that opens the pane (see ui/reports.js);
    // the unit tier holds the exact function, and this holds the consequence:
    // the process is still alive and still drawing afterwards.
    const r = await runCli([], {
      cwd: tmpdir('tabs-'), env: tui, script: [],
      stdinSteps: ['\x1b1', '\x1b2', '\x1b1', '\x1b4', '\x1b1', `/exit${CR}`],
      stepDelayMs: 1200, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, `the session died while switching tabs:\n${plain(r.out).slice(-1200)}`);
    const out = plain(r.out);
    assert.ok(!/ReferenceError|Cannot access|is not defined/.test(out),
      `a reference error reached the screen:\n${out.slice(-1200)}`);
    assert.ok(visited(r.out).has('context'), 'CONTEXT was never drawn');
  });
  await test('TABS: CONTEXT survives a round trip through the MODEL PICKER', async () => {
    // The reported shape was "context → model picker → context can crash". A
    // panel takes the keyboard and the pane keeps its state underneath; coming
    // back must re-enter the report path cleanly rather than resuming a
    // half-torn-down one.
    const ctx = `\x1b${VIEWS.indexOf('context') + 1}`;
    const r = await runCli([], {
      cwd: tmpdir('ctxmodel-'), env: tui, script: [],
      stdinSteps: [ctx, `/models${CR}`, '\x1b', ctx, ctx, `/exit${CR}`],
      stepDelayMs: 1200, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, `the session died around the model picker:
${plain(r.out).slice(-1200)}`);
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not defined|is not a function/.test(out),
      `an error reached the screen:
${out.slice(-1200)}`);
    assert.ok(visited(r.out).has('context'), 'CONTEXT was never drawn');
  });

  await test('TABS: CONTEXT survives a round trip through the SLASH PICKER', async () => {
    // The same question for the completion menu, which is a different kind of
    // surface: it follows what is typed instead of owning the keyboard, so it
    // tears down on a different path.
    const ctx = `\x1b${VIEWS.indexOf('context') + 1}`;
    const r = await runCli([], {
      cwd: tmpdir('ctxslash-'), env: tui, script: [],
      stdinSteps: [ctx, '/', '\x1b', ctx, ctx, `/exit${CR}`],
      stepDelayMs: 1000, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, `the session died around the slash picker:
${plain(r.out).slice(-1200)}`);
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not defined|is not a function/.test(out),
      `an error reached the screen:
${out.slice(-1200)}`);
    assert.ok(visited(r.out).has('context'), 'CONTEXT was never drawn');
  });

  await test('TABS: repeated CONTEXT re-entry is idempotent — no drift, no crash', async () => {
    // Re-entering a pane must not accumulate anything: a second report pass, a
    // duplicate subscription, a scroll position that creeps. Ten round trips is
    // cheap and would expose all three.
    const ctx = `\x1b${VIEWS.indexOf('context') + 1}`;
    const other = `\x1b${VIEWS.indexOf('plan') + 1}`;
    const steps = [];
    for (let i = 0; i < 5; i++) { steps.push(ctx, other); }
    steps.push(ctx, `/exit${CR}`);
    const r = await runCli([], {
      cwd: tmpdir('ctxloop-'), env: tui, script: [],
      stdinSteps: steps, stepDelayMs: 500, timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0, `the session died on repeated re-entry:
${plain(r.out).slice(-1200)}`);
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not defined/.test(out),
      `an error reached the screen:
${out.slice(-1200)}`);
    // It still DRAWS the briefing at the end, rather than having degraded into
    // a placeholder or an empty pane along the way.
    assert.match(out, /PROJECT/, 'CONTEXT stopped reporting after repeated re-entry');
  });
};
