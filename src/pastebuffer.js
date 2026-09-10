'use strict';

/**
 * BRACKETED PASTE — the framing, split out of the line editor.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, and it is a real seam rather than a place to put
 * lines so another file fits under a guard.
 *
 * src/input.js owns EDITING: a line, a caret, a selection, an undo stack, and
 * the key sequences that move them. This owns a PROTOCOL on the byte stream
 * underneath all of that: a terminal announces a paste with `ESC[200~`, sends
 * bytes that mean nothing but themselves, and closes with `ESC[201~`. Those two
 * jobs fail differently, are tested differently, and — as the defect below
 * showed — reason about the input in different units. The editor thinks in
 * keystrokes; this thinks in reads that can split anywhere.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THAT MADE THE SEAM OBVIOUS, and it cost the session its keyboard.
 *
 * The end marker is six bytes and a read boundary can fall anywhere inside it.
 * The old code, on failing to find the marker, moved the WHOLE buffer into the
 * paste — swallowing the `ESC[201` half. The `~` arrived on its own, matched
 * nothing, and was swallowed too. The marker no longer existed anywhere, so
 * `pasting` stayed true FOR THE REST OF THE SESSION: every keystroke after it,
 * Enter included, was appended to a paste buffer nobody would ever close.
 *
 * The symptom is "I pasted something and now the input does nothing", and no
 * amount of typing recovers it. It is not a rare race either — the chance of a
 * boundary landing inside those six bytes goes UP with the size of the paste,
 * so the bigger the paste the likelier it is to kill the input.
 *
 * `partialSuffix` is the fix and the whole of it: a tail that could be the
 * beginning of a marker is held back for the next read rather than consumed.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE USES `this`. Both functions take the reader explicitly, which is
 * the project's rule for an extracted helper and the reason this can be tested
 * by handing it a plain object.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * HOW MANY BYTES AT THE END OF `buf` COULD BE THE START OF `marker`.
 *
 * The only safe thing to do with a tail that MIGHT be half a marker is hold it
 * back until the next read decides. Consuming it makes the marker
 * unrecognisable — see the header for what that costs.
 *
 * @returns {number} the length of the longest suffix of `buf` that is a PROPER
 *   prefix of `marker`, or 0.
 */
function partialSuffix(buf, marker) {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/**
 * INSIDE A PASTE: take what has arrived, and say whether it ended.
 *
 * @returns {boolean} true when the paste closed and the loop should continue;
 *   false when it is still open and this read is exhausted.
 */
function absorb(r) {
  const end = r.buf.indexOf(PASTE_END);
  if (end < 0) {
    // A tail that could be the beginning of the end marker joins the next read.
    // Anything that cannot be is paste content and goes in. See the header.
    const keep = partialSuffix(r.buf, PASTE_END);
    r.pasteBuf += keep ? r.buf.slice(0, r.buf.length - keep) : r.buf;
    r.buf = keep ? r.buf.slice(r.buf.length - keep) : '';
    return false;
  }
  r.pasteBuf += r.buf.slice(0, end);
  r.buf = r.buf.slice(end + PASTE_END.length);
  r.pasting = false;

  // A PASTE IS TEXT ARRIVING IN THE INPUT BOX — never a submission. This used
  // to emit the line here, so pasting "Continue from step 4. … /exit" started a
  // task with no Enter pressed, which is the one thing a paste must never do.
  // Newlines inside it are content, not Enter: only the bracketed markers, not
  // the bytes between them, say what the user did. A single trailing newline is
  // dropped — terminals add one when the copied region ended with a line break.
  const text = r.pasteBuf.replace(/\r\n/g, '\n').replace(/\n$/, '');
  r.pasteBuf = '';

  // ONE UNDO STEP for the whole paste, and A SELECTION UNDER IT IS REPLACED
  // exactly as typing over one is — this writes `line`/`cursor` directly rather
  // than going through an insert, so both need doing here too.
  r._pushUndo('paste');
  if (r.hasSelection()) r._deleteSelectionRaw();
  // Pasted text lands AT THE CARET, like any other insertion, and leaves the
  // caret after it — so the viewport follows what was just pasted.
  r.line = r.line.slice(0, r.cursor) + text + r.line.slice(r.cursor);
  r.cursor += text.length;
  // Remembered so the eventual submit can still say it came from a paste;
  // downstream never has to guess that from the content.
  r.pastedInLine = r.pastedInLine || Boolean(text);
  // ---- AND THE PAYLOAD ITSELF, FOR THE COMPOSER'S DRAWING ---------------
  //
  // THIS IS THE PATH REAL PASTES TAKE. `Input.insertText` records it too, and
  // that covers a Ctrl+V arriving as a key — but a bracketed paste from the
  // terminal lands HERE, writing `line` directly (see the note above on the
  // undo step and the selection), so a record kept only in `insertText` would
  // have missed every paste that came from actually pasting.
  //
  // WHAT was pasted, never WHERE: ui/composer.js finds it by searching the
  // buffer, so nothing here has to move when the line is edited around it.
  // The buffer is untouched and is the whole of what gets sent.
  if (text && Array.isArray(r.pastesInLine)) {
    r.pastesInLine.push(text);
    if (r.pastesInLine.length > 16) r.pastesInLine.shift();
  }
  r.histIndex = r.history.length;
  r.emit('edit', r.line, { pasted: true });
  return true;
}

/**
 * NOT IN A PASTE: open one if the start marker is here.
 *
 * @returns {boolean} true when a paste opened and the loop should continue.
 */
function open(r) {
  const start = r.buf.indexOf(PASTE_START);
  if (start < 0) return false;
  const before = r.buf.slice(0, start);
  r.buf = r.buf.slice(start + PASTE_START.length);
  r.pasting = true;
  if (!before) return true;
  if (r.isTTY) {
    // ---- TYPED CHARACTERS GO IN AT THE CARET, AND MOVE IT -----------------
    //
    // Characters typed before the paste on the same line arrive in the same
    // read as the start marker. This appended them to the END of the line and
    // left the caret where it was - so the paste, which lands AT the caret,
    // went in FRONT of what had just been typed:
    //
    //     type abc, paste X   ->   Xabc
    //
    // They are ordinary insertions and behave like ordinary insertions.
    const typed = before.replace(/\r/g, '');
    r.line = r.line.slice(0, r.cursor) + typed + r.line.slice(r.cursor);
    r.cursor += typed.length;
    return true;
  }
  // PIPED INPUT. `before` can hold whole lines that arrived in the same chunk
  // as the paste marker. Assigning them to `line` — a TTY-only field the piped
  // path never reads — silently DISCARDED them, so a command sent immediately
  // before a paste vanished without a trace. Emit the complete lines; any
  // trailing partial line belongs to the paste and is carried into it.
  const parts = before.replace(/\r/g, '').split('\n');
  const partial = parts.pop();
  for (const line of parts) r._emitInput(line, false);
  if (partial) r.pasteBuf += partial;
  return true;
}

module.exports = { PASTE_START, PASTE_END, partialSuffix, absorb, open };
