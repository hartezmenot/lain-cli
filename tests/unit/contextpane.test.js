'use strict';

/**
 * THE CONTEXT PANE — the crash, and what the pane is allowed to say.
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS FILE EXISTS FOR, exactly as reported: "open Context, move to
 * another tab, come back, LAIN can crash."
 *
 * The cause was not a lifecycle, a listener or a race. `ensureReport` read
 * `app` in its first branch and declared `const app` eight lines below, so
 * opening CONTEXT threw `ReferenceError: Cannot access 'app' before
 * initialization` — synchronously, on the keystroke, every time. The middle
 * step of the repro is a red herring: the FIRST view is set at startup without
 * going through that function, so the throw waits for the first NAVIGATION to
 * context, which is what coming back to the tab is.
 *
 * The same defect produced the second complaint. The survey never started, so
 * the pane sat on its "surveying — reading the tree…" placeholder for the
 * whole session: the pane meant to say what is true about the project could
 * only ever say it was about to find out.
 *
 * A unit test is the right tier for this. The failure was a synchronous throw
 * out of one function on one named path — nothing about spawning a terminal
 * makes it more visible, and everything about it makes it slower to catch.
 * ------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const tabs = require('../../src/ui/tabs');
const reports = require('../../src/ui/reports');
const contextview = require('../../src/ui/contextview');

/** A UI double with exactly the surface ui/reports.js and ui/keys.js touch. */
function fakeUi(cwd, { onRefresh = null } = {}) {
  const ui = {
    app: { session: { cwd, task: null, plan: null } },
    refreshes: 0,
    draws: 0,
    screen: {
      view: 'context',
      report: {},
      setView(v) { this.view = v; },
      draw() { ui.draws += 1; },
    },
    refresh() { ui.refreshes += 1; if (onRefresh) onRefresh(ui); },
    ensureReport(view) { return reports.ensureReport(ui, view); },
  };
  return ui;
}

/** A survey shaped like survey.run()'s result, with something in every list. */
function fakeSurvey(root) {
  return {
    root,
    health: { build: 'PASS', test: 'UNVERIFIED', runtime: 'PASS', frontend: 'UNVERIFIED', engineering: 'DEGRADED' },
    languages: { js: 40, py: 3, json: 9 },
    scanned: 43,
    notes: ['The source sweep was truncated at 2500 files.'],
    environment: { os: 'Windows 11', shell: { preferred: 'powershell' }, packageManager: 'npm', runtimes: { node: 'node' } },
    git: {
      ok: true,
      totalLines: 412,
      files: [
        { file: 'src/a.js', added: 100, removed: 4 },
        { file: 'src/b.js', added: 40, removed: 40, rewrite: true },
        { file: 'src/c.js', added: 8, removed: 0, untracked: true },
        { file: 'src/d.js', added: 1, removed: 1 },
        { file: 'src/e.js', added: 2, removed: 2 },
      ],
    },
    testRun: null,
    findings: [
      { severity: 'ERROR', file: 'src/a.js', line: 12, message: 'a.js does not parse', explanation: 'a stray brace' },
      { severity: 'WARNING', file: 'src/b.js', message: 'whole-file rewrite', explanation: 'nearly every line differs' },
      { severity: 'UNVERIFIED', message: 'Front-end runtime was not observed.', explanation: 'nothing looked' },
    ],
  };
}

