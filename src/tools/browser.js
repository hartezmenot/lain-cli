'use strict';

/**
 * browser — the model's route to LAIN'S OWN Chromium, and to no other.
 *
 *     model → this tool → BrowserRuntime → a Chromium LAIN started
 *
 * IT ONLY EXISTS WHILE THE BROWSER IS RUNNING, which the user starts with
 * `/external browser`. That is the same rule `probe` follows and for the same
 * reason: a model told it can drive a browser will try, and a browser that
 * opens because a coding session mentioned a URL is a browser nobody asked for.
 *
 * WHAT COMES BACK IS EVIDENCE, not `{ok:true}`. An inspect returns the
 * element's real rectangle; a screenshot returns a PATH, never the image —
 * a 300KB screenshot encoded into a model's context is an enormous bill for
 * something the model cannot see. The picture goes to `visual_choice`, which
 * shows it to a person.
 *
 * AND A SCREENSHOT IS STILL NOT A VERIFICATION. `inspect` can prove the button
 * moved — a rectangle is a fact. Whether the page LOOKS right is a judgment
 * this tool never makes and never implies.
 */

const browserMod = require('../browser');

const OPS = {
  open: 'navigate to a URL and wait for it to load',
  info: 'the page title, URL, ready state and viewport size',
  screenshot: 'capture the page to a PNG file and return its path',
  inspect: 'an element\'s rectangle, text and visibility, by CSS selector',
  click: 'click an element by CSS selector, with a real mouse event',
  type: 'focus an element and type into it, with real key events',
  key: 'press Enter, Tab, Escape or Backspace',
  wait: 'wait for a selector to appear, or report that it never did',
  // ---- THE TWO THAT MAKE A LAYOUT MEASURABLE RATHER THAN DESCRIBED --------
  //
  // A model cannot see a page. Asked whether one looks right, it reasons from
  // the source that produced it, which is a guess dressed as an observation.
  // `measure` replaces the guess with a delta, and `console` replaces "it does
  // not work" with the exception the browser already recorded.
  measure: 'an element\'s rectangle and the computed styles that decide it, with the delta from an expected rect',
  console: 'console messages and uncaught exceptions the page has produced, with file and line',
};

