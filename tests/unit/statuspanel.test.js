'use strict';

/**
 * `/status` MUST FIT ITS OWN PANEL, AT AN ORDINARY TERMINAL SIZE.
 *
 * Found live: adding one more row to `diagnose.statusRows()` (a cache-hit
 * summary, folded into the tokens row instead once this was caught) silently
 * pushed `config` — the last row — past the OUTPUT panel's rendered slice on
 * a 96x28 terminal, breaking three smoke tests. The exact mechanism was not
 * obvious from `statusRows()` alone: `/status`'s command body (commands.js)
 * writes a bold "Status" HEADER LINE before the rows, so the panel's real
 * item count is `statusRows().length + 1` — one more than this file's first
 * draft accounted for, which is exactly why that draft did not reproduce the
 * regression when checked against a deliberately-reintroduced extra row.
 *
 * So this drives the REAL path end to end — the real `/status` command body
 * (`commands.run`), through a real `Renderer` onto a real `Screen` and a real
 * `InteractionPanel` — at the terminal sizes the affected smoke tests use,
 * rather than reconstructing what `/status` writes by hand. A future row
 * added anywhere in that path without checking the panel's budget fails here
 * in milliseconds instead of in a multi-minute smoke run.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { Screen } = require('../../src/ui/layout');
const { Renderer } = require('../../src/render');
const commands = require('../../src/commands');
const { Session } = require('../../src/session');

/** The exact terminal size tests/smoke/liveness.test.js and integration-push.test.js use. */
const SIZES = [[96, 28], [96, 30]];

function fakeApp(out) {
  const panel = new (require('../../src/ui/panel').InteractionPanel)();
  const screen = new Screen({ out, panel });
  screen.active = true;
  const render = new Renderer(out);
  render.attachScreen(screen);
  const session = new Session({ cwd: 'C:\\Users\\HARTEZ~1\\AppData\\Local\\Temp\\statuspanel-test-dir' });
  return { app: { cfg: {}, session, resumedFrom: null, render, abort: null }, screen, panel };
}

module.exports = async function () {
  await test('STATUS PANEL: the real /status command fits its panel, unscrolled, at an ordinary terminal size', async () => {
    for (const [cols, lines] of SIZES) {
      const out = { columns: cols, rows: lines, isTTY: true, write() {} };
      const { app, screen, panel } = fakeApp(out);

      await commands.run(app, '/status');

      assert.ok(panel.visible, `/status must open the panel at ${cols}x${lines}`);
      const g = screen.geometry();
      const rendered = panel.render(cols, g.panelRows).join('\n');
      // EVERY label, not just `config` — whichever row a future addition lands
      // BEFORE is the one that gets pushed out, and pinning this to one label
      // only catches the exact ordering the original bug happened to have.
      //
      // WORD-BOUNDARY, NOT `includes`. `provider` reads "none configured", and
      // a plain substring check on the label `config` is satisfied by that —
      // a false pass that looks green while the actual `config` ROW is the one
      // missing. `\b` refuses that: "config" is not bounded inside "configured".
      const labels = require('../../src/diagnose').statusRows(app).map(([k]) => k);
      for (const label of labels) {
        assert.match(rendered, new RegExp(`\\b${label}\\b`),
          `at ${cols}x${lines} (panelRows=${g.panelRows}, items=${panel.items.length}), `
          + `'${label}' scrolled out of the rendered panel — /status has grown past its budget`);
      }
    }
  });
};
