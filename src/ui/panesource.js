'use strict';

/**
 * WHAT THE ONE SURFACE IS MADE OF.
 *
 * ------------------------------------------------------------------------
 * THIS FILE USED TO BE A SWITCH WITH NINE ARMS.
 *
 * `workspaceLines` dispatched on `screen.view` — plan, diff, files, output,
 * tokens, memory, context, detail, activity — and each arm reached a different
 * renderer with different state, different scroll behaviour and, in two cases,
 * an asynchronous project read of its own. Nine answers to "what is on the
 * screen" is nine ways for the screen to be showing the wrong one.
 *
 * There is now ONE answer: the CONVERSATION. Everything the other eight arms
 * rendered is still rendered, by the same functions, reached by a command that
 * opens the panel under the input instead of replacing the conversation:
 *
 *     plan     /plan           ui/views.js planView
 *     diff     /changes        ui/panes.js diffView
 *     files    /changes files  ui/panes.js filesView
 *     output   /jobs <n>       the job's own account
 *     tokens   /token          ui/tokenview.js
 *     memory   /note           ui/memoryview.js
 *     context  /brief          ui/contextview.js
 *     detail   /brief detail   ui/contextview.js
 *
 * Nothing was deleted and nothing became unreachable. What changed is that
 * none of it is a PLACE you can be in by mistake.
 *
 * Nothing here paints, positions or scrolls. Every function returns lines.
 * FREE FUNCTIONS OVER `screen`, as in ui/geometry.js and ui/projection.js.
 */

const views = require('./views');

/**
 * THE CONVERSATION, as lines. ONE renderer, ONE surface.
 *
 * ONE OWNER FOR THE LIVE ROW, and it is not this: the status row above the
 * input says what is happening this second. This is what was SAID.
 */
function liveLines(screen, width) {
  const s = screen.state;
  return views.activity({
    session: s.session, current: s.current, width,
    transcript: s.transcript,
    liveActions: s.liveActions || [], liveNarration: s.liveNarration || [], liveNotes: s.liveNotes || [],
    liveUser: s.liveUser || null, liveFrom: s.liveFrom || null, extras: s.extras || [],
    // HOW A PARAGRAPH OF THE TURN IN FLIGHT IS PRESENTED — see ui/reveal.js.
    // Handed in rather than reached for, so the dashboard and the tests render
    // the same account with no animation and no argument about a clock.
    reveal: s.activity ? (text, at) => s.activity.reveal(text, at) : null,
  });
}

/**
 * The surface's content, as lines. No branch on a view, because there is none.
 *
 * The task-complete overlay is the single exception and it is TRANSIENT: it is
 * a report that Esc dismisses, not a second place to be. See
 * ui/completionview.js.
 */
function workspaceLines(screen, width, height = 20) {
  const s = screen.state;
  if (screen.completion) return screen.completion;

  const lines = liveLines(screen, width);
  // ---- THE LIVE POSITION, at the foot of the feed ------------------------
  //
  // The account above is what HAPPENED; this is what is happening. It sits
  // last because that is nearest the input box, which is where the eye already
  // is — a live operation drawn at the top would be the one thing on the
  // screen you had to look away to find.
  //
  // ONLY THE LIVE HALF. The feed above already draws every finished call as
  // one quiet line, so asking for the timeline's own history too would put
  // each operation on screen twice — and, the feed being windowed, the
  // duplicates would push the model's prose off the top.
  //
  // ASKED FOR AT THIS WIDTH, and it is a pure read — the timeline is a
  // function of its events and the clock, so drawing a frame twice cannot
  // advance it. See ui/playback.js.
  if (s.activity) {
    try {
      for (const r of s.activity.liveRows(width)) lines.push(r);
    } catch { /* presentation only — the account above still stands */ }
  }
  // The launch screen stands in only when there is truly nothing yet: no task
  // AND no feed. Once a task exists the conversation carries its objective —
  // the first thing the user said — so the feed belongs here even in the
  // moment it is empty between turns.
  const hasTask = Boolean(s.session && s.session.task);
  if (hasTask || lines.filter((l) => l.trim()).length) return lines;
  return views.welcome({
    cwd: s.cwd, project: s.project, model: s.model, provider: s.provider,
    connection: s.connection, effort: s.effort, resume: s.resumeToken,
    width, height,
  });
}

module.exports = { liveLines, workspaceLines };
