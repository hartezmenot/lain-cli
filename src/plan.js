'use strict';

/**
 * PLANS. Optional, and OWNED BY THE SESSION.
 *
 * V1 kept the plan in `<cwd>/.lain/plan.md`, so a plan outlived the run that
 * wrote it. It then needed a session stamp to tell "mine" from "abandoned here
 * by someone else" — and the check was applied on some paths and not others, so
 * `/plan run` in a brand-new session could execute a previous session's plan
 * while the banner advertised it as "Active plan".
 *
 * V2 removes the possibility rather than guarding it. A plan is a field on the
 * Session object and is serialized inside the session file. There is no plan
 * file in the project, nothing to discover in a cwd, no ownership stamp, no
 * similarity heuristic, and no code path that can load a plan from anywhere
 * except the session being resumed. A new session cannot inherit a plan because
 * there is nowhere for it to inherit one from.
 *
 * "change the button text" needs no plan. Plans are for work worth tracking, and
 * nothing here forces one to exist.
 *
 * STEER SEMANTICS (rule 24): a steer adjusts what is LEFT. Completed steps are
 * evidence and are never rewritten, never renumbered away, never deleted. The
 * reason for the change is recorded in Decisions so it survives compaction.
 */

const STATUS = Object.freeze({ TODO: 'todo', ACTIVE: 'active', DONE: 'done', DROPPED: 'dropped' });
/** How many completed steps the compact digest shows before folding the rest. */
const DIGEST_DONE = 6;

class Plan {
  constructor(objective = '') {
    this.objective = String(objective);
    this.createdAt = new Date().toISOString();
    this.steps = [];       // [{ n, text, status, note, completedAt }]
    this.decisions = [];   // [{ text, at, reason }]
    /**
     * WHEN THIS PLAN STOPPED BEING THE WORK IN HAND, or null while it still is.
     *
     * A plan does not disappear when its task completes — the PLAN pane is the
     * record of what was done, and deleting it would throw that away. But it
     * also stops being an answer to "how far along is LAIN right now", and
     * that distinction had no representation at all: `progressOf` read the
     * session's plan unconditionally, so a task that finished at 2/2 left
     * `STEP 2/2 ████ 100%` sitting in the status strip through the idle
     * prompt and into the whole of the next turn, above a model that had not
     * yet decided whether it needed a plan.
     *
     * Retired is a property of the PLAN, not a flag the screen sets, because
     * every surface that draws progress has to agree about it. Adding work
     * un-retires it: a reopened plan is the work in hand again.
     */
    this.retiredAt = null;
  }

  /** This plan's work is finished. It remains readable; it is no longer live. */
  retire(reason = '') {
    if (!this.retiredAt) {
      this.retiredAt = new Date().toISOString();
      if (reason) this.decisions.push({ text: String(reason).slice(0, 200), at: this.retiredAt, reason: 'retired' });
    }
    return this;
  }

  /** Is this plan the work in hand? */
  get isLive() { return !this.retiredAt; }

  addSteps(texts) {
    // NEW WORK REOPENS THE PLAN. Steps arriving after a task was called done
    // mean the task was not done, and the progress the strip draws has to
    // follow the work rather than the verdict that preceded it.
    if (String(texts && texts.length ? texts.join('') : '').trim()) this.retiredAt = null;
    for (const t of texts) {
      const text = String(t || '').trim();
      if (!text) continue;
      this.steps.push({ n: this.steps.length + 1, text, status: STATUS.TODO, note: '', completedAt: null });
    }
    if (this.steps.length && !this.steps.some((s) => s.status === STATUS.ACTIVE)) {
      const first = this.steps.find((s) => s.status === STATUS.TODO);
      if (first) first.status = STATUS.ACTIVE;
    }
    return this;
  }

  current() {
    return this.steps.find((s) => s.status === STATUS.ACTIVE)
      || this.steps.find((s) => s.status === STATUS.TODO)
      || null;
  }

  /** Mark the active step done WITH a note, and promote the next todo. */
  complete(note = '') {
    const cur = this.current();
    if (!cur) return null;
    cur.status = STATUS.DONE;
    cur.note = String(note || '').slice(0, 400);
    cur.completedAt = new Date().toISOString();
    const next = this.steps.find((s) => s.status === STATUS.TODO);
    if (next) next.status = STATUS.ACTIVE;
    return { done: cur, next: next || null };
  }

  get completed() { return this.steps.filter((s) => s.status === STATUS.DONE); }
  get remaining() { return this.steps.filter((s) => s.status === STATUS.TODO || s.status === STATUS.ACTIVE); }
  get isFinished() { return this.steps.length > 0 && this.remaining.length === 0; }