module.exports = async function () {
  // ================================================== THE CRASH, DIRECTLY ==

  await test('CONTEXT: opening the pane does not throw — the exact TDZ regression', () => {
    const ui = fakeUi(tmpdir('ctxpane-'));
    // If this ever throws again it takes the keystroke, and the session, with it.
    assert.doesNotThrow(() => reports.ensureReport(ui, 'context'),
      'ensureReport must not throw for the CONTEXT view');
    assert.doesNotThrow(() => reports.ensureReport(ui, 'detail'));
  });

  await test('CONTEXT: switching away and back, repeatedly, never throws and stays renderable', async () => {
    const root = tmpdir('ctxpane-');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x","scripts":{"test":"node t.js"}}', 'utf8');
    fs.writeFileSync(path.join(root, 'index.js'), 'function go() {}\nmodule.exports = { go };\n', 'utf8');
    const ui = fakeUi(root);

    // THE REPRO, twenty times over, through the SAME path a keystroke takes.
    for (let i = 0; i < 20; i++) {
      for (const view of ['context', 'activity', 'context', 'diff', 'detail', 'plan', 'context']) {
        ui.screen.setView(view);
        assert.doesNotThrow(() => ui.ensureReport(view), `${view} on round ${i}`);
        // AND THE PANE IS DRAWN ON EVERY ONE, because a redraw happens between
        // every keystroke and rendering a half-built report is the other way
        // this crashes.
        if (view === 'context' || view === 'detail') {
          assert.doesNotThrow(() => contextview.render(view, ui.screen.report.brief, {
            width: 100, session: ui.app.session, cwd: root,
          }), `rendering ${view} on round ${i}`);
        }
      }
    }
    // Let whatever pass is in flight finish, then draw again — the state having
    // changed under the pane is the case that must also be safe.
    await Promise.resolve(ui._briefPending);
    const out = contextview.render('context', ui.screen.report.brief, { width: 100, session: ui.app.session, cwd: root });
    assert.ok(Array.isArray(out) && out.length, 'the pane must still produce lines after the pass lands');
  });

  await test('CONTEXT: 140 tab switches start ONE survey, not 140', async () => {
    // Each pass reads the tree, the git state and the toolchain. Starting a
    // fresh one per keystroke means a person cycling the tabs has several
    // running at once over the same directory, finishing in any order and each
    // overwriting the last — expensive, and the "state mutated while the pane
    // is being rebuilt" shape.
    const root = tmpdir('ctxpane-');
    fs.writeFileSync(path.join(root, 'index.js'), 'const a = 1;\n', 'utf8');
    const ui = fakeUi(root);
    let started = 0;
    const realBuild = require('../../src/briefcommand').build;
    require('../../src/briefcommand').build = async (...a) => { started += 1; return realBuild(...a); };
    try {
      for (let i = 0; i < 70; i++) {
        ui.ensureReport('context');
        ui.ensureReport('activity');
        ui.ensureReport('detail');
      }
      await Promise.resolve(ui._briefPending);
      for (let i = 0; i < 70; i++) ui.ensureReport('context');
      await Promise.resolve(ui._briefPending);
    } finally {
      require('../../src/briefcommand').build = realBuild;
    }
    assert.strictEqual(started, 1, `the survey ran ${started} times for 140 tab switches`);
  });

  await test('CONTEXT: a survey IS re-read once real work has happened', async () => {
    // The other half of the caching rule. Looking again is not evidence that
    // the tree moved; a turn having run is. A cache with no way to go stale is
    // just a wrong answer that never changes.
    const root = tmpdir('ctxpane-');
    fs.writeFileSync(path.join(root, 'index.js'), 'const a = 1;\n', 'utf8');
    const ui = fakeUi(root);
    ui.app.session.turns = [];
    let started = 0;
    const realBuild = require('../../src/briefcommand').build;
    require('../../src/briefcommand').build = async (...a) => { started += 1; return realBuild(...a); };
    try {
      ui.ensureReport('context');
      await Promise.resolve(ui._briefPending);
      ui.ensureReport('context');
      await Promise.resolve(ui._briefPending);
      assert.strictEqual(started, 1, 'no work happened between those two');

      ui.app.session.turns.push({ id: 't1' });                 // a turn ran
      ui.ensureReport('context');
      await Promise.resolve(ui._briefPending);
    } finally {
      require('../../src/briefcommand').build = realBuild;
    }
    assert.strictEqual(started, 2, 'a turn having run must make the survey stale');
    assert.strictEqual(reports.workKey(ui.app), '1:0');
  });

  await test('CONTEXT: a re-read never takes the old report off the screen', async () => {
    // ---- WHAT THIS LOOKED LIKE ------------------------------------------
    //
    // "Can't see anything, the reading took all the blank space." Refreshing
    // CLEARED the cached survey and then started a new one, so the pane fell
    // back to its placeholder for the whole of every refresh — and during an
    // active turn that is close to permanent, because files change on every
    // write, which moves the cache key, which threw the report away again.
    // The pane a person opens WHILE the work is happening was exactly the pane
    // that could never show any.
    //
    // A survey a few seconds old is a good answer; a placeholder is not an
    // answer at all.
    const root = tmpdir('ctxstale-');
    fs.writeFileSync(path.join(root, 'index.js'), 'const a = 1;\n', 'utf8');
    const ui = fakeUi(root);
    ui.app.session.turns = [];

    ui.ensureReport('context');
    await Promise.resolve(ui._briefPending);
    const first = ui.screen.report.brief;
    assert.ok(first, 'the first pass must land');

    // Work happens — the key moves, so a re-read is due.
    ui.app.session.turns.push({ id: 't1' });
    ui.ensureReport('context');
    assert.strictEqual(ui.screen.report.brief, first,
      'the previous survey must stay on screen while the next one is read');
    assert.strictEqual(ui.screen.report.reading, true, 'and the pane must say a newer one is coming');

    // It is REPLACED, not blanked, when the new one arrives.
    await Promise.resolve(ui._briefPending);
    assert.ok(ui.screen.report.brief, 'and there is still a survey afterwards');
    assert.strictEqual(ui.screen.report.reading, false);

    // The header says so over the report that is up, rather than replacing it.
    const mid = contextview.render('context', first, { width: 90, cwd: root, reading: true }).join('\n');
    assert.ok(/re-reading/.test(mid), 'the corner says a newer pass is in flight');
    assert.ok(/PROJECT/.test(mid), 'and the report is still there while it runs');
  });

  await test('CONTEXT: the pane says what it already knows before the survey lands', async () => {
    // The expensive half reads the git state, the toolchain and the findings
    // and spawns compilers to do it. Almost nothing at the top of the pane
    // needs any of that: where the project is, what it is written in and how to
    // run it are a directory walk and one file read.
    const root = tmpdir('ctxquick-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src/b.js'), 'const b = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","scripts":{"test":"node t.js"}}', 'utf8');

    const started = Date.now();
    const quick = reports.quickFacts(root);
    assert.ok(Date.now() - started < 2000, 'the cheap half must stay cheap');
    assert.strictEqual(quick.root, root);
    assert.ok(quick.languages.js >= 2, `the census must find the source: ${JSON.stringify(quick.languages)}`);
    assert.ok(quick.commands.some((c) => c.label === 'test'), 'and how to run it');

    const text = contextview.pending('context', 90, '', quick).join('\n');
    assert.ok(/PROJECT/.test(text), 'the pane must say what the project IS while it reads');
    assert.ok(new RegExp(path.basename(root)).test(text), 'naming it');
    assert.ok(/js \(2\)/.test(text), 'and what it is written in');
    assert.ok(/node t\.js|npm/.test(text), 'and how to run it');
    // HONEST, AND AT THE BOTTOM. It was a section with a heading in the middle
    // of the pane, so the notice that the pane was unfinished took more room
    // than the facts it was waiting on. One line, last, under the content —
    // the corner of the title is where the status itself lives.
    const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(/still reading/i.test(text), 'it must still say more is coming');
    assert.ok(/still reading/i.test(rows[rows.length - 1]), `and say it LAST: ${rows.slice(-3).join(' | ')}`);
    assert.strictEqual(text.match(/still reading/gi).length, 1, 'in one line, not a section');
    assert.ok(rows.indexOf(rows.find((l) => /PROJECT/.test(l))) < rows.length - 1,
      'with the facts above it');

    // AND THE PANE STILL WORKS WITH NOTHING AT ALL — the very first frame,
    // before even the cheap pass has run.
    assert.doesNotThrow(() => contextview.pending('context', 90, '', null));
  });

  await test('CONTEXT: opening the pane fills the cheap facts in, once', () => {
    const root = tmpdir('ctxquick2-');
    fs.writeFileSync(path.join(root, 'index.js'), 'const a = 1;\n', 'utf8');
    const ui = fakeUi(root);
    ui.ensureReport('context');
    assert.ok(ui.screen.report.quick, 'the cheap facts are computed on the way in');
    const once = ui.screen.report.quick;
    ui.ensureReport('detail');
    assert.strictEqual(ui.screen.report.quick, once, 'and not recomputed on every entry');
  });

  await test('CONTEXT: a report that fails leaves the session alive and the pane honest', async () => {
    const root = tmpdir('ctxpane-');
    const ui = fakeUi(root);
    const realBuild = require('../../src/briefcommand').build;
    require('../../src/briefcommand').build = async () => { throw new Error('the tree could not be read'); };
    try {
      assert.doesNotThrow(() => ui.ensureReport('context'));
      await Promise.resolve(ui._briefPending);
    } finally {
      require('../../src/briefcommand').build = realBuild;
    }
    assert.ok(ui.screen.report.failed && ui.screen.report.failed.context,
      'a failed pass must be recorded, not swallowed — a pane stuck on "reading…" is how this stayed invisible');
    const lines = contextview.render('context', null, { width: 90, failed: ui.screen.report.failed.context }).join('\n');
    assert.ok(/unavailable/i.test(lines), 'and the pane must say so rather than claim to still be reading');
    assert.ok(/could not be read/.test(lines), 'naming the reason');
    // AND IT ASKS AGAIN. A cleared flag is what lets the next entry retry.
    assert.strictEqual(ui._briefPending, null, 'the pending flag must be cleared on the failure path too');
  });

  await test('CONTEXT: a malformed or partial survey renders a placeholder, never a throw', () => {
    for (const bad of [null, undefined, {}, { languages: null, health: null }, { git: { ok: true } }, 42, 'nonsense']) {
      for (const view of ['context', 'detail']) {
        assert.doesNotThrow(() => contextview.render(view, bad, { width: 80 }), `${view} on ${JSON.stringify(bad)}`);
      }
    }
  });

  // ============================================ WHAT BELONGS IN WHICH PANE ==

  await test('CONTEXT: the pane carries identity, state and the next action — not the discovery output', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const text = contextview.contextDoc(survey, { width: 100, session: null, cwd: root }).join('\n');

    // HIGH SIGNAL, present.
    assert.ok(/PROJECT/.test(text), 'project identity');
    assert.ok(/Stack/.test(text) && /js \(40\)/.test(text), 'the stack it is written in');
    assert.ok(/STATE/.test(text) && /Build/.test(text), 'the active state');
    assert.ok(/NEXT/.test(text), 'what to do next');

    // LOW SIGNAL, absent — this is the whole point of the split.
    assert.ok(!/surveying/i.test(text), 'the pane must not lead with its own discovery process');
    assert.ok(!/a stray brace/.test(text), 'a finding explanation belongs in DETAIL');
    assert.ok(!/Front-end runtime was not observed/.test(text), 'and so does the list of findings');
    assert.ok(!/truncated at 2500/.test(text), 'sweep bookkeeping is not context');
    assert.ok(!/Windows 11/.test(text), 'the machine is not the project');

    // THE ONE EXCEPTION, AND IT IS THE POINT OF THE PANE. The single `next`
    // action names the finding that is actually blocking, because "what do I
    // do now" is the most actionable thing there is. What is excluded is the
    // LIST — every finding, with its explanation, as a wall to read.
    const blocking = (text.match(/does not parse/g) || []).length;
    assert.strictEqual(blocking, 1, `the blocking finding is named once, as the next action: ${blocking} occurrence(s)`);
    assert.ok(/→ Investigate/.test(text), 'and it is named as an action, not as a report');

    // THE COUNT IS THERE, WITH A POINTER — a summary, not a silence.
    assert.ok(/1 error/.test(text), `the number of findings must be stated: ${text}`);
    assert.ok(/DETAIL \(8\)/.test(text), 'and where to read them');
  });

  await test('DETAIL: the pane carries the rows behind the counts', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const text = contextview.detailDoc(survey, { width: 100, cwd: root }).join('\n');
    assert.ok(/does not parse/.test(text), 'the finding itself');
    assert.ok(/a stray brace/.test(text), 'and its explanation');
    assert.ok(/truncated at 2500/.test(text), 'and what the sweep did not reach');
    assert.ok(/ENVIRONMENT/.test(text) && /Windows 11/.test(text), 'and the machine');
    assert.ok(/src\/e\.js/.test(text), 'and every changed file, not the first three');
    assert.ok(/CONTEXT \(1\)/.test(text), 'with the way back');
  });

  await test('CONTEXT and DETAIL do not print the same list twice', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const ctx = contextview.contextDoc(survey, { width: 100, session: null, cwd: root }).join('\n');
    const det = contextview.detailDoc(survey, { width: 100, cwd: root }).join('\n');
    // The finding ROWS live in exactly one of them. CONTEXT may name the ONE
    // that is blocking, as its next action; DETAIL carries all of them with
    // the evidence behind each.
    assert.strictEqual((ctx.match(/does not parse/g) || []).length, 1);
    assert.ok(/does not parse/.test(det) && /a stray brace/.test(det));
    assert.ok(!/a stray brace/.test(ctx), 'the evidence behind a finding is never in both');
    // CONTEXT shows the first few changed files as a shape and says where the
    // rest are; DETAIL has all of them. That is a summary and its detail, not
    // a duplicate.
    assert.ok(/src\/a\.js/.test(ctx), 'the shape of the change is context');
    assert.ok(!/src\/e\.js/.test(ctx), 'the tail of the list is not');
    assert.ok(/more in DETAIL/.test(ctx));
  });

  await test('CONTEXT: a migration in flight is stated, because it changes how everything else reads', () => {
    const root = tmpdir('ctxpane-');
    const M = require('../../src/migration');
    const intent = require('../../src/migrationintent');
    const map = require('../../src/migrationmap');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/scanner.cpp'), 'void Scanner::scan() { }\n', 'utf8');
    const d = intent.parse('Migrate src to Python');
    d.paths = ['src'];
    d.dispositionHint = 'REPLACE';
    const built = map.build(root, d, { intent: 'Migrate src to Python' });
    M.save(built.contract);

    const rows = contextview.migrationRows(root);
    assert.ok(rows, 'an active migration must be reported');
    assert.ok(rows.outstanding.includes('src/scanner.cpp'),
      `what has not gone yet is the part somebody coming back needs: ${JSON.stringify(rows)}`);

    const text = contextview.contextDoc(fakeSurvey(root), { width: 100, session: null, cwd: root }).join('\n');
    assert.ok(/MIGRATION/.test(text), 'and it must appear on the pane');
    assert.ok(/Not yet gone/.test(text), 'saying what is still there that should not be');

    // A FINISHED MIGRATION IS NOT ACTIVE STATE. It would be one more true,
    // useless line — exactly what this pane was cleared out of.
    M.note(built.contract, M.STAGE.COMPLETE, 'done');
    M.save(built.contract);
    assert.strictEqual(contextview.migrationRows(root), null);
  });

  // ============================================= THE STRIP AND THE KEYS =====

  await test('TABS: Alt+N opens the pane whose number is printed in the strip, for every N', () => {
    // Alt+6 and Alt+7 were hand-written to open `audit` and `health` — panes
    // REMOVED from the strip — so the labels said `6 files` and `7 memory`
    // while the keys set a view name nothing draws. Both lists come from
    // tabs.js now, which is the only way they cannot drift.
    const keys = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'keys.js'), 'utf8');
    assert.ok(!/setView\('audit'\)|setView\('health'\)/.test(keys),
      'no key may open a pane that is not in the strip');
    for (let n = 1; n <= tabs.VIEWS.length; n++) {
      const view = tabs.byNumber(n);
      assert.ok(view, `Alt+${n} must name a view`);
      assert.strictEqual(tabs.numberOf(view), n, `the strip prints ${n} for ${view}`);
    }
    assert.strictEqual(tabs.byNumber(8), 'detail', 'Alt+8 is the secondary information view');
  });

  await test('CONTEXT: the pane fills the space under the banner, not the strip above the input', () => {
    // ---- WHAT THIS LOOKED LIKE ON SCREEN ----------------------------------
    //
    // The CONTEXT heading sat just above the input box with the whole pane
    // empty above it — a project briefing pushed off the part of the screen
    // anybody looks at. The cause was `stickToBottom`, which is right for a
    // conversation (newest line nearest the caret) and wrong for a document,
    // and which still listed `context` from when CONTEXT WAS the transcript.
    //
    // Asserted on the DRAWN ROWS, because that is where the defect was: the
    // report rendered perfectly and was simply put in the wrong half.
    const { Screen } = require('../../src/ui/layout');
    const T = require('../../src/ui/text');
    const root = tmpdir('ctxrows-');
    fs.writeFileSync(path.join(root, 'index.js'), 'const a = 1;\n', 'utf8');

    const draw = (view) => {
      let wrote = '';
      const s = new Screen({ out: { columns: 100, rows: 40, isTTY: true, write(x) { wrote += x; }, on() {}, removeListener() {} } });
      s.active = true;
      s.setView(view);
      s.report.brief = fakeSurvey(root);
      s.state = {
        cwd: root,
        session: { cwd: root, task: { objective: 'make the scanner fast' }, turns: [] },
        llm: { phase: null }, liveActions: [], liveNarration: [], extras: [],
      };
      s.draw();
      const rows = {};
      const re = new RegExp('\\x1b\\[(\\d+);1H([^\\x1b]*)', 'g');
      let m;
      while ((m = re.exec(wrote))) rows[Number(m[1])] = T.strip(m[2]).trimEnd();
      return { s, rows };
    };

    for (const view of ['context', 'detail']) {
      const { s, rows } = draw(view);
      const first = s.rowMap.feedStart;
      const last = first + s.rowMap.feedRows - 1;
      const filled = [];
      for (let r = first; r <= last; r++) if ((rows[r] || '').trim()) filled.push(r);
      assert.ok(filled.length > 5, `${view} drew almost nothing: ${filled.length} rows`);
      assert.strictEqual(s.rowMap.feedPad, 0, `${view} is padded down the screen like a conversation`);
      assert.ok(filled[0] <= first + 1,
        `${view} starts at row ${filled[0]} but its space begins at ${first} — it is anchored to the bottom`);
    }

    // AND THE TWO RULES STAY APART. `growsUpward` pads above short content;
    // `followsLive` scrolls new output into view. They were one flag, which is
    // why ACTIVITY could not read from the top without also going deaf to new
    // lines. See ui/tabs.js.
    assert.strictEqual(tabs.growsUpward('activity'), false,
      'the conversation reads from the top, like the transcript it is');
    assert.strictEqual(tabs.followsLive('activity'), true,
      'and still follows the newest line once there is more than a paneful');
    assert.strictEqual(tabs.growsUpward('output'), true,
      'a running command account is read newest-first and keeps its floor');
    assert.strictEqual(tabs.followsLive('output'), true);
    assert.strictEqual(tabs.growsUpward('context'), false);
    assert.strictEqual(tabs.followsLive('context'), false);
    assert.strictEqual(tabs.growsUpward('detail'), false);
  });

  await test('CONTEXT: the objective is on screen ONCE — the pinned banner owns it', () => {
    // The banner over CONTEXT already carries the objective and the plan
    // progress, and never scrolls. A pane that printed them again put the same
    // sentence on screen twice and spent rows the briefing had no room for.
    const root = tmpdir('ctxobj-');
    const survey = fakeSurvey(root);
    const session = {
      task: { objective: 'make the scanner fast' },
      plan: { steps: [{ text: 'read the loader', status: 'done' }, { text: 'rewrite the filter', status: 'active' }] },
    };
    const text = contextview.contextDoc(survey, { width: 100, session, cwd: root }).join('\n');
    assert.ok(!/make the scanner fast/.test(text), 'the objective belongs to the banner, not the document');
    // What the banner does NOT say is which step is running, so that stays.
    assert.ok(/rewrite the filter/.test(text), 'the active step is the one line worth adding under it');
  });

  await test('TABS: the cycle visits every pane and returns, in both directions', () => {
    // Started from the list rather than from a name: this is about WRAPPING,
    // not about which pane happens to lead, and writing the leader down here
    // made it a second copy of the order ui/tabs.js owns.
    const n = tabs.VIEWS.length;
    const first = tabs.VIEWS[0];
    let v = first;
    const forward = new Set([v]);
    for (let i = 0; i < n; i++) { v = tabs.step(v, 1); forward.add(v); }
    assert.strictEqual(v, first, 'Tab must wrap back to where it started');
    assert.strictEqual(forward.size, n, 'and pass through every pane on the way');

    v = first;
    for (let i = 0; i < n; i++) v = tabs.step(v, -1);
    assert.strictEqual(v, first, 'Shift+Tab must wrap too');
    assert.strictEqual(tabs.step(first, -1), tabs.VIEWS[n - 1], 'backwards from the first is the last');
  });
};
