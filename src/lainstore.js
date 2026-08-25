'use strict';

/**
 * `<project>/.lain/` — ONE AUTHORITY FOR WHERE PROJECT INTELLIGENCE LIVES.
 *
 * ------------------------------------------------------------------------
 * WHY A PATH AUTHORITY IS WORTH A FILE OF ITS OWN.
 *
 * Three modules already wanted to write inside `.lain/`, and each of them knew
 * its own filename. That is exactly how a directory acquires two index formats,
 * a `graph.json` and a `graph/` that disagree, and a cleanup routine that
 * deletes something another module still reads. The rule this file exists to
 * hold is:
 *
 *     NOTHING OUTSIDE THIS MODULE JOINS A PATH INSIDE `.lain/`.
 *
 * A caller names a SLOT — `architecture`, `wiring`, `concepts` — and gets a
 * document. Where that document sits is this file's business and may change
 * without anybody else noticing.
 *
 * ------------------------------------------------------------------------
 * THE TWO STATE DOMAINS, AND WHICH ONE THIS IS.
 *
 *     ~/.lain-v2/               THE RUNTIME'S. Identity, credentials, which
 *                               machines opened what, supervisor bookkeeping.
 *                               Rust owns it. It outlives every CLI process.
 *
 *     <project>/.lain/          THIS. What the PROJECT is: its architecture,
 *                               its symbols, its vocabulary, its wiring. It
 *                               travels with the checkout because it describes
 *                               the checkout.
 *
 * Neither is a copy of the other. A symbol table in the runtime home would be a
 * second copy of the project's own, and a record of which machines opened a
 * project has no business in a directory somebody clones.
 *
 * ------------------------------------------------------------------------
 * THE INVARIANT THAT DECIDES WHAT MAY BE STORED HERE.
 *
 *     `.lain/` MUST SURVIVE a model restart, a model switch, a compaction and
 *     a frontend restart — AND IT MUST STILL BE USEFUL IF THE SOURCE FILES ARE
 *     GONE.
 *
 * That last clause is the sharp one, and it is what separates this from a
 * cache. A cache of file contents is worthless once the files vanish. A record
 * that a component called "Rust Guardian" was INTENDED, lives at
 * `rust/lain-supervisor/src/guardian.rs`, owns the input gate, and was last
 * VERIFIED on a given day, is worth *more* once the file vanishes — it is the
 * only thing that can say what was lost. See architecture.js.
 *
 * ------------------------------------------------------------------------
 * WHAT MAY NOT GO IN. No transcript, no model output, no conversation, no
 * credential. `.lain/` is machine state ABOUT THE PROJECT, and it is never sent
 * to a model wholesale — a caller asks it a question and gets an answer.
 * Shipping it into a prompt would recreate the cost it exists to remove.
 *
 * ------------------------------------------------------------------------
 * A PROJECT THAT CANNOT BE WRITTEN TO STILL WORKS. Every write returns a
 * boolean and every read has a fallback; a read-only checkout degrades to
 * per-session intelligence rather than to an error. That trade is the same one
 * projectindex.js makes, for the same reason.
 */

const fs = require('fs');
const path = require('path');

/** The directory, inside the project being worked on. */
const DIR = '.lain';

/**
 * THE SLOTS. A closed list, because an open one is how a second authority
 * arrives: a module that can invent a filename will, and then two modules own
 * overlapping state and neither knows it.
 *
 * `index` is the file projectindex.js has always written. It is named here so
 * that this module is genuinely the whole map of the directory — a path
 * authority with a hole in it is not one.
 */
const SLOTS = Object.freeze({
  /** The INTENDED architecture: what this project is meant to be. */
  architecture: 'architecture/skeleton.json',
  /** What was on disk the last time intent was compared against it. */
  observed: 'fingerprints/observed.json',
  /** Typed relationships between architecture nodes. */
  wiring: 'graph/wiring.json',
  /** The dictionary: what the project's words mean. */
  concepts: 'graph/concepts.json',
  /** Facts promoted out of scratch because something verified them. */
  memory: 'memory/facts.json',
  /** What was checked, when, and by what. */
  validation: 'validation/checks.json',
  /** The file/symbol index. Written by projectindex.js since before this file. */
  index: 'index.json',
});

