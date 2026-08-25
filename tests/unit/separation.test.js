'use strict';

/**
 * ACTIVITY IS WHAT LAIN IS DOING. CONTEXT IS WHAT IS TRUE.
 *
 * These are two different questions and they get two different panes. The
 * failure this guards against is CONTEXT growing a second copy of the feed —
 * it had one: a bounded tail of the conversation drawn beneath the briefing, so
 * the pane whose job is stable project information scrolled with every tool
 * call, and the landing pane was a worse ACTIVITY and a worse CONTEXT at once.
 *
 * The separation is easy to undo by accident, because the feed renderer is one
 * function call away from every pane. So it is asserted structurally — CONTEXT
 * must not contain what only the feed produces — rather than by eyeballing a
 * screenshot.
 */

const assert = require('assert');
const { test } = require('../helpers');

const tabs = require('../../src/ui/tabs');
const panesource = require('../../src/ui/panesource');

/**
 * A screen with a conversation in it, distinctive enough that any copy of the
 * feed is unmistakable wherever it lands.
 */
function screenWith(view) {
  return {
    view,
    completion: null,
    expandedSteps: new Set(),
    planCursor: -1,
    diffFile: null,
    report: {
      brief: {
        root: process.cwd(),
        health: { build: 'PASS', test: 'UNVERIFIED', runtime: 'UNVERIFIED', frontend: 'UNVERIFIED', engineering: 'CLEAN' },
        findings: [],
        git: { ok: true, files: [], totalLines: 0 },
        languages: { javascript: 10 },
        environment: {},
      },
      quick: null,
      reading: false,
      failed: {},
    },
    state: {
      cwd: process.cwd(),
      session: { cwd: process.cwd(), task: null, plan: null, turns: [], messages: [] },
      transcript: [],
      liveActions: [{ tool: 'read_file', target: 'FEEDMARKER_ONLY_IN_ACTIVITY.js', ok: true }],
      liveNarration: ['FEEDMARKER_NARRATION'],
      liveNotes: [],
      liveUser: 'FEEDMARKER_USER_ASKED',
      extras: [],
      current: null,
      outputs: [],
      checkpoints: null,
      tree: [],
      project: { languages: ['javascript'] },
      model: 'm', provider: 'p', connection: 'c', effort: 'auto', resumeToken: null,
    },
  };
}

const textOf = (lines) => (Array.isArray(lines) ? lines.join('\n') : String(lines || ''));

module.exports = async function () {
  await test('SEPARATION: CONTEXT contains NO feed — no tool calls, no narration', () => {
    const out = textOf(panesource.workspaceLines(screenWith('context'), 100, 24));
    for (const marker of ['FEEDMARKER_ONLY_IN_ACTIVITY', 'FEEDMARKER_NARRATION', 'FEEDMARKER_USER_ASKED']) {
      assert.ok(!out.includes(marker),
        `CONTEXT is carrying the activity feed again (${marker}):\n${out.slice(0, 600)}`);
    }
  });

  await test('SEPARATION: ACTIVITY is where the feed actually is', () => {
    // The other half. A separation test that only checks CONTEXT is empty would
    // pass if the feed stopped being rendered anywhere at all — which is the
    // defect this whole pane arrangement was built to fix.
    const out = textOf(panesource.workspaceLines(screenWith('activity'), 100, 24));
    assert.ok(out.includes('FEEDMARKER_ONLY_IN_ACTIVITY'),
      `ACTIVITY must carry the tool activity:\n${out.slice(0, 600)}`);
  });

  await test('SEPARATION: CONTEXT still answers what is TRUE', () => {
    // Removing the feed must not have emptied the pane.
    const out = textOf(panesource.workspaceLines(screenWith('context'), 100, 24));
    assert.match(out, /PROJECT/i, 'it names the project');
    assert.match(out, /STATE/i, 'and says what state it is in');
  });

  await test('SEPARATION: ACTIVITY leads, and CONTEXT is a pane of its own', () => {
    assert.strictEqual(tabs.VIEWS[0], 'activity', 'the pane LAIN opens on is the operational log');
    assert.ok(tabs.VIEWS.includes('context'));
    assert.notStrictEqual(tabs.VIEWS.indexOf('context'), tabs.VIEWS.indexOf('activity'));
  });

  await test('SEPARATION: only ONE pane renders the conversation', () => {
    // Two call sites for one feed is how two surfaces come to disagree about
    // what the model just said. Counted across every pane rather than asserted
    // about the two we happen to be thinking of.
    const carrying = tabs.VIEWS.filter((v) => {
      const out = textOf(panesource.workspaceLines(screenWith(v), 100, 24));
      return out.includes('FEEDMARKER_ONLY_IN_ACTIVITY');
    });
    assert.deepStrictEqual(carrying, ['activity'],
      `exactly one pane may draw the feed, saw: ${carrying.join(', ') || 'none'}`);
  });

  await test('SEPARATION: the composed-pane contract is gone, not merely unused', () => {
    // CONTEXT used to return a pane marked `composed`, which ui/layout.js
    // honoured by refusing to scroll it. A consumer with no producer is exactly
    // the shape that caused the original defect, so neither half may linger.
    const fs = require('fs');
    const path = require('path');
    const layout = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'layout.js'), 'utf8');
    assert.ok(!/lines\.composed|const composed =/.test(layout),
      'ui/layout.js still honours a `composed` pane that nothing produces');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'src', 'ui', 'split.js')),
      'ui/split.js composed the briefing with the feed and has no job left');
  });
};
