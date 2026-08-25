'use strict';

/**
 * THE WORKING-TREE COMMANDS — what changed on disk, and putting it back.
 *
 * Split out of commands.js, which had grown past the god-object guard. The seam
 * matches the one routecommands.js and sessioncommands.js already draw:
 * commands.js owns the REGISTRY, the dispatcher, and the rules about what may
 * run during a turn; a family of commands that share a subject owns its own
 * file and registers into that registry.
 *
 * THE SUBJECT HERE IS THE BYTES ON DISK. Both of these read the ONE
 * byte-snapshot system (checkpoint.js), and neither keeps an opinion of its own
 * about what changed — a second record of that would be a second answer to
 * "what did LAIN do to my files", which is the question a person asks precisely
 * when they are already uneasy.
 *
 * Nothing here calls a model or starts a turn.
 */

const path = require('path');

function register({ define, DURING_TURN, C }) {
  define('/undo', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Restore the files changed by the most recent mutating tool call',
    run(app) {
      const r = app.checkpoints.undo();
      if (!r.ok) {
        // A refusal to overwrite someone else's change is a WARNING, not the
        // shrug that "nothing to undo" is. They are different situations.
        if (r.stale) app.render.notice('warn', r.error);
        else app.render.write(C.dim(`  ${r.error}\n`));
        return;
      }
      app.render.write(C.green(`  undid ${r.id}`) + '\n');
      for (const f of r.restored) {
        app.render.write(C.dim(`    ${f.action}  ${path.relative(app.session.cwd, f.path)}`) + '\n');
        app.session.evidence.invalidate(f.path); // the bytes changed under us
      }
    },
  });

  define('/changes', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'What changed since each checkpoint in this session',
    run(app) {
      const list = app.checkpoints.entries;
      if (!list.length) { app.render.write(C.dim('  No changes recorded this session.\n')); return; }
      app.render.write('\n' + C.bold('Changes') + '\n');
      for (const e of list) {
        for (const row of app.checkpoints.diff(e)) {
          if (row.kind === 'unchanged' || row.kind === 'absent') continue;
          const rel = path.relative(app.session.cwd, row.path);
          const delta = row.kind === 'modified' ? C.dim(` ${row.beforeBytes} → ${row.afterBytes} bytes`) : '';
          app.render.write(`  ${row.kind.padEnd(9)} ${rel}${delta}\n`);
        }
      }
      app.render.write(C.dim('\n  /undo reverts the most recent one.\n'));
    },
  });
}

module.exports = { register };
