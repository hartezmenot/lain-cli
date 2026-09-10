'use strict';

/**
 * WHAT GIT SAYS ABOUT THE TREE, ONCE PER TURN, OFF THE REQUEST PATH.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES (GAP-MATRIX row 24). gitsense.js has measured the working
 * tree since it was written — status, numstat, shape — but only two callers
 * ever consumed it (survey.js, review_changes), and the model received none of
 * it. Every other harness stamps git state into the prompt; LAIN's model had to
 * spend a run_bash to learn what `git status` says for free.
 *
 * IT MUST NOT RIDE THE STABLE PREFIX. Working-tree state is the definition of
 * volatile: it changes the moment a file is written. The split seam
 * (promptparts.js) is where this belongs — `live`, the tail that re-prices only
 * itself — and the header comment in prompt.js records the measurement that
 * made that split worth doing.
 *
 * ------------------------------------------------------------------------
 * WHY ASYNC, WHEN THE PROMPT IS SYNCHRONOUS.
 *
 * `git status` is a subprocess; `promptparts.of` is called while a request is
 * being assembled and may not wait for one. So the same shape runtimefacts.js
 * already uses for supervisor facts applies: refresh in the background into a
 * field on the app, let every reader take whatever is there. A turn that starts
 * before the first refresh completes simply renders no section — the same
 * honest absence a project with no .git produces.
 *
 * The refresh is scheduled when a turn is SUBMITTED (submit → prefetch), so it
 * overlaps the request instead of delaying it, and one turn's writes are
 * visible to the next turn's section. Within a turn it is deliberately NOT
 * re-measured: mid-turn mutation is what the transcript is for.
 *
 * ------------------------------------------------------------------------
 * WHAT IS SAID, AND WHAT IS DELIBERATELY LEFT OUT.
 *
 * Numbers, not content — the same rule gitsense.js states for the diff itself:
 * reading diff content into the model's context is the expensive thing a
 * per-file count avoids. Files and their +added/-removed; the counts of
 * untracked and staged; and the three observations that change what a model
 * should do next (a huge change set for a small task, files differing that
 * this session never wrote, generated files in the change set). `describe` is
 * NOT reused whole because its WORTH A SECOND LOOK section is advice for a
 * human reviewing a finished session; here the reader is a model mid-task and
 * the section is smaller than that.
 *
 * NO JUDGEMENT IS MADE here about correctness — a 4,000-line diff can be right.
 * The section makes the shape visible; the model decides what it means.
 */

const gitsense = require('./gitsense');

/** Files listed before the section says "…and more". A briefing, not an inventory. */
const MAX_FILES = 12;
/** Rows of observations (the shape facts) before the same cut. */
const MAX_NOTES = 4;

/**
 * THE SECTION, from a `gitsense.review` result.
 * Returns '' whenever there is nothing useful to say — a clean tree, a project
 * with no .git, or a measurement that failed all produce silence, which is the
 * correct answer for each.
 *
 * A PURE RENDERER: every judgement on this list — unexpected, rewrite,
 * generated, huge — was already made by gitsense.review, which owns the ONE
 * normalization rule (repo-relative, forward slashes) that decides whether a
 * ledger path and a git path are the same file. An earlier version re-derived
 * "unexpected" here from a second copy of the expected list, compared absolute
 * ledger paths against relative git names, never matched, and flagged every
 * modified file as not written by the session. Re-deriving is the second idea;
 * rendering is the right one.
 */
