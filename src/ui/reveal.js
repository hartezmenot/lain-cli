'use strict';

/**
 * PROSE THAT RESOLVES — the model's words, presented rather than dumped.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR.
 *
 * A paragraph is generated over several seconds and then appears in one frame,
 * complete, as a block. Everything about that reads as OUTPUT: the interface
 * was still, and then a wall of text was there. It is also a lie about the
 * shape of the work — the sentence took time, and the screen showed none of it.
 *
 * So the paragraph is PRESENTED: characters resolve left to right, with a short
 * band of unsettled glyphs at the leading edge that settle into the real text
 * behind it. Nothing is invented and nothing is left corrupted — every glyph
 * resolves to the character the model actually wrote, and at the end the string
 * is exactly the string that went in.
 *
 * ------------------------------------------------------------------------
 * IT IS FAST. That is not a caveat, it is the requirement.
 *
 * "Smooth" here means continuous, not slow: `UNITS_PER_SEC` is several hundred
 * characters a second and the whole thing is capped at `MAX_MS`, so a long
 * answer resolves in about a second and a half rather than being typed out at
 * somebody. A per-character delay big enough to notice AS a delay is the cheap
 * loading animation this is explicitly not.
 *
 * PARAGRAPHS ARRIVE IN ORDER, and that falls out of the cost model rather than
 * needing a scheduler: a newline costs more than a character and a blank line
 * costs much more, so paragraph two cannot start until paragraph one has
 * finished and has been held for a beat.
 *
 * ------------------------------------------------------------------------
 * PURE FUNCTION OF (text, startedAt, now). Called twice with one clock it
 * returns one answer, which is what lets ui/layout.js suppress an identical
 * frame and what lets the tests drive it by hand. No timer, nothing awaited,
 * and the agent is never paced by it.
 *
 * MARKED TEXT RESOLVES BY LINE, NOT BY CHARACTER. A fence, a heading or a table
 * is structure, and scrambling half of a ``` is not a presentation of anything.
 * Those arrive a whole line at a time — still progressive, still in order, and
 * the renderer downstream (ui/markdown.js) always sees complete lines.
 */

/** Cost of one visible character. The unit everything else is priced in. */
const CHAR = 1;
/** A line ending — a small beat at the end of a line. */
const NEWLINE = 6;
/** A blank line: the settle between two paragraphs. */
const PARAGRAPH = 40;
/** Units per second. Fast enough to read as motion rather than as typing. */
const UNITS_PER_SEC = 520;
/** However long the text, it is resolved by here. */
const MAX_MS = 1500;
/**
 * How deep behind the leading edge characters are still unsettled.
 *
 * ------------------------------------------------------------------------
 * IT IS A WAVE, NOT A BLOCK, and that is the difference between materialising
 * and a cursor dragging a smudge.
 *
 * The first version scrambled EVERY character in the band and none outside it,
 * so the front was a hard-edged rectangle of ten glyphs sliding along the line.
 * Read at speed that is one moving object, not text arriving: the eye tracks
 * the block instead of the words behind it.
 *
 * Now a character's chance of still being unsettled FALLS with its distance
 * behind the edge — certain at the edge, gone by `BAND`. The front is ragged
 * and it thins out, so letters settle at slightly different moments and the
 * line resolves rather than being uncovered. Same cost, same purity, same
 * final string.
 */
const BAND = 14;
/** How often the unsettled glyphs change. Fast, but not every frame. */
const SCRAMBLE_MS = 55;

/**
 * The unsettled glyphs.
 *
 * SINGLE-WIDTH ONLY. ui/text.js measures a row by counting characters, so a
 * double-width glyph — which is most of what makes a "matrix" effect obvious —
 * would make every width calculation on that row wrong and tear the frame open.
 * These are the ones that occupy exactly one cell everywhere LAIN draws.
 */
const GLYPHS = '░▒▓#%&$@*+=<>/\\|~^';

