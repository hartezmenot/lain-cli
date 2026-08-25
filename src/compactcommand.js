'use strict';

/** `/compact`: manual use of the ONE context authority that may compact. */
function register({ define, DURING_TURN, C }) {
  define('/compact', {
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Shrink the conversation to fit the window (local, costs no tokens)',
    run(app) {
      const providerMod = require('./provider');
      const contextbudget = require('./contextbudget');
      const pc = providerMod.resolve(app.cfg);
      const decision = app.session.contextAuthority.compact(pc, app.cfg, { reason: 'manual-compaction' });
      const r = decision.result || {
        compacted: false,
        before: app.session.contextChars(),
        after: app.session.contextChars(),
        beforeMessages: app.session.messages.length,
        afterMessages: app.session.messages.length,
      };
      if (!r.compacted) {
        app.render.write(C.dim(`  Nothing to elide — ${Math.round(r.before / 1000)}k chars in `
          + `${r.beforeMessages || app.session.messages.length} messages, and the recent working set is kept whole.\n`));
        return;
      }
      if (r.folded > 0) {
        app.render.write(C.green(`  ${r.beforeMessages} → ${r.afterMessages} messages`)
          + C.dim(` (${r.folded} of the oldest folded into one summary)\n`));
        app.render.write(C.dim('  What you asked for is kept word for word; the tool calls are named and counted. '
          + 'Their full text is still in the session and on screen — it is no longer being sent.\n'));
      }
      const budget = decision.result ? contextbudget.charsFor(pc, app.cfg) : 0;
      app.render.write(
        C.green(`  ${Math.round(r.before / 1000)}k → ${Math.round(r.after / 1000)}k chars`)
        + C.dim(` (budget ${Math.round(budget / 1000)}k)\n`)
      );
      app.render.write(C.dim('  Old tool output was replaced by a one-line stub naming the call. Nothing was deleted; re-run a call to get its output back.\n'));
    },
  });
}

module.exports = { register };
