'use strict';

const assert = require('assert');
const { test } = require('../helpers');
const { Plan } = require('../../src/plan');
const views = require('../../src/ui/views');
const panelMod = require('../../src/ui/panel');
const { Screen } = require('../../src/ui/layout');

function mkPlan(statuses) {
  return { steps: statuses.map((st, i) => ({ n: i + 1, text: `step ${i + 1}`, status: st, note: '' })), decisions: [] };
}

module.exports = async function () {
  // ---- progress semantics: the trap the design calls out -------------------
  await test('UI: progress is COMPLETED work — step 1 started is 0%, not 20%', () => {
    const p = views.progressOf(mkPlan(['active', 'todo', 'todo', 'todo', 'todo']));
    assert.strictEqual(p.total, 5);
    assert.strictEqual(p.completed, 0);
    assert.strictEqual(p.current, 1, 'shows Step 1 / 5');
    assert.strictEqual(p.percent, 0, 'current/total would wrongly say 20%');
  });

  await test('UI: after step 1 finishes and step 2 starts, it is 20%', () => {
    const p = views.progressOf(mkPlan(['done', 'active', 'todo', 'todo', 'todo']));
    assert.strictEqual(p.current, 2);
    assert.strictEqual(p.percent, 20);
  });

  await test('UI: all steps done is 100% and reads COMPLETE', () => {
    const p = views.progressOf(mkPlan(['done', 'done', 'done']));
    assert.strictEqual(p.percent, 100);
    assert.strictEqual(p.completed, p.total);
    const h = views.header({ plan: mkPlan(['done', 'done', 'done']), status: views.STATE.COMPLETE, width: 80 });
    assert.ok(h.join('\n').includes('COMPLETE'));
  });

  await test('UI: an unknown total yields NO invented percentage', () => {
    const p = views.progressOf(null);
    assert.strictEqual(p.known, false);
    assert.strictEqual(p.percent, null);
  });

  await test('UI: dropped steps are excluded from the total', () => {
    const p = views.progressOf(mkPlan(['done', 'dropped', 'todo']));
    assert.strictEqual(p.total, 2);
    assert.strictEqual(p.percent, 50);
  });

  // ---- header -------------------------------------------------------------
  await test('UI: header shows model, connection and effort as SEPARATE fields', () => {
    const h = views.header({
      cwd: 'C:\\Projects\\TradingBot', model: 'Claude Opus 5', connection: 'OmniRoute',
      effort: 'high', status: views.STATE.WORKING, width: 80,
    }).join('\n');
    assert.ok(h.includes('LAIN'));
    assert.ok(h.includes('TradingBot'), 'project folder');
    assert.ok(h.includes('Claude Opus 5') && h.includes('OmniRoute') && h.includes('high'));
    assert.ok(h.includes('WORKING'));
  });

  await test('UI: header never exceeds the terminal width', () => {
    for (const w of [40, 60, 80, 120]) {
      const h = views.header({ cwd: 'C:\\a\\very\\long\\path\\that\\keeps\\going\\forever\\and\\ever', model: 'some-extremely-long-model-identity-name', connection: 'connection-name', effort: 'medium', plan: mkPlan(['done', 'todo']), status: views.STATE.READY, width: w });
      for (const line of h) assert.ok(line.length <= w, `header line ${line.length} > ${w}`);
    }
  });

  await test('UI: statusOf maps lifecycle onto header states', () => {
    assert.strictEqual(views.statusOf({ busy: true }), views.STATE.WORKING);
    assert.strictEqual(views.statusOf({ awaitingUser: true }), views.STATE.NEEDS_USER);
    assert.strictEqual(views.statusOf({ lifecycle: { state: 'BLOCKED' } }), views.STATE.BLOCKED);
    assert.strictEqual(views.statusOf({ lifecycle: { state: 'NEEDS_AUTH' } }), views.STATE.NEEDS_AUTH);
    assert.strictEqual(views.statusOf({ providerStatus: 'MAINTENANCE' }), views.STATE.MAINTENANCE);
    assert.strictEqual(views.statusOf({}), views.STATE.READY);
  });

  // ---- plan view: expansion is display-only -------------------------------
  await test('UI: expanding a step does NOT mutate plan state', () => {
    const plan = mkPlan(['done', 'active', 'todo']);
    const snapshot = JSON.stringify(plan);
    views.planView({ plan, expanded: new Set([2]), width: 80 });
    assert.strictEqual(JSON.stringify(plan), snapshot, 'the plan is read, never written');
  });

  await test('UI: PLAN folds older completed steps but keeps the newest evidence', () => {
    const plan = new Plan('long task');
    plan.addSteps(Array.from({ length: 20 }, (_, i) => `step ${i + 1}`));
    for (let i = 0; i < 17; i++) plan.complete(`done ${i + 1}`);
    const text = require('../../src/ui/views').planView({ plan, width: 80 }).join('\n');
    assert.match(text, /9 earlier completed step\(s\)/);
    assert.match(text, /step 10/, 'the newest completed steps stay visible');
    assert.ok(!text.includes('step 1.'), 'the oldest completed rows are folded');
    assert.match(text, /step 18/, 'the active step is still visible');
  });

  await test('UI: a collapsed step is one line; expanding it reveals the detail', () => {
    // Detail is what expansion is FOR. The default list stays one line per step
    // so a plan can be read at a glance, and neither form shows timestamps,
    // ids or lifecycle state.
    const plan = mkPlan(['active']);
    plan.steps[0].note = 'Refresh tokens are accepted without validation.';
    const collapsed = views.planView({ plan, expanded: new Set(), width: 80 }).join('\n');
    const expanded = views.planView({ plan, expanded: new Set([1]), width: 80 }).join('\n');

    assert.ok(!collapsed.includes('Refresh tokens'), 'collapsed hides the detail');
    assert.ok(expanded.includes('Refresh tokens'), 'expanded shows it');
    assert.ok(expanded.includes('Why'), 'under a heading a person can read');
    assert.ok(expanded.length > collapsed.length, 'expansion adds rows');
    assert.ok(!/\d{4}-\d{2}-\d{2}T|completedAt/.test(expanded), 'no internal metadata');
  });

  // ---- diff is deterministic ---------------------------------------------
  await test('UI: diff marks removed and added lines without an LLM', () => {
    const out = views.unifiedish('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\n', 40);
    // Rows carry line numbers now: "   2 - const b = 2;"
    assert.ok(out.some((l) => / - /.test(l) && l.includes('const b = 2;')), out.join('|'));
    assert.ok(out.some((l) => / \+ /.test(l) && l.includes('const b = 3;')), out.join('|'));
    assert.ok(out.every((l) => /^\s*\d+/.test(l)), 'every row is line-numbered');
  });

  await test('UI: a huge diff is bounded, not unbounded', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 5000 }, (_, i) => `changed ${i}`).join('\n');
    const out = views.unifiedish(before, after, 40);
    assert.ok(out.length < 200, `bounded output, got ${out.length} lines`);
  });

  // ---- the ONE interaction panel -----------------------------------------
  await test('PANEL: hidden by default; opening makes it visible', () => {
    const p = new panelMod.InteractionPanel();
    assert.strictEqual(p.visible, false);
    assert.strictEqual(p.mode, panelMod.MODE.HIDDEN);
    p.open(panelMod.effortAdapter({ available: ['low', 'high'], current: 'high' }));
    assert.strictEqual(p.visible, true);
    assert.strictEqual(p.mode, panelMod.MODE.COMPACT);
  });

  await test('PANEL: navigation skips non-selectable rows', () => {
    const p = new panelMod.InteractionPanel();
    p.open({ title: 't', items: [
      { label: 'heading', selectable: false },
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
    ] });
    p.cursor = 1;
    p.move(1);
    assert.strictEqual(p.items[p.cursor].value, 'b');
    p.move(1);
    assert.strictEqual(p.items[p.cursor].value, 'a', 'wrapped past the heading');
  });

  await test('PANEL: a long list is windowed, never rendered whole', () => {
    const p = new panelMod.InteractionPanel();
    p.open({ title: 'big', items: Array.from({ length: 2000 }, (_, i) => ({ label: `row ${i}`, value: i })) });
    const lines = p.render(80, 12);
    assert.strictEqual(lines.length, 12, 'exactly the allotted rows');
    for (const l of lines) assert.ok(l.length <= 80);
    assert.ok(lines.some((l) => l.includes('of 2000')), 'reports the window position');
  });

  await test('PANEL: Esc resolves the open() promise with null', async () => {
    const p = new panelMod.InteractionPanel();
    const pending = p.open(panelMod.confirmAdapter({ question: 'sure?' }));
    p.close(null);
    assert.strictEqual(await pending, null);
    assert.strictEqual(p.visible, false);
  });

  await test('PANEL: /models drills into routes and ← goes back', () => {
    const catalog = { models: [{ id: 'claude-opus-5', displayName: 'Claude Opus 5', connections: [
      { connectionId: 'omni:github', route: 'github', provider: 'anthropic', via: 'bridge', auth: 'none', efforts: ['low', 'high'] },
    ] }] };
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.modelsAdapter({ catalog }));
    assert.ok(p.frame.title.includes('MODELS'));
    // MODEL → ROUTES. One row per route plus its effort summary, so a model
    // served twenty ways is not a hundred and sixty lines of fields.
    //
    // `→` opens the routes; ENTER now means "use this model" and commits when
    // there is nothing left to choose. Measured on the live catalog, 882 of 975
    // models have exactly one route, so Enter-as-drill made the common case
    // cost three keypresses through two screens that offered no choice.
    p.select({ key: 'right' });
    assert.ok(p.frame.title.includes('CLAUDE OPUS 5'), 'drilled into routes');
    const routes = p.render(80, 14).join('\n');
    assert.ok(routes.includes('anthropic'), 'the route names its provider');
    assert.ok(routes.includes('low · high'), 'and summarises the efforts it offers');

    // ROUTE → DETAIL. identity / provider / connection / credential /
    // availability / effort are still SEPARATE fields — they moved one level
    // deeper, to where they are actually being asked for.
    p.select();
    const detail = p.render(80, 16).join('\n');
    assert.ok(detail.includes('connection'));
    assert.ok(detail.includes('provider'));
    assert.ok(detail.includes('credential'));
    assert.ok(detail.includes('EFFORT'));
    assert.ok(detail.includes('low') && detail.includes('high'), 'each level is choosable');

    p.back();
    assert.ok(p.frame.title.includes('CLAUDE OPUS 5'), 'back returned to the routes');
    p.back();
    assert.ok(p.frame.title.includes('MODELS'), 'back returned to the model list');
  });

  await test('PANEL: /models is model-centric — one row per identity', () => {
    const catalog = { models: [
      { id: 'a', displayName: 'Claude Opus 5', connections: [{}, {}, {}, {}] },
      { id: 'b', displayName: 'Kimi K3', connections: [{}] },
    ] };
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.modelsAdapter({ catalog }));
    assert.strictEqual(p.items.length, 2, 'two models, not six provider rows');
    // The row says "4 providers" where there is a choice to make, and names the
    // single provider where there is not. "4 routes / 1 route" was internal
    // vocabulary — a route count of 1 is not information a person can act on.
    assert.ok(p.items[0].label.includes('4 providers'), p.items[0].label);
    assert.ok(!/\broutes?\b/.test(p.items[1].label), `a lone route should not be counted at the user: ${p.items[1].label}`);
  });

  await test('PANEL: effort adapter always offers auto and marks the current level', () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.effortAdapter({ available: ['low', 'medium', 'high', 'xhigh'], current: 'high' }));
    const labels = p.items.map((i) => i.value);
    assert.deepStrictEqual(labels, ['low', 'medium', 'high', 'xhigh', 'auto']);
    assert.ok(p.items.find((i) => i.value === 'high').label.includes('(current)'));
  });

  await test('PANEL: ask_user renders the choices deterministically', () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'Which frontend?', options: ['React + Vite', 'Vanilla', 'Svelte'] }));
    // WAS `[A] React + Vite`, and before that `1. React + Vite` under `ASK
    // LAIN`. It is now `A.  React + Vite`: the bracket was noise, and the
    // label has to read the same way whether it is a letter or — on a list of
    // numeric choices — a number, because it is now something you can TYPE.
    // See ui/answer.js. The guarantee is unchanged: the same question and
    // options render the same rows every time, and every option is present.
    const body = p.render(60, 12).join('\n');
    assert.ok(body.includes('LAIN NEEDS YOUR INPUT'), body);
    assert.ok(body.includes('Which frontend?'));
    assert.ok(body.includes('A.  React + Vite'), body);
    assert.ok(body.includes('C.  Svelte'), body);
    assert.strictEqual(body, p.render(60, 12).join('\n'), 'and it is deterministic');
  });

  // ---- layout geometry ----------------------------------------------------
  function fakeOut(cols, rows) {
    return { columns: cols, rows, isTTY: true, write() {}, on() {}, removeListener() {} };
  }

  await test('LAYOUT: header and input are fixed; workspace absorbs the rest', () => {
    const s = new Screen({ out: fakeOut(80, 30) });
    const g = s.geometry();
    assert.strictEqual(g.inputRows, 3, 'input never shrinks');
    assert.strictEqual(g.panelRows, 0, 'panel hidden by default');
    // FIVE regions now, not four: the LLM status strip sits between the
    // workspace and the input. Every row of the terminal is still accounted for
    // by exactly one region — which is the property this test exists to hold.
    assert.ok(g.statusRows >= 1, 'the live status strip has a row on a normal terminal');
    assert.strictEqual(g.headerRows + g.workspace + g.statusRows + g.inputRows, 30);
  });

  await test('LAYOUT: an open panel shrinks the workspace, never the input', () => {
    const panel = new panelMod.InteractionPanel();
    const s = new Screen({ out: fakeOut(80, 30), panel });
    const before = s.geometry();
    panel.open(panelMod.effortAdapter({ available: ['low'], current: null }));
    const after = s.geometry();
    assert.ok(after.panelRows > 0, 'panel takes rows');
    assert.ok(after.workspace < before.workspace, 'workspace shrank');
    assert.strictEqual(after.inputRows, before.inputRows, 'input untouched');
  });

  await test('LAYOUT: a short terminal degrades instead of crashing', () => {
    for (const rows of [8, 10, 12, 14]) {
      const panel = new panelMod.InteractionPanel();
      const s = new Screen({ out: fakeOut(40, rows), panel });
      panel.open(panelMod.effortAdapter({ available: ['low', 'high'], current: null }));
      const g = s.geometry();
      assert.ok(g.workspace >= 1, `workspace kept at ${rows} rows`);
      assert.ok(g.inputRows === 3, 'input preserved');
      assert.ok(g.headerRows + g.workspace + g.statusRows + g.inputRows + g.panelRows <= rows);
    }
  });

  await test('LAYOUT: header goes compact on a short terminal', () => {
    assert.strictEqual(new Screen({ out: fakeOut(80, 30) }).geometry().compactHeader, false);
    assert.strictEqual(new Screen({ out: fakeOut(80, 12) }).geometry().compactHeader, true);
  });

  await test('LAYOUT: workspace windows huge content to the visible rows', () => {
    const s = new Screen({ out: fakeOut(80, 30) });
    s.state = { outputs: [{ command: 'npm test', output: Array.from({ length: 9000 }, (_, i) => `line ${i}`).join('\n'), exitCode: 0 }] };
    s.view = 'output';
    const total = s.workspaceLines(80, 28).length;
    assert.ok(total > 200, `content really is huge, got ${total}`);
    const g = s.geometry();
    assert.ok(g.workspace < 40, 'yet only a screenful is ever drawn');
  });

  await test('PALETTE: a path is CYAN, and the table in paint.js is not fiction', () => {
    // The palette exists so "what colour is a path" has ONE answer in one
    // file. Its own doc table said cyan while the code said `C.blue` — SGR 34,
    // a navy that on a dark terminal is barely separable from the background,
    // in views whose entire job is naming changed files.
    //
    // Forced on rather than mocked: the real `C.*` returns the string
    // untouched off a TTY, so without this the assertion would pass against
    // plain text and prove nothing.
    const savedNo = process.env.NO_COLOR;
    const savedLain = process.env.LAIN_NO_COLOR;
    const savedTty = process.stdout.isTTY;
    delete process.env.NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.stdout.isTTY = true;
    try {
      // Required fresh: render.js decides colour support at call time, but the
      // palette is captured on first import by whatever loaded it earlier.
      delete require.cache[require.resolve('../../src/ui/paint')];
      delete require.cache[require.resolve('../../src/render')];
      const paint = require('../../src/ui/paint');
      const P = paint.P || paint;
      const painted = P.path('src/added.js');
      assert.ok(painted.includes('\x1b[36m'), `a path must be cyan, got ${JSON.stringify(painted)}`);
      assert.ok(!painted.includes('\x1b[34m'), 'SGR 34 is the unreadable navy this replaced');
    } finally {
      if (savedNo !== undefined) process.env.NO_COLOR = savedNo;
      if (savedLain !== undefined) process.env.LAIN_NO_COLOR = savedLain;
      process.stdout.isTTY = savedTty;
      delete require.cache[require.resolve('../../src/ui/paint')];
      delete require.cache[require.resolve('../../src/render')];
    }
  });
};