function say(review) {
  if (!review || !review.ok || !review.files || !review.files.length) return '';

  const lines = [];
  const mod = review.files.filter((f) => !f.untracked && !f.deleted).slice(0, MAX_FILES);
  const untracked = review.files.filter((f) => f.untracked).slice(0, MAX_FILES);
  const deleted = review.files.filter((f) => f.deleted).slice(0, MAX_FILES);
  const more = review.files.length - mod.length - Math.min(untracked.length, MAX_FILES) - Math.min(deleted.length, MAX_FILES);

  const row = (f) => `  ${f.file}  +${f.added} -${f.removed}${f.rewrite ? '  [whole file rewritten]' : ''}`;
  if (mod.length) {
    lines.push('Working tree vs the last commit (this session did not write all of these):');
    lines.push(...mod.map(row));
  }
  if (untracked.length) {
    lines.push(`${mod.length ? '' : 'Working tree vs the last commit:\n'}  untracked: ${untracked.map((f) => f.file).join(', ')}`);
  }
  if (deleted.length) lines.push(`  deleted: ${deleted.map((f) => f.file).join(', ')}`);
  if (more > 0) lines.push(`  (+${more} more)`);

  // ---- THE SHAPE FACTS THAT CHANGE THE NEXT MOVE ---------------------------
  //
  // Each phrased as an observation with its reasoning attached — never as an
  // error. Same rule as gitsense.describe. All four facts come from the review
  // result itself (`unexpected`, `generated`, `rewrite`, `huge`), which is
  // where the one path-normalization rule already lives.
  const notes = [];
  if (review.huge) notes.push(`the change set is ${review.totalLines} lines — if the task was small, most of this was not asked for`);
  const surprise = review.files.filter((f) => f.unexpected && !f.untracked);
  if (surprise.length) {
    notes.push(`${surprise.length} file(s) differ that this session never wrote (${surprise.slice(0, 3).map((f) => f.file).join(', ')}${surprise.length > 3 ? '…' : ''}) — they may have been dirty before this session started`);
  }
  const gen = review.files.filter((f) => f.generated);
  if (gen.length) {
    notes.push(`generated or built files in the change set (${gen.slice(0, 3).map((f) => f.file).join(', ')}${gen.length > 3 ? '…' : ''}) — usually produced by a command, not edited`);
  }
  const rewrites = review.files.filter((f) => f.rewrite);
  if (rewrites.length) {
    notes.push(`whole-file rewrites: ${rewrites.slice(0, 3).map((f) => f.file).join(', ')}${rewrites.length > 3 ? '…' : ''} — the signature of writing a file back whole rather than patching it`);
  }
  if (notes.length) {
    lines.push('', 'Worth knowing:', ...notes.slice(0, MAX_NOTES).map((n) => `  - ${n}`));
  }

  return lines.join('\n');
}

/**
 * THE REFRESH — one background measurement, stored for the synchronous reader.
 *
 * Never throws, never blocks the caller (both by returning the promise for the
 * caller to ignore), and never starts anything but `git` itself. A tree with
 * no .git, a wedged git, or a review that fails all leave the field as it was —
 * and `say` renders nothing from it.
 *
 * @param {object} app  the field `_gitSnapshot` is stored on
 * @param {string[]} expected  absolute paths this session has written, from the
 *   checkpoint ledger — the same source /changes reads, never a second idea
 */
function prefetch(app, expected = []) {
  if (!app || !app.session || !app.session.cwd) return Promise.resolve(null);
  const cwd = app.session.cwd;
  return Promise.resolve()
    .then(() => gitsense.review(cwd, { expected }))
    .then((r) => { app._gitSnapshot = r || null; return r; })
    .catch(() => { /* leave whatever was there; a failed measure is silence */ });
}

/** Forget the measurement. `adopt` calls this — a new session is a new tree. */
function reset(app) {
  if (app) app._gitSnapshot = null;
}

/**
 * THE FILES THIS SESSION HAS WRITTEN, as absolute paths — the checkpoint
 * ledger's answer, which is the same source pretest.js and /changes read, so
 * there is no second idea here of what LAIN touched. Lives HERE rather than as
 * app.js body because app.js is against its line guard and this is the same
 * shape promptparts.js already uses for the same reason: a plain function
 * over `app`, no `this`.
 */
function touched(app) {
  try {
    const rows = require('./ui/panes').changedFiles({
      checkpoints: app && app.checkpoints,
      cwd: app && app.session && app.session.cwd,
    });
    return (rows || []).map((r) => (r && r.path) || '').filter(Boolean);
  } catch { return []; }
}

module.exports = { say, prefetch, reset, touched, MAX_FILES, MAX_NOTES };
