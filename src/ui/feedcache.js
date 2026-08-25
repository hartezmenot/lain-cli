'use strict';

/**
 * THE CONVERSATION, BUILT ONCE PER CHANGE INSTEAD OF ONCE PER FRAME.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS, and it was found by MEASURING rather than by suspecting.
 *
 * The activity presentation runs the redraw clock at 60Hz while anything is
 * animating, and `ui/layout.js` composes the whole frame on every tick. Almost
 * all of that frame is the conversation — and the conversation does not change
 * between two animation frames. Measured on this machine:
 *
 *     session            feed rebuild   whole frame
 *     5 turns x 4          0.09 ms        0.32 ms
 *     80 turns x 12        1.91 ms        2.18 ms
 *     400 turns x 20      11.39 ms       13.01 ms
 *
 * So at any realistic size the frame IS the feed rebuild, and at the top end it
 * consumed the entire 16ms budget for a screen on which one card and one diff
 * row had moved. That is the bottleneck the profile named, and this is the
 * optimisation of the current implementation that it asked for — no rewrite,
 * no reduced animation quality, no lowered frame rate.
 *
 * ------------------------------------------------------------------------
 * IT IS KEYED ON THE CONTENT, NOT ON A "SOMETHING CHANGED" FLAG.
 *
 * A flag bumped by every mutator is a correctness bug waiting for the next
 * mutator somebody forgets to bump, and the symptom — a feed that silently
 * stops updating — is the worst failure this interface could have. So the key
 * is derived from the inputs themselves: the length of every text, the size of
 * every list, and the identity of the arrays holding them. Anything that
 * changes what would be drawn changes the key.
 *
 * Building the key over four hundred turns costs about a twentieth of a
 * millisecond, against the eleven it saves.
 *
 * ONE SLOT. The feed is drawn for one pane at one width; a second entry would
 * only ever be the previous width, thrown away on the next frame anyway.
 *
 * THE CALLER GETS A COPY. `ui/panesource.js` appends the live timeline rows to
 * whatever this returns, and handing out the cached array itself would let one
 * frame's live rows accumulate into the next frame's history — a growing tail
 * of stale cards, which is a far worse bug than the cost it was avoiding.
 */

/** The one remembered render: its key, and the lines it produced. */
let slot = { key: '', lines: null };

/**
 * A STABLE NAME FOR AN ARRAY, so "a different list of turns" is detectable.
 *
 * `/resume` replaces the session wholesale. Two different conversations of the
 * same shape would otherwise agree on every length in the key and the second
 * would be drawn as the first — the one collision that is actually reachable,
 * and it is closed by identity rather than by hoping the contents differ.
 */
const ids = new WeakMap();
let nextId = 1;
function idOf(arr) {
  if (!arr || typeof arr !== 'object') return 0;
  if (!ids.has(arr)) ids.set(arr, nextId++);
  return ids.get(arr);
}

/**
 * A cheap, complete description of what the feed would be built from.
 *
 * Lengths and counts rather than contents: two different strings of the same
 * length in the same slot is the only collision available, and reaching it
 * requires an edit that replaces text with different text of exactly equal
 * length in an already-recorded turn — which nothing in the program does,
 * because a turn record is written once when the turn ends.
 */
function key(o) {
  const parts = [o.width, idOf(o.turns), (o.turns || []).length];
  for (const t of o.turns || []) {
    parts.push(
      (t.userInput || '').length,
      (t.text || '').length,
      (t.reasoning || '').length,
      (t.actions || []).length,
      (t.narration || []).length,
      (t.steerTexts || []).length,
      (t.errors || []).length,
    );
  }
  const extras = o.extras || [];
  parts.push('x', extras.length);
  for (const e of extras) parts.push(e.kind, (e.text || '').length, e.afterTurns);
  const plan = o.plan;
  parts.push('p', plan ? plan.steps.map((s) => s.status).join('') : '');
  parts.push('t', o.objective ? String(o.objective).length : 0);
  parts.push('a', (o.liveActions || []).length);
  for (const a of o.liveActions || []) parts.push(a.name, a.ok ? 1 : 0, (a.note || '').length, (a.output || '').length);
  // THE LIVE PROSE GOES IN WHOLE, not as a length: it is the one input that
  // changes without changing size, because a paragraph resolving on screen
  // (ui/reveal.js) swaps unsettled glyphs for real characters one at a time.
  parts.push('n', (o.liveTexts || []).length);
  for (const t of o.liveTexts || []) parts.push(t);
  // AND THE LAST TURN'S PROSE, for exactly the same reason. It keeps resolving
  // across the moment the turn ends (see ui/conversation.js), so between two
  // frames it is a different string of the same length — which every other
  // entry here is described by and this one therefore cannot be.
  parts.push('s', (o.settledTexts || []).length);
  for (const t of o.settledTexts || []) parts.push(t);
  parts.push('o', (o.liveNotes || []).length);
  parts.push('u', o.liveUser ? String(o.liveUser).length : 0);
  parts.push('r', (o.transcript || []).length, (o.transcript || []).length ? String(o.transcript[o.transcript.length - 1]).length : 0);
  parts.push('c', ((o.current && o.current.steps) || []).map((s) => `${s.label}${s.done ? 1 : 0}${s.active ? 1 : 0}`).join('|'));
  return parts.join(',');
}

/**
 * A COPY of the cached lines, with the two side-channels the pane needs.
 *
 * `spoken` is what the `↓ N new` indicator counts and `userAt` maps a drawn row
 * back to the message on it (ui/mouse.js). Both ride on the array rather than
 * in it, so both have to be carried across the copy or a cached frame would
 * silently lose click-to-restore and the unread count.
 */
function copyOf(lines) {
  const out = lines.slice();
  out.spoken = lines.spoken;
  if (lines.userAt) {
    Object.defineProperty(out, 'userAt', { value: lines.userAt, enumerable: false, writable: true });
  }
  return out;
}

/** The remembered render for this key, or null. */
function get(k) {
  return slot.key && slot.key === k && slot.lines ? copyOf(slot.lines) : null;
}

/** Remember this render, and hand back a copy of it. */
function put(k, lines) {
  slot = { key: k, lines };
  return copyOf(lines);
}

/** Forget it. Nothing depends on this — it is here for the tests. */
function reset() { slot = { key: '', lines: null }; }

module.exports = { key, get, put, reset, copyOf, idOf };
