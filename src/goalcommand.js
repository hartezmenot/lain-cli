'use strict';

/**
 * `/goal` — WHAT THE USER IS TRYING TO ACHIEVE.
 *
 * ------------------------------------------------------------------------
 * THE ONE BEHAVIOUR THAT MAKES IT WORTH HAVING.
 *
 * `/goal` with a goal already set does NOT print it read-only. It copies it
 * back into the composer:
 *
 *     GOAL › Stabilize LAIN CLI and finish Harness_
 *
 * so it can be edited — words deleted, detail appended, the whole thing
 * rewritten — and committed with Enter. A read-only panel would make every
 * revision a retype from memory, and a goal that is annoying to revise is a
 * goal that goes stale and then gets ignored.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT MACHINERY, so it does not go to the command panel.
 *
 * A goal is a statement about the WORK, in the record of the work — the same
 * argument `/plan` already makes for itself in commands.js. Routed to the panel
 * it would sit in a box that closes on Esc.
 *
 * ------------------------------------------------------------------------
 * WITHOUT A LINE EDITOR — a pipe, `-p`, a test — there is no composer to open.
 * `/goal <text>` still works and is the form a script uses; bare `/goal` prints
 * the goal, because printing is the only thing a surface with no keyboard can
 * usefully do.
 */

const goal = require('./goal');
const compose = require('./composemode');

function register({ define, C }) {
  define('/goal', {
    // Like /plan: a statement about the task belongs in the task's record.
    args: '[<what you are trying to achieve> | clear]',
    desc: 'The standing goal this work serves — bare /goal edits it',
    run(app, { args = [], rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || '').toLowerCase();
      const current = goal.text(app.session);

      if (sub === 'clear' || sub === 'none') {
        if (!current) { w(C.dim('  No goal set.\n')); return; }
        goal.clear(app.session);
        try { app.session.save(); } catch { /* the change still holds for this run */ }
        w(C.dim('  Goal cleared.\n'));
        return;
      }

      // ---- `/goal <text>` — the direct form ------------------------------
      if (rest && rest.trim()) {
        goal.set(app.session, rest.trim());
        try { app.session.save(); } catch { /* the change still holds for this run */ }
        w(C.green('  ✓ goal  ') + C.bold(goal.text(app.session)) + '\n');
        return;
      }

      // ---- BARE `/goal` — open the composer, prefilled --------------------
      // `input.isTTY`, not `ui.enabled` — see plan.js for the whole reasoning.
      // The short version: UI ENABLED is a fact about output, and
      // `LAIN_FORCE_TUI=1` draws real frames over a pipe. Opening the composer
      // there is worse than the plan case rather than better: nothing blocks,
      // so the composer stays open and EATS the following piped lines as its
      // own text instead of running them.
      const interactive = Boolean(app.ui && app.ui.enabled && app.input && app.input.isTTY);
      if (!interactive) {
        // NOTHING TO TYPE INTO. Say what is true rather than opening a mode
        // nobody can close — the same rule the ask panel follows on a pipe.
        if (current) w('  ' + C.bold(current) + '\n' + C.dim('  /goal <text> to change it\n'));
        else w(C.dim('  No goal set. /goal <what you are trying to achieve>\n'));
        return;
      }
      compose.open(app, compose.KIND.GOAL, { prefill: current });
      w(current
        ? C.dim('  Editing the goal — Enter commits, Esc cancels.\n')
        : C.dim('  What are you trying to achieve? Enter commits, Esc cancels.\n'));
    },
  });
}

module.exports = { register };
