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
    args: '[files]',
    desc: 'What changed on disk this session — the diff, or `files` for the grouped list',
    run(app, { rest }) {
      // ------------------------------------------------------------------
      // THIS IS WHERE THE DIFF AND FILES PANES WENT.
      //
      // `/changes` used to print a bare list — `modified  src/auth/login.js
      // 412 → 480 bytes` — which answers "which files" and not "what changed",
      // because the DIFF pane answered the second one and was one keystroke
      // away. There is no pane, so the command has to be both, and the
      // renderers it uses are the pane's own (ui/panes.js): the same bytes,
      // the same grouping, the same line numbers.
      //
      // THE DIFF IS THE DEFAULT, deliberately. `diffView` shows every changed
      // file in full under a heavy rule carrying its path and counts — the
      // pane learned that lesson already, and its header records why: a diff
      // view whose default state contains no diff is a table of contents.
      // `/changes files` is the structural view, for a change too big to read.
      // ------------------------------------------------------------------
      const panes = require('./ui/panes');
      const width = (app.render && app.render.width) || 80;
      const cwd = app.session && app.session.cwd;
      const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd });
      if (!files.length) { app.render.write(C.dim('  No changes recorded this session.\n')); return; }

      const wantFiles = /^files?$/i.test(String(rest || '').trim());
      const lines = wantFiles
        ? panes.filesView({ checkpoints: app.checkpoints, cwd, width, tree: app.projectTree ? app.projectTree() : [] })
        : panes.diffView({ checkpoints: app.checkpoints, cwd, width });
      for (const line of lines) app.render.write(line + '\n');
      app.render.write(C.dim(wantFiles
        ? '\n  /changes shows the diff itself · /undo reverts the most recent one.\n'
        : '\n  /changes files groups them by what happened · /undo reverts the most recent one.\n'));
    },
  });
}

module.exports = { register };
