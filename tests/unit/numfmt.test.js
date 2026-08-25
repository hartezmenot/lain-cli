'use strict';

/**
 * DEC AND HEX TOGETHER — and the value never changing on the way through.
 *
 * The tests that matter here are the ones about CORRECTNESS OF THE NUMBER, not
 * about the shape of the string. A formatter that renders a 64-bit address
 * through a JavaScript number silently drops the low bits — the exact digits
 * somebody opened the debugger to read — and the output still looks perfectly
 * plausible. So precision, signedness and width are each pinned directly.
 *
 * The other half is restraint: `3` is not clearer as `3 (0x3)`, and a
 * formatter that annotates every number buries the two that matter.
 */

const assert = require('assert');
const { test } = require('../helpers');

const N = require('../../src/numfmt');

module.exports = async function () {
  // ------------------------------------------------------------ precision --

  await test('NUM: a 64-bit address survives exactly — no float rounding', () => {
    // THE DEFECT THIS PREVENTS. 0xFFFFFFFFFFFF0000 exceeds
    // Number.MAX_SAFE_INTEGER, so going through a JS number loses the low bits
    // and prints a confidently wrong address.
    const big = '0xFFFFFFFFFFFF0000';
    assert.strictEqual(N.hex(big), '0xFFFFFFFFFFFF0000');
    assert.strictEqual(N.dec(big), '18446744073709486080');
    assert.ok(!Number.isSafeInteger(Number(big)), 'the premise: this is past the safe range');
  });

  await test('NUM: decimal and hexadecimal are exact inverses at 64 bits', () => {
    for (const h of ['0x1', '0x1000', '0x7FFF12345600', '0xDEADBEEFCAFEBABE', '0xFFFFFFFFFFFFFFFF']) {
      const d = N.dec(h);
      assert.strictEqual(N.hex(d), h.toUpperCase().replace('0X', '0x'),
        `${h} did not survive the round trip through decimal`);
    }
  });

  await test('NUM: a known address converts to the right decimal', () => {
    // 0x7FFF12345600 = 0x7FFF * 2^32 + 0x12345600, computed by hand.
    assert.strictEqual(N.dec('0x7FFF12345600'), '140733498807808');
  });

  // ----------------------------------------------------------- signedness --

  await test('NUM: a negative value keeps its sign and is NOT faked as two-s complement', () => {
    // Rendering -1 as 0xFFFFFFFF would be inventing a width nobody stated.
    assert.strictEqual(N.hex(-1), '-0x1');
    assert.strictEqual(N.dec(-1), '-1');
    assert.strictEqual(N.pid(-1), '-1 (-0x1)');
  });

  await test('NUM: zero is a real value, not an absence', () => {
    assert.strictEqual(N.dec(0), '0');
    assert.match(N.addr(0), /0x0+ \(0\)/);
  });

  // --------------------------------------------------------------- prefix --

  await test('NUM: exactly one 0x prefix, uppercase digits', () => {
    // Mixed case makes two identical addresses look different down a column.
    assert.strictEqual(N.hex(0x3fa8), '0x3FA8');
    assert.strictEqual((N.hex(255).match(/0x/g) || []).length, 1);
    assert.strictEqual(N.hex(255, { prefix: false }), 'FF');
  });

  await test('NUM: an already-hex string is read as hex, not as decimal digits', () => {
    assert.strictEqual(N.dec('0x3FA8'), '16296');
    assert.strictEqual(N.dec('3FA8'), null, 'without a prefix that is not a number we will guess at');
  });

  // ---------------------------------------------------------------- width --

  await test('NUM: an address pads to a natural word width, so a column lines up', () => {
    assert.strictEqual(N.naturalWidth(0x1n), 4);
    assert.strictEqual(N.naturalWidth(0x12345n), 8);
    assert.strictEqual(N.naturalWidth(0x7FFF12345600n), 12);
    assert.match(N.addr(0x1000), /^0x1000 /);
  });

  await test('NUM: a value wider than 64 bits is not truncated to fit', () => {
    const huge = '0x1FFFFFFFFFFFFFFFFF';
    assert.strictEqual(N.hex(huge), huge.toUpperCase().replace('0X', '0x'));
  });

  // ------------------------------------------------------- what is refused --

  await test('NUM: things that are not integers are declined, never rounded', () => {
    assert.strictEqual(N.hex(3.5), null, 'rounding would invent a value');
    assert.strictEqual(N.hex('hello'), null);
    assert.strictEqual(N.hex(null), null);
    assert.strictEqual(N.hex(undefined), null);
    assert.strictEqual(N.hex(Infinity), null);
    assert.strictEqual(N.hex(NaN), null);
  });

  // ------------------------------------------------------ per-field style --

  await test('NUM: a PID leads with decimal; an address leads with hexadecimal', () => {
    // Each matches the tool a person would compare it against — a process list
    // for one, a disassembler for the other.
    assert.match(N.pid(16296), /^16296 \(0x3FA8\)$/);
    assert.match(N.addr('0x7FFF12345600'), /^0x7FFF12345600 \(140733498807808\)$/);
  });

  await test('NUM: a size carries a human unit once it is big enough to help', () => {
    assert.strictEqual(N.size(4096), '4096 (0x1000, 4.0 KB)');
    assert.strictEqual(N.size(512), '512 (0x200)', 'below a KB a unit adds nothing');
    assert.match(N.size(52428800), /50\.0 MB/);
  });

  // ------------------------------------------------------------ restraint --

  await test('NUM: only fields where the second base MEANS something are annotated', () => {
    // "Do not blindly add hex where hexadecimal has no diagnostic meaning."
    const rows = N.lines({ pid: 16296, address: '0x7FFF12345600', size: 4096, count: 3, name: 'notepad.exe' });
    const text = rows.join('\n');
    assert.match(text, /pid/);
    assert.match(text, /address/);
    assert.match(text, /size/);
    assert.doesNotMatch(text, /count/, 'a count of 3 is not clearer as 3 (0x3)');
    assert.doesNotMatch(text, /name/);
  });

  await test('NUM: nested payloads are walked, and paths are named', () => {
    const rows = N.lines({ process: { pid: 42, modules: [{ base: '0x400000' }] } });
    const text = rows.join('\n');
    assert.match(text, /process\.pid/);
    assert.match(text, /modules\[0\]\.base/);
  });

  await test('NUM: a value that already shows both bases is not annotated twice', () => {
    assert.deepStrictEqual(N.lines({ pid: '16296 (0x3FA8)' }), []);
  });

  // ------------------------------------------------- data is never changed --

  await test('NUM: annotating does not mutate the payload', () => {
    // The cross-cutting rule: presentation must not become the data.
    const payload = { pid: 16296, address: '0x7FFF12345600', nested: { size: 4096 } };
    const before = JSON.stringify(payload);
    N.annotate(payload);
    N.lines(payload);
    assert.strictEqual(JSON.stringify(payload), before, 'the canonical payload must be untouched');
  });

  await test('NUM: the probe tool appends the reading and keeps the JSON intact', () => {
    // A parser reading the JSON must see exactly what it saw before.
    const src = require('fs').readFileSync(require.resolve('../../src/tools/probe'), 'utf8');
    assert.match(src, /bothBases/, 'the tool must add the reading');
    assert.match(src, /text \+ bothBases\(value\)/, 'and APPEND it rather than replace the payload');
  });

  await test('NUM: probe status keeps the canonical pid beside the shown one', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/probe'), 'utf8');
    assert.match(src, /pid: this\.child \? this\.child\.pid : null/, 'the raw pid stays');
    assert.match(src, /pidShown/, 'and the rendering is a separate field');
  });
};
