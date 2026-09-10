'use strict';

/** `/compact`: manual use of the ONE context authority that may compact. */
function register({ define, DURING_TURN, C }) {
  define('/compact', {
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Shrink the conversation to fit the window (local, costs no tokens)',
    run(app) {
      const w = (line) => app.render.write(line + '\n');
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
      // ---- ONE LINE, AND THE ACCOUNTING IS `/token` ----------------------
      //
      // IT USED TO PRINT FIVE, including two paragraphs of reassurance:
      //
      //     291 → 84 messages (207 of the oldest folded into one summary)
      //     What you asked for is kept word for word; the tool calls are named
      //     and counted. Their full text is still in the session and on screen
      //     - it is no longer being sent.
      //     84k → 31k chars (budget 120k)
      //     Old tool output was replaced by a one-line stub naming the call.
      //     Nothing was deleted; re-run a call to get its output back.
      //
      // What somebody who typed `/compact` needs back is that it worked and by
      // how much. Everything else - what survived, what was stubbed, how close
      // to the budget this leaves them - is `/token`, which says all of it and is
      // one word away. A command that answers at five times the length of the
      // question teaches people to stop reading its answer.
      const kb = (n) => `${Math.round(Math.max(0, n) / 1000)}k`;
      if (!r.compacted) {
        w(C.dim(`  Nothing to compact · ${kb(r.before)} in ${r.beforeMessages || app.session.messages.length} messages`));
        return;
      }
      const budget = decision.result ? contextbudget.charsFor(pc, app.cfg) : 0;
      const msgs = r.folded > 0 ? `  ·  ${r.beforeMessages} → ${r.afterMessages} messages` : '';
      w(C.green(`  ✓ Compacted · ${kb(r.before)} → ${kb(r.after)}`)
        + C.dim(`${msgs}  ·  budget ${kb(budget)}`));
      // NOTHING WAS DELETED is the one fact that is not in the numbers, and it is
      // the one a person is actually uneasy about.
      w(C.dim('  Nothing was deleted — /token for what was kept, /jobs or a re-run for any output you need back.'));
    },
  });
}

module.exports = { register };
