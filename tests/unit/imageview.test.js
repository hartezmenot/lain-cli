'use strict';

/**
 * LOOKING AT AN IMAGE —.
 *
 * "ASCII representation is not visual evidence." LAIN already refuses to
 * pretend: an image in a tool result is reported as a real path, real
 * dimensions and a real format, with NOT SEEN said plainly. That was honest and
 * a dead end — the one thing a person wants at that moment is to LOOK.
 *
 * What is pinned here is the honesty of the other half: that it opens a real
 * file, that it says WHICH window it opened (LAIN's own or the user's), and
 * that it never once claims anybody looked.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const view = require('../../src/imageview');

/** A real 2×2 PNG, so the dimensions come from a header rather than a guess. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000020000000208060000007f'
  + 'a87d630000000d49444154789c6360600000000400012734270a0000000049454e44ae426082', 'hex');

function withImage(name = 'shot.png') {
  const dir = tmpdir('imgview-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG);
  return file;
}

module.exports = async function () {
  await test('IMAGE: a real image opens, and the facts come from the file', async () => {
    const file = withImage();
    const r = await view.open({}, file);
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.facts.width, 2, 'measured from the PNG header, not assumed');
    assert.strictEqual(r.facts.height, 2);
    assert.strictEqual(r.facts.kind, 'PNG');
    assert.ok(fs.existsSync(r.page), 'and a page was written to look at it in');
  });

  await test('IMAGE: it says WHICH window — LAIN\'s own or the user\'s', async () => {
    // The distinction matters: one of them is the browser LAIN is allowed to
    // drive, and one of them is the user's session.
    const r = await view.open({}, withImage());
    assert.ok(['lain-chromium', 'default-viewer'].includes(r.how),
      `"${r.how}" is not a window anyone can identify`);
  });

  await test('IMAGE: a missing file is reported, not opened', async () => {
    const r = await view.open({}, path.join(tmpdir('imgview-'), 'nope.png'));
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /no file at that path/);
  });

  await test('IMAGE: a file that is not an image is refused by name', async () => {
    const dir = tmpdir('imgview-');
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    const r = await view.open({}, file);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /not an image/);
  });

  await test('IMAGE: it NEVER claims anybody looked', async () => {
    // Opening a window is not looking at one. `visual_choice` is how a judgment
    // is obtained; conflating the two is what the whole evidence model forbids.
    const r = await view.open({}, withImage());
    const said = JSON.stringify(r).toLowerCase();
    for (const claim of ['verified', 'confirmed', 'looks', 'seen', 'judged']) {
      assert.ok(!said.includes(claim), `the result claims "${claim}": ${said}`);
    }
  });

  await test('IMAGE: the page names the file and the measurement, and escapes them', () => {
    const html = view.page('C:\\a\\<script>.png', { ok: true, width: 4, height: 3, bytes: 2048 });
    assert.ok(html.includes('&lt;script&gt;'), 'a filename is not markup');
    assert.match(html, /4×3/);
    assert.match(html, /PNG/);
  });

  await test('IMAGE: nothing is written into the project', async () => {
    // The wrapper page goes to LAIN's own directory; the image is only read.
    const file = withImage();
    const before = fs.readdirSync(path.dirname(file));
    const r = await view.open({}, file);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), before,
      'the folder the image lives in must be untouched');
    assert.ok(!r.page.startsWith(path.dirname(file)), 'and the page is not written beside it');
  });

  await test('IMAGE: the images offered are read from the OUTPUT surface, not a second list', () => {
    // A second record of "images LAIN has seen" is a second thing to keep in
    // step with the pane the user is already looking at.
    const app = {
      ui: {
        outputs: [
          { command: 'shot', output: 'wrote C:\\tmp\\one.png' },
          { command: 'shot', output: 'wrote C:\\tmp\\two.png and C:\\tmp\\three.jpg' },
        ],
      },
    };
    assert.deepStrictEqual(view.recent(app),
      ['C:\\tmp\\two.png', 'C:\\tmp\\three.jpg', 'C:\\tmp\\one.png'],
      'newest first, so the default is the one just produced');
    assert.deepStrictEqual(view.recent({}), [], 'and an empty session offers nothing');
  });
};
