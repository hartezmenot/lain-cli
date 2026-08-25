'use strict';

/**
 * THE VISUAL WINDOW — four candidates, side by side, outside the terminal.
 *
 * A TUI cannot show a picture, and this whole workflow exists because somebody
 * has to LOOK at one. So a round is written as a single self-contained HTML
 * file and opened in the machine's default browser: real pixels, at real size,
 * next to each other, where a person can actually compare them.
 *
 * ------------------------------------------------------------------------
 * WHERE THE ANSWER IS TYPED, AND WHY IT IS NOT HERE.
 *
 * The page DISPLAYS. LAIN's existing compact MCQ TAKES THE ANSWER. That is a
 * deliberate deviation from "the window has a text box at the bottom", and the
 * reason is that a browser page cannot hand anything back without a local HTTP
 * server listening on a port. That would be a new network surface, opened on
 * the user's machine, so that a choice between four pictures could travel
 * fifteen centimetres — and it would be a SECOND INPUT PATH into a program
 * whose input architecture was rebuilt specifically to have one.
 *
 * So: look in the window, answer in LAIN, where every other question in this
 * program is answered — same keys, same Esc-for-details, same history. The page
 * says so at the bottom, in as many words, so nobody sits waiting for a button
 * that is not there.
 *
 * ------------------------------------------------------------------------
 * SELF-CONTAINED, because the alternative is worse. Images are embedded as
 * data URIs and the CSS is inline: the file can be reopened later, attached to
 * a report, or looked at after LAIN has exited, and it cannot leak a local path
 * to anything. Nothing is fetched, no script runs, and the page has no network
 * access of its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** Bytes of image a single round may embed. Four screenshots, comfortably. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function dir() {
  const base = (() => {
    try { return require('./config').configDir(); } catch { return path.join(os.homedir(), '.lain-v2'); }
  })();
  return path.join(base, 'visual');
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/**
 * An image as a data URI, or null.
 *
 * A candidate whose image cannot be read is still SHOWN — with its machine
 * evidence and a plain statement that the picture is missing. Dropping it would
 * silently turn a four-way choice into a three-way one, and the person would be
 * choosing from a set they were never told had changed.
 */
function embed(file) {
  try {
    const ext = path.extname(String(file)).toLowerCase();
    const type = TYPES[ext];
    if (!type) return null;
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Render one round as a standalone page.
 *
 * Exported and pure, so what the person sees is testable without a browser,
 * a screen, or a running LAIN.
 */
function page(round, { question = '', constraints = null, roundsLeft = null } = {}) {
  const cards = (round.candidates || []).map((c) => {
    const img = c.image ? embed(c.image) : null;
    const picture = img
      ? `<img src="${img}" alt="${esc(c.label)}">`
      : `<div class="missing">no image — ${esc(c.image ? 'could not be read' : 'none was supplied')}</div>`;
    return `<figure>
      <div class="key">${esc(c.letter)}</div>
      ${picture}
      <figcaption>
        <strong>${esc(c.label)}</strong>
        <span class="machine">${esc(c.machine)}</span>
      </figcaption>
    </figure>`;
  }).join('\n');

  const known = constraints && Object.keys(constraints).length
    ? `<section class="known"><h2>already established</h2><ul>${
      Object.entries(constraints).map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(v)}</li>`).join('')
    }</ul></section>`
    : '';

  const budget = roundsLeft === null ? ''
    : `<span class="budget">${roundsLeft} round${roundsLeft === 1 ? '' : 's'} left</span>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>LAIN — visual inspection</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:24px; font:14px/1.5 ui-sans-serif,system-ui,sans-serif;
         background:#12151a; color:#e6e9ef; }
  h1 { font-size:17px; margin:0 0 4px; font-weight:600; }
  .q { color:#9aa4b2; margin:0 0 20px; max-width:70ch; }
  .budget { float:right; font-size:12px; color:#9aa4b2; border:1px solid #2a3038;
            border-radius:99px; padding:2px 10px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
  figure { margin:0; background:#171b21; border:1px solid #262c35; border-radius:10px;
           overflow:hidden; position:relative; }
  .key { position:absolute; top:10px; left:10px; width:26px; height:26px; border-radius:6px;
         background:#e6e9ef; color:#12151a; font-weight:700; display:flex;
         align-items:center; justify-content:center; font-size:14px; }
  img { display:block; width:100%; height:auto; background:#0b0d10; }
  .missing { padding:56px 16px; text-align:center; color:#7c8695; background:#0b0d10; font-style:italic; }
  figcaption { padding:12px 14px; display:flex; flex-direction:column; gap:4px; }
  .machine { color:#8fb3ff; font-family:ui-monospace,monospace; font-size:12px; }
  .known { margin-top:22px; padding:12px 16px; background:#171b21; border:1px solid #262c35; border-radius:10px; }
  .known h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#9aa4b2; margin:0 0 6px; }
  .known ul { margin:0; padding-left:18px; }
  footer { margin-top:22px; padding-top:14px; border-top:1px solid #262c35; color:#9aa4b2; }
  kbd { background:#262c35; border-radius:4px; padding:1px 6px; font-family:ui-monospace,monospace; }
</style>
<h1>Visual inspection ${budget}</h1>
<p class="q">${esc(question || round.question || 'Which of these is right?')}</p>
<div class="grid">
${cards}
</div>
${known}
<footer>
  <b>Answer in LAIN, not here.</b> This window shows the candidates; the choice is
  made in the terminal, where every other question is answered — press
  <kbd>A</kbd>–<kbd>D</kbd> to move, <kbd>Enter</kbd> to commit,
  <kbd>Esc</kbd> for the full question. Nothing on this page is clickable, and
  it needs no network.
</footer>`;
}

/**
 * Write the round and open it.
 *
 * A window that could not be opened is REPORTED rather than silently skipped —
 * the file is still on disk and its path is given, because a person who has
 * been asked to look at something must be able to find it.
 *
 * @returns {{ok, file, opened, why}}
 */
function show(round, opts = {}) {
  const file = path.join(dir(), `round-${Date.now()}.html`);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file, page(round, opts), 'utf8');
  } catch (e) {
    return { ok: false, file: null, opened: false, why: `could not write the visual round: ${e.message}` };
  }
  let opened = false;
  let why = '';
  try {
    if (process.platform === 'win32') {
      // The empty title argument is required: `start "path"` treats a single
      // quoted argument as the window title and opens nothing.
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    }
    opened = true;
  } catch (e) {
    why = `the file is written but a browser could not be opened (${e.message}) — open it yourself`;
  }
  return { ok: true, file, opened, why };
}

/** Old rounds, cleared when a task ends. Never touches anything else. */
function clean(keep = 10) {
  try {
    const files = fs.readdirSync(dir()).filter((f) => /^round-\d+\.html$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(dir(), f)); } catch { /* already gone */ }
    }
    return true;
  } catch { return false; }
}

module.exports = { show, page, embed, clean, dir, MAX_IMAGE_BYTES };
