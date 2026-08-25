'use strict';

/**
 * PROJECT MEMORY — what is TRUE about this project, not what was SAID about it.
 *
 * ------------------------------------------------------------------------
 * THE DISTINCTION THAT MAKES THIS WORTH HAVING.
 *
 *     Conversation history answers   "what did we say?"
 *     Project memory answers         "what is true about this project?"
 *
 * The first is a transcript: long, chronological, full of the reasoning that
 * led somewhere, and summarised away the moment context gets tight. The second
 * is a handful of durable sentences that every future session needs and none of
 * them should have to re-derive:
 *
 *     DECISION    External JSON is the source of truth for enemy data.
 *     FACT        lain-probe takes decimal PIDs.
 *     LIMITATION  Browser verification needs a Chromium that is not installed.
 *     NOTE        The context summary still feels compressed.
 *
 * None of those survive compaction as conversation. All of them are still true
 * tomorrow. Keeping them apart is what stops the next model "tidying up" a
 * deliberate architectural decision because the reasoning scrolled out of view.
 *
 * IT IS NOT A TRANSCRIPT, and the shape enforces that: one line, one kind, no
 * speaker, no timestamp in the text. "User said X, then the model did Y" is
 * exactly what does not belong here.
 * ------------------------------------------------------------------------
 *
 * THE ORIGINAL PROBLEM, which is still the most useful case:
 *
 * THE PROBLEM, stated the way it actually happens:
 *
 *     "I knew there was something I wanted to check about the reconnect
 *      handling, and now I can't remember what it was."
 *
 * That thought arrives in the middle of doing something else. It is not a task,
 * so it does not belong in a plan. It is not a defect anybody has established,
 * so it is not a finding. It is a SUSPICION with a short shelf life, and every
 * mechanism LAIN already has loses it:
 *
 *   · the transcript loses it to compaction and summarisation
 *   · a plan step turns a suspicion into work somebody has committed to
 *   · a finding claims evidence that does not exist yet
 *
 * So it gets its own store, and the store is deliberately dumb: a line of text,
 * when it was written, and what became of it.
 *
 * ------------------------------------------------------------------------
 * WHY IT LIVES ON DISK, PER PROJECT, RATHER THAN ON THE SESSION.
 *
 * Because "survives context compaction" and "survives session restart" are the
 * whole requirement. Anything held in the conversation is subject to the
 * compactor; anything held on the session object dies with `/new`. A concern
 * about this project is still true tomorrow, in a different session, after the
 * transcript it was born in has been summarised away.
 *
 * It is kept in LAIN's OWN config home keyed by project path — never written
 * into the user's repository. A tool that leaves files in somebody's project
 * without being asked is a tool they stop trusting.
 * ------------------------------------------------------------------------
 *
 * IT IS NOT A TODO LIST, and the difference is enforced by what you can do with
 * one: a concern is RESOLVED with a note about what was found, or it is
 * PROMOTED into something with a stronger claim once evidence exists. It is
 * never "completed", because nobody agreed to do it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { configDir } = require('./config');

/** Bounds: a store nobody prunes must not grow without limit. */
const MAX_CONCERNS = 200;
const MAX_TEXT = 400;

/**
 * WHAT KIND OF DURABLE THING THIS IS.
 *
 * Few on purpose. Each answers a different question a future session asks, and
 * a kind that does not change what somebody does with it is not a kind.
 */
const KIND = Object.freeze({
  /** Something noticed that may matter and has not been settled. */
  NOTE: 'note',
  /** Settled deliberately. Do not reopen without a reason. */
  DECISION: 'decision',
  /** A convention that is true of this project. */
  FACT: 'fact',
  /** Something that cannot be done here, and why. */
  LIMITATION: 'limitation',
  /** Where the real version of something lives, after a migration. */
  SOURCE_OF_TRUTH: 'source-of-truth',
});

/** The order they are shown in: settled things first, open questions last. */
const KIND_ORDER = [KIND.DECISION, KIND.SOURCE_OF_TRUTH, KIND.FACT, KIND.LIMITATION, KIND.NOTE];

const STATE = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
});

/** Where this project's concerns live. Keyed by path, so projects stay apart. */
function fileFor(root) {
  const key = crypto.createHash('sha1').update(path.resolve(String(root || '.'))).digest('hex').slice(0, 16);
  return path.join(configDir(), 'concerns', `${key}.json`);
}