/** Directories that exist because something writes into them per-session. */
const SCRATCH = 'scratch';

/** Bumped when an envelope's shape changes, so an old document is discarded. */
const VERSION = 1;

function dirFor(root) { return path.join(String(root), DIR); }

/**
 * The absolute path of a slot. THE ONLY PATH JOIN IN THE PROJECT for anything
 * under `.lain/`, which is the whole point of the module.
 */
function pathOf(root, slot) {
  const rel = SLOTS[slot];
  if (!rel) throw new Error(`unknown .lain slot "${slot}" — the slot list is closed on purpose`);
  return path.join(dirFor(root), rel);
}

/** Where one session's working files go. See scratch.js for the lifecycle. */
function scratchDir(root, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  return path.join(dirFor(root), SCRATCH, safe);
}

function scratchRoot(root) { return path.join(dirFor(root), SCRATCH); }

/**
 * READ A SLOT, or the fallback.
 *
 * A CORRUPT OR OLD DOCUMENT IS AN ABSENT ONE, never an error and never a
 * partial read. Half-trusting a file that did not parse is the class of bug
 * this directory is built to avoid — see projectindex.js, which learned it
 * first.
 */
function read(root, slot, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(pathOf(root, slot), 'utf8'); } catch { return fallback; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return fallback; }
  if (!doc || typeof doc !== 'object') return fallback;
  if (doc.version !== VERSION) return fallback;
  return doc.body === undefined ? fallback : doc.body;
}

/**
 * WRITE A SLOT, atomically.
 *
 * Temp file then rename, because the failure this prevents actually happened to
 * this repository: a process died between opening a file for writing and
 * writing to it, and left 900 lines at zero bytes. A rename is the only write
 * that has no such window.
 *
 * @returns {boolean} whether it landed. NEVER THROWS: a read-only project is a
 *   state, not an exception.
 */
function write(root, slot, body) {
  const file = pathOf(root, slot);
  const doc = { version: VERSION, slot, updatedAt: Date.now(), body };
  let text;
  try { text = JSON.stringify(doc); } catch { return false; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** When a slot was last written, or 0. Cheap: one stat, no parse. */
function updatedAt(root, slot) {
  try { return Math.floor(fs.statSync(pathOf(root, slot)).mtimeMs); } catch { return 0; }
}

/** Whether a slot has ever been written. */
function has(root, slot) {
  try { return fs.statSync(pathOf(root, slot)).isFile(); } catch { return false; }
}

/**
 * WHAT THIS PROJECT REMEMBERS, as a fact rather than an impression.
 *
 * Deliberately CHEAP — stats, no parses — because it is called to decide
 * whether a more expensive read is worth doing, and a survey that costs as much
 * as the thing it surveys is not a survey.
 */
function survey(root) {
  const out = { dir: dirFor(root), exists: false, slots: {}, scratch: [] };
  try { out.exists = fs.statSync(out.dir).isDirectory(); } catch { return out; }
  for (const slot of Object.keys(SLOTS)) {
    const at = updatedAt(root, slot);
    let bytes = 0;
    if (at) { try { bytes = fs.statSync(pathOf(root, slot)).size; } catch { /* raced */ } }
    out.slots[slot] = { present: at > 0, updatedAt: at, bytes };
  }
  try {
    for (const e of fs.readdirSync(scratchRoot(root), { withFileTypes: true })) {
      if (e.isDirectory()) out.scratch.push(e.name);
    }
  } catch { /* no scratch yet, which is the ordinary case */ }
  return out;
}

/**
 * PERMANENTLY FORGET ONE SLOT. Used by the tests that prove a document can be
 * rebuilt, and by nothing else — there is no "clear .lain" verb, because a
 * directory that can be emptied by a passing caller is not memory.
 */
function forget(root, slot) {
  try { fs.unlinkSync(pathOf(root, slot)); return true; } catch { return false; }
}

module.exports = {
  DIR, SLOTS, VERSION, SCRATCH,
  dirFor, pathOf, scratchDir, scratchRoot,
  read, write, has, updatedAt, survey, forget,
};
