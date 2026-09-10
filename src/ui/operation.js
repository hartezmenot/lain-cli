'use strict';

/**
 * THE TRANSIENT OPERATION NOTE — `> Recovering interrupted turn`, and then gone.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS WRONG, QUOTED FROM THE SCREEN IT WAS FOUND ON:
 *
 *     1 unfinished turn(s) left findings behind - /lain
 *     held - the last turn did not finish. Recovering with what LAIN observed...
 *     Copied 3 line(s) - 184 characters.
 *
 * Three sentences of LAIN's own housekeeping, rendered as ordinary prose in the
 * conversation, indistinguishable from something the model had said, and still
 * sitting there an hour later between two real exchanges. None of them is a
 * message. None of them is worth scrolling past tomorrow. Two of them are about
 * machinery the user did not ask about and cannot act on.
 *
 * They are OPERATIONS: things LAIN is doing this second. An operation belongs in
 * the one row above the caret that says what is happening now, and when the next
 * one happens it REPLACES it — which is the whole difference between live state
 * and a log.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A SECOND ROW AND NOT A PANEL. There is exactly one live row
 * (ui/geometry.js `statusRows` is 1 at every terminal size), and this shares it
 * with the turn phase on a strict precedence: while a turn is running the PHASE
 * owns the row, because `RECEIVING` and `RAN python -c "import ast"` are more
 * specific and more urgent than any note. An operation is drawn only where the
 * row would otherwise have said READY. See ui/status.js `liveState`.
 *
 * ------------------------------------------------------------------------
 * WHAT DOES NOT COME THROUGH HERE. A material warning or a failure the user
 * needs later is NOT an operation — it is a fact about their work, and it stays
 * in the conversation where they can find it again. `render.notice('error', …)`
 * is unchanged. What moved are the three above: recovery machinery, and the
 * acknowledgement of a clipboard copy.
 *
 * NO CHAIN OF THOUGHT. Every caller passes a short description of an explicit
 * action it is about to take or has just taken. Nothing here renders model
 * reasoning, and nothing here is generated from it.
 */

/** How long a note stands before the row goes back to READY. */
const LIFE_MS = 6000;

/** Longer than this is a paragraph, and a paragraph is not an operation. */
const MAX = 72;

/**
 * Record one operation, replacing whatever the last one was.
 *
 * REPLACES, NEVER APPENDS. `ui.op` holds one note, so a sequence of them —
 * recovering, restoring, continuing — animates in place on a single row instead
 * of growing a list.
 *
 * ONE SHOT TO CLEAR IT, not a poll. The redraw ticker only runs while a turn is
 * in flight (ui/index.js `_syncTicker`), so an operation noted at an idle prompt
 * would otherwise stay on screen until something else happened to cause a frame.
 * A single unref'd timer per note is what takes it away; it is not a loop, it
 * holds nothing open, and a second note simply supersedes the first.
 */
function note(ui, text, { level = 'info' } = {}) {
  if (!ui) return;
  const say = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!say) return;
  ui.op = { text: say.slice(0, MAX), level, at: Date.now() };
  if (ui._opTimer) { clearTimeout(ui._opTimer); ui._opTimer = null; }
  const t = setTimeout(() => {
    ui._opTimer = null;
    // GUARDED ON IDENTITY. In six seconds a newer note may have taken the row;
    // clearing whatever happens to be there would erase somebody else's.
    if (ui.op && Date.now() - ui.op.at >= LIFE_MS) { ui.op = null; try { ui.refresh(); } catch { /* chrome */ } }
  }, LIFE_MS + 50);
  if (t.unref) t.unref();
  ui._opTimer = t;
  try { ui.refresh(); } catch { /* a note that cannot be drawn is still only a note */ }
}

/** Forget the current note. Called when a turn begins: its phase owns the row. */
function clear(ui) {
  if (!ui) return;
  ui.op = null;
  if (ui._opTimer) { clearTimeout(ui._opTimer); ui._opTimer = null; }
}

/** The note to draw, or null. Pure — expiry is read from the clock, not a flag. */
function current(ui, now = Date.now()) {
  const o = ui && ui.op;
  if (!o || !o.text) return null;
  return now - o.at > LIFE_MS ? null : { text: o.text, level: o.level || 'info' };
}

/**
 * THE ONE DOOR CALLERS USE, so neither of them has to know whether a screen
 * exists.
 *
 * With a TUI the note takes the live row and is gone in six seconds. WITHOUT
 * ONE - a pipe, `lain -p`, a test - there is no row to take and no way to
 * supersede anything, so it is written as a plain dim operational line. That is
 * not a fallback that loses information: on a linear terminal the scrollback IS
 * the surface, and `> Recovering interrupted turn` is still marked as an
 * operation rather than dressed as prose.
 */
function say(app, text, level = 'info') {
  if (!app) return;
  const ui = app.ui;
  if (ui && ui.enabled) return void note(ui, text, { level });
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return;
  try { app.render.write(`  › ${t}
`); } catch { /* an operation nobody can see is still only an operation */ }
}

module.exports = { note, clear, current, say, LIFE_MS, MAX };
