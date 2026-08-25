'use strict';

/**
 * FLOOD COMPACTION — what a long run of events becomes on screen.
 *
 * Split out of ui/feed.js, which reached the god-object guard. The seam is a
 * real one rather than a place to put spare lines: that file decides how an
 * entry is DRAWN — who said it, at what weight, behind which gutter — and this
 * decides WHICH ENTRIES THERE ARE to draw when there are too many of them.
 *
 * They change for different reasons. The drawing changes when the visual
 * language does; this changes when the answer to "how much history competes
 * with the work in hand" does. Keeping them in one file is what let a run of
 * thirty calls be a rendering question.
 *
 * NOTHING IS EVER DISCARDED HERE. A folded run states its true count, a FAILURE
 * is never folded away, and the full list is still in the turn record, in AUDIT,
 * and in the DIFF and OUTPUT panes. This decides emphasis, not truth.
 */

/** views.js holds the shared text helpers; required lazily to avoid a cycle. */
const V = () => require('./views');

/**
 * TOOL FLOOD COMPACTION — a long run of calls becomes a count, not a wall.
 *
 * The failure this exists for is reproducible and was reproduced: a turn that
 * searches and reads thirty times fills every row of the workspace with
 *
 *     ✓ Searched for "update"
 *     ✓ Read src/render.js
 *     ✓ Searched for "cache"
 *     …
 *
 * and pushes what the model actually SAID off the top of the pane. The calls
 * are the evidence for the answer; they were outcompeting it for the screen.
 *
 * The rule: a run of more than `KEEP + 2` consecutive calls keeps its most
 * recent `KEEP` verbatim and rolls the rest into one summary row grouped by
 * verb. NOTHING IS DISCARDED SILENTLY — the summary states the true count, the
 * full list stays in the turn record and in AUDIT, and a FAILED call is never
 * compacted away, because a failure is the one row worth reading in full.
 */
const KEEP = 4;
/**
 * How many rows a FINISHED run of calls keeps.
 *
 * Two is enough to see what a run was and what it ended on, and few enough that
 * five finished runs cannot outweigh the one still going. It is the compaction
 * half of the same argument the fade makes in `renderFeed`: current work
 * prominent, completed work present but quiet.
 */
const KEEP_OLD = 2;

/**
 * `retry 3/5 at 12:07:56 (4s) · Esc cancels the wait` — one attempt, announced.
 *
 * Five of them are five rows saying the same thing with a different number, and
 * they arrive precisely when the pane most needs to be readable: something has
 * gone wrong and the user is looking for what. The RUN is one event.
 */
const RETRY_NOTE = /^(.*?)\s+—\s+retry\s+(\d+)\/(\d+)\b/;

/**
 * A run of retry notices, as the single event it is.
 *
 * The LAST attempt is the true state — `retrying · 3/5` says both how far it
 * has got and how far it may go — and the reason is taken from the first, which
 * is where the provider's own words are. Nothing is invented: every number here
 * was in a message that really was produced.
 */
function compactRetries(run) {
  const hits = run.map((e) => RETRY_NOTE.exec(e.text || '')).filter(Boolean);
  if (hits.length < 2) return null;
  const last = hits[hits.length - 1];
  const why = String(hits[0][1] || '').trim();
  return {
    kind: 'note',
    // The retries themselves are a WARNING; whatever failure ends the run
    // arrives as its own ERROR row and keeps its colour.
    level: 'warn',
    text: `retrying · ${last[2]}/${last[3]}${why ? ` — ${why}` : ''}`,
    compacted: true,
  };
}

function compactRuns(entries, keep = KEEP) {
  const out = [];
  // WHERE THE CURRENT RUN OF CALLS BEGINS — the same question ui/feed.js's
  // renderer asks to decide what recedes. Computed from the list being
  // compacted, so the two cannot disagree about which run is the live one.
  let lastActionRun = -1;
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].kind !== 'action') continue;
    if (k === 0 || entries[k - 1].kind !== 'action') lastActionRun = k;
  }
  let i = 0;
  while (i < entries.length) {
    // ---- A RUN OF RETRIES IS ONE EVENT ----------------------------------
    if (entries[i].kind === 'note') {
      let j = i;
      while (j < entries.length && entries[j].kind === 'note') j++;
      const run = entries.slice(i, j);
      const folded = compactRetries(run);
      if (folded) {
        // ORDER IS PRESERVED, and it matters: the failure that ENDED the run
        // came after the attempts, and printing it above them tells the story
        // backwards — the refusal first, then LAIN apparently retrying past it.
        // The folded row takes the place of the FIRST attempt; everything that
        // was not an attempt stays exactly where it was.
        let placed = false;
        for (const e of run) {
          if (RETRY_NOTE.test(e.text || '')) {
            if (!placed) { out.push(folded); placed = true; }
            continue;
          }
          out.push(e);
        }
        i = j;
        continue;
      }
      for (const e of run) out.push(e);
      i = j;
      continue;
    }
    if (entries[i].kind !== 'action') { out.push(entries[i++]); continue; }
    let j = i;
    while (j < entries.length && entries[j].kind === 'action') j++;
    const run = entries.slice(i, j);
    // ---- HISTORY IS COMPACTED HARDER THAN THE WORK IN HAND ----------------
    //
    // `keep` applied to every run equally, and a run is broken by any prose
    // between two calls — so a real investigation (four reads, a finding, four
    // more reads, a finding…) never reached the threshold at all and kept
    // EVERY row at full length. Thirty calls arrived as thirty rows, and the
    // flood the compaction exists to prevent came back through the one door it
    // did not cover.
    //
    // The LAST run is the work in hand and keeps `keep` rows verbatim.
    // Everything before it has finished and keeps `KEEP_OLD` — enough to see
    // what it was, not enough to compete with what is happening now. The rest
    // folds into the same honest summary row, which states the true count.
    //
    // NOTHING IS DISCARDED: the summary carries the count, a FAILURE is never
    // compacted away, and the whole list is still in the turn record, in AUDIT,
    // and in the DIFF and OUTPUT panes.
    const room = i === lastActionRun ? keep : KEEP_OLD;
    // Only whole successful call rows count towards a flood; a wrapped detail
    // line is part of the row above it and must travel with it.
    if (run.length <= room + 2) { for (const e of run) out.push(e); i = j; continue; }
    const head = run.slice(0, run.length - room);
    const kept = run.slice(run.length - room);
    // Failures inside the compacted head survive verbatim, above the summary.
    const failed = head.filter((e) => e.failed);
    const summary = summarise(head.filter((e) => !e.failed));
    if (summary) out.push({ kind: 'action', text: summary, compacted: true });
    for (const e of failed) out.push(e);
    for (const e of kept) out.push(e);
    i = j;
  }
  return out;
}

/** `✓ Searched ×7 · Read ×5` — one row for a run, grouped by what it did. */
function summarise(rows) {
  const counts = new Map();
  let n = 0;
  for (const r of rows) {
    if (!r.verb) continue;
    counts.set(r.verb, (counts.get(r.verb) || 0) + 1);
    n++;
  }
  if (!n) return '';
  const parts = [...counts.entries()].map(([v, c]) => (c > 1 ? `${v} ×${c}` : v));
  return `${V().MARK.done} ${parts.join(' · ')}`;
}
module.exports = { compactRuns, summarise, compactRetries, KEEP, KEEP_OLD, RETRY_NOTE };
