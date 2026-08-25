'use strict';

/**
 * THE PLAN, REACHABLE BY THE MODEL.
 *
 * plan.js owned a complete plan implementation — steps, completion, steer
 * semantics, protection of finished work — and `/plan` let the USER drive it.
 * The model could not touch it. That left three things permanently dead in real
 * use, which is how it was found: not by reading the code, but by watching a
 * real task finish with an empty plan view and a 0% progress bar.
 *
 *   - `App.maybeComplete()` requires `plan.isFinished`, so with no plan it
 *     returned false forever. The completion screen and its evidence check —
 *     both implemented, both tested — could never fire on a real task.
 *   - The PLAN view had nothing to show.
 *   - Progress was always 0%.
 *
 * This file adds NO plan logic. Every rule still lives in plan.js: the Plan
 * class creates the steps, promotes the next one, and refuses to rewrite
 * completed work. This is the adapter that lets the model call it.
 *
 * WHAT THESE TOOLS CANNOT DO, and why that matters:
 *
 *   - They cannot COMPLETE A TASK. `plan_step_done` finishes a step; whether
 *     the task is done is still decided by `lifecycle.complete()`, which
 *     demands real evidence — a changed file, a command that ran, a verified
 *     check. A model that writes a one-step plan and immediately marks it done
 *     has produced a finished checklist and no evidence, and completion is
 *     refused exactly as before.
 *   - They cannot rewrite history. Completed steps are evidence and plan.js
 *     will not touch them.
 *   - They cannot start or redefine the task. Task identity is task.js's, and
 *     nothing here writes it.
 *
 * A plan remains OPTIONAL. Nothing requires the model to write one, and small
 * work should not have one — the tool descriptions say so, because a plan for
 * "fix this typo" is pure overhead.
 */

const { Plan } = require('../plan');

const MAX_STEPS = 20;
const MAX_STEP_CHARS = 200;

/** Plans live on the session; without one there is nowhere to put a plan. */
function sessionOf(ctx) {
  return ctx && ctx.session ? ctx.session : null;
}

const tools = {
  plan_write: {
    // Not a filesystem mutation: there is no plan file, and there is nothing to
    // snapshot or undo. The plan is a field on the session object.
    mutates: false,
    schema: {
      name: 'plan_write',
      description:
        'Record a short plan for work worth tracking (roughly 3-7 steps). Optional — skip it for small, '
        + 'single-edit tasks. Calling it again REPLACES the steps not yet done; steps already completed are '
        + 'kept and never rewritten. The plan is shown to the user and drives the progress display.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'the remaining steps, in order, each one short and concrete',
          },
          objective: { type: 'string', description: 'optional one-line restatement of the goal' },
        },
        required: ['steps'],
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active, so there is nowhere to keep a plan', isError: true };

      const steps = (Array.isArray(input.steps) ? input.steps : [])
        .map((s) => String(s == null ? '' : s).trim().slice(0, MAX_STEP_CHARS))
        .filter(Boolean)
        .slice(0, MAX_STEPS);
      if (!steps.length) return { output: 'plan_write needs at least one non-empty step', isError: true };

      const objective = String(input.objective || (session.task && session.task.objective) || '').trim();

      if (!session.plan) {
        session.plan = new Plan(objective);
        session.plan.addSteps(steps);
        return {
          output: `plan recorded — ${steps.length} step(s). Step 1: ${steps[0]}`,
          meta: { steps: steps.length, completed: 0 },
        };
      }

      // A REVISION. Completed steps are evidence: plan.steer() drops the open
      // ones and appends the new list, and refuses to touch anything done. So a
      // model that rethinks its approach halfway keeps its receipts.
      const plan = session.plan;
      const nextOpen = steps.map((s) => s.trim());
      const currentOpen = plan.remaining.map((s) => String(s.text || '').trim());
      if (nextOpen.length === currentOpen.length
          && nextOpen.every((text, i) => text === currentOpen[i])) {
        const cur = plan.current();
        return {
          output: `plan unchanged — ${plan.completed.length} step(s) already done, `
            + `${nextOpen.length} step(s) still ahead${cur ? `; next: ${cur.text}` : ''}`,
          meta: { steps: plan.steps.length, completed: plan.completed.length, unchanged: true },
        };
      }
      const openBefore = plan.remaining.map((s) => s.n);
      plan.steer('plan revised by the model', { drop: openBefore, append: steps });
      const cur = plan.current();
      return {
        output: `plan revised — ${plan.completed.length} step(s) already done are unchanged, `
          + `${steps.length} step(s) now ahead.${cur ? ` Next: ${cur.text}` : ''}`,
        meta: { steps: plan.steps.length, completed: plan.completed.length },
      };
    },
  },

  plan_step_done: {
    mutates: false,
    schema: {
      name: 'plan_step_done',
      description:
        'Mark the current plan step finished and move to the next. Pass a short note saying what actually '
        + 'happened (what changed, what the check showed) — the note is kept as the record of that step. '
        + 'Only call this once the step is genuinely done.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'what was done, concretely — e.g. "reset failures on success; 5/5 tests pass"' },
        },
        required: ['note'],
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active', isError: true };
      const plan = session.plan;
      if (!plan || !plan.steps.length) {
        return { output: 'there is no plan — use plan_write first, or simply continue without one', isError: true };
      }
      const note = String(input.note || '').trim();
      const r = plan.complete(note);
      if (!r) return { output: 'every step in the plan is already done', isError: true };

      const done = plan.completed.length;
      const total = plan.steps.filter((s) => s.status !== 'dropped').length;
      if (r.next) {
        return {
          output: `step ${r.done.n} done (${done}/${total}). Next: ${r.next.n}. ${r.next.text}`,
          meta: { completed: done, total },
        };
      }
      // The plan is finished. That is NOT the same as the task being complete:
      // App.maybeComplete() still asks the lifecycle, which requires evidence
      // AND a check that is not currently failing.
      //
      // If the check IS failing, say so HERE — in the tool result, where the
      // model will read it on its next step and can act. Reporting it only to
      // the user would mean the one party able to fix it never hears about it.
      const life = session.lifecycle;
      const last = life && life.lastCommand;
      if (last && !last.ok) {
        return {
          output: `step ${r.done.n} done (${done}/${total}) — that was the last step, but the task is NOT complete: `
            + `the last command failed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}: ${last.command}. `
            + 'Fix what it reported and run it again until it passes.',
          meta: { completed: done, total, finished: true, failingCheck: last.command },
        };
      }
      return {
        output: `step ${r.done.n} done (${done}/${total}) — that was the last step. `
          + 'If anything remains unverified, verify it now rather than stopping here.',
        meta: { completed: done, total, finished: true },
      };
    },
  },
};

module.exports = { tools, MAX_STEPS, MAX_STEP_CHARS };
