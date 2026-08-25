'use strict';

/**
 * `/troubleshoot` AS A WORKFLOW YOU CAN SEE.
 *
 * The mode paragraph was already right; what was missing was any structure the
 * user could read the result by. So there is a report, and the properties that
 * make it worth having are all about honesty:
 *
 *   - the EVIDENCE is a real local scan, done before anything is asked
 *   - the INVESTIGATION is the tool calls that actually ran
 *   - a conclusion the model did not state reads as "not stated", never as a
 *     plausible sentence promoted into a finding
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const ts = require('../../src/troubleshoot');
const T = require('../../src/ui/text');

function project() {
  const dir = tmpdir('ts-');
  fs.mkdirSync(path.join(dir, 'probot'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'probot', 'dashboard.py'),
    'def refresh():\n    try:\n        pull()\n    except Exception:\n        pass\n');
  fs.writeFileSync(path.join(dir, 'probot', 'logger.py'), 'def log(msg):\n    print(msg)\n');
  return dir;
}

module.exports = async function () {
  await test('TS: the distinctive words are pulled out, the useless ones are not', () => {
    const t = ts.terms('there are 8 errors silently dropped in the dashboard');
    assert.ok(t.includes('silently'), `expected "silently": ${t.join(', ')}`);
    assert.ok(t.includes('dropped'));
    assert.ok(t.includes('dashboard'));
    assert.ok(!t.includes('there'), 'a stopword points nowhere');
    assert.ok(!t.includes('errors'), '"errors" is in every codebase and narrows nothing');
  });

  await test('TS: evidence is gathered LOCALLY, before anything is asked of a model', async () => {
    const e = await ts.gather(project(), 'there are 8 errors silently dropped in the dashboard');
    assert.ok(e.scanned > 0, 'it really read files');
    assert.ok(e.hits.length, 'and found where the words live');
    assert.match(e.hits[0].file, /dashboard\.py/, 'the file that matches most is first');
    const emptyCatch = e.markers.find((m) => m.id === 'emptycatch');
    assert.ok(emptyCatch && emptyCatch.count >= 1, 'a silently swallowed exception is real evidence');
  });

  await test('TS: only the markers the description is about are looked for', () => {
    assert.deepStrictEqual(ts.relevantMarkers('the button will not turn on'), []);
    assert.ok(ts.relevantMarkers('exceptions are silently swallowed').includes('emptycatch'));
    assert.ok(ts.relevantMarkers('half of it is a stub').includes('stub'));
  });

  await test('TS: the model closing sections are read out of what it ACTUALLY said', () => {
    const c = ts.conclusions([
      'I traced the refresh path.',
      'Finding: the exception handler swallows every error.',
      'Likely cause: a bare except added to silence a startup warning.',
      'Recommended fix: log the exception and re-raise anything unexpected.',
      'Verification: run the suite and check the log has the new line.',
    ].join('\n'));
    assert.match(c.finding.join(' '), /swallows every error/);
    assert.match(c.cause.join(' '), /bare except/);
    assert.match(c.fix.join(' '), /log the exception/);
    assert.match(c.verification.join(' '), /run the suite/);
    assert.match(c.rest.join(' '), /traced the refresh path/, 'the preamble is kept separately');
  });

  await test('TS: what the model did NOT conclude reads as not stated', () => {
    // The whole reason this workflow exists is that a plausible story is not a
    // finding. A missing cause must look missing.
    const r = {
      problem: 'errors are dropped', project: 'probot',
      evidence: { hits: [], markers: [], terms: ['dropped'], scanned: 2, total: 2 },
      investigation: [],
      conclusions: ts.conclusions('Finding: the handler is too broad.'),
    };
    const text = T.strip(ts.reportLines(r, 90).join('\n'));
    assert.match(text, /FINDING/);
    assert.match(text, /the handler is too broad/);
    // The report is framed, so the section heading and its body are separated by
    // the box border as well as the newline.
    assert.match(text, /LIKELY CAUSE[^a-zA-Z]+not stated/, 'an unstated cause must not be filled in');
    assert.match(text, /RECOMMENDED FIX[^a-zA-Z]+not stated/);
  });

  await test('TS: the report is framed, sectioned, and square at any width', () => {
    const r = {
      problem: 'x'.repeat(200), project: 'probot',
      evidence: { hits: [{ file: 'a/'.repeat(60) + 'b.py', score: 3, matched: ['x'] }], markers: [], terms: ['x'], scanned: 1, total: 1 },
      investigation: [{ text: '✓ Read a.py', ok: true }, { text: '✗ Ran pytest', ok: false }],
      conclusions: null,
    };
    for (const w of [50, 80, 120]) {
      const lines = ts.reportLines(r, w);
      for (const l of lines) assert.strictEqual(T.width(l), w, `a report row was ${T.width(l)} wide at ${w}`);
      const text = T.strip(lines.join('\n'));
      for (const s of ['PROBLEM', 'EVIDENCE', 'INVESTIGATION', 'FINDING', 'LIKELY CAUSE', 'RECOMMENDED FIX', 'VERIFICATION']) {
        assert.ok(text.includes(s), `${s} missing at width ${w}`);
      }
    }
  });

  await test('TS: the investigation is the calls that really ran, deduplicated', () => {
    const app = { _troubleshoot: { problem: 'p', project: 'x', evidence: {}, investigation: [], conclusions: null } };
    ts.conclude(app, {
      text: 'Finding: it is the handler.',
      actions: [
        { name: 'grep', target: '/except/', ok: true },
        { name: 'grep', target: '/except/', ok: true },
        { name: 'read_file', target: 'dashboard.py', ok: true },
        { name: 'run_bash', target: 'pytest', ok: false },
      ],
    });
    const steps = app._troubleshoot.investigation.map((i) => i.text);
    assert.strictEqual(steps.length, 3, 'the same search twice is one thing that was done');
    assert.match(steps[0], /Searched for "except"/);
    assert.match(steps[2], /^✗/, 'a failed check is not reported as a tick');
  });

  await test('TS: nothing matching is a RESULT, and it says what that means', () => {
    const r = {
      problem: 'the light is off', project: 'x',
      evidence: { hits: [], markers: [], terms: ['light'], scanned: 9, total: 9 },
      investigation: [], conclusions: null,
    };
    const text = T.strip(ts.reportLines(r, 90).join('\n'));
    assert.match(text, /nothing in the tree matched light/);
    assert.match(text, /probably not in the source/);
    assert.match(text, /scanned 9 of 9 files locally, before asking anything/);
  });
};