/** Only letters and digits are ever scrambled. Structure is left alone. */
const SCRAMBLABLE = /[A-Za-z0-9]/;

/** Cheap, stable, and different for adjacent positions. */
function pick(i, tick) {
  const h = ((i * 2654435761) ^ (tick * 40503)) >>> 0;
  return GLYPHS[(h >>> 7) % GLYPHS.length];
}

/**
 * A DETERMINISTIC 0..1 FOR THIS POSITION AT THIS TICK.
 *
 * The wave needs per-character randomness that is nonetheless a pure function
 * of (position, tick) — `Math.random()` here would make two draws of one frame
 * disagree, which is the one thing ui/layout.js's identical-frame suppression
 * cannot survive, and would make every test non-deterministic.
 *
 * A different mixing constant from `pick`, so a character's chance of being
 * unsettled is not correlated with which glyph it would show.
 */
function noise(i, tick) {
  const h = ((i * 374761393) ^ (tick * 668265263) ^ (i << 5)) >>> 0;
  return (h % 10007) / 10007;
}

/**
 * EVERYTHING UP TO `end`, WITH AN UNSETTLED FRONT ON IT.
 *
 * The one place the materialising effect is written down, so prose, an activity
 * subject and a line of code being typed all resolve by the same rule instead
 * of by three that drift apart.
 *
 * `p` is how far through the WHOLE reveal we are, and it is used for one thing:
 * closing the band at the end. Held at full width to the last frame, the final
 * characters would be unsettled one frame and correct the next — a snap, at the
 * one moment the eye is on the end of the sentence. It narrows over the last
 * third instead, so the text arrives rather than being switched on.
 *
 * @param {string} s     the whole text
 * @param {number} end   how many characters have been reached
 * @param {number} p     0..1 through the reveal, for closing the band
 * @param {number} tick  which scramble frame this is
 */
function front(s, end, p, tick) {
  if (end <= 0) return '';
  const band = Math.round(BAND * Math.min(1, Math.max(0, 1 - p) * 3));
  const from = Math.max(0, end - band);
  let out = s.slice(0, from);
  for (let i = from; i < end; i++) {
    const ch = s[i];
    if (!SCRAMBLABLE.test(ch)) { out += ch; continue; }
    // ---- THE WAVE --------------------------------------------------------
    //
    // How far behind the leading edge this character sits, as a fraction of
    // the band: 0 at the edge, 1 at the back of it. Its chance of still being
    // unsettled is the complement — certain at the edge, gone by the time the
    // edge is a full band away. That makes the front RAGGED and thinning
    // instead of a hard-edged block of glyphs sliding along, which is the
    // difference between text materialising and a smudge being dragged over it.
    const k = (end - 1 - i) / Math.max(1, band);
    out += noise(i, tick) < 1 - k ? pick(i, tick) : ch;
  }
  return out;
}

/**
 * THE SAME EFFECT, DRIVEN BY A FRACTION RATHER THAN BY A CLOCK.
 *
 * `resolve` prices text in units and works out how far through it should be.
 * Some things already know: an activity subject materialises across the ENTER
 * phase its card is already in, and a line of code is written across the span
 * its hunk was planned. Those callers have a 0..1 and no business computing a
 * second reveal budget from a second clock — which is exactly the kind of
 * duplicate that comes apart later.
 *
 * Pure, like everything else here: same `(text, p, tick)`, same string.
 */
function emerge(text, p, tick = 0) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const f = Math.max(0, Math.min(1, Number(p) || 0));
  if (f >= 1) return s;
  return front(s, Math.ceil(s.length * f), f, Math.floor(tick) || 0);
}

/** What one character of this text costs to emit. */
function costOf(ch, prev) {
  if (ch === '\n') return prev === '\n' ? PARAGRAPH : NEWLINE;
  return CHAR;
}

