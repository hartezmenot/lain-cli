'use strict';

const fs = require('fs');

/** A newline, as a value. */
const NL = String.fromCharCode(10);

/**
 * NAMING A TOOL CALL FOR A PERSON.
 *
 * Split out of turn.js, which had reached the god-object guard. The seam is a
 * real one: the turn loop RUNS calls, and this decides what to call them on a
 * screen. It is pure string work over arguments the caller already holds — it
 * reads nothing, asks nobody, and costs no token.
 *
 * It exists because a feed of bare tool names is unreadable. Ten rows of
 * , ,  in a row are indistinguishable from each other,
 * and the subject — WHICH file, WHICH pattern, WHICH operation — is the part a
 * person is actually scanning for.
 */

/**
 * The one-line human subject of a tool call — "src/auth/login.js:41-83",
 * "npm test", "src". Pure string work over arguments the caller already has;
 * it reads nothing and asks nobody.
 */
function describeTarget(name, input) {
  const i = input || {};
  // A DISPATCHED CALL IS ABOUT ITS OPERATION. `probe` and `computer` carry the
  // real subject in `op`, and none of the branches below look at it — so every
  // Probe action in the feed and in the status strip read as a bare "probe"
  // with no subject, and thirty of them were indistinguishable from each other.
  //
  // `computer` REPLACED `desktop` IN THIS LIST, and that replacement is the
  // whole of the fix: the consolidation retired the `desktop` name, this line
  // was left naming it, and so a tool that no longer exists was being matched
  // while the one that took its place — same `op`-shaped input, same need —
  // fell through and drew as a bare "computer" with no subject.
  if (i.op && (name === 'probe' || name === 'computer')) {
    const op = String(i.op).slice(0, 40);
    return i.target ? `${op} → ${String(i.target).slice(0, 30)}` : op;
  }
  // A SEARCH IS ABOUT WHAT IT LOOKED FOR. `path` was tested first, so every
  // grep in the feed read `Searched for "."` — the scope, which is almost
  // always the whole project and therefore says nothing, in the place where
  // the question belongs. Ten of those in a row are indistinguishable from
  // each other, which is most of why a working turn read as noise.
  if (i.pattern && (name === 'grep' || name === 'glob')) {
    const pat = `/${String(i.pattern).slice(0, 40)}/`;
    const scope = i.path && String(i.path) !== '.' ? ` in ${String(i.path).replace(/\\/g, '/')}` : '';
    return pat + scope;
  }
  if (i.path) {
    const p = String(i.path).replace(/\\/g, '/');
    const from = i.start_line || i.offset;
    const to = i.end_line || (from && i.limit ? Number(from) + Number(i.limit) - 1 : null);
    return from ? `${p}:${from}${to ? '-' + to : '+'}` : p;
  }
  if (i.command) return String(i.command).replace(/\s+/g, ' ').slice(0, 60);
  // A PROGRAM RUN DIRECTLY IS ABOUT THE PROGRAM. `process_run` names it in
  // `program` rather than `command`, so it fell through every branch here and
  // drew as a bare `process_run` — the same subject-less row that `probe` and
  // `computer` were fixed out of.
  if (i.program) {
    const args = Array.isArray(i.args) ? i.args.join(' ') : '';
    return `${String(i.program)}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ').slice(0, 60);
  }
  // ---- LOOKING SOMETHING UP IS ABOUT WHAT WAS LOOKED UP ------------------
  //
  // Without these, a research call drew as a bare `web_fetch` with no subject —
  // the same subject-less row `probe`, `computer` and `process_run` each had to
  // be fixed out of. A host is what a person recognises in a URL, so the host
  // leads and the path follows it.
  if (i.url && name === 'web_fetch') {
    try {
      const u = new URL(String(i.url));
      const tail = u.pathname === '/' ? '' : u.pathname;
      return `${u.hostname.replace(/^www\./, '')}${tail}`.slice(0, 60);
    } catch { return String(i.url).slice(0, 60); }
  }
  if (i.query && name === 'web_search') return `"${String(i.query).replace(/\s+/g, ' ').slice(0, 50)}"`;
  if (i.pattern) return `/${String(i.pattern).slice(0, 40)}/`;
  if (i.question) return String(i.question).replace(/\s+/g, ' ').slice(0, 60);
  return '';
}

/** The first meaningful line of a tool result, bounded for display. */
function firstLine(output) {
  const s = String(output == null ? '' : output);
  const line = s.split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.slice(0, 100);
}

/**
 * WHAT A COMPLETELY SILENT TURN IS TOLD TO THE USER.
 *
 * Reported with a screenshot: the task banner, an empty Context and a green
 * DONE. The request had succeeded, the model had produced no answer, called no
 * tool and thought nothing aloud — and the screen was indistinguishable from
 * LAIN having lost the reply, which is what the user reasonably concluded.
 *
 * Naming the likeliest cause matters, because it is not a thing the user can
 * see: reasoning models behind OpenRouter-shaped gateways stream their prose as
 * `reasoning`, and a route whose output lands in a field the protocol does not
 * read looks exactly like this.
 *
 * It lives here because this file already owns how a turn is WORDED for a
 * person, and turn.js was over the god-object guard again.
 */
const EMPTY_ANSWER = 'the model returned no text and called no tools — the request '
  + 'succeeded and the answer was empty. Some models stream their prose as `reasoning`; '
  + 'if this route does that, its output is arriving in a field this provider protocol '
  + 'does not read.';

/** Results at or under this length are messages to the user, not data. */
const BRIEF_RESULT = 160;

/**
 * HOW MANY LINES THIS CALL ADDED AND REMOVED, from its own checkpoint.
 *
 * ------------------------------------------------------------------------
 * THIS CHECKPOINT, NOT THE SESSION. `ui/panes.changedFiles` measures every
 * changed file against the EARLIEST bytes captured for it, which is the right
 * question for "what has this session done to the tree" and the wrong one here:
 * with three edits to one file it would hand each of them the running total, so
 * the third call would claim the first two.
 *
 * The entry captured for THIS call holds the bytes as they were immediately
 * before it, so the difference from what is on disk now is exactly what this
 * call did. `countChanges` is the same arithmetic the DIFF pane uses, so the two
 * cannot report different numbers for one change.
 *
 * ------------------------------------------------------------------------
 * WHY THE RECORD AND NOT THE LIVE FEED. The timeline card shows the counters
 * climbing and then takes them away with it; the turn record is what remains.
 * Patching the live copy instead (ui/story.js) put the numbers on screen for
 * the length of the turn and lost them the moment it ended — measured across
 * real captured frames: 24 rows with counts, 216 without. A number that
 * vanishes is worse than one that was never there.
 *
 * TOTAL. A call that touched no file, a checkpoint never taken, a file since
 * deleted — all of them are "no counts", which is what an absent field already
 * means to every reader.
 *
 * @returns {{added: number, removed: number}|{}}
 */
function editSize(checkpoints, checkpoint) {
  if (!checkpoints || !checkpoint) return {};
  const id = checkpoint.id || checkpoint;
  const entry = ((checkpoints.entries || []).find((e) => e.id === id)) || null;
  if (!entry || !entry.files || !entry.files.length) return {};
  const { countChanges } = require('./ui/panes');
  let added = 0;
  let removed = 0;
  for (const f of entry.files) {
    const before = f.bytes ? f.bytes.toString('utf8') : null;
    let after = null;
    try { after = fs.readFileSync(f.path, 'utf8'); } catch { after = null; }
    if (before === after) continue;
    const n = countChanges(before == null ? [] : before.split(NL),
      after == null ? [] : after.split(NL));
    added += n.added;
    removed += n.removed;
  }
  return (added || removed) ? { added, removed } : {};
}

/**
 * ONE FINISHED CALL, as the ACTIVITY view needs it.
 *
 * Moved out of turn.js, which was at the god-object guard. The seam is a real
 * one rather than a place to put spare lines: this file already owns how a call
 * is WORDED for a person — `describeTarget` names its subject and `firstLine`
 * takes the readable head of its output — and this is the record built out of
 * exactly those two plus the outcome. The turn loop kept it only because that
 * is where the values happened to be in scope.
 *
 * It costs no tokens: every field is a description of something that has
 * already run.
 */
function actionRecord(call, result, { step = 0, ms = 0, reused = false, added = 0, removed = 0 } = {}) {
  const out = String(result && result.output == null ? '' : result.output);
  return {
    name: call.name,
    target: describeTarget(call.name, call.input),
    ok: !(result && result.isError),
    step,                      // which model step this call belonged to
    ms,
    reused: Boolean(reused),
    // In TTY mode raw tool output no longer streams to stdout (the Screen owns
    // it), so without this a person could see THAT a tool ran but never what
    // it said.
    note: firstLine(result && result.output),
    // A SHORT result is a message to the user ("The user chose: Beta", "no such
    // file"); a long one is data for the model (a file's contents). Only the
    // first kind is worth putting on screen, and the length is the honest test
    // — no list of special tool names.
    brief: out.length <= BRIEF_RESULT,
    // A call that names a FILE already says what it acted on; its output is
    // that file's data, which belongs in the model's context and not in the
    // activity feed.
    file: Boolean(call.input && call.input.path),
    // ---- AND WHICH FILE, because `file` is only whether ----------------
    //
    // The boolean above answers "should this call's output be drawn", which
    // is all it was ever asked. A row saying `Read src/loader.js` could not
    // say WHICH file it meant to anything downstream, so clicking it could
    // not open anything. The path is already in hand here; carrying it is
    // what makes the row navigable. See ui/feed.js `fileAt`.
    path: (call.input && call.input.path) || null,
    // HOW BIG THE CHANGE WAS — see `editSize`. Zero for everything that did not
    // change a file, which is what the drawing already treats as absent.
    added: Number(added) || 0,
    removed: Number(removed) || 0,
  };
}

module.exports = { describeTarget, firstLine, actionRecord, editSize, EMPTY_ANSWER, BRIEF_RESULT };