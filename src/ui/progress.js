'use strict';

/**
 * HOW FAR ALONG THE WORK IS — the one answer, and the one bar that draws it.
 *
 * Split out of ui/views.js when that file reached the architecture guard, and
 * the seam is a real one rather than a place to put lines. views.js LAYS OUT
 * regions of the screen: the header, the task banner, the plan pane, the tab
 * strip, the completion card. This answers a single question that several of
 * those regions ask — the status strip above the input, the pinned banner, and
 * `/copy` all want to know how far along the plan is, and they must all get the
 * same answer.
 *
 * They change for different reasons. A new pane touches the layout and not
 * this; a change to what COUNTS as progress touches this and every surface at
 * once, which is precisely why it must live in one place.
 */

/**
 * THE PLAN THE CURRENT WORK IS FOLLOWING, or null.
 *
 * ONE answer, asked by every surface that reports progress. They used to read
 * `session.plan` directly, which is the record of the last plan the session
 * ever had, whether or not its work is still in hand. See plan.js `retiredAt`.
 */
function livePlan(session) {
  const plan = session && session.plan;
  return plan && plan.isLive !== false ? plan : null;
}

/**
 * PROGRESS FROM COMPLETED WORK, never from the active step's index.
 *
 * A dropped step is not work and is not counted — a plan of five whose second
 * step was abandoned is a plan of four, and counting it would leave the bar
 * permanently short of 100% on a plan that finished.
 */
function progressOf(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    return { known: false, completed: 0, total: 0, current: 0, percent: null };
  }
  const steps = plan.steps.filter((s) => s.status !== 'dropped');
  const total = steps.length;
  const completed = steps.filter((s) => s.status === 'done').length;
  const activeIdx = steps.findIndex((s) => s.status === 'active');
  const current = activeIdx >= 0 ? activeIdx + 1 : Math.min(completed + 1, total);
  return {
    known: true,
    completed,
    total,
    current: completed >= total ? total : current,
    percent: Math.round((completed / total) * 100),
  };
}

function bar(percent, width = 22) {
  if (percent == null) return '─'.repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** `STEP 3/5  ████████░░░░  40%` — the whole progress state on one line. */
function progressCompact(p, width) {
  // NEVER THE WORD "DONE" HERE. This is the PLAN's progress, and the plan
  // finishing is not the task finishing (see App.maybeComplete). A bar that
  // reads DONE beside a task still verifying is the progress indicator lying
  // about the one thing it must not: STEP 7/7 at 100% says exactly as much and
  // claims nothing.
  const left = `STEP ${p.current}/${p.total}`;
  const right = `${p.percent}%`;
  const barW = Math.max(4, Math.min(18, width - left.length - right.length - 4));
  return `${left}  ${bar(p.percent, barW)}  ${right}`;
}

module.exports = { livePlan, progressOf, bar, progressCompact };
