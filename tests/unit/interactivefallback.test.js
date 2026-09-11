'use strict';

/**
 * "INTERACTIVE" MEANS SOMEBODY CAN ANSWER — NOT THAT A SCREEN IS DRAWN.
 *
 * Two commands open an editing mode when typed bare (`/plan`, `/goal`) and both
 * carry a written fallback for the case with nothing to type into: "a pipe,
 * `-p`, a test — read it out rather than opening a mode nobody can close".
 *
 * Both asked the wrong question. `app.ui.enabled` is a fact about OUTPUT, and
 * `LAIN_FORCE_TUI=1` bypasses exactly one thing — the isTTY check on the screen
 * — so a piped run draws real frames into which nothing can ever be typed. The
 * fallback could not fire, and each command failed differently:
 *
 *   /plan   opened the three-way choice, read EOF, took it for a dismissal and
 *           printed `Plan unchanged.` — the plan never shown.
 *   /goal   opened the composer, which does not block, so it stayed open and
 *           ATE the following piped lines as its own text.
 *
 * The honest question is `input.isTTY`: a pipe is not a keyboard. It is the
 * same byte-level fact input.js `_consume` uses to tell Ctrl+J from a line
 * separator, so the two cannot drift apart.
 *
 * These tests hold the RULE, not the phrasing. They assert that a non-TTY run
 * READS OUT and OPENS NOTHING, which is what the fallbacks promise, and that a
 * real TTY still gets its editor — because "never open the editor" would pass
 * every assertion below the first and destroy the feature.
 */

const assert = require('assert');
const { test } = require('../helpers');

const plan = require('../../src/plan');
const goalcommand = require('../../src/goalcommand');
const compose = require('../../src/composemode');
const goal = require('../../src/goal');

/**
 * `/goal`'s handler, taken from its own registration.
 *
 * Not through the shared REGISTRY: clearing that to re-register would tear down
 * every other command for the rest of the process, and a test that damages the
 * suite around it is not a test. `register` takes `define` as a parameter for
 * exactly this reason.
 */
function goalRun() {
  let captured = null;
  goalcommand.register({ C, define: (name, spec) => { if (name === '/goal') captured = spec.run; } });
  assert.ok(captured, '/goal must still register a handler');
  return captured;
}

const C = new Proxy({}, { get: () => (s) => String(s == null ? '' : s) });

/**
 * A minimal App with a REAL session and a real composer, differing only in
 * whether the input is a terminal. Everything the assertions are about — the
 * predicate, the fallback text, the composer state — is production code.
 */
function appWith({ isTTY, steps = [] }) {
  const written = [];
  const { Plan } = plan;
  const app = {
    render: { write(s) { written.push(String(s)); } },
    ui: {
      enabled: true,                       // as LAIN_FORCE_TUI=1 leaves it
      asked: 0,
      async ask() { this.asked += 1; return null; },   // EOF: a pipe answers nothing
      refresh() {},
    },
    input: { isTTY, line: '', setLine(s) { this.line = s; } },
    session: { plan: null, task: null, goal: '', save() {} },
    written,
    get text() { return written.join(''); },
  };
  if (steps.length) {
    app.session.plan = new Plan('do the thing');
    app.session.plan.addSteps(steps);
  }
  return app;
}

module.exports = async function () {
  // ------------------------------------------------------------- /plan ------

  await test('PLAN: a piped run READS THE PLAN OUT instead of asking', async () => {
    const app = appWith({ isTTY: false, steps: ['a', 'b', 'c'] });
    await plan.runCommand(app, { args: [], rest: '' }, { C });
    assert.strictEqual(app.ui.asked, 0, 'nothing may be asked of a pipe — it cannot answer');
    assert.ok(!/Plan unchanged/.test(app.text),
      'EOF is not a dismissal, and must never be reported as one');
    assert.match(app.text, /STEP\s*1\/3|\ba\b/i, 'the plan itself is what a pipe gets');
  });

  await test('PLAN: a piped run with NO plan says so, and opens no composer', async () => {
    const app = appWith({ isTTY: false });
    await plan.runCommand(app, { args: [], rest: '' }, { C });
    assert.strictEqual(compose.pending(app), null, 'no mode is opened where none can be closed');
    assert.match(app.text, /No plan/i, 'and the reason is stated');
  });

  await test('PLAN: a REAL terminal still gets the editor — the feature survives', async () => {
    const app = appWith({ isTTY: true, steps: ['a', 'b'] });
    await plan.runCommand(app, { args: [], rest: '' }, { C });
    assert.strictEqual(app.ui.asked, 1,
      'on a keyboard, bare /plan is the three-way choice it was designed to be');
  });

  await test('PLAN: `show` reads out on a TTY too — the explicit read path is intact', async () => {
    const app = appWith({ isTTY: true, steps: ['a', 'b', 'c'] });
    await plan.runCommand(app, { args: ['show'], rest: 'show' }, { C });
    assert.strictEqual(app.ui.asked, 0, '`show` asks nothing of anybody');
    assert.match(app.text, /STEP\s*1\/3/i);
  });

  // ------------------------------------------------------------- /goal ------

  await test('GOAL: a piped run does NOT open the composer that would eat the pipe', async () => {
    // The consequence, not just the state: whatever is typed next is a COMMAND,
    // and an open composer would have taken it as goal text.
    const app = appWith({ isTTY: false });
    goal.set(app.session, 'ship the harness');
    await goalRun()(app, { args: [], rest: '' });
    assert.strictEqual(compose.pending(app), null,
      'an open composer on a pipe silently swallows every line after it');
    assert.match(app.text, /ship the harness/, 'the goal is read out instead');
  });

  await test('GOAL: a REAL terminal still opens the composer, prefilled', async () => {
    const app = appWith({ isTTY: true });
    goal.set(app.session, 'ship the harness');
    await goalRun()(app, { args: [], rest: '' });
    assert.ok(compose.pending(app), 'on a keyboard the composer is the point of bare /goal');
    assert.strictEqual(app.input.line, 'ship the harness', 'and it is prefilled with the goal');
    compose.cancel(app);
  });

  // ------------------------------------------------------ the rule itself ----

  await test('NEITHER command decides interactivity from the SCREEN alone', () => {
    // A source guard, because the defect was invisible at runtime until a whole
    // smoke tier drove the binary over a pipe. `ui.enabled` may be consulted —
    // there is no editor without a screen — but never as the only question.
    const fs = require('fs');
    for (const f of ['src/plan.js', 'src/goalcommand.js']) {
      const body = fs.readFileSync(require('path').join(__dirname, '..', '..', f), 'utf8');
      const decides = body.match(/const interactive = Boolean\([^;]*\);/);
      assert.ok(decides, `${f} must still decide interactivity in one readable place`);
      assert.match(decides[0], /isTTY/,
        `${f} decides from the screen alone — a pipe would be treated as a keyboard`);
    }
  });
};
