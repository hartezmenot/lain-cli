'use strict';

/**
 * ONE NUMBER, BOTH REPRESENTATIONS — without ever changing the number.
 *
 * Debugging a process means reading PIDs, addresses, offsets and sizes, and
 * each is natural in a different base: a PID is decimal because that is what
 * Task Manager and `ps` show, an address is hexadecimal because that is what a
 * disassembler, a map file and a debugger show. Being given only one of the two
 * means doing the conversion by hand, every time, in the middle of thinking
 * about something else.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS UNDER: PRESENTATION MUST NOT BECOME THE DATA.
 *
 * Nothing here mutates a value or a structure. Every function takes a number
 * and returns a STRING for a person to read. The canonical value — the one a
 * parser or a script depends on — is untouched, and anything that renders a
 * value keeps the original beside the rendering rather than replacing it.
 * ------------------------------------------------------------------------
 *
 * EVERYTHING IS BigInt INTERNALLY, and that is not fussiness. A 64-bit address
 * such as `0xFFFFFFFFFFFF0000` is larger than `Number.MAX_SAFE_INTEGER`, so
 * converting it through a JavaScript number silently loses the low bits — the
 * exact digits somebody is trying to read. A formatter that corrupts the value
 * it is displaying is worse than no formatter.
 */

/** Widths an address is naturally padded to, by how big it is. */
const NATURAL_WIDTHS = [4, 8, 12, 16];

/**
 * Read anything number-shaped into a BigInt.
 *
 * Accepts a JS number, a BigInt, a decimal string, or a `0x`-prefixed hex
 * string — because Probe payloads use all of them, and which one arrives is
 * the provider's choice rather than ours.
 *
 * @returns {{value: bigint, negative: boolean}|null} null when it is not a
 *   number at all, which is a normal answer and never an error.
 */
function parse(v) {
  if (typeof v === 'bigint') return { value: v < 0n ? -v : v, negative: v < 0n };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // A NON-INTEGER IS NOT AN ADDRESS. Rendering 3.5 as hex would be inventing
    // a value, so it is declined rather than rounded.
    if (!Number.isInteger(v)) return null;
    const b = BigInt(v);
    return { value: b < 0n ? -b : b, negative: b < 0n };
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(body)) return { value: BigInt(body), negative: neg };
    if (/^[0-9]+$/.test(body)) return { value: BigInt(body), negative: neg };
  } catch { return null; }
  return null;
}

/**
 * `0x3FA8` — uppercase digits, lowercase prefix, exactly one prefix.
 *
 * Uppercase because that is how every debugger, map file and disassembler
 * prints an address, and mixing cases across a screen makes two identical
 * addresses look different.
 */
function hex(v, { width = 0, prefix = true } = {}) {
  const p = parse(v);
  if (!p) return null;
  let digits = p.value.toString(16).toUpperCase();
  if (width > 0) digits = digits.padStart(width, '0');
  return `${p.negative ? '-' : ''}${prefix ? '0x' : ''}${digits}`;
}

/** The decimal form, exact at any width. */
function dec(v) {
  const p = parse(v);
  if (!p) return null;
  return `${p.negative ? '-' : ''}${p.value.toString(10)}`;
}

/**
 * The width an address should be padded to.
 *
 * Padding to the next natural boundary is what makes a column of addresses
 * line up and makes a difference in magnitude visible at a glance. A value
 * bigger than 64 bits is left unpadded rather than truncated.
 */
function naturalWidth(value) {
  const n = value.toString(16).length;
  for (const w of NATURAL_WIDTHS) if (n <= w) return w;
  return n;
}

/**
 * A MEMORY ADDRESS — hexadecimal first, because that is how it is thought
 * about, with the decimal beside it for arithmetic.
 *
 *     0x00007FFF12345600 (140733193388032)
 */
