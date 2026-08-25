'use strict';

/**
 * IMAGES IN A TERMINAL — and the lie that was available here.
 *
 * A TUI cannot show a picture. The tempting fix is to render the PNG as ASCII
 * blocks and let the conversation proceed as though somebody had looked at it.
 * That is the false-verification failure the whole evidence model exists to
 * prevent, wearing a different hat: an ASCII approximation of a screenshot is
 * not the screenshot, and a person who "saw" one has not seen the thing being
 * asked about.
 *
 * So OUTPUT states the FACTS — measured from the file's own header — and says
 * NOT SEEN. Every time.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test, tmpdir } = require('../helpers');

const img = require('../../src/ui/images');
const panes = require('../../src/ui/panes');

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/** A real PNG of a known size, written byte by byte so the test owns the truth. */
function png(dir, name, w, h) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b) => {
    let crc = 0xffffffff;
    for (const byte of b) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

module.exports = async function () {
  await test('IMAGE: dimensions are MEASURED from the file, not guessed', () => {
    const dir = tmpdir('img-');
    const d = img.describe(png(dir, 'shot.png', 320, 180));
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.width, 320);
    assert.strictEqual(d.height, 180);
    assert.ok(d.bytes > 0);
  });

  await test('IMAGE: a file it cannot parse says UNKNOWN, not a plausible number', () => {
    // A believable wrong number is worse than an admitted gap.
    const dir = tmpdir('img-');
    const bad = path.join(dir, 'truncated.png');
    fs.writeFileSync(bad, Buffer.from([137, 80, 78, 71]));      // signature only
    const d = img.describe(bad);
    assert.strictEqual(d.ok, true, 'the file exists, which is itself a fact');
    assert.strictEqual(d.width, null);
    assert.strictEqual(d.height, null);
  });

  await test('IMAGE: a missing file is a plain refusal', () => {
    const d = img.describe(path.join(tmpdir('img-'), 'nope.png'));
    assert.strictEqual(d.ok, false);
    assert.match(d.why, /no such file/);
  });

  await test('IMAGE: OUTPUT states NOT SEEN — and never renders the picture', () => {
    // The assertion this whole file exists for.
    const dir = tmpdir('img-');
    const file = png(dir, 'capture.png', 1280, 720);
    const lines = plain(panes.outputView({
      outputs: [{ command: 'python vision.py', output: `saved ${file}\nOCR confidence 0.81`, exitCode: 0 }],
      width: 100,
    }).join('\n'));
    assert.match(lines, /NOT SEEN/);
    assert.match(lines, /1280×720/, 'the real measured size');
    assert.match(lines, /capture\.png/);
    assert.match(lines, /a terminal cannot show an image/);
    // No block-drawing characters: an ASCII rendering would be the lie.
    assert.ok(!/[▀▄█░▒▓]/.test(lines), 'nothing may approximate the picture');
  });

  await test('IMAGE: paths are found in output the command did not know was an image', () => {
    // A shell command, a test that writes a diff image, a script that saves a
    // plot — none of them declare that they produced a picture.
    const dir = tmpdir('img-');
    const a = png(dir, 'one.png', 10, 10);
    const b = png(dir, 'two.png', 20, 20);
    const lines = plain(panes.outputView({
      outputs: [{ command: 'npm test', output: `wrote ${a}\nand ${b}`, exitCode: 0 }], width: 100,
    }).join('\n'));
    assert.match(lines, /one\.png/);
    assert.match(lines, /two\.png/);
    assert.match(lines, /10×10/);
  });

  await test('IMAGE: output with no image is completely unchanged', () => {
    // The notice must mean something; attaching it to everything is how it
    // stops being read.
    const lines = plain(panes.outputView({
      outputs: [{ command: 'npm test', output: '281 passed', exitCode: 0 }], width: 100,
    }).join('\n'));
    assert.ok(!/NOT SEEN/.test(lines));
    assert.match(lines, /281 passed/);
  });

  await test('IMAGE: only real image extensions count', () => {
    assert.strictEqual(img.isImage('a.png'), true);
    assert.strictEqual(img.isImage('a.JPG'), true);
    assert.strictEqual(img.isImage('a.txt'), false);
    assert.strictEqual(img.isImage('a.pngx'), false);
  });

  await test('IMAGE: the visual workflow is where a picture is actually JUDGED', () => {
    // OUTPUT proves a capture exists. visual.js is the only thing that can
    // record that a person looked — and it needs a measurement per candidate.
    const visual = require('../../src/visual');
    const dir = tmpdir('img-');
    const c = visual.candidate({
      label: 'threshold 140',
      image: png(dir, 'cand.png', 64, 64),
      machine: 'OCR confidence 0.81',
    });
    assert.ok(c.image, 'a candidate carries the real file');
    const i = new visual.VisualInspection('which is clearest?');
    assert.strictEqual(i.conclusion().verdict, visual.VERDICT.NOT_INSPECTED,
      'and until somebody looks, nothing is inspected');
  });
};
