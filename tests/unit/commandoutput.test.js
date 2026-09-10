'use strict';

/**
 * WHERE A COMMAND'S OUTPUT GOES — and, just as importantly, where it does not.
 *
 * THE FIRST ATTEMPT AT THIS WAS WRONG, and the wrongness is worth recording
 * because it is the mistake the architecture keeps inviting. Command output was
 * polluting Context, so it was routed out of the transcript — into a NEW region
 * drawn just above the input, with its own geometry, its own draw path and its
 * own Esc handling. It worked. It was also a second window in the same corner of
 * the screen as the one `/` and `/model` already open, overlapping it, and it
 * truncated anything past eight rows so most command output never appeared at
 * all: 185 tests failed on output that had silently gone nowhere.
 *
 * There is ONE surface for "LAIN is showing you something", and it is the
 * interaction panel. Command output is an adapter for it, exactly like the
 * command palette and the model list.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Renderer } = require('../../src/render');
const panelMod = require('../../src/ui/panel');
const { InteractionPanel, KIND } = panelMod;
const T = require('../../src/ui/text');
const { outputAdapter } = require('../../src/ui/adapters');

/** A Renderer wired to a panel, pretending to be on a TTY. */
function wired() {
  const panel = new InteractionPanel();
  const out = { write() {}, columns: 96, isTTY: true, on() {} };
  const render = new Renderer(out);
  render.attachScreen({ active: true, panel, draw() { this.drew = (this.drew || 0) + 1; } });
  return { render, panel };
}