function load(root) {
  let raw;
  try { raw = fs.readFileSync(fileFor(root), 'utf8'); } catch { return { root: String(root), items: [] }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { root: String(root), items: [] }; }
  const items = Array.isArray(j && j.items) ? j.items : [];
  return { root: String(root), items: items.filter((i) => i && typeof i.text === 'string') };
}

function save(root, store) {
  const file = fileFor(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: String(root), items: store.items }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * Write one down. This is the whole interaction, and it is one line on purpose:
 * a concern that costs a workflow to record is a concern nobody records.
 */
function add(root, text, { kind = KIND.NOTE } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!t) return { ok: false, why: 'a concern needs some text' };
  const store = load(root);
  // The same thought twice is one thought. Compared case-insensitively so
  // re-noticing something does not quietly duplicate it.
  const already = store.items.find((i) => i.state === STATE.OPEN && i.text.toLowerCase() === t.toLowerCase());
  if (already) return { ok: true, duplicate: true, item: already };
  const item = {
    id: nextId(store),
    text: t,
    kind: Object.values(KIND).includes(kind) ? kind : KIND.NOTE,
    state: STATE.OPEN,
    at: new Date().toISOString(),
    note: null,
  };
  store.items.push(item);
  // Oldest RESOLVED entries fall off first — history is worth less than the
  // things still outstanding.
  while (store.items.length > MAX_CONCERNS) {
    const i = store.items.findIndex((x) => x.state === STATE.RESOLVED);
    store.items.splice(i >= 0 ? i : 0, 1);
  }
  const ok = save(root, store);
  return { ok, item, persisted: ok };
}

function nextId(store) {
  let max = 0;
  for (const i of store.items) {
    const n = Number(String(i.id || '').replace(/\D/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `C${String(max + 1).padStart(2, '0')}`;
}

/**
 * Close one, WITH what was found.
 *
 * The note is the point. "Resolved" on its own loses the answer, and the answer
 * is what stops the same suspicion being raised again next week.
 */
function resolve(root, id, note = '') {
  const store = load(root);
  const item = store.items.find((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (!item) return { ok: false, why: `no concern ${id}` };
  item.state = STATE.RESOLVED;
  item.note = String(note || '').trim().slice(0, MAX_TEXT) || null;
  item.resolvedAt = new Date().toISOString();
  return { ok: save(root, store), item };
}

/** Reclassify once somebody knows what it really is. */
function promote(root, id, kind) {
  const store = load(root);
  const item = store.items.find((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (!item) return { ok: false, why: `no concern ${id}` };
  if (!Object.values(KIND).includes(kind)) {
    return { ok: false, why: `unknown kind ${kind} — one of ${Object.values(KIND).join(', ')}` };
  }
  item.kind = kind;
  return { ok: save(root, store), item };
}

function drop(root, id) {
  const store = load(root);
  const at = store.items.findIndex((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (at < 0) return { ok: false, why: `no concern ${id}` };
  const [item] = store.items.splice(at, 1);
  return { ok: save(root, store), item };
}

/** The ones still outstanding, oldest first — the order they were noticed. */
function open(root) {
  return load(root).items.filter((i) => i.state === STATE.OPEN);
}

function all(root) { return load(root).items; }

/**
 * The short form that rides in the system prompt.
 *
 * Capped hard: this is on every request, and a concern list that grows without
 * bound would quietly become the largest thing in the prompt. The cap is
 * disclosed rather than silent.
 */
function digest(root, limit = 5) {
  const items = open(root);
  if (!items.length) return '';
  const rows = items.slice(0, limit).map((i) => `- ${i.id} ${i.text}`);
  const more = items.length > limit ? `\n- (${items.length - limit} more, see /concern)` : '';
  return `Open concerns — noticed earlier and not yet settled:\n${rows.join('\n')}${more}`;
}

/** The open entries grouped by kind, in reading order. Powers the MEMORY view. */
function grouped(root) {
  const items = open(root);
  const out = [];
  for (const k of KIND_ORDER) {
    const rows = items.filter((i) => i.kind === k);
    if (rows.length) out.push({ kind: k, items: rows });
  }
  return out;
}

module.exports = {
  grouped, KIND_ORDER, add, resolve, promote, drop, open, all, load, save, digest, fileFor, KIND, STATE, MAX_CONCERNS };
