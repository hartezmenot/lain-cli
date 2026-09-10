'use strict';

/**
 * THE SURFACE IS WHAT LAIN IS DOING. A REPORT IS WHAT IS TRUE.
 *
 * ------------------------------------------------------------------------
 * THIS USED TO BE ABOUT TWO PANES, and the property it guards outlived them.
 *
 * ACTIVITY and CONTEXT were two panes answering two questions, and CONTEXT once
 * grew a second copy of the feed — a bounded tail of the conversation drawn
 * beneath the briefing — so the pane whose job was stable project information
 * scrolled with every tool call. The lesson was: ONE renderer for the
 * conversation, and no report may contain a copy of it.
 *
 * With one surface the shape of the failure changes but not its nature. The
 * conversation has exactly one home — the surface — and the reports that used
 * to be panes are now commands (`/brief`, `/brief detail`, `/note`, `/token`)
 * whose output is drawn in the panel. If one of those starts carrying the feed,
 * the same defect is back, one layer down: a briefing that scrolls with tool
 * calls stops being readable as a briefing.
 *
 * So the assertions moved from "which pane" to "which renderer", which is where
 * they should have been.
 * ------------------------------------------------------------------------
 */

const assert = require('assert');
const { test } = require('../helpers');

const panesource = require('../../src/ui/panesource');
const contextview = require('../../src/ui/contextview');

/**
 * A screen with a conversation in it, distinctive enough that any copy of the
 * feed is unmistakable wherever it lands.
 */
function screenWithFeed() {
  return {
    completion: null,
    state: {
      cwd: process.cwd(),
      session: { cwd: process.cwd(), task: null, plan: null, turns: [], messages: [] },
      transcript: [],
      // AN EDIT, NOT A READ, and `name` rather than `tool`. A successful read is
      // live state and leaves no row in the conversation (ui/feed.js `durable`);
      // this test is about WHERE the conversation is drawn, so it needs a call
      // that persists in it.
      liveActions: [{ name: 'edit_file', target: 'FEEDMARKER_ONLY_ON_THE_SURFACE.js', ok: true }],
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

/** A survey shaped like `survey.run()`'s result — what `/brief` renders. */
function survey() {
  return {
    root: process.cwd(),
    health: { build: 'PASS', test: 'UNVERIFIED', runtime: 'UNVERIFIED', engineering: 'CLEAN' },
    findings: [],
    git: { ok: true, files: [], totalLines: 0 },
    languages: { javascript: 10 },
    environment: {},
  };
}

const textOf = (lines) => (Array.isArray(lines) ? lines.join('\n') : String(lines || ''));
const MARKERS = ['FEEDMARKER_ONLY_ON_THE_SURFACE', 'FEEDMARKER_NARRATION', 'FEEDMARKER_USER_ASKED'];

module.exports = async function () {
  await test('SEPARATION: the SURFACE is where the conversation is', () => {
    // The half that would silently pass if the feed simply stopped being drawn
    // anywhere — which is the defect this whole arrangement exists to prevent.
    const out = textOf(panesource.workspaceLines(screenWithFeed(), 100, 24));
    assert.ok(out.includes('FEEDMARKER_ONLY_ON_THE_SURFACE'),
      `the surface must carry the tool activity:\n${out.slice(0, 600)}`);
    assert.ok(out.includes('FEEDMARKER_USER_ASKED'),
      'and what the user said');
  });

  await test('SEPARATION: the project briefing contains NO feed', () => {
    // `/brief` and `/brief detail` render the survey and nothing else. Neither
    // has any access to the conversation, and that is checked by giving them a
    // survey while the markers exist in the same process.
    for (const view of ['context', 'detail']) {
      const out = textOf(contextview.render(view, survey(), { width: 100, cwd: process.cwd() }));
      for (const marker of MARKERS) {
        assert.ok(!out.includes(marker),
          `the ${view} rendering is carrying the conversation (${marker})`);
      }
    }
  });

  await test('SEPARATION: the briefing still answers what is TRUE', () => {
    // Containing no feed must not mean containing nothing.
    const out = textOf(contextview.render('context', survey(), { width: 100, cwd: process.cwd() }));
    assert.match(out, /PROJECT/i, 'it names the project');
    assert.match(out, /STATE/i, 'and says what state it is in');
  });

  await test('SEPARATION: ONE renderer draws the conversation, and it is asked for once', () => {
    // Two call sites for one feed is how two surfaces come to disagree about
    // what the model just said. Counted across the tree rather than asserted
    // about the callers we happen to be thinking of.
    const fs = require('fs');
    const path = require('path');
    const SRC = path.join(__dirname, '..', '..', 'src');
    const hits = [];
    const walk = (dir, base = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, rel);
        else if (e.name.endsWith('.js')) {
          const text = fs.readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          // `views.activity(...)` is the conversation renderer. ui/views.js
          // re-exports it and ui/conversation.js defines it; only ONE place may
          // CALL it.
          if (/\bviews\.activity\s*\(/.test(text)) hits.push(rel);
        }
      }
    };
    walk(SRC);
    // TWO CALLERS, AND THE SECOND IS NOT A SURFACE. `copy.js` turns the same
    // renderer's output into plain text for the clipboard — it draws nothing,
    // competes with nothing, and reuses the renderer precisely so `/copy`
    // cannot report a different conversation from the one on screen. Any THIRD
    // caller is a second surface being built.
    assert.deepStrictEqual(hits.sort(), ['copy.js', 'ui/panesource.js'],
      `only the surface and /copy may render the conversation, saw: ${hits.join(', ') || 'none'}`);
  });

  await test('SEPARATION: the pane machinery it guarded is gone entirely', () => {
    // CONTEXT used to return a pane marked `composed`, which ui/layout.js
    // honoured by refusing to scroll it. A consumer with no producer is exactly
    // the shape that caused the original defect, so neither half may linger —
    // and now neither may the panes themselves.
    const fs = require('fs');
    const path = require('path');
    const UI = path.join(__dirname, '..', '..', 'src', 'ui');
    const layout = fs.readFileSync(path.join(UI, 'layout.js'), 'utf8');
    assert.ok(!/lines\.composed|const composed =/.test(layout),
      'ui/layout.js still honours a `composed` pane that nothing produces');
    assert.ok(!fs.existsSync(path.join(UI, 'split.js')),
      'ui/split.js composed the briefing with the feed and has no job left');
    assert.ok(!fs.existsSync(path.join(UI, 'tabs.js')),
      'and the pane list itself is gone — see tests/unit/onesurface.test.js');
  });
};
