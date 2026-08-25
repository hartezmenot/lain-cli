'use strict';

/**
 * THE UX RESTRUCTURING — what each surface is now FOR.
 *
 * The complaint these come from was not that anything was broken. It was that
 * the screen was mostly chrome: the objective printed twice, a pane that named
 * itself inside itself, a diff view containing no diff, a conversation marooned
 * at the top of an empty rectangle, and a dashboard that listed tool names
 * instead of showing the conversation.
 *
 * Each test below pins one of those to the surface that now owns it, and — this
 * is the part that matters — several of them assert the ABSENCE of the thing
 * that was removed. A layout test that only checks the new thing is present
 * lets the old duplicate quietly come back.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const views = require('../../src/ui/views');
const panes = require('../../src/ui/panes');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');
const { statusStrip } = require('../../src/ui/status');
const panelMod = require('../../src/ui/panel');

const strip = (lines) => T.strip([].concat(lines).join('\n'));

function screenWithTask(rows = 24, objective = 'the dashboard has been stale since Aug 14', view = 'context') {
  let wrote = '';
  const s = new Screen({ out: { columns: 100, rows, isTTY: true, write(x) { wrote += x; }, on() {}, removeListener() {} } });
  s.active = true;
  // WHICH PANE, EXPLICITLY. These phases are about two different surfaces: the
  // pinned task banner lives over CONTEXT, and the transcript lives in
  // ACTIVITY — which used to be the same pane and no longer is. A fixture that
  // leaves it to the default asks the conversation's rules of a report.
  s.view = view;
  s.stickToBottom = require('../../src/ui/tabs').followsLive(view);
  s.state = {
    cwd: 'C:\\work\\scalpbot',
    session: { cwd: 'C:\\work\\scalpbot', task: { objective }, turns: [{ userInput: 'it stopped updating', text: 'I found the writer.', actions: [], errors: [] }] },
    llm: { phase: null },
    liveActions: [], liveNarration: [], extras: [],
  };
  s.draw();
  return { screen: s, out: wrote };
}

module.exports = async function () {
  // ------------------------------------------------- A — context / chrome --

  await test('PHASE A: the objective is on screen ONCE, not in the header as well', () => {
    const objective = 'the dashboard has been stale since Aug 14';
    const { out } = screenWithTask(24, objective);
    const text = T.strip(out).split('\x1b').join('');
    const hits = text.split(objective).length - 1;
    assert.strictEqual(hits, 1, `the objective appears ${hits} times; the header used to repeat the banner`);
  });

  await test('PHASE A: the CONTEXT pane does not print its own name inside itself', () => {
    // The tab strip one row above already reads `[1 context]`.
    const lines = views.activity({
      session: { turns: [{ userInput: 'do it', text: 'Working.', actions: [], errors: [] }] },
      width: 90,
    });
    const text = strip(lines);
    assert.match(text, /USER/);
    // The model's answer is present; it simply is not announced by name.
    assert.match(text, /Working\./);
    assert.ok(!/^CONTEXT$/m.test(text), 'the pane must not label itself:\n' + text);
  });

  await test('PHASE A: a short conversation reads from the TOP of the pane, not glued to the input', () => {
    // A TRANSCRIPT IS READ FROM ITS FIRST LINE DOWN.
    //
    // This asserted the opposite until now — newest line against the caret, the
    // way a chat window works — and on a real terminal it read as a fault: the
    // first thing said sat at the bottom of an otherwise empty pane, and every
    // new line shunted the whole exchange upward, so a short answer looked like
    // a screen that had already scrolled away.
    //
    // FOLLOWING NEW OUTPUT IS A SEPARATE RULE and is unchanged — ACTIVITY still
    // scrolls itself to the newest line once there is more than a paneful. See
    // ui/tabs.js, where the two rules stopped sharing one flag.
    const { screen, out } = screenWithTask(24, undefined, 'activity');
    const rows = {};
    const re = new RegExp('\\x1b\\[(\\d+);1H([^\\x1b]*)', 'g');
    let m;
    while ((m = re.exec(out))) rows[Number(m[1])] = T.strip(m[2]).trimEnd();
    const feed = screen.rowMap.feedStart;
    const feedEnd = feed + screen.rowMap.feedRows - 1;
    const filled = [];
    for (let r = feed; r <= feedEnd; r++) if ((rows[r] || '').trim()) filled.push(r);
    assert.ok(filled.length, 'the conversation must be drawn somewhere');
    assert.strictEqual(screen.rowMap.feedPad, 0,
      'ACTIVITY must not pad above its content — that is what glued it to the floor');
    assert.ok(filled[0] <= feed + 1,
      `the conversation should start at the top of the feed (first filled ${filled[0]}, feed begins ${feed})`);
  });

  // ------------------------------------------------------ B — live status --

  // ---- ONE PROGRESS INDICATOR, NOT TWO ------------------------------------
  //
  // The strip used to draw `STEP 3/5 ████░░ 60%` in its right-hand column, and
  // the task banner drew the SAME BAR at the top of the same screen. One
  // measurement, two indicators, competing for the corner where the thing that
  // moves every second needed to be. The banner keeps it — progress belongs
  // beside the objective it measures — and the strip now answers the question
  // the banner cannot: what is this costing.
  //
  // These tests are the guard on that split. The bar must be in exactly one
  // place, and it must be the top one.

  await test('PHASE B: the strip names the work, and does NOT repeat the banner bar', () => {
    const line = T.strip(statusStrip({
      phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'src/dashboard.py' },
      phaseSince: Date.now() - 3000,
      progress: { known: true, current: 3, total: 5, percent: 60 },
      recent: [],
    }, 100, 1)[0]);
    assert.match(line, /READING/, 'the verb, not a generic RUNNING');
    assert.match(line, /dashboard\.py/, 'and what it is reading');
    assert.ok(!/STEP 3\/5/.test(line), 'the step count belongs to the banner, not to both');
    assert.ok(!/[█░]{6,}/.test(line), 'and so does the bar — one indicator per measurement');
  });

  await test('PHASE B: the bar is still drawn, once, by the task banner', () => {
    // The measurement did not disappear; it stopped being drawn twice.
    const session = {
      task: { objective: 'wire the dashboard to the live feed' },
      plan: {
        steps: [
          { status: 'done' }, { status: 'done' }, { status: 'done' },
          { status: 'active' }, { status: 'todo' },
        ],
      },
    };
    const rows = views.taskBanner({ session, width: 100 }).map(T.strip).join('\n');
    assert.match(rows, /STEP 4\/5/, 'where in the plan');
    assert.match(rows, /[█░]{6,}/, 'a bar you can read at a glance');
    assert.match(rows, /60%/, 'and how much is finished');
  });

  await test('PHASE B: the strip reports tokens, and never invents an output figure', () => {
    // §10. The input side of an open request is known from its first frame and
    // is shown; the OUTPUT side is stated once, at the end, by every provider
    // LAIN speaks to — so while a request is open there is nothing to draw and
    // a `+…` says so rather than a `0` pretending to be a measurement.
    const open = T.strip(statusStrip({
      phase: { phase: 'WAITING_MODEL' },
      requestOpen: true,
      usage: { inputTokens: 42118, outputTokens: 1234, cacheReadTokens: 31400, cacheCreationTokens: 0 },
      liveUsage: { inputTokens: 18300, cacheReadTokens: 0, cacheCreationTokens: 0 },
      recent: [],
    }, 100, 1)[0]);
    assert.match(open, /↑42K/, 'input, the session total');
    assert.match(open, /⚡31K/, 'cache reads — the only way to tell whether caching works at all');
    assert.match(open, /↓1\.2K/, 'output, completion-only and always a total');
    assert.match(open, /\+18K/, 'and the open request, separate from the total rather than folded in');

    const unknown = T.strip(statusStrip({
      phase: { phase: 'WAITING_MODEL' },
      requestOpen: true,
      usage: { inputTokens: 42118, outputTokens: 1234, cacheReadTokens: 31400 },
      recent: [],
    }, 100, 1)[0]);
    assert.match(unknown, /\+…/, 'a request is open and its cost is genuinely not known yet');
    assert.ok(!/\+0\b/.test(unknown), 'which is never reported as zero');
  });

  await test('PHASE B: the telemetry gives way before the live row does', () => {
    for (const w of [100, 80, 60, 40]) {
      const line = T.strip(statusStrip({
        phase: { phase: 'RUNNING_TOOL', tool: 'run_bash', target: 'npm test' },
        requestOpen: false,
        usage: { inputTokens: 42118, outputTokens: 1234, cacheReadTokens: 31400 },
        recent: [],
      }, w, 1)[0]);
      assert.match(line, /RUNNING/, `the live row proves LAIN is alive at ${w}`);
      assert.ok(T.width(line) <= w, `the strip overflowed at ${w}: ${T.width(line)}`);
      if (w < 56) assert.ok(!/↑/.test(line), `accounting is shed rather than mangled at ${w}`);
    }
  });

  await test('PHASE B: a finished PLAN is never reported as the task being done', () => {
    const line = T.strip(statusStrip({
      progress: { known: true, current: 4, total: 4, percent: 100 },
      pendingCompletion: 'nothing has been run to check the change',
      recent: [],
    }, 100, 1)[0]);
    assert.match(line, /VERIFYING/, 'the task is not finished');
    assert.ok(!/\bDONE\b/.test(line), 'the strip must not say DONE over unverified work');
    // And the banner, which is where 100% now lives, still does not claim it.
    const session = {
      task: { objective: 'ship it' },
      plan: { steps: [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }] },
    };
    const rows = views.taskBanner({ session, width: 100 }).map(T.strip).join('\n');
    assert.match(rows, /100%/, 'the plan really is finished');
    assert.ok(!/\bDONE\b/.test(rows), 'and a full bar is still not a completion claim');
  });

  // ------------------------------------------------------------- E — diff --

  await test('PHASE E: DIFF opens on the actual diff, with a divider per file', () => {
    const dir = tmpdir('phe-');
    fs.writeFileSync(path.join(dir, 'app.js'), 'const x = 1;\nconst y = 2;\n');
    fs.writeFileSync(path.join(dir, 'knowledge.py'), 'a = 1\nb = 3\n');
    const checkpoints = {
      entries: [{
        files: [
          { path: path.join(dir, 'app.js'), existed: true, bytes: Buffer.from('const x = 1;\nconst y = 9;\n') },
          { path: path.join(dir, 'knowledge.py'), existed: true, bytes: Buffer.from('a = 1\nb = 2\n') },
        ],
      }],
    };
    const text = strip(panes.diffView({ checkpoints, cwd: dir, width: 92 }));
    assert.match(text, /━━ app\.js/, 'a divider carrying the path');
    assert.match(text, /━━ knowledge\.py/, 'and one for the next file, so scrolling walks between them');
    assert.match(text, /-\s*const y = 9;/, 'the removed line, without being asked for');
    assert.match(text, /\+\s*const y = 2;/, 'and the added one');
    assert.ok(!/Enter to open a file/.test(text), 'nothing may stand between the user and the diff');
  });

  await test('PHASE E: the diff colours removals red and additions green', () => {
    const saved = { no: process.env.NO_COLOR, lain: process.env.LAIN_NO_COLOR };
    delete process.env.NO_COLOR; delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const dir = tmpdir('phec-');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'after\n');
      const checkpoints = { entries: [{ files: [{ path: path.join(dir, 'a.txt'), existed: true, bytes: Buffer.from('before\n') }] }] };
      const lines = panes.diffView({ checkpoints, cwd: dir, width: 70 });
      const minus = lines.find((l) => /-\s*before/.test(T.strip(l)));
      const plus = lines.find((l) => /\+\s*after/.test(T.strip(l)));
      assert.ok(minus && /\x1b\[31m/.test(minus), 'a removed line is red');
      assert.ok(plus && /\x1b\[32m/.test(plus), 'an added line is green');
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved.no !== undefined) process.env.NO_COLOR = saved.no;
      if (saved.lain !== undefined) process.env.LAIN_NO_COLOR = saved.lain;
    }
  });

  // ------------------------------------------------------------- F — plan --

  await test('PHASE F: PLAN is a checklist with a bar, and never claims completion', () => {
    const plan = {
      steps: [
        { n: 1, text: 'Inspect dashboard', status: 'done' },
        { n: 2, text: 'Trace signal event', status: 'done' },
        { n: 3, text: 'Fix frontend', status: 'active' },
        { n: 4, text: 'Run smoke test', status: 'todo' },
        { n: 5, text: 'Verify', status: 'todo' },
      ],
      decisions: [],
    };
    const text = strip(views.planView({ plan, width: 70 }));
    assert.match(text, /✓ Inspect dashboard/);
    assert.match(text, /● Fix frontend/, 'the step in flight is marked apart from the finished ones');
    assert.match(text, /○ Verify/);
    assert.match(text, /STEP 3\/5/);
    assert.match(text, /[█░]{8,}/, 'with a bar under the list it describes');
    assert.match(text, /40%/, 'and the percentage is COMPLETED work, not the step index');
    assert.ok(!/\bDONE\b/.test(text), 'the plan pane never declares the task finished');
  });

  // ----------------------------------------------------------- D — output --

  await test('PHASE D: OUTPUT states the exit status even when it succeeded', () => {
    const text = strip(panes.outputView({
      outputs: [{ command: 'npm test', output: 'PASS a\nPASS b\n128 passed\n', exitCode: 0 }],
      width: 70,
    }));
    assert.match(text, /npm test/);
    assert.match(text, /128 passed/);
    assert.match(text, /Process exited 0/,
      'silence after a command is as consistent with "still running" as with success');
  });

  await test('PHASE D: OUTPUT says what is executing RIGHT NOW', () => {
    const text = strip(panes.outputView({
      outputs: [],
      running: { name: 'run_bash', target: 'npm test' },
      width: 70,
    }));
    assert.match(text, /npm test/);
    assert.match(text, /RUNNING/, 'the pane must answer "what is running?", not only "what ran"');
    assert.match(text, /tool\s+run_bash/, 'and name the tool doing it');
  });

  // -------------------------------------------------------- G — ask_user --

  await test('PHASE G: the MCQ is compact and labelled', () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({
      question: 'Which layout?',
      options: ['Minimal — only the essential controls', 'Chat-style — reads like a conversation'],
    }));
    const body = strip(p.render(64, 12));
    assert.match(body, /LAIN NEEDS YOUR INPUT/);
    // WAS `[A] Minimal`. The label is now `A.  Minimal` — see ui/answer.js: it
    // is a thing you can TYPE, so it has to read the same for a letter and for
    // a number, and the brackets were noise around it.
    assert.match(body, /A\.  Minimal/);
    assert.match(body, /B\.  Chat-style/);
    assert.ok(!/only the essential controls/.test(body),
      'the reasoning belongs one level down, not clipped into the choice');
    assert.match(body, /Esc details/, 'and Escape is advertised as the way to it');
    // AND THE KEY THAT ANSWERS IT. A footer that names only the way OUT of a
    // question is how the typed answer came to be undiscoverable.
    assert.match(body, /type A-B/, 'the footer must name the answering key too');
  });

  await test('PHASE G: Escape opens the DETAILS and Escape returns, question intact', () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({
      question: 'Which layout?',
      options: ['Minimal — only the essential controls', 'Chat-style — reads like a conversation', 'Other'],
    }));
    p.move(1);
    const at = p.cursor;
    assert.strictEqual(p.escape(), true, 'Escape is claimed by the MCQ');
    const details = strip(p.render(64, 16));
    assert.match(details, /QUESTION DETAILS/);
    assert.match(details, /only the essential controls/, 'the full reasoning is here');
    assert.match(details, /reads like a conversation/);
    assert.strictEqual(p.escape(), true, 'and Escape comes back');
    assert.match(strip(p.render(64, 12)), /Which layout\?/, 'the question survived');
    assert.strictEqual(p.cursor, at, 'and so did the highlighted choice');
  });

  await test('PHASE G: Escape still CANCELS a question that has nothing more to explain', () => {
    // Escape that opens an empty screen is worse than Escape that cancels.
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'Continue?', options: ['Yes', 'No'] }));
    assert.strictEqual(p.escape(), false, 'the frame declines it, so the caller closes as usual');
    assert.match(strip(p.render(60, 10)), /Esc cancel/);
  });

  await test('PHASE G: the answer still comes back through the ONE ask promise', () => {
    const p = new panelMod.InteractionPanel();
    const promise = p.open(panelMod.askAdapter({ question: 'Which?', options: ['A — one', 'B — two'] }));
    p.escape();            // into details
    p.escape();            // back out
    p.select({ key: 'enter' });
    return promise.then((v) => {
      assert.strictEqual(v, 'A — one', 'the round trip through details must not orphan the caller');
    });
  });

  // ------------------------------------------------------------ L — dash --

  await test('PHASE L: the dashboard is served a CONVERSATION, in order', () => {
    const { conversation } = require('../../src/dashconversation');
    const session = {
      turns: [
        { userInput: 'fix the dashboard', text: 'I found the writer.', actions: [{ name: 'read_file', target: 'dashboard.py', ok: true }] },
        { userInput: 'go on', text: 'Editing now.', actions: [] },
      ],
      actors: [{ kind: 'external', text: 'FACT: status.json is stale.', afterTurns: 1 }],
    };
    const who = conversation(session, {}).map((m) => m.who);
    assert.deepStrictEqual(who, ['USER', 'LAIN', 'ACTION', 'EXTERNAL', 'USER', 'LAIN'],
      'the review sits between the turn that produced it and the turn that followed');
  });

  await test('PHASE L: the page is a chat, and stays read-only until actions are enabled', () => {
    const html = require('../../src/dashpage').page('tok');
    assert.match(html, /id="thread"/, 'a conversation thread');
    assert.match(html, /Type a message/, 'and a composer');
    assert.match(html, /viewport/, 'sized for a phone');
    // THE SAFETY PROPERTIES, unchanged by making it pretty.
    assert.match(html, /\$\('steer'\)\.disabled=!on/, 'the composer is disabled without actions');
    assert.ok(!/\bexec\b|child_process|\/api\/shell/.test(html), 'no arbitrary execution is offered');
    assert.match(html, /esc\(/, 'and everything reaching the DOM is escaped');
  });

  // ------------------------------------------------- M — visual inspection --

  await test('PHASE M: visual readiness answers for EITHER transport, and for refusals', () => {
    // MOVED OUT OF inspection.js, where it asked `app.desktop()` and nothing
    // else — so a machine with a Probe running and no MCP bridge was told "no
    // desktop bridge is configured, so nothing can look at the screen" while
    // `computer{op:"screenshot"}` was working perfectly through the Probe. It
    // was answering about ONE transport in a program that has two. It lives in
    // computer.js now, which is the module that knows both.
    const { visualReadiness, channelsOf } = require('../../src/computer');
    const { CHANNEL } = require('../../src/channels');

    const off = visualReadiness({});
    assert.strictEqual(off.ok, false);
    assert.match(off.why, /nothing is connected/);

    // A PROBE ALONE IS ENOUGH, which is the case the old version got wrong.
    const probeOnly = { _probe: { state: 'CONNECTED', call: async () => ({ ok: true }) } };
    const viaProbe = visualReadiness(probeOnly);
    assert.strictEqual(viaProbe.ok, true, 'a Probe can see the screen');
    assert.strictEqual(viaProbe.transport, 'probe');

    // A BRIDGE ALONE IS ALSO ENOUGH.
    const bridgeOnly = { desktop: () => ({ bridge: { call: async () => ({ ok: true }) } }) };
    assert.strictEqual(visualReadiness(bridgeOnly).transport, 'desktop');

    // AND A REFUSAL CLOSES IT, however connected the transport is. Reporting
    // POSSIBLE here is the "it says CONNECTED, why did nothing happen"
    // complaint in its original form.
    channelsOf(probeOnly).deny(CHANNEL.SCREEN, 'you said no');
    const refused = visualReadiness(probeOnly);
    assert.strictEqual(refused.ok, false, 'connected is not the same as allowed to look');
    assert.match(refused.why, /SCREEN DENIED/);
  });
};
