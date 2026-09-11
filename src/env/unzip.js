'use strict';

/**
 * A ZIP READER, because the browser distribution arrives as one and this
 * project does not take dependencies.
 *
 * ------------------------------------------------------------------------
 * WHY NOT SHELL OUT TO `tar` / `unzip` / `Expand-Archive`?
 *
 * Because the three behave differently on the one thing that matters here.
 * Extracting an archive downloaded over the network is the moment a path like
 * `../../../.ssh/authorized_keys` gets to choose where it lands, and the
 * defence has to be in the extractor. Delegating it means inheriting whatever
 * the local tool happens to do — which on Windows is a different tool
 * (`bsdtar`) than on Linux (`unzip`, sometimes absent), with different
 * traversal handling and different symlink handling. `reject` below is one
 * rule, applied identically everywhere.
 *
 * It also removes an availability question from the install path: a machine
 * without `unzip` is not a machine where the Harness browser cannot be
 * installed.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * No encryption, no Zip64, no symlinks, no multi-disk. Chrome for Testing uses
 * none of them, and every one of those is a place to be subtly wrong. Each is
 * DETECTED and REFUSED rather than ignored — an extractor that quietly skips
 * an entry it does not understand produces a half-installed browser that fails
 * later, somewhere else, for a reason nobody can trace back to here.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * FIND THE END-OF-CENTRAL-DIRECTORY RECORD.
 *
 * It is at the end, but not at a fixed offset: a zip may carry up to 64KB of
 * trailing comment. So this scans BACKWARDS from the end — backwards because a
 * forward scan can match the signature inside compressed data and find a
 * plausible-looking record that is not the real one.
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * IS THIS PATH ALLOWED TO EXIST UNDER `dest`?
 *
 * Absolute paths, drive letters and `..` segments are all refused by NAME
 * before anything is created, and then the resolved result is checked against
 * `dest` again. Two checks rather than one because they fail differently: the
 * name check catches the obvious attack, and the resolve check catches the
 * clever one (a name that is harmless per-segment but escapes once the OS has
 * normalised it).
 */
function reject(name, dest) {
  const n = String(name || '');
  if (!n) return 'an entry has no name';
  if (n.includes('\0')) return `entry name contains a NUL byte: ${JSON.stringify(n)}`;
  if (path.isAbsolute(n) || /^[a-zA-Z]:/.test(n) || n.startsWith('/') || n.startsWith('\\')) {
    return `entry is an absolute path: ${n}`;
  }
  if (n.split(/[/\\]/).includes('..')) return `entry escapes the archive: ${n}`;
  const full = path.resolve(dest, n);
  const root = path.resolve(dest);
  if (full !== root && !full.startsWith(root + path.sep)) return `entry resolves outside the destination: ${n}`;
  return null;
}

/** Every entry, read from the central directory — the authoritative index. */
function entries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, why: 'not a zip archive: no end-of-central-directory record' };
  // Zip64 changes the width of every offset below. Refuse rather than read
  // 32-bit fields that are documented to be placeholders.
  for (let i = eocd - 20; i >= 0 && i > eocd - 128; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD64_LOCATOR) return { ok: false, why: 'zip64 archives are not supported' };
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) {
      return { ok: false, why: `the central directory is malformed at entry ${i}` };
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compressed = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const external = buf.readUInt32LE(off + 38);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (flags & 0x1) return { ok: false, why: `encrypted archives are not supported (${name})` };
    // The UNIX mode lives in the high 16 bits. S_IFLNK (0xA000) is a symlink,
    // whose "contents" are a path — extracting one is how an archive writes
    // outside its own directory without any `..` in a name.
    const mode = (external >>> 16) & 0xffff;
    if ((mode & 0xf000) === 0xa000) return { ok: false, why: `symlinks are not supported (${name})` };
    out.push({ name, method, crc, compressed, size, local, mode, dir: /[/\\]$/.test(name) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries: out };
}

/** Where one entry's bytes actually begin — the local header re-states the
 *  variable-length fields, and its lengths are the ones that count. */
function dataOffset(buf, e) {
  if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== SIG_LOCAL) return -1;
  return e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
}

/**
 * EXTRACT THE WHOLE ARCHIVE.
 *
 * `strip` drops leading path segments, because these distributions wrap
 * everything in one versioned top directory that nobody wants in the
 * destination.
 *
 * The CRC is checked per entry. A truncated download is the likeliest fault
 * here and it produces a browser that starts and then misbehaves in ways that
 * look like application bugs — so it is worth the cheap check to fail at the
 * install instead.
 */
function extract(zipPath, dest, { strip = 0 } = {}) {
  let buf;
  try { buf = fs.readFileSync(zipPath); } catch (e) {
    return { ok: false, why: `could not read the archive: ${(e && e.message) || e}` };
  }
  const idx = entries(buf);
  if (!idx.ok) return idx;

  let written = 0;
  const executables = [];
  for (const e of idx.entries) {
    const parts = e.name.split(/[/\\]/).filter(Boolean);
    if (parts.length <= strip) continue;
    const rel = parts.slice(strip).join(path.sep);
    const bad = reject(rel, dest);
    if (bad) return { ok: false, why: `refusing to extract: ${bad}` };
    const full = path.resolve(dest, rel);

    if (e.dir) { fs.mkdirSync(full, { recursive: true }); continue; }
    const start = dataOffset(buf, e);
    if (start < 0) return { ok: false, why: `the local header for ${e.name} is malformed` };
    const raw = buf.slice(start, start + e.compressed);

    let body;
    try {
      if (e.method === STORED) body = raw;
      else if (e.method === DEFLATED) body = zlib.inflateRawSync(raw);
      else return { ok: false, why: `unsupported compression method ${e.method} for ${e.name}` };
    } catch (err) {
      return { ok: false, why: `${e.name} would not decompress: ${(err && err.message) || err}` };
    }
    if (body.length !== e.size) {
      return { ok: false, why: `${e.name} is ${body.length} bytes but the index says ${e.size} — the download is corrupt` };
    }
    if (zlib.crc32 && zlib.crc32(body) !== e.crc) {
      return { ok: false, why: `${e.name} failed its checksum — the download is corrupt` };
    }

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    // THE EXECUTABLE BIT IS THE POINT ON POSIX. A perfectly extracted browser
    // that cannot be run is not extracted. Windows has no such bit and
    // `chmod` there is a no-op, so this is simply skipped rather than guarded.
    if (process.platform !== 'win32' && (e.mode & 0o111)) {
      try { fs.chmodSync(full, (e.mode & 0o777) || 0o755); executables.push(rel); } catch { /* mode is advisory */ }
    }
    written++;
  }
  return { ok: true, written, executables, entries: idx.entries.length };
}

module.exports = { extract, entries, reject, findEocd };