  /**
   * Apply a user steer.
   *
   * COMPLETED STEPS ARE UNTOUCHABLE. `drop` and `replace` silently skip a done
   * step rather than modifying it — rewriting finished work is how a model gets
   * invited to redo it, which is the exact token burn V1 suffered.
   *
   * The steer text ALWAYS lands in decisions, even when it changes no step, so
   * the rationale is durable.
   */
  steer(text, { drop = [], replace = [], append = [] } = {}) {
    const reason = String(text || '').trim();

    const dropSet = new Set(drop.map(Number));
    for (const s of this.steps) {
      if (s.status === STATUS.DONE) continue;               // evidence — never dropped
      if (dropSet.has(s.n)) s.status = STATUS.DROPPED;
    }
    for (const r of replace) {
      const s = this.steps.find((x) => x.n === Number(r.n));
      if (!s || s.status === STATUS.DONE) continue;         // evidence — never rewritten
      s.text = String(r.text);
    }
    for (const t of append) {
      const text2 = String(t || '').trim();
      if (text2) { this.steps.push({ n: this.steps.length + 1, text: text2, status: STATUS.TODO, note: '', completedAt: null }); this.retiredAt = null; }
    }
    // Exactly one active step, and it is the first thing still to do.
    for (const s of this.steps) if (s.status === STATUS.ACTIVE) s.status = STATUS.TODO;
    const next = this.steps.find((s) => s.status === STATUS.TODO);
    if (next) next.status = STATUS.ACTIVE;

    if (reason) this.decisions.push({ text: reason, at: new Date().toISOString(), reason: 'user steer' });
    return this;
  }

  /** A failed check is recorded and the work continues. The plan is NEVER reset. */
  recordFailure(what) {
    this.decisions.push({ text: String(what || '').slice(0, 400), at: new Date().toISOString(), reason: 'failure' });
    return this;
  }

  /** Compact digest for the system prompt. Stable within a step. */
  digest(maxChars = 700) {
    if (!this.steps.length) return '';
    const done = this.completed.length;
    const lines = [`Plan: ${this.objective} (${done}/${this.steps.length} done)`];
    const shown = this.steps.filter((s) => s.status !== STATUS.DROPPED);
    const doneRows = shown.filter((s) => s.status === STATUS.DONE);
    const newestDone = new Set(doneRows.slice(-DIGEST_DONE).map((s) => s.n));
    let hiddenDone = 0;
    for (const s of shown) {
      const mark = s.status === STATUS.DONE ? '✓' : s.status === STATUS.ACTIVE ? '→' : s.status === STATUS.DROPPED ? '✗' : '·';
      if (s.status === STATUS.DONE) {
        hiddenDone += 1;
        if (!newestDone.has(s.n)) continue;
      }
      lines.push(`${mark} ${s.n}. ${s.text}${s.status === STATUS.DONE && s.note ? ` (done: ${s.note})` : ''}`.slice(0, 160));
    }
    if (hiddenDone > DIGEST_DONE) {
      lines.splice(1, 0, `  ✓ ${hiddenDone - DIGEST_DONE} earlier completed step(s) omitted — the full list is in /plan`);
    }
    if (this.decisions.length) {
      lines.push('Decisions:');
      for (const d of this.decisions.slice(-4)) lines.push(`- ${d.text}`.slice(0, 160));
    }
    const out = lines.join('\n');
    return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
  }

  toJSON() {
    return {
      objective: this.objective, createdAt: this.createdAt, retiredAt: this.retiredAt,
      steps: this.steps, decisions: this.decisions,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const p = new Plan(data.objective);
    p.createdAt = data.createdAt || p.createdAt;
    p.steps = Array.isArray(data.steps) ? data.steps : [];
    p.decisions = Array.isArray(data.decisions) ? data.decisions : [];
    p.retiredAt = data.retiredAt || null;
    return p;
  }
}


/**
 * The  command. It lives here because every branch of it is a plan
 * operation; commands.js is a registry, not a place for plan rules.
 *
 * `C` is passed in so this module stays usable without the rendering stack.
 */
function runCommand(app, { args = [], rest = '' } = {}, { C } = {}) {
    const { Plan } = require('./plan');
    const sub = (args[0] || 'show').toLowerCase();
    const tail = rest.slice(sub.length).trim();
    const w = (s) => app.render.write(s);

    if (sub === 'clear') { app.session.plan = null; w(C.dim('  Plan cleared (this session only).\n')); return; }

    if (sub === 'step') {
      if (!tail) { w(C.dim('  Usage: /plan step <text>\n')); return; }
      if (!app.session.plan) app.session.plan = new Plan(app.session.task ? app.session.task.objective : 'session plan');
      app.session.plan.addSteps([tail]);
      w(C.green(`  added step ${app.session.plan.steps.length}\n`));
      return;
    }
    if (sub === 'done') {
      if (!app.session.plan) { w(C.dim('  No plan.\n')); return; }
      const r = app.session.plan.complete(tail);
      if (!r) { w(C.dim('  No open step.\n')); return; }
      w(C.green(`  ✓ step ${r.done.n} done`) + (r.next ? C.dim(`  → next: ${r.next.n}. ${r.next.text}`) : C.dim('  all steps complete')) + '\n');
      // Finishing the last step is the moment completion becomes possible. The
      // evidence safeguard inside maybeComplete() still decides whether it IS
      // complete — a finished checklist with nothing done is not completion.
      app.maybeComplete();
      return;
    }
    if (sub === 'drop') {
      if (!app.session.plan) { w(C.dim('  No plan.\n')); return; }
      // Completed steps are evidence — plan.steer() refuses to touch them.
      app.session.plan.steer(`dropped step ${tail}`, { drop: [Number(tail)] });
      w(C.dim(`  dropped step ${tail} (completed steps are never dropped)\n`));
      return;
    }
    const p = app.session.plan;
    if (!p || !p.steps.length) { w(C.dim('  No plan. Plans are optional; add one with /plan step <text>.\n')); return; }
    w('\n' + C.bold('Plan') + C.dim(`  ${p.completed.length}/${p.steps.length} done`) + '\n');
    w('  ' + p.digest(1200).split('\n').join('\n  ') + '\n');
}

module.exports = { runCommand, Plan, STATUS };
