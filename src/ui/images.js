'use strict';

/**
 * AN IMAGE IN A TERMINAL — what may honestly be said about one.
 *
 * A TUI cannot show a picture. The temptation is to approximate: render the
 * PNG as ASCII blocks, print it, and let the conversation proceed as though
 * somebody had looked at it. That is the same false-verification failure the
 * whole evidence model exists to prevent, wearing a different hat — an ASCII
 * approximation of a screenshot is not the screenshot, and a person who "saw"
 * one has not seen the thing being asked about.
 *
 * So this does the opposite. It reads the FACTS about the file — that it
 * exists, its real pixel dimensions, its size, when it was written — states
 * them, and says plainly that nobody has looked at it and where to look.
 *
 *     ▣ shot-1787.png   1280×720 · 84 KB · just now
 *       NOT SEEN — press V, or open it, to look at it
 *
 * Dimensions come from parsing the file header, not from a library and not
 * from a guess: a claim about an image should be measured from the image.
 */

const fs = require('fs');
const path = require('path');

/** Extensions this can say anything true about. */
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function isImage(file) {
  return IMAGE.has(path.extname(String(file || '')).toLowerCase());
}

/**
 * Real pixel dimensions, read from the file's own header.
 *
 * PNG and GIF are fixed-offset and trivial. JPEG requires walking its segment
 * chain to the frame header, which is still a dozen lines and is the only way
 * to know rather than assume. An unrecognised or truncated file returns null —
 * unknown, which is a true answer, rather than a plausible-looking number.
 */
function dimensions(buf) {
  try {
    // PNG: 8-byte signature, then IHDR with width/height as big-endian u32.
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: 'GIF', then width/height as little-endian u16.
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP: 'BM', then the DIB header's signed i32 width/height.
    if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    // JPEG: walk the segments to a start-of-frame marker.
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0..SOF15, excluding the four that are not frame headers.
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* a truncated or malformed file: unknown is the honest answer */ }
  return null;
}

/** Everything true about an image file, or why nothing could be said. */
function describe(file) {
  const p = String(file || '');
  let st;
  try { st = fs.statSync(p); } catch { return { ok: false, file: p, why: 'no such file' }; }
  let dim = null;
  try { dim = dimensions(fs.readFileSync(p).subarray(0, 4096)); } catch { dim = null; }
  return {
    ok: true,
    file: p,
    name: path.basename(p),
    bytes: st.size,
    at: st.mtimeMs,
    width: dim ? dim.width : null,
    height: dim ? dim.height : null,
  };
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * The rows an image gets in OUTPUT.
 *
 * NOT SEEN is stated on every one of them, every time, and is the entire point:
 * this pane can prove a capture happened and can never prove anybody looked.
 */
function imageLines(file, width = 80) {
  const { P } = require('./paint');
  const d = describe(file);
  if (!d.ok) return ['      ' + P.bad(`▣ ${path.basename(String(file))} — ${d.why}`)];
  const size = d.bytes >= 1024 ? `${Math.round(d.bytes / 1024)} KB` : `${d.bytes} B`;
  const dim = d.width ? `${d.width}×${d.height}` : 'dimensions unknown';
  const head = `▣ ${d.name}`;
  const facts = `${dim} · ${size} · ${ago(d.at)}`;
  return [
    '      ' + P.info(head) + '  ' + P.meta(facts),
    // The claim this pane is careful about. A terminal cannot show the picture,
    // and an ASCII approximation of it would not be the picture.
    // NOT SEEN, AND HOW TO SEE IT. Saying only that a terminal cannot show a
    // picture is honest and a dead end — the one thing a person wants at that
    // moment is to look, and `/image` is how. See imageview.js, which opens it
    // in LAIN's own Chromium when one is running.
    '      ' + P.warn('NOT SEEN') + P.meta(' — a terminal cannot show an image. /image opens it.'),
    '      ' + P.meta(require('./text').clip(d.file, Math.max(20, width - 8))),
  ];
}

module.exports = { isImage, describe, dimensions, imageLines, ago, IMAGE };
