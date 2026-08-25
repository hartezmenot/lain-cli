'use strict';

/**
 * LOOKING AT AN IMAGE — the escape hatch from "a terminal cannot show you this".
 *
 * "ASCII representation is not visual evidence." LAIN already
 * refuses to pretend — an image in a tool result is reported as a real path,
 * real dimensions and a real format, with `NOT SEEN` said plainly (ui/images.js).
 * That is honest, and on its own it is a dead end: the one thing a person wants
 * at that moment is to LOOK, and there was no way to.
 *
 * So this opens it. In LAIN's OWN Chromium when one is running, because that is
 * the browser LAIN owns and the design says not to overload the user's session with
 * LAIN's automation. Otherwise the machine's default viewer, which is what a
 * person would have done by hand.
 *
 * IT NEVER CLAIMS THE PICTURE WAS SEEN. Opening a window is not looking at one,
 * and the difference is the whole of the evidence discipline here: `visual_choice`
 * is how a judgment is obtained, and this is how a person is given the chance to
 * make one. What comes back says which window was opened and nothing more.
 *
 * IT WRITES NOTHING INTO THE PROJECT. The wrapper page goes to LAIN's own
 * directory beside the visual rounds, and the image itself is only ever read.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const images = require('./ui/images');

/** Where the wrapper pages go — LAIN's own, never the project's. */
function dir() {
  return path.join(require('./visualwindow').dir(), 'view');
}

/**
 * The images LAIN has actually seen mentioned, newest first.
 *
 * Read from the OUTPUT surface that already exists rather than from a new list
 * kept for this: a second record of the same thing is a second thing to keep in
 * step, and this one is already what the user is looking at.
 */
function recent(app, limit = 10) {
  const panes = require('./ui/panes');
  const outputs = (app && app.ui && app.ui.outputs) || [];
  const found = [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    for (const f of panes.imagesIn(outputs[i])) {
      if (!found.includes(f)) found.push(f);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * A page that shows one image at its real size, on a neutral ground.
 *
 * A neutral mid-grey rather than white or black: a screenshot judged against a
 * background that is itself one of the extremes reads lighter or darker than it
 * is, which is precisely the kind of error somebody opens an image to avoid.
 */
function page(file, d) {
  const src = `file:///${String(file).replace(/\\/g, '/')}`;
  const facts = d.ok
    ? `${format(file)} · ${d.width}×${d.height} · ${Math.round(d.bytes / 1024)} KB`
    : `${d.why || 'could not be measured'}`;
  return `<meta charset="utf-8"><title>${esc(path.basename(file))}</title>
<style>
  html,body{margin:0;height:100%;background:#6b6b6b;color:#eee;
            font:13px ui-monospace,Consolas,monospace}
  header{padding:8px 12px;background:#2a2a2a;border-bottom:1px solid #444}
  b{color:#8fe3a8}
  main{display:flex;align-items:center;justify-content:center;
       height:calc(100% - 38px);overflow:auto}
  img{max-width:100%;max-height:100%;image-rendering:pixelated}
</style>
<header><b>${esc(path.basename(file))}</b> &nbsp; ${esc(facts)} &nbsp;
  <span style="color:#999">${esc(file)}</span></header>
<main><img src="${esc(src)}" alt=""></main>`;
}

/** What the file claims to be. `describe` measures the pixels; this names the kind. */
function format(file) {
  return (path.extname(String(file)).replace('.', '') || '?').toUpperCase();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Open one image for a person to look at.
 *
 * @returns {{ok, how, file, page, why, facts}}
 *   `how` is 'lain-chromium' or 'default-viewer' — which window this is in
 *   matters, because one of them is LAIN's and one of them is the user's.
 */
async function open(app, file) {
  const target = path.resolve(String(file || ''));
  if (!fs.existsSync(target)) {
    return { ok: false, how: null, file: target, why: 'there is no file at that path' };
  }
  if (!images.isImage(target)) {
    return { ok: false, how: null, file: target, why: 'that is not an image LAIN can measure' };
  }
  const facts = images.describe(target);
  if (facts.ok) facts.kind = format(target);

  let out = null;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    out = path.join(dir(), `view-${Date.now()}.html`);
    fs.writeFileSync(out, page(target, facts), 'utf8');
  } catch (e) {
    return { ok: false, how: null, file: target, facts, why: `could not write the page: ${e.message}` };
  }

  // LAIN'S OWN BROWSER FIRST. It is the one LAIN is allowed to drive, it has
  // its own profile, and using it keeps LAIN's windows out of the user's
  // session — which is the whole point of having it. See browser.js.
  const browser = require('./browser').live();
  if (browser) {
    const r = await browser.open(`file:///${out.replace(/\\/g, '/')}`).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok !== false) return { ok: true, how: 'lain-chromium', file: target, page: out, facts };
  }

  try {
    if (process.platform === 'win32') {
      // The empty title argument is required: `start "path"` treats a single
      // quoted argument as the window title and opens nothing.
      spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [out], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [out], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, how: 'default-viewer', file: target, page: out, facts };
  } catch (e) {
    return {
      ok: false, how: null, file: target, page: out, facts,
      why: `the page is written but no viewer could be opened (${e.message}) — open it yourself`,
    };
  }
}

module.exports = { open, recent, page, dir };
