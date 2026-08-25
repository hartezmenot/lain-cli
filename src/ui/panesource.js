'use strict';

/**
 * WHAT EACH PANE IS MADE OF — the content behind the workspace region.
 *
 * Split out of ui/layout.js, which owns WHERE things are drawn and had grown
 * to also own WHAT was in them. The seam is the one the tab strip already
 * implies: ui/tabs.js says which panes exist and in what order, this says what
 * each of them contains, and layout.js windows the result into the rows it has.
 *
 * Nothing here paints, positions or scrolls. Every function returns lines.
 *
 * FREE FUNCTIONS OVER `screen`, as in ui/geometry.js and ui/projection.js.
 */

const views = require('./views');

/**
 * THE CONVERSATION, as lines. ONE renderer, ONE pane.
 *
 * ACTIVITY is the whole scrollable operational stream and the only surface that
 * draws it. It was rendered in two places for a while — the full pane, and a
 * bounded tail beneath the CONTEXT briefing — and two call sites for one feed
 * is how two surfaces come to disagree about what the model just said.
 *
 * ONE OWNER FOR THE LIVE ROW, and it is not this: the STATUS STRIP above the
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

/** Content for the current workspace view, as lines. */
function workspaceLines(screen, width, height = 20) {
  const s = screen.state;
  if (screen.completion) return screen.completion;
  switch (screen.view) {
    case 'plan':
      return views.planView({ plan: s.plan, expanded: screen.expandedSteps, width, cursor: screen.planCursor, evidence: s.evidence });
    case 'diff':
      return views.diffView({ checkpoints: s.checkpoints, cwd: s.cwd, width, selected: screen.diffFile });
    case 'files':
      return views.filesView({ checkpoints: s.checkpoints, cwd: s.cwd, width, tree: s.tree || [] });
    case 'output':
      return views.outputView({ outputs: s.outputs || [], width, running: s.running || null });
    // AUDIT and HEALTH are the same evidence as `/audit` and `/health`, laid
    // out for a pane. The reports are produced asynchronously (they read the
    // tree), so the screen renders whatever the last completed pass left here
    // and says "reading…" until the first one lands. See ui/index.js.
    // ---- MEMORY — what has been decided, not what was said --------------
    // ---- TOKENS — what this conversation has actually cost ---------------
    //
    // Every figure carries where it came from: MEASURED from a provider's usage
    // block, ESTIMATED from the array LAIN transmitted, PENDING while a request
    // is open, UNKNOWN where a route has never reported the quantity. See
    // ui/tokenview.js for why those four must never be collapsed into one.
    case 'tokens':
      return require('./tokenview').render({
        usage: (s.session && s.session.usage) || null,
        live: s.liveUsage || null,
        audit: s.lastAudit || null,
        requests: (s.session && s.session.usage && s.session.usage.requests) || 0,
        open: Boolean(s.requestOpen),
        model: s.model || '',
        provider: s.provider || '',
        width,
      });

    case 'memory':
      return require('./memoryview').render({
        root: s.cwd || process.cwd(), width,
      });

    // ---- CONTEXT — what is TRUE about this project right now -------------
    //
    // This used to be the transcript. A record of how knowledge was arrived
    // at is not the knowledge, and it is the knowledge somebody wants when
    // they come back to a project. The conversation moved to ACTIVITY.
    //
    // Rendered from the SAME survey `/brief` runs — see ui/briefview.js —
    // so the pane and the command cannot describe the project differently.
    // ---- CONTEXT AND DETAIL — one survey, two renderings ------------------
    //
    // NEITHER OF THEM CARRIES THE CONVERSATION. CONTEXT once drew a bounded
    // tail of the feed beneath its briefing, which put a second, worse copy of
    // ACTIVITY on the pane whose whole job is to say what is TRUE rather than
    // what just happened. A briefing that scrolls with tool calls is an event
    // ticker, and it stops being readable as a briefing.
    //
    // The feed has exactly one home, and ACTIVITY is it — which is also why
    // ACTIVITY is the pane LAIN lands on (ui/tabs.js).
    case 'context': case 'detail':
      return require('./contextview').render(screen.view, screen.report.brief, {
        width, session: s.session, cwd: s.cwd, quick: screen.report.quick,
        reading: Boolean(screen.report.reading), failed: (screen.report.failed || {}).context || '',
      });

    case 'activity':
    default: {
      const lines = liveLines(screen, width);
      // ---- THE LIVE POSITION, at the foot of the feed ---------------------
      //
      // The account above is what HAPPENED; this is what is happening. It sits
      // last because that is nearest the input box, which is where the eye
      // already is — a live operation drawn at the top would be the one thing
      // on the screen you had to look away to find.
      //
      // ONLY THE LIVE HALF. The feed above already draws every finished call
      // as one quiet line, so asking for the timeline's own history too would
      // put each operation on screen twice — and, the feed being windowed,
      // the duplicates would push the model's prose off the top.
      //
      // The diff window rides with it (ui/activity.js), so an edit is followed
      // by its change and then by nothing at all: the window closes itself and
      // the compact edit line the feed already carries is what remains.
      //
      // ASKED FOR AT THIS WIDTH, and it is a pure read — the timeline is a
      // function of its events and the clock, so drawing a frame twice cannot
      // advance it. See ui/playback.js.
      if (s.activity) {
        try {
          for (const r of s.activity.liveRows(width)) lines.push(r);
        } catch { /* presentation only — the account above still stands */ }
      }
      // The launch screen stands in only when there is truly nothing yet: no
      // task AND no feed. Once a task exists its objective and progress are
      // pinned above by the banner, so the feed belongs here even in the design
      // moment it is empty between turns — showing the welcome pane then would
      // wipe the task off the screen.
      const hasTask = Boolean(s.session && s.session.task);
      if (hasTask || lines.filter((l) => l.trim()).length) return lines;
      return views.welcome({
        cwd: s.cwd, project: s.project, model: s.model, provider: s.provider,
        connection: s.connection, effort: s.effort, resume: s.resumeToken,
        width, height,
      });
    }
  }
}

module.exports = { liveLines, workspaceLines };