/** Total cost of the text, in units. */
function unitsOf(text) {
  let n = 0;
  let prev = '';
  for (const ch of text) { n += costOf(ch, prev); prev = ch; }
  return n;
}

/**
 * How long this text takes to resolve, in milliseconds. Capped.
 *
 * WHOLE MILLISECONDS, and that is not tidiness. A caller asking for the state
 * at `startedAt + duration()` is asking for the finished text, and with a
 * fractional duration `(start + d) - start` comes back a few floating-point
 * bits SHORT of `d` — so the one call that must return the settled string
 * returned a half-resolved one. Clocks are integers; so is this.
 */
function duration(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return Math.ceil(Math.min(MAX_MS, (unitsOf(s) / UNITS_PER_SEC) * 1000));
}

/** Structure that must arrive whole lines at a time. */
function marked(text) {
  return require('./markdown').looksMarked(text);
}

/**
 * The text as it stands at `now`.
 *
 * Before it started: nothing. After it has resolved: exactly the input. In
 * between: everything up to the leading edge, with the last `BAND` letters and
 * digits standing in for themselves until they settle.
 */
function resolve(text, startedAt, now) {
  const s = String(text == null ? '' : text);
  if (!s || !startedAt) return s;
  // ---- SETTLED LONG AGO, WITHOUT MEASURING IT --------------------------
  //
  // `duration` walks the whole string, and this is now asked about RECORDED
  // prose as well as live prose (ui/conversation.js keeps the last turn's
  // paragraphs resolving across the end of their turn). At 60Hz that is the
  // whole of a finished answer re-costed every frame, for ever, to be told
  // each time that it finished.
  //
  // `duration` is capped at `MAX_MS`, so anything older than the cap is
  // settled — no measurement can say otherwise. One subtraction instead of a
  // walk, and it is exact rather than an approximation.
  if (Number(now) - Number(startedAt) >= MAX_MS) return s;
  const total = duration(s);
  const elapsed = Math.max(0, Number(now) - Number(startedAt));
  if (!total || elapsed >= total) return s;

  const budget = unitsOf(s) * (elapsed / total);

  // ---- MARKED TEXT: WHOLE LINES ----------------------------------------
  if (marked(s)) {
    const lines = s.split('\n');
    let spent = 0;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cost = lines[i].length + (i ? (lines[i - 1] === '' ? PARAGRAPH : NEWLINE) : 0);
      if (spent + cost > budget) break;
      spent += cost;
      out.push(lines[i]);
    }
    return out.length ? out.join('\n') : '';
  }

  // ---- PLAIN PROSE: CHARACTER BY CHARACTER, WITH A BAND -----------------
  const tick = Math.floor(elapsed / SCRAMBLE_MS);
  let spent = 0;
  let end = 0;
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = costOf(s[i], prev);
    if (spent + c > budget) break;
    spent += c;
    prev = s[i];
    end = i + 1;
  }
  if (!end) return '';
  return front(s, end, elapsed / total, tick);
}

/**
 * Is anything still resolving? The redraw clock asks this.
 *
 * `entries` are the live narration records, each stamped with when it arrived
 * (see ui/story.js). An entry with no stamp is from before this existed and is
 * treated as settled — unknown means unknown, and guessing "just arrived" would
 * replay an old paragraph.
 */
function pending(entries, now) {
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.at) continue;
    // Past the cap it is settled, whatever it says — see `resolve`. Asked on
    // every frame about every recorded paragraph, so it must not measure one
    // it can rule out with a subtraction.
    const age = Number(now) - Number(e.at);
    if (age >= MAX_MS) continue;
    if (age < duration(e.text)) return true;
  }
  return false;
}

module.exports = {
  resolve, pending, duration, unitsOf, marked, noise, front, emerge,
  CHAR, NEWLINE, PARAGRAPH, UNITS_PER_SEC, MAX_MS, BAND, SCRAMBLE_MS, GLYPHS,
};
