'use strict';

/**
 * THE AUDIT AND HEALTH RENDERINGS.
 *
 * These were two of the nine workspace panes before the panes went, and they
 * had already stopped being panes before that — see the last test in this file.
 * What they are is a LAYOUT over the existing engines, not second copies of
 * them:
 * `audit()` and `projecthealth.assess()` produce the evidence and these only lay
 * it out. The properties that matter are that a pane never invents a verdict,
 * never blocks on work it has not done yet, and always fits the frame it was
 * given — including when it carries colour, which it now may: ui/text.js
 * measures what the terminal shows rather than what is in memory, so an escape
 * sequence no longer counts as width it does not occupy.
 *
 * The HEALTH pane is the PROJECT's health. LAIN's own readiness is `/ready`, a
 * different question with a different owner (health.js).
 */

const assert = require('assert');
const { test } = require('../helpers');

const { auditLines } = require('../../src/audit');
const { projectHealthLines } = require('../../src/projecthealth');
const T = require('../../src/ui/text');

module.exports = async function () {
  await test('PANE: before the pass lands, the pane says it is reading — it does not guess', () => {
    for (const lines of [auditLines(null, 80), projectHealthLines(null, 80)]) {
      assert.ok(Array.isArray(lines) && lines.length, 'a pane must always render something');
      assert.match(T.strip(lines.join(' ')), /reading/i);
    }
  });

  await test('PANE: health reads the PROJECT, not LAIN — and grades its confidence', async () => {
    const ph = require('../../src/projecthealth');
    const a = await ph.assess(process.cwd(), null);
    const text = T.strip(projectHealthLines(a, 100).join('\n'));
    assert.match(text, /PROJECT HEALTH — /, 'the pane must name the project it read');
    assert.match(text, /AREA\s+STATUS\s+EVIDENCE/, 'the columns must be named');
    assert.match(text, /STRUCTURE/);
    assert.match(text, /CODE HEALTH/);
    assert.match(text, /WORK STATE/);
    assert.match(text, /NEXT ACTION/);
    // The thing that keeps a local scan honest: findings say how sure they are.
    assert.ok(/CONFIRMED|LIKELY|NEEDS REVIEW/.test(text), 'findings must carry a confidence');
    // And it must NOT be LAIN's own readiness wearing the project's name.
    assert.ok(!/Context window|Connections|Isolation \(V2/.test(text),
      'LAIN own runtime state belongs to /ready, not to the project health view');
  });

  await test('PANE: audit lays the project reading out in a frame, with sections', async () => {
    const a = await require('../../src/audit').audit(process.cwd());
    const lines = auditLines(a, 100);
    const text = T.strip(lines.join('\n'));
    assert.match(text, /PROJECT AUDIT — /);
    // AREA / STATUS / EVIDENCE: what was looked at, how sure the reading is, and
    // the thing in the tree that says so. An audit whose lines cannot be checked
    // is an opinion with a frame around it.
    assert.match(text, /AREA\s+STATUS\s+EVIDENCE/);
    assert.match(text, /✓ CONFIRMED/);
    assert.match(text, /STRUCTURE/);
    assert.match(text, /ENTRY POINTS/);
    assert.match(text, /WATCH AREAS/);
    assert.match(text, /NEXT ACTION/);
    assert.ok(lines[0].includes('┌'), 'the report is framed, not floating text');
    assert.ok(lines[lines.length - 1].includes('└'), 'and the frame is closed');
  });

  await test('PANE: colour is measured, so a coloured frame is still square', async () => {
    // The reason panes were plain text: `.length` counted escape bytes as cells
    // and tore the right-hand border off every coloured row. With visible-width
    // maths the frame must be exactly square at every width, coloured or not.
    const saved = { no: process.env.NO_COLOR, lain: process.env.LAIN_NO_COLOR };
    delete process.env.NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const a = await require('../../src/audit').audit(process.cwd());
      const ph = require('../../src/projecthealth');
      const h = await ph.assess(process.cwd(), null);
      for (const w of [60, 80, 120]) {
        const lines = [...auditLines(a, w), ...ph.projectHealthLines(h, w)];
        assert.ok(lines.some((l) => /\x1b\[/.test(l)), `nothing was coloured at width ${w}`);
        for (const l of lines) {
          assert.strictEqual(T.width(l), w, `a row was ${T.width(l)} visible cells wide at width ${w}`);
        }
      }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved.no !== undefined) process.env.NO_COLOR = saved.no;
      if (saved.lain !== undefined) process.env.LAIN_NO_COLOR = saved.lain;
    }
  });

  await test('PANE: the evidence generators are COMMANDS, and never were destinations', () => {
    // ------------------------------------------------------------------
    // THIS TEST USED TO ASSERT THE TAB CYCLE, and the point it was making
    // outlived the cycle by one design.
    //
    // AUDIT and HEALTH left the pane order first, and for the reason that
    // eventually took every other pane with it: they are evidence GENERATORS
    // wearing a destination, so reaching project state through them meant
    // navigating to a report ABOUT the project instead of seeing the project.
    // Their engines were untouched and stayed reachable as commands.
    //
    // That is now the whole architecture: one surface, everything else a
    // command. So what is left to hold is the half that always mattered — the
    // ENGINES are still reachable, and nothing that reads them has grown a
    // second home.
    // ------------------------------------------------------------------
    const { REGISTRY } = require('../../src/commands');
    assert.ok(REGISTRY.has('/health'), '/health must still work — only its pane went');
    assert.ok(!REGISTRY.has('/audit'), '/audit was removed from the command surface deliberately');
    // The audit ENGINE is still here and still rendered — `/brief` and
    // `/doctor` read it. A generator with no caller would be the dead half.
    assert.strictEqual(typeof require('../../src/audit').audit, 'function');
    assert.strictEqual(typeof auditLines, 'function');
  });
};
