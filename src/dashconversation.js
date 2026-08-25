'use strict';

/**
 * THE CONVERSATION, AS THE DASHBOARD NEEDS IT.
 *
 * `/dash` used to serve a STATUS PAGE — task, model, a list of recent tool
 * names, changed files, MCP state. Every one of those is a fact about the
 * session, and none of them is the thing a person on a phone actually wants,
 * which is to READ WHAT IS HAPPENING: what was asked, what LAIN said back, what
 * the reviewer thought, what got run.
 *
 * So the snapshot gains a conversation, built from the SAME state the CONTEXT
 * pane renders — `session.turns` and `session.actors` — and in the same order.
 * This is deliberately not a second story: it is the one story, flattened into
 * JSON for a browser instead of into rows for a terminal. If they ever disagree
 * it is a bug in one of them, not a difference of opinion.
 *
 * WHAT IT MAY CARRY. The user's words, the model's prose, a one-line summary
 * per tool call, and what the external reviewer and the MCP bridge said. NOT
 * raw command output — that is bulk, it is already bounded per turn in the
 * terminal's OUTPUT pane, and shipping it over the network to a phone is the
 * opposite of a summary. Everything is length-capped, because this crosses a
 * socket.
 */

/** How many entries the phone is sent. A conversation, not an archive. */
const MAX_ENTRIES = 60;
/** Per-entry cap. Long enough to read, short enough not to be a payload. */
const MAX_TEXT = 400;

/**
 * THE ONE FUNCTION EVERY ENTRY GOES THROUGH, so it is where the credential
 * filter belongs on this surface.
 *
 * The dashboard is a SECOND renderer, in a browser, on a network the terminal
 * knows nothing about — which makes it the surface where a leak travels
 * furthest. Every field the phone is sent is built here; nothing reaches it
 * that did not pass through this line. See src/redact.js.
 */
const trim = (s) => require('./redact')
  .text(String(s == null ? '' : s))
  .replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/**
 * One flat, ordered list of `{ who, text, ok }`.
 *
 * `who` is the actor label the terminal uses — USER / LAIN / EXTERNAL / MCP /
 * ACTION — so the browser can colour them the same way and a person moving
 * between the two surfaces is reading the same conversation.
 *
 * @param {Session} session
 * @param {object}  live   { actions, narration, user } — the turn in flight
 */
function conversation(session, live = {}) {
  const out = [];
  const turns = (session && session.turns) || [];
  const actors = (session && session.actors) || [];

  // Actor lines are anchored to the turn count at the moment they were spoken
  // (see ui/index.js noteActor), which is what lets a review sit between the
  // turn that produced it and the turn that acted on it. Unanchored entries are
  // older records with no position and belong at the end.
  const at = (e) => (Number.isFinite(e.afterTurns) ? e.afterTurns : Number.MAX_SAFE_INTEGER);
  const pending = [...actors].sort((a, b) => at(a) - at(b));
  const flush = (upTo) => {
    while (pending.length && at(pending[0]) <= upTo) {
      const e = pending.shift();
      const who = e.kind === 'external' ? 'EXTERNAL' : e.kind === 'mcp' ? 'MCP' : 'LAIN';
      // THE TERMINAL FEED SHOWS THE EVENT; THE PHONE CAN SHOW THE WORDS.
      // An external consultation is one line in the conversation on purpose
      // (see externalrequest.dispatch), and the advisor's own text rides along
      // on `detail`. The dashboard is a place somebody goes to READ, so it is
      // the right surface for the whole of it — and it is the only surface,
      // apart from the saved session, where the advice can still be found.
      out.push({ who, text: trim(e.text), detail: Array.isArray(e.detail) ? e.detail : null });
    }
  };

  for (let i = 0; i < turns.length; i++) {
    flush(i);
    const t = turns[i];
    // A TURN LAIN ASKED ITSELF FOR IS NOT A USER REQUEST. The advisory brief
    // an external consultation hands back is submitted like any other turn, and
    // drawing it as `USER` claims somebody typed six hundred characters they
    // never typed. Same rule as the terminal feed — see ui/conversation.js.
    const said = t.userInput ? require('./ui/phrasing').selfAskedCaption(t.from) : null;
    if (said) out.push({ who: 'LAIN', text: said });
    else if (t.userInput) out.push({ who: 'USER', text: trim(t.userInput) });
    if (t.text) out.push({ who: 'LAIN', text: trim(t.text) });
    for (const a of (t.actions || [])) {
      out.push({ who: 'ACTION', text: trim(`${a.name} ${a.target || ''}`), ok: a.ok !== false });
    }
  }
  flush(Number.MAX_SAFE_INTEGER);

  // THE TURN IN FLIGHT. Without it the phone shows nothing at all while the
  // work is happening — the same gap the terminal feed had before the live
  // rows were added, and far more obvious on a device you are only watching.
  if (live.user) out.push({ who: 'USER', text: trim(live.user) });
  for (const n of (live.narration || [])) out.push({ who: 'LAIN', text: trim(n.text) });
  for (const a of (live.actions || [])) {
    out.push({ who: 'ACTION', text: trim(`${a.name} ${a.target || ''}`), ok: a.ok !== false });
  }

  return out.filter((e) => e.text).slice(-MAX_ENTRIES);
}

module.exports = { conversation, MAX_ENTRIES, MAX_TEXT };