function addr(v) {
  const p = parse(v);
  if (!p) return null;
  const h = hex(p.negative ? -p.value : p.value, { width: naturalWidth(p.value) });
  return `${h} (${dec(v)})`;
}

/**
 * A PROCESS ID — decimal first, because that is what every process list shows.
 *
 *     16296 (0x3FA8)
 */
function pid(v) {
  const p = parse(v);
  if (!p) return null;
  return `${dec(v)} (${hex(v)})`;
}

/** An offset. Hex-leaning, like an address, but never padded to a full word. */
function offset(v) {
  const p = parse(v);
  if (!p) return null;
  return `${hex(v)} (${dec(v)})`;
}

/**
 * A SIZE — decimal first, with hex beside it and a human unit when it is big
 * enough for one to help.
 *
 *     4096 (0x1000, 4 KB)
 */
function size(v) {
  const p = parse(v);
  if (!p || p.negative) return p ? `${dec(v)} (${hex(v)})` : null;
  const n = p.value;
  const unit = n >= 1024n * 1024n * 1024n ? `${(Number(n) / 1073741824).toFixed(1)} GB`
    : n >= 1024n * 1024n ? `${(Number(n) / 1048576).toFixed(1)} MB`
      : n >= 1024n ? `${(Number(n) / 1024).toFixed(1)} KB`
        : null;
  return `${dec(v)} (${hex(v)}${unit ? `, ${unit}` : ''})`;
}

/**
 * WHICH FIELDS ARE WORTH SHOWING TWICE.
 *
 * Deliberately a small, named list. Adding both representations to every
 * number in a payload would bury the two or three that matter under a wall of
 * `(0x1)` — a count of 3 is not clearer as `3 (0x3)`, and the request said so:
 * do not add hex where hexadecimal has no diagnostic meaning.
 */
const FIELD = [
  [/^(?:pid|processid|process_id|tid|threadid|thread_id|ppid)$/i, pid],
  [/^(?:address|addr|base|baseaddress|base_address|ptr|pointer|target|location|rip|rsp|rbp|eip|esp)$/i, addr],
  [/^(?:offset|delta|displacement|rva)$/i, offset],
  [/^(?:size|length|len|bytes|region_size|regionsize)$/i, size],
];

/** The formatter for a field name, or null when it is not a field worth it. */
function formatterFor(key) {
  for (const [re, fn] of FIELD) if (re.test(String(key))) return fn;
  return null;
}

/**
 * Walk a payload and collect the values worth showing in both bases.
 *
 * RETURNS A SEPARATE LIST. It does not touch the payload — see the header. The
 * caller renders this BESIDE the original JSON, so a parser reading the JSON
 * sees exactly what it saw before.
 *
 * @returns {Array<{path, key, raw, shown}>}
 */
function annotate(payload, { maxDepth = 6, max = 40 } = {}) {
  const out = [];
  const walk = (node, path, depth) => {
    if (out.length >= max || depth > maxDepth || node == null) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (out.length >= max) return;
      const here = path ? `${path}.${k}` : k;
      if (v !== null && typeof v === 'object') { walk(v, here, depth + 1); continue; }
      const fn = formatterFor(k);
      if (!fn) continue;
      const shown = fn(v);
      if (shown == null) continue;
      // Already carrying both forms — do not annotate an annotation.
      if (typeof v === 'string' && /\(0x/i.test(v)) continue;
      out.push({ path: here, key: k, raw: v, shown });
    }
  };
  walk(payload, '', 0);
  return out;
}

/** The annotations as lines, or '' when there is nothing worth adding. */
function lines(payload, opts) {
  const found = annotate(payload, opts);
  if (!found.length) return [];
  const width = found.reduce((w, f) => Math.max(w, f.path.length), 0);
  return found.map((f) => `  ${f.path.padEnd(width)}  ${f.shown}`);
}

module.exports = { parse, hex, dec, addr, pid, offset, size, annotate, lines, formatterFor, naturalWidth, FIELD };