const schema = {
  name: 'browser',
  description:
    "Drive LAIN's own Chromium — a separate browser with its own profile, never the user's. "
    + 'Use it to look at a running front end: open a local URL, inspect an element to get its real '
    + 'position and size, click, type, and capture a screenshot. '
    + 'inspect is how you VERIFY a layout change — a rectangle is a fact, and it costs nothing. '
    + 'measure goes further: pass `expect` with the rectangle you intended and get the DELTA, plus the '
    + 'computed styles that produced it — the rectangle says what is wrong and the styles say why. '
    + 'console returns what the page itself reported, with file and line: start a "it does not work" '
    + 'diagnosis there rather than reading source and guessing. '
    + 'screenshot returns a FILE PATH, not an image: you cannot see it. If the question is whether '
    + 'something LOOKS right, pass that path to visual_choice and let the user judge. '
    + `Operations: ${Object.entries(OPS).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', description: `One of: ${Object.keys(OPS).join(', ')}` },
      url: { type: 'string', description: 'for open' },
      selector: { type: 'string', description: 'a CSS selector, for inspect/measure/click/type/wait' },
      text: { type: 'string', description: 'for type' },
      key: { type: 'string', description: 'for key: Enter, Tab, Escape, Backspace' },
      timeout_ms: { type: 'number', description: 'for wait' },
      expect: {
        type: 'object',
        description: 'for measure: the rectangle you intended, e.g. {"x":420,"y":180,"width":640,"height":48}. '
          + 'Any subset. The result reports the difference per axis.',
        properties: {
          x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
        },
      },
      errors_only: { type: 'boolean', description: 'for console: skip ordinary log output' },
    },
    required: ['op'],
  },
};

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const b = app && app._browser;
  if (!b || !b.running) {
    return {
      output: "LAIN's browser is not running. The user starts it with /external browser. "
        + 'Nothing was done; do not describe a page you have not opened.',
      isError: true,
    };
  }
  const op = String(input.op || '').trim();
  if (!OPS[op]) {
    return { output: `unknown browser operation "${op}". Available: ${Object.keys(OPS).join(', ')}`, isError: true };
  }

  const r = await dispatch(b, op, input);
  if (!r.ok) return { output: `${op} failed: ${r.error}`, isError: true, meta: { browser: op, state: b.state } };

  // EVIDENCE, in the words that say what it does and does not establish.
  if (op === 'screenshot') {
    return {
      output: `screenshot saved to ${r.file} (${Math.round(r.bytes / 1024)} KB).\n`
        + 'You cannot see this image. It is MACHINE evidence that a capture exists — not that the '
        + 'page looks right. To have it judged, pass this path to visual_choice with a measurement.',
      meta: { browser: op, file: r.file },
    };
  }
  if (op === 'inspect') {
    if (!r.found) return { output: `${r.selector} — NOT FOUND on this page.`, meta: { browser: op } };
    return {
      output: `${r.selector} — <${r.tag}> at x=${r.rect.x} y=${r.rect.y} `
        + `${r.rect.width}×${r.rect.height}, ${r.visible ? 'visible' : 'NOT VISIBLE'}, `
        + `in a ${r.viewport.width}×${r.viewport.height} viewport.`
        + (r.text ? `\ntext: ${r.text}` : ''),
      meta: { browser: op, rect: r.rect },
    };
  }
  if (op === 'measure') {
    if (!r.found) {
      return {
        output: `${r.selector} — NOT FOUND on this page (viewport ${r.viewport.width}×${r.viewport.height}).`,
        meta: { browser: op, found: false },
      };
    }
    const lines = [
      `${r.selector} — <${r.tag}> in a ${r.viewport.width}×${r.viewport.height} viewport`
        + (r.devicePixelRatio && r.devicePixelRatio !== 1 ? ` at ${r.devicePixelRatio}x` : ''),
      `  actual   left=${r.rect.x} top=${r.rect.y} width=${r.rect.width} height=${r.rect.height}`
        + ` (right=${r.rect.right} bottom=${r.rect.bottom})`,
    ];
    if (r.delta) {
      // THE DELTA IS THE POINT. "It looks slightly off" is not actionable and
      // is not even reliably true; `x = +43, everything else 0` is both.
      const rows = Object.entries(r.delta).map(([k, v]) => `${k} = ${v > 0 ? '+' : ''}${v}`);
      lines.push(`  delta    ${rows.join('  ')}`
        + (Object.values(r.delta).every((v) => v === 0) ? '   — exactly as expected' : ''));
    }
    if (!r.visible) lines.push('  NOT VISIBLE — it has no box, or is hidden, or is fully transparent.');
    if (r.overflowing) lines.push('  OVERFLOWING the viewport.');
    if (r.parentRect) {
      lines.push(`  parent   left=${r.parentRect.x} top=${r.parentRect.y} `
        + `width=${r.parentRect.width} height=${r.parentRect.height}`);
    }
    const style = Object.entries(r.style)
      .filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px')
      .map(([k, v]) => `${k}: ${v}`);
    lines.push(`  computed ${style.join('; ')}`);
    return { output: lines.join('\n'), meta: { browser: op, rect: r.rect, delta: r.delta } };
  }
  if (op === 'console') {
    if (!r.messages.length) {
      return {
        output: 'The page has produced no console output and no uncaught exceptions since it was opened. '
          + 'That is a real observation, not a failure to look.',
        meta: { browser: op, errors: 0 },
      };
    }
    const rows = r.messages.map((m) => `  ${m.level.toUpperCase().padEnd(9)} ${m.text}`
      + (m.url ? `\n            at ${m.url}${m.line ? `:${m.line}${m.column ? `:${m.column}` : ''}` : ''}` : ''));
    return {
      output: `${r.total} console message(s), ${r.errors} of them errors or uncaught exceptions:\n${rows.join('\n')}`
        + (r.total > r.messages.length ? `\n  [showing the last ${r.messages.length}]` : ''),
      meta: { browser: op, errors: r.errors, total: r.total },
    };
  }
  const { ok, ...rest } = r;
  return { output: JSON.stringify(rest).slice(0, 8000), meta: { browser: op, state: b.state } };
}

function dispatch(b, op, input) {
  switch (op) {
    case 'open': return b.open(input.url);
    case 'info': return b.pageInfo();
    case 'screenshot': return b.screenshot();
    case 'inspect': return b.inspect(input.selector);
    case 'click': return b.click(input.selector);
    case 'type': return b.type(input.selector, input.text);
    case 'key': return b.key(input.key);
    case 'wait': return b.wait(input.selector, Number(input.timeout_ms) || 10000);
    case 'measure': return b.measure(input.selector, input.expect || null);
    case 'console': return Promise.resolve(b.consoleLog({ errorsOnly: Boolean(input.errors_only) }));
    default: return Promise.resolve({ ok: false, error: `unhandled ${op}` });
  }
}

module.exports = { tools: { browser: { mutates: true, schema, run } }, OPS, STATE: browserMod.STATE };
