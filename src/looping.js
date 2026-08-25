'use strict';

/**
 * "THIS HAS BEEN DOING THE SAME THING FOR A WHILE" — told to YOU, not to it.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES, and why the old shape was wrong on two counts.
 *
 * The repetition detector in lifecycle.js is good and is unchanged: it counts
 * byte-identical (tool, args, result) fingerprints across a task, so read A,
 * read B, read A, read C, read A scores three rather than zero. What was done
 * with that signal was the problem.
 *
 *   IT SPOKE TO THE MODEL, AS THE USER. The nudge was pushed into the
 *     conversation as `role: 'user'` — LAIN writing in the person's voice to
 *     correct the model's behaviour. The model has no way to tell that from
 *     something the human actually typed, which makes it worse than merely
 *     bossy: it is impersonation inside the one record everything else trusts.
 *
 *   THEN IT STOPPED THE TURN. After a bounded number of nudges the task went
 *     BLOCKED on LAIN's own judgement about whether motion was progress.
 *
 * Both are LAIN deciding what the model meant and steering it there.
 *
 * ------------------------------------------------------------------------
 * WHAT HAPPENS INSTEAD.
 *
 * The observation goes to the PERSON, as an advisory, and the model is left
 * entirely alone:
 *
 *   IT DOES NOT BLOCK.   The turn keeps running while the advisory is up. It is
 *                        something to look at, not a question to answer, and
 *                        ignoring it costs nothing.
 *   IT TAKES NO KEYS WHILE YOU ARE TYPING.  Up/Down move its own highlight and
 *                        Enter confirms the choice, but only while the input
 *                        line is EMPTY (see ui/keys.js) — the moment there is
 *                        a character in the line, the arrows and Enter are the
 *                        line's again, so composing a correction is never
 *                        interrupted.
 *   IT RETRACTS ITSELF.  If the model gets past the sticking point, the
 *                        condition is gone and so is the advisory. Nobody has
 *                        to dismiss a warning about a problem that resolved.
 *   IT RE-ARMS.          If the same loop starts again, it comes back.
 *
 * That last pair is the whole design: the advisory is a VIEW OF A CONDITION,
 * not a message that was sent. A message has to be read and cleared; a
 * condition simply stops being true.
 */

/**
 * Identical results before it is worth saying anything at all.
 *
 * The same threshold the old nudge used, kept deliberately: it was never the
 * number that was wrong. Two is a retry, which is ordinary and often correct;
 * three is a pattern. Lower and it would interrupt normal work, which is how a
 * warning becomes something you learn to ignore.
 */
const SAY_AT = 3;

/**
 * The advisory, as an adapter for the ONE interaction panel.
 *
 * `KIND.ADVISORY` is what makes it non-blocking — see panel.js. Nothing awaits
 * the promise this opens with; it is closed by the condition clearing, by Esc,
 * or by one of its own letters.
 *
 * @param {object} what  { name, target, count }
 * @param {object} acts  { onLet, onSay, onStop } — what the letters do
 */
/**
 * WHAT IS REPEATING, in the words the rest of the program already uses.
 *
 * `describeTarget` produced the target, so this reads as the same thing the
 * activity feed shows — "read_file a.txt", not a second vocabulary for the same
 * call. Named once because the panel and the no-screen line must never describe
 * the same loop two different ways.
 */
function subjectOf(what) {
  return what.target ? `${what.name} ${what.target}` : what.name;
}

function adapter(what, acts = {}) {
  const { KIND, MODE } = require('./ui/panel');
  const subject = subjectOf(what);
  return {
    title: 'STILL GOING ROUND',
    kind: KIND.ADVISORY,
    mode: MODE.COMPACT,
    items: [
      { label: `${subject} — same call, same result, ${what.count}×`, selectable: false },
      { label: '', selectable: false },
      { label: 'let it run — it may know something you do not', value: 'LET' },
      // THE GESTURE, NOT A PROMISE ABOUT TIMING. This read "it lands at the
      // next step", which is what the SECOND Enter does: the first queues a
      // steer to arrive after the work in flight (app.queueSteer, mode WAIT),
      // and an empty Enter promotes it to NOW. Stating the earlier timing for
      // the earlier keystroke would have been a footer that lies about the one
      // thing the person is timing.
      { label: 'say something — just type: Enter queues it, Enter again sends it now', value: 'SAY' },
      { label: 'stop the turn', value: 'STOP' },
    ],
    footer: '↑↓ choose · Enter (empty line) confirms · Esc hides · nothing is waiting on you',
    // ONLY LIVE ON AN EMPTY LINE — see ui/keys.js's advisory branch. Typing,
    // and Enter with something typed, go where they always go: the work has
    // not stopped and neither has the person's ability to get on with it.
    onSelect(item) {
      if (item.value === 'LET' && acts.onLet) acts.onLet();
      else if (item.value === 'SAY' && acts.onSay) acts.onSay();
      else if (item.value === 'STOP' && acts.onStop) acts.onStop();
      return { close: item.value };
    },
  };
}

/**
 * The same observation as ONE LINE, for a run with no screen.
 *
 * `-p` and a piped stdin have nobody to press a letter, and a run that is not
 * interactive must not become interactive because something looked odd. It is
 * still said, once, so the transcript records what was noticed — and it is
 * phrased as an observation rather than an instruction, because that is all it
 * has ever been entitled to be.
 */
function line(what) {
  return `[looping] ${subjectOf(what)} has returned the same result ${what.count} times in this task.`;
}

/**
 * Should the advisory be showing, and about what?
 *
 * PURE. It reads the observation and answers; it raises nothing itself, so the
 * policy is testable without a terminal and there is one place that decides.
 *
 * @param {object} v        the lifecycle observation `{ repeated, ... }`
 * @param {Set}    silenced fingerprints the user said "let it run" about
 * @returns {{show:boolean, count:number}}
 */
function verdict(v, silenced, key) {
  const n = Number(v && v.repeated) || 0;
  if (n < SAY_AT) return { show: false, count: n };
  // "LET IT RUN" IS REMEMBERED FOR THAT EXACT LOOP. Being told again about the
  // thing you just approved is how an advisory becomes noise, and noise is
  // dismissed without reading — which costs you the one that mattered.
  if (silenced && silenced.has(key)) return { show: false, count: n };
  return { show: true, count: n };
}

module.exports = { adapter, verdict, line, SAY_AT };
