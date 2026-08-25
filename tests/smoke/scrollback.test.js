'use strict';

/**
 * CAN YOU SCROLL BACK TO THE BEGINNING OF YOUR OWN CONVERSATION?
 *
 * A user could not. They scrolled up, hit a wall, and the start of their
 * session — which was sitting complete in the saved session file — was
 * unreachable from the screen.
 *
 * The cause was one line: the feed was BUILT from `turns.slice(-6)`. Not
 * trimmed for display, not paged — constructed from the last six turns, so
 * every mechanism downstream of it (the entry cap, the line clip, the scroll
 * bounds, which are computed from the number of lines produced) was operating
 * on a conversation that had already been thrown away. No amount of scrolling
 * could reach a seventh turn, because there was no seventh turn in the buffer
 * to scroll to.
 *
 * IT HAS TO BE TESTED BY SCROLLING. A unit test on the renderer proves the
 * lines exist; it cannot prove the key that moves the viewport can reach them,
 * and the bound that was wrong lived in the interaction between the two. So
 * this drives the real binary, presses PageUp, and looks for the FIRST message.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const TURNS = 120;
const PAGEUP = '\x1b[5~';

/**
 * SGR mouse reports, built rather than typed.
 *
 * Bit 32 is the motion flag: under button-event tracking it is set only while a
 * button is held, so a report carrying it is a DRAG. `M` is a press or a drag,
 * `m` a release — and no test here ever sends one.
 */
const SGR_PRESS = (x, y) => `\x1b[<0;${x};${y}M`;
const SGR_DRAG = (x, y) => `\x1b[<32;${x};${y}M`;

/** A session with enough turns that the old six-turn window is obviously short. */
function longSession() {
  const dir = tmpdir('lain-scroll-');
  const proj = path.join(dir, 'proj');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const turns = [];
  for (let i = 0; i < TURNS; i++) {
    turns.push({
      turnId: `t${i}`,
      startedAt: Date.now(),
      endedAt: Date.now(),
      userInput: `MARKERQ${i}`,
      text: `MARKERA${i}`,
      toolCalls: 0,
      toolNames: [],
      actions: [],
      narration: [],
      steerTexts: [],
      reasoning: '',
      errors: [],
      mutations: [],
      stopReason: 'done',
      usage: {},
    });
  }
  fs.writeFileSync(path.join(cfg, 'sessions', '20260101-000000-scrl.json'), JSON.stringify({
    id: '20260101-000000-scrl',
    createdAt: new Date().toISOString(),
    cwd: proj,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 },
    turns,
    task: null,
    lifecycle: null,
    evidence: {},
    plan: null,
    mode: null,
    actors: [],
  }), 'utf8');
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: proj, level: 'TRUSTED', at: new Date().toISOString() }],
  }, null, 2), 'utf8');
  return { proj, cfg };
}

module.exports = async function () {
  await test('SCROLLBACK: PageUp reaches the FIRST message of a long session', async () => {
    const { proj, cfg } = longSession();
    const r = await runCli(['--resume', 'scrl'], {
      cwd: proj,
      configDir: cfg,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: PAGEUP.repeat(80) + '/exit\n',
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-1500));

    const seen = new Set((r.out.match(/MARKERQ\d+/g) || []));
    assert.ok(seen.has('MARKERQ0'),
      `scrolling could not reach the first message of a ${TURNS}-turn session; `
      + `the earliest reached was ${[...seen].map((s) => Number(s.slice(7))).sort((a, b) => a - b)[0]}`);
    assert.ok(seen.has(`MARKERQ${TURNS - 1}`), 'and the most recent must still be there');
    // The old bound was six turns. Anything near that means the wall is back.
    assert.ok(seen.size > TURNS / 2,
      `only ${seen.size} of ${TURNS} turns were reachable — the feed is being truncated again`);
  });

  await test('SELECT: dragging across the feed highlights it, in the real binary', async () => {
    // PRESS AND DRAG ONLY, NEVER A RELEASE. A release copies, and a test that
    // writes the real clipboard has reached outside the tree to do something no
    // assertion would notice. The unit tier covers the copy with the clipboard
    // stubbed; this covers the half a unit test structurally cannot — that the
    // mouse bytes are decoded, routed and painted by a real process.
    const { proj, cfg } = longSession();
    let keys = SGR_PRESS(3, 8);
    for (let y = 8; y <= 12; y++) keys += SGR_DRAG(40, y);
    const r = await runCli(['--resume', 'scrl'], {
      cwd: proj,
      configDir: cfg,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: `${keys}/exit\n`,
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-1500));
    const REVERSE = `${String.fromCharCode(27)}[7m`;
    assert.ok(r.out.includes(REVERSE),
      'a drag across the feed painted no highlight at all — the selection never reached the screen');
    // And it must be over real conversation, not over empty chrome.
    const plain = r.out.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
    assert.ok(/MARKERQ\d+/.test(plain), 'the rows being dragged over must be the conversation');
  });

  await test('SCROLLBACK: the session opens at the BOTTOM, on the most recent message', async () => {
    // Reaching the top must not cost starting there. A resumed session shows
    // where the work left off.
    const { proj, cfg } = longSession();
    const r = await runCli(['--resume', 'scrl'], {
      cwd: proj,
      configDir: cfg,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: '/exit\n',
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-1500));
    assert.ok(r.out.includes(`MARKERQ${TURNS - 1}`), 'the newest message must be on screen at rest');
    assert.ok(!r.out.includes('MARKERQ0'),
      'and the oldest must NOT be — the view starts at the bottom, it does not dump the whole history');
  });
};
