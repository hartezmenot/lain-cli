'use strict';

/**
 * computer — LAIN's own operations on the machine.
 *
 *     model → this tool → LAIN owns the aim, the order and the evidence
 *                       → a transport performs the syscall
 *
 * THE OWNERSHIP CORRECTION. Every operation on the machine used to be spelled
 * in a FOREIGN vocabulary (`probe(op:"input.mouse.click")`), which made the
 * Probe the owner of clicking, typing, focusing and seeing, and LAIN a pipe.
 * Here the model names what it WANTS — `click`, `focus`, `screenshot` — and
 * LAIN decides how, whether, and what may be claimed afterwards. Which bridge
 * carries it is an implementation detail the model never has to learn.
 *
 * THE RAW INSTRUMENT IS NOT THIS. Memory, breakpoints, disassembly and
 * findings belong to an external instrument (lain-probe, owned by the LAIN
 * Harness, not this CLI) — screen and input are not that: they are how anyone
 * uses a computer, and LAIN owns them. (The raw `probe` tool that exposed the
 * instrument directly — `probe{op:"memory.read"}` — was removed from LAIN CLI
 * with the Probe integration in 2026-09; the desktop bridge below is the only
 * transport.)
 *
 * IT ONLY EXISTS WHEN SOMETHING CAN CARRY IT. `tools/index.js` includes this
 * only while a transport is connected, so an ordinary coding session is never
 * told the machine can be driven — and cannot try.
 *
 * NOTHING HERE SYNTHESISES INPUT OR CAPTURES A SCREEN. The syscall belongs to
 * the bridge, and the user's permission belongs to the bridge's own gate. What
 * LAIN refuses to do is act unaimed, or call an accepted injection a delivery.
 */

const computer = require('../computer');
const cap = require('../capability');
const kbd = require('../keyboarddelivery');

const schema = {
  name: 'computer',
  description:
    'Use the computer: look at the screen, read text on it, move and click the mouse, focus a '
    + 'window, and type into it. '
    + `Operations: ${computer.NAMES.join(', ')}. `
    + 'A KEYSTROKE GOES TO WHATEVER HAS FOCUS, so type/key/hold REQUIRE `window` and send nothing '
    + 'unless that window is verified in front. A CLICK GOES TO A COORDINATE, so it needs x and y '
    + 'and cannot be aimed at a window — screenshot first, find the thing, then click where it is. '
    + 'Input comes back SENT_UNCONFIRMED: the OS accepted it and nothing watched the target '
    + 'receive it, so confirm by looking (screenshot, ocr, or the target\'s own log). '
    // AIM THE READS, and say so where the model will read it. Without this,
    // "what does the game show" was answered with a picture of the whole
    // desktop, LAIN's own panels included, and the text of every window at once.
    + 'AIM screenshot AND ocr with `window` (or an explicit `region`) whenever you want ONE '
    + 'window: unaimed, they capture the entire desktop including LAIN\'s own panels, and the '
    + 'text you get back will be a mixture of everything on screen. `windows` lists what is open.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: computer.NAMES, description: 'what to do' },
      window: {
        type: 'string',
        description: 'the window TITLE. Required for focus, type, key and hold. For screenshot and '
          + 'ocr it AIMS the capture at that window\'s rectangle instead of the whole desktop.',
      },
      region: {
        type: 'object',
        description: 'an explicit rectangle {x, y, width, height} for screenshot and ocr, when you '
          + 'want part of a window rather than all of it',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
      x: { type: 'number', description: 'screen x, for move and click' },
      y: { type: 'number', description: 'screen y, for move and click' },
      text: { type: 'string', description: 'what to type, for type' },
      key: { type: 'string', description: 'the key, for key and hold, e.g. "W" or "enter"' },
      ms: { type: 'number', description: 'how long to hold, for hold' },
      why: { type: 'string', description: 'one short sentence the USER will read explaining why' },
    },
    required: ['op'],
  },
};

/** The arguments each operation actually takes, in the transport's shape. */
function paramsFor(op, input) {
  switch (op) {
    case 'move': case 'click': return { x: Number(input.x), y: Number(input.y) };
    case 'type': return { text: String(input.text == null ? '' : input.text) };
    case 'key': return { key: String(input.key || '') };
    case 'hold': return { key: String(input.key || ''), ms: Number(input.ms) || undefined };
    // A REGION GOES TO BOTH READS. `screenshot` took nothing at all, so "look
    // at the game" produced a picture of the whole desktop — LAIN's own panels
    // included — and LAIN then had to guess which text belonged to the target.
    // An explicit region wins; naming a `window` is resolved to one in
    // computer.perform, which is where the aiming lives.
    case 'ocr': case 'screenshot': return input.region ? { region: input.region } : {};
    default: return {};
  }
}

/** What is missing before this can be attempted at all. */
function missing(op, input) {
  if ((op === 'move' || op === 'click') && !(Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y)))) {
    return `${op} needs x and y. It is aimed at a screen coordinate, not at a window — `
      + 'take a screenshot, find the thing, then click where it is.';
  }
  if (op === 'type' && !String(input.text || '')) return 'type needs text';
  if ((op === 'key' || op === 'hold') && !String(input.key || '')) return `${op} needs a key`;
  if ((op === 'focus') && !String(input.window || '')) return 'focus needs a window title';
  if ((op === 'type' || op === 'key' || op === 'hold') && !String(input.window || '')) {
    return `${op} needs a window: a keystroke goes to whatever has focus, and without a window `
      + "there is nothing to aim at. NOTHING WAS SENT.";
  }
  return null;
}

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const op = String((input && input.op) || '').trim();
  if (!computer.OPS[op]) {
    return {
      output: `unknown operation "${op}". Available: ${computer.NAMES.join(', ')}`,
      isError: true,
    };
  }
  const gap = missing(op, input || {});
  if (gap) return { output: `${gap}`, isError: true, meta: { computer: op } };

  const why = String((input && input.why) || '').slice(0, 160);
  const outcome = await computer.perform(app, op, paramsFor(op, input || {}), {
    window: String((input && input.window) || ''),
    why,
  });

  const ok = outcome.stage === cap.STAGE.SUCCEEDED || outcome.stage === cap.STAGE.SENT_UNCONFIRMED;
  const e = cap.envelope({
    op: `computer.${op}`,
    stage: outcome.stage,
    capability: computer.capabilityFor(op, outcome.transport || 'probe'),
    aim: computer.OPS[op].aim,
    why: outcome.why || '',
    result: ok ? outcome.result : null,
  });

  const lines = [e.text];
  if (outcome.trail && outcome.trail.length) {
    lines.push('', 'WHAT ACTUALLY HAPPENED, in order:', ...kbd.trailLines(outcome.trail));
  }
  if (outcome.transport) lines.push('', `carried by: ${outcome.transport}`);
  return {
    output: lines.join('\n').slice(0, 20000),
    isError: !ok,
    meta: { computer: op, state: outcome.stage, via: outcome.transport, why: why || undefined },
  };
}

module.exports = { tools: { computer: { mutates: true, schema, run } }, paramsFor, missing };
