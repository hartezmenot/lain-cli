'use strict';

/**
 * THE AUDIT AND HEALTH PANES.
 *
 * These are a SURFACE over the existing engines, not second copies of them:
 * `audit()` and `projecthealth.assess()` produce the evidence and these only lay
 * it out. The properties that matter are that a pane never invents a verdict,
 * never blocks on work it has not done yet, and always fits the frame it was
 * given — including when it carries colour, which it now may: ui/text.js
 * measures what the terminal shows rather than what is in memory, so an escape
 * sequence no longer counts as width it does not occupy.
 *
 * The HEALTH pane is the PROJECT's health. LAIN's own readiness is `/rc`, a
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
      'LAIN own runtime state belongs to /rc, not to the project health view');
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

  await test('PANE: the workspace cycle includes activity and memory', () => {
    // The list moved to ui/tabs.js and is now the ONE source the Tab cycle, the
    // strip's numbers, the Alt+N bindings and the click hit-test all read. It
    // used to be spelled out in each of those four places — four chances for
    // the number printed on screen and the pane it opens to disagree.
    const { VIEWS } = require('../../src/ui/tabs');
    // AUDIT and HEALTH deliberately left the navigation: they are evidence
    // GENERATORS, not destinations, and reaching project state through them
    // meant navigating to a report about the project instead of seeing it.
    // Their engines are untouched and still reachable as /audit and /health.
    for (const v of ['activity', 'memory']) assert.ok(VIEWS.includes(v), `${v} is not in the Tab cycle`);
    for (const v of ['audit', 'health']) {
      assert.ok(!VIEWS.includes(v), `${v} is a report generator, not a workspace`);
    }
    const { REGISTRY } = require('../../src/commands');
    for (const c of ['/audit', '/health']) {
      assert.ok(REGISTRY.has(c), `${c} must still work — only the pane went`);
    }
    // And nothing may keep a private copy of it.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src', 'ui');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f === 'tabs.js') continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/\[\s*'context',\s*'plan',\s*'diff'/.test(src),
        `${f} spells the view order itself — it must ask ui/tabs.js`);
    }
  });
};
