'use strict';

/**
 * LIFECYCLE HOOKS — and the two rules that stop them becoming a hidden program.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS SMALL, AND MUST STAY SMALL.
 *
 * A hook system is the easiest thing in a harness to over-build and the easiest
 * to regret. The regret has a shape: work starts happening that nobody can see
 * in the record, at times nobody chose, attributed to nothing. Then a task
 * fails for a reason that is in none of its evidence, because a hook did it.
 *
 * So there are exactly two rules here, and everything else follows:
 *
 *   1. A HOOK IS ON THE TIMELINE. Every run emits `hook.ran` against the task
 *      it ran for, with its name, its point and how long it took. A hook that
 *      cannot be seen in the flight recorder is a hook that does not run.
 *
 *   2. A HOOK MAY NOT DECIDE. It is handed a frozen snapshot and its return
 *      value is ignored. It cannot move a task's state, fail a verification,
 *      cancel anything or answer a question. It observes, and it may cause
 *      effects OUTSIDE the harness — write a file, ping something, start a
 *      recording — which is the whole legitimate use.
 *
 * A HOOK THAT THROWS IS DROPPED, exactly like an event subscriber. The work is
 * not a convenience; the hook is.
 *
 * ------------------------------------------------------------------------
 * WHY THE POINTS ARE A CLOSED LIST.
 *
 * The same reason the event vocabulary is: a hook registered at a point nobody
 * fires is silently dead, and that is indistinguishable from the feature not
 * working. Registering at an unknown point is REFUSED, loudly, at registration
 * time rather than never.
 */

const POINT = Object.freeze({
  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  BEFORE_EXECUTION: 'before.execution',
  AFTER_EXECUTION: 'after.execution',
  BEFORE_VERIFICATION: 'before.verification',
  AFTER_VERIFICATION: 'after.verification',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
});

const POINTS = Object.freeze(Object.values(POINT));
const KNOWN = new Set(POINTS);

/** A hook that takes longer than this is REPORTED as slow. It is not killed. */
const SLOW_MS = 2000;

class Hooks {
  constructor() {
    this._at = new Map();
    /** Hooks that threw, by name. Reported on `/harness doctor`, never hidden. */
    this.failures = [];
  }

  /**
   * Register. Returns an unregister function.
   *
   * @throws if the point is not in the closed list — see the header.
   */
  on(point, name, fn) {
    const p = String(point);
    if (!KNOWN.has(p)) {
      throw new Error(`unknown hook point "${p}" — the points are ${POINTS.join(', ')}`);
    }
    if (typeof fn !== 'function') return () => {};
    const entry = { name: String(name || 'anonymous').slice(0, 60), fn };
    if (!this._at.has(p)) this._at.set(p, []);
    this._at.get(p).push(entry);
    return () => {
      const list = this._at.get(p) || [];
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  names(point) { return (this._at.get(String(point)) || []).map((e) => e.name); }

  count() {
    let n = 0;
    for (const list of this._at.values()) n += list.length;
    return n;
  }

  /**
   * Fire one point.
   *
   * `report` is called once per hook with `{name, point, ms, ok, error}` — the
   * runtime passes an emitter here, which is how rule 1 is actually enforced
   * rather than merely stated. Nothing is returned to the caller: rule 2.
   *
   * SYNCHRONOUS ON PURPOSE. An async hook whose promise nobody awaits runs at
   * an unpredictable point in some later turn and lands on the timeline in the
   * wrong place, which is precisely the "work at times nobody chose" failure.
   * A hook that needs to do something slow starts it and returns.
   */
  fire(point, snapshot, report = null) {
    const list = this._at.get(String(point)) || [];
    for (const entry of list) {
      const began = Date.now();
      let ok = true;
      let error = '';
      try {
        entry.fn(snapshot);
      } catch (e) {
        ok = false;
        error = String((e && e.message) || e).slice(0, 200);
        this.failures.push({ name: entry.name, point: String(point), error, at: began });
        if (this.failures.length > 50) this.failures.shift();
      }
      const ms = Date.now() - began;
      if (typeof report === 'function') {
        try { report({ name: entry.name, point: String(point), ms, ok, error, slow: ms > SLOW_MS }); } catch { /* a reporter that fails must not fail the hook */ }
      }
    }
  }
}

module.exports = { Hooks, POINT, POINTS, SLOW_MS };