module.exports = async function () {
  await test('OUTPUT: a command writes into the PANEL, not into the transcript', () => {
    const { render, panel } = wired();
    render.openSurface('/status');
    render.write('  model    mock-model\n');
    render.write('  effort   auto\n');
    render.doneSurface();

    assert.strictEqual(panel.visible, true, 'the panel must be showing it');
    assert.strictEqual(panel.kind, KIND.OUTPUT, 'and must know what kind of panel it is');
    const labels = panel.items.map((i) => i.label);
    assert.ok(labels.some((l) => l.includes('mock-model')), `the output is missing: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('effort')), 'every line must arrive, not just the last few');
    assert.strictEqual(render.transcript.length, 0, 'NOTHING may reach the transcript Context renders');
  });

  await test('OUTPUT: nothing in it is selectable — there is nothing to choose', () => {
    const { render, panel } = wired();
    render.openSurface('/status');
    render.write('a\nb\nc\n');
    render.doneSurface();
    assert.ok(panel.items.length >= 3);
    for (const item of panel.items) {
      assert.strictEqual(item.selectable, false, 'a line of output is not an option');
    }
    assert.strictEqual(panel.current, null, 'so nothing is highlighted and Enter commits nothing');
  });

  await test('OUTPUT: a long report is SCROLLED, never truncated away', () => {
    // THE 185-FAILURE BUG. The region this replaced kept only its last rows, so
    // a command that said forty things showed eight and lost the rest — output
    // that had gone nowhere at all, silently.
    const { render, panel } = wired();
    render.openSurface('/status');
    for (let i = 0; i < 40; i++) render.write(`row ${i}\n`);
    render.doneSurface();
    const labels = panel.items.map((i) => i.label);
    assert.strictEqual(labels.length, 40, `expected all 40 rows, kept ${labels.length}`);
    assert.ok(labels[0].includes('row 0'), 'the FIRST line must survive — it is usually the answer');
    assert.ok(labels[39].includes('row 39'), 'and so must the last');
  });

  await test('OUTPUT: the arrows SCROLL it — every row is reachable', () => {
    // THE DEFECT, seen on a real `/status`: twelve rows of output in a ten-row
    // panel, a footer reading "(1-10 of 12)", and no keystroke that could reach
    // the other two. `move` walks the cursor to the next SELECTABLE row, output
    // has none, so the cursor stayed at 0 and the view never moved — a panel
    // that names what you are missing and will not show it to you.
    const { render, panel } = wired();
    render.openSurface('/status');
    for (let i = 0; i < 12; i++) render.write(`row ${i}\n`);
    render.doneSurface();

    const VIEW = 10;
    assert.strictEqual(panel.scroll, 0, 'it starts at the top');
    panel.move(1, VIEW);
    assert.strictEqual(panel.scroll, 1, 'down must move the view when there is no cursor to move');

    // ALL THE WAY DOWN reaches the last row, and stops there.
    for (let i = 0; i < 50; i++) panel.move(1, VIEW);
    assert.strictEqual(panel.scroll, 2, 'the view stops at the last screenful, not past it');
    const visible = panel.items.slice(panel.scroll, panel.scroll + VIEW).map((i) => i.label);
    assert.ok(visible.some((l) => l.includes('row 11')), 'the final row must be reachable');

    // AND A REDRAW MUST NOT HAUL IT BACK. `_clampScroll` follows the cursor,
    // which here is parked at 0 forever; following it would undo every scroll
    // on the very next frame.
    // THE CHROME IS ASKED FOR, NOT COUNTED. It was six rows of box; it is a title,
    // a blank row and a footer now (ui/panel.js `render`), and a test that knows
    // the number is a test that breaks when the box goes.
    panel.render(80, VIEW + 1 + panelMod.FOOTER_ROWS);
    assert.strictEqual(panel.scroll, 2, 'drawing the panel must not reset the scroll');

    for (let i = 0; i < 50; i++) panel.move(-1, VIEW);
    assert.strictEqual(panel.scroll, 0, 'and up returns to the top');
  });

  await test('OUTPUT: the same subject APPENDS; a different one starts clean', () => {
    // Compaction speaks twice — what it did, then what survived. Re-opening
    // under the same title must not wipe the first line before it is read.
    const { render, panel } = wired();
    render.openSurface('COMPACT');
    render.write('folded 54 messages\n');
    render.openSurface('COMPACT');
    render.write('kept: the objective\n');
    render.doneSurface();
    let labels = panel.items.map((i) => i.label);
    assert.strictEqual(labels.length, 2, `the second notice replaced the first: ${JSON.stringify(labels)}`);

    // A DIFFERENT TITLE IS A DIFFERENT THING BEING SHOWN.
    render.openSurface('/status');
    render.write('model mock\n');
    render.doneSurface();
    labels = panel.items.map((i) => i.label);
    assert.strictEqual(labels.length, 1, 'a new subject must not inherit the old one\'s lines');
    assert.ok(labels[0].includes('model mock'));
  });

  await test('OUTPUT: a QUESTION outranks a notice and is never replaced', () => {
    // The panel is the one surface, which means a notice and an `ask_user` want
    // the same frame. A question has a caller awaiting a value: replacing it
    // would answer somebody's question with silence.
    const { render, panel } = wired();
    const answered = [];
    panel.open({ title: 'Which one?', kind: KIND.ASK_USER, items: [{ label: 'A', value: 'A' }] })
      .then((v) => answered.push(v));

    const opened = render.openSurface('/status');
    assert.strictEqual(opened, false, 'a notice must refuse to take a panel that is awaiting an answer');
    render.write('this must not appear\n');
    render.doneSurface();

    assert.strictEqual(panel.kind, KIND.ASK_USER, 'the question must still be the open frame');
    assert.strictEqual(panel.frame.title, 'Which one?');
    assert.strictEqual(answered.length, 0, 'and it must not have been resolved behind the caller\'s back');
  });

  await test('FLASH: an informational notice CLEARS ITSELF, with no keystroke', async () => {
    // "Model changed", "unchanged", "effort high", "compacted 296k → 294k" are
    // notifications: you asked for something, this says what happened, and
    // there is nothing further to do with it. Requiring Esc to dismiss your own
    // confirmation is a keystroke that buys nothing, and until you press it the
    // box sits over the conversation.
    const { render, panel } = wired();
    render.openSurface('/model');
    render.write('  unchanged.\n');
    render.doneSurface({ closeAfterMs: 40 });
    assert.strictEqual(panel.visible, true, 'it must be readable first');
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(panel.visible, false, 'and then clear itself');
  });

  await test('FLASH: a stale timer never closes something ELSE', async () => {
    // In four seconds the user may have opened a question. Closing whatever
    // happens to be on screen would answer it with silence, so the timer is
    // guarded on the FRAME it opened, not merely on the panel being open.
    const { render, panel } = wired();
    render.openSurface('/model');
    render.write('  changed.\n');
    render.doneSurface({ closeAfterMs: 40 });
    panel.close(null);
    const answered = [];
    panel.open({ title: 'Which one?', kind: KIND.ASK_USER, items: [{ label: 'A', value: 'A' }] })
      .then((v) => answered.push(v));
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(panel.kind, KIND.ASK_USER, 'the question must survive the stale timer');
    assert.strictEqual(answered.length, 0, 'and must not have been resolved behind its caller');
  });

  await test('FLASH: output you READ has no timer at all', () => {
    // `/dash` prints an address and a credential somebody may be copying to a
    // phone; `/status` is a dozen facts to look through. Those wait for Esc.
    const cmds = require('../../src/commands');
    assert.strictEqual(cmds.REGISTRY.get('/dash').flashMs, 0, '/dash must wait to be dismissed');
    assert.strictEqual(cmds.REGISTRY.get('/status').flashMs, 0, '/status must wait to be dismissed');
    // And the default is to clear, so a new machinery command inherits the
    // right behaviour without anyone remembering to ask for it.
    assert.ok(cmds.REGISTRY.get('/models').flashMs > 0, 'a receipt clears itself');
    assert.ok(cmds.REGISTRY.get('/effort').flashMs > 0);
  });

  await test('WRAP: long output WRAPS — it is never cut mid-word', () => {
    // FROM A LIVE SCREEN: "Chat history exceeds the 800-mes…" — the panel
    // announced that a limit had been reached and then removed the number,
    // which is the one fact in the sentence. Output is prose and paths, not a
    // list of choices, so it continues on the next line.
    const { InteractionPanel } = require('../../src/ui/panel');
    const p = new InteractionPanel();
    const line = 'Provider omniroute is not answering: 413 Payload Too Large - Chat history '
      + 'exceeds the 800-message limit; compact the conversation and retry.';
    p.open(outputAdapter({ title: '/compact', lines: [line] }));
    const body = p.render(80, 16).join('\n');

    assert.ok(!/\b800-mes\b/.test(body), 'the number must not be cut in half');
    assert.match(body, /800-message limit/, 'the whole fact must survive somewhere');
    // EVERY WORD INTACT: reassembling the drawn rows must give the sentence back.
    // ---- NO BORDER TO STRIP ANY MORE -----------------------------------
    //
    // The rows used to arrive as `| text |` and this peeled the edges off. The
    // panel is a list now: the rows ARE the text, indented (ui/panel.js
    // `render`). What the test is about is unchanged — reassembling the drawn
    // rows must give the sentence back, with no word cut in half.
    const rebuilt = p.render(80, 16)
      .map((r) => T.strip(r).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    assert.ok(rebuilt.includes(line.replace(/\s+/g, ' ')),
      `the wrapped rows do not reassemble into the original:\n${rebuilt}`);
  });

  await test('WRAP: a word longer than the panel is split rather than overflowing', () => {
    const { InteractionPanel } = require('../../src/ui/panel');
    const p = new InteractionPanel();
    const path = 'C:/Users/x/AppData/Local/Temp/' + 'a'.repeat(120) + '.log';
    p.open(outputAdapter({ title: '/status', lines: [path] }));
    for (const row of p.render(60, 16)) {
      assert.ok(row.length <= 60, `a row ran past the border: ${row.length} columns`);
    }
  });

  await test('WRAP: a LIST of choices still clips — one row per option', () => {
    // The other half of the rule. A model list wraps into unusability: one row
    // per choice is what makes it scannable, and a long id is recognisable from
    // its start.
    const { InteractionPanel, MODE } = require('../../src/ui/panel');
    const p = new InteractionPanel();
    p.open({
      title: 'MODELS',
      mode: MODE.EXPANDED,
      items: [{ label: 'anthropic/claude-opus-5-with-a-very-long-identifier-that-runs-on', value: 'a' },
        { label: 'second', value: 'b' }],
    });
    const rows = p.render(40, 12).filter((r) => /claude-opus/.test(r));
    assert.strictEqual(rows.length, 1, 'a choice occupies exactly one row');
    assert.match(rows[0], /…/, 'and is clipped with an ellipsis rather than wrapped');
  });

  await test('OUTPUT: a command that says NOTHING leaves no empty box behind', () => {
    const { render, panel } = wired();
    render.openSurface('/exit');
    render.doneSurface();
    assert.strictEqual(panel.visible, false, 'an empty panel with a title is worse than no panel');
  });

  await test('OUTPUT: off a TTY it changes nothing — there is no panel on a pipe', () => {
    const written = [];
    const render = new Renderer({ write(s) { written.push(s); }, columns: 80, isTTY: false, on() {} });
    assert.strictEqual(render.openSurface('/status'), false, 'there is nothing to open');
    render.write('plain output\n');
    render.doneSurface();
    assert.ok(written.join('').includes('plain output'), 'and the output still goes where it always went');
  });

  await test('OUTPUT: the adapter drops padding but keeps the words', () => {
    const a = outputAdapter({ title: '/dash', lines: ['', '  Remote Control', '   ', 'token abc'] });
    assert.strictEqual(a.title, '/DASH', 'the title names the command');
    assert.deepStrictEqual(a.items.map((i) => i.label), ['  Remote Control', 'token abc']);
    assert.strictEqual(a.footer, 'Esc close', 'the same footer the palette and the model list use');
  });
};
