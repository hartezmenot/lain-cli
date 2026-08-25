'use strict';

/**
 * THE SESSION AND VIEW COMMANDS — which session is current, and what is on
 * screen right now.
 *
 * Split out of commands.js, which had grown past the god-object guard again.
 * The seam is the same one routecommands.js draws: every command here is a
 * question about the SESSION — start a new one, clear what is shown of this
 * one, list the saved ones, restore one — while commands.js keeps the tools,
 * the reports and the workspace.
 *
 * There is still exactly ONE registry. This file does not own a second one: it
 * is handed `define` and registers into the same map, at load time, from the
 * bottom of commands.js. That is also why it requires nothing back from
 * commands.js — a cycle here would be a second dispatch path waiting to happen.
 */

const { Session } = require('./session');

/**
 * @param {object} api  { define, DURING_TURN, C } — the registry's own
 *                      vocabulary, passed in rather than imported back.
 */
function register({ define, REGISTRY, DURING_TURN, C }) {
  define('/new', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Start a fresh, empty session',
    run(app) {
      // adopt() also rebinds checkpoints and the cached project brief. Assigning
      // app.session directly left them pointing at the PREVIOUS session, so
      // /undo could revert work that belonged to a different session.
      app.adopt(new Session({ cwd: app.cwd }));
      app.render.write(C.dim(`  new session ${app.session.id} — empty.\n`));
    },
  });

  /**
   * `/clean` — CLEAR THE SCREEN'S MEMORY, NOT THE SESSION'S.
   *
   * The visible conversation is a rendering of `session.turns`, the actor lines
   * and the linear transcript. This empties those, and NOTHING else: the model's
   * own context (`session.messages`) is untouched, so a task in flight keeps
   * working and keeps making sense.
   *
   * That distinction is the whole command, and it is stated on screen rather than
   * left to be discovered — a cleared screen that silently also wiped the model's
   * memory, or one that silently did not, are two very different programs and the
   * user cannot tell them apart by looking. `/new` is the other one, and it says
   * so here.
   *
   * Nothing on disk is touched: no session file, no config, no checkpoint. `/undo`
   * still works afterwards, because the snapshots are not part of the view.
   */
  define('/clean', {
    // ---- ITS OWN RECEIPT MUST NOT BE THE FIRST THING IN THE CLEARED VIEW ---
    //
    // Observed: "even slash clear is sticking on conversation
    // context". It wrote through `render.write`, which the Screen prints into
    // the transcript — so clearing the conversation left "Context cleared. 3
    // turn(s) removed from the view." sitting in the conversation as the
    // conversation's new first line. The command that empties the view was
    // putting something into it, every time, and that line then rode along in
    // every later screen.
    //
    // It is machinery talking about machinery, so it goes to the bottom surface
    // with every other notice, and closes itself — you asked for this and have
    // read the answer by the time you have read it.
    surface: true,
    desc: 'Clear the visible conversation (the model keeps its context; /new starts over)',
    run(app) {
      const s = app.session;
      const turns = (s.turns || []).length;
      const voices = (s.actors || []).length;
      s.turns = [];
      s.actors = [];
      // THE PINNED OBJECTIVE IS PART OF THE VIEW TOO.
      //
      // Clearing the feed while the header kept the objective left the last task
      // sitting on screen above an empty conversation — which is exactly the
      // "permanent banner" complaint, and not what anyone means by clean.
      //
      // Only when nothing is RUNNING. A turn in flight owns the task, the plan
      // and the lifecycle, and pulling those out from under it would be a silent
      // cancellation. This command is not one, and says so below.
      const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
      if (!turnActive) { s.task = null; s.lifecycle = null; s.plan = null; }
      if (app.ui) {
        app.ui.story.beginTurn();
        app.ui.story.endTurn();
        app.ui.story.outputs = [];
        if (app.ui.enabled) {
          app.ui.dismissCompletion();
          app.ui.screen.workspaceScroll = 0;
          app.ui.screen.stickToBottom = true;
        }
      }
      app.render.transcript = [];
      const removed = `${turns} turn(s)` + (voices ? ` and ${voices} actor line(s)` : '');
      // ---- IT SAID "CONTEXT CLEARED" AND THE CONTEXT WAS NOT CLEARED --------
      //
      // The program has one meaning for "context": `session.contextChars()`,
      // which counts `session.messages` — what the model actually reads, and
      // what the window limit is measured against. This command does not touch
      // that, deliberately. So the word was a straight contradiction of the
      // state it was reporting, and a user who ran `/clear` because they were
      // near the window limit was told the thing they wanted had happened while
      // the number stayed exactly where it was.
      //
      // It now says WHICH of the two it cleared, and the size of the one it did
      // not, because that number is the reason people reach for this command.
      const kept = (s.messages || []).length;
      app.render.write(C.green('  View cleared.') + C.dim(`  ${removed} removed from the screen.`) + '\n');
      if (kept) {
        const k = Math.round(s.contextChars() / 1000);
        app.render.write(C.dim(`  The model's context is UNCHANGED — ${kept} messages, ~${k}k chars.`) + '\n');
        app.render.write(C.dim('  /compact shrinks it. /new starts a genuinely fresh session.') + '\n');
      }
      if (turnActive) {
        app.render.write(C.dim('  A turn is still running; it keeps its task and plan. /clean never cancels work.') + '\n');
      }
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  /**
   * `/clear` — CLEAR THE CONVERSATION THE MODEL IS SENT.
   *
   * ------------------------------------------------------------------------
   * IT WAS AN ALIAS OF `/clean`, AND THAT WAS THE BUG.
   *
   * `/clean` empties the VIEW. `/clear` forwarded to it, so the command people
   * reach for when they are up against the context limit did nothing to the
   * context at all: measured on the wire, the request after `/clear` carried
   * MORE messages than the one before it, because the conversation was
   * untouched and two more messages had been added. Somebody clearing to escape
   * a 413 got a blank screen and the same refusal.
   *
   * The two names now mean the two different things people already assume they
   * mean, and each says which:
   *
   *     /clean   the SCREEN. The model keeps everything.
   *     /clear   the MODEL'S CONVERSATION. The screen goes with it.
   *
   * ------------------------------------------------------------------------
   * WHAT SURVIVES, deliberately, because clearing the conversation is not
   * abandoning the work:
   *
   *   THE TASK, THE PLAN AND THE LIFECYCLE. What is being done, how far it has
   *     got and what has been checked are the RECORD of the work, not the
   *     transcript of it. `/new` is the command that drops those too.
   *   THE FILES ALREADY CHANGED. They are on disk; nothing here touches them,
   *     and `/undo` still reverses them.
   *   THE SESSION FILE. Everything cleared here is still in the saved session,
   *     so `/resume` brings it back — this is not a delete.
   *
   * BLOCKED during a turn: it rewrites the very array the turn is sending.
   */
  define('/clear', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[context]',
    desc: "Clear the model's conversation (the task and plan survive; /clean clears only the screen)",
    run(app) {
      const s = app.session;
      const cleared = s.clearContext();
      const had = cleared.removed;
      const chars = cleared.chars;
      // The view goes too — a screen still showing a conversation the model no
      // longer has is the same trap in the other direction.
      REGISTRY.get('/clean').run(app, { args: [], rest: '' });
      app.render.write(C.green('  Conversation cleared.')
        + C.dim(`  ${had} message(s), ~${Math.round(chars / 1000)}k chars removed from what the model is sent.`) + '\n');
      if (s.task) {
        app.render.write(C.dim(`  The task survives: ${String(s.task.objective || '').slice(0, 60)}\n`));
        app.render.write(C.dim('  /new drops the task and plan as well.\n'));
      }
      app.render.write(C.dim('  Nothing on disk changed — /resume brings this session back.\n'));
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  /**
   * `/backup` — a state worth returning to, with the evidence it worked.
   *
   * NOT a zip command. `/undo` already reverses the last edits from the byte
   * snapshots taken before each mutating call; this answers a different
   * question — "put me back to the last time everything passed" — which walking
   * backward one edit at a time cannot, because it has no idea which of those
   * points was good. See backups.js.
   *
   * Restoring is always explicit, never automatic, and it checkpoints the
   * current state first.
   */
  define('/backup', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[list | create [label] | restore <n>]',
    desc: 'Checkpoint this project, or go back to one that passed',
    run(app, { args, rest }) {
      const B = require('./backups');
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || 'list').toLowerCase();

      const show = () => {
        const rows = B.list();
        if (!rows.length) {
          w(C.dim('  No checkpoints yet. /backup create [label]') + '\n');
          return rows;
        }
        w('\n' + C.bold('CHECKPOINTS') + '\n');
        rows.forEach((r, i) => {
          const when = String(r.at).replace('T', ' ').slice(0, 16);
          // STABLE MEANS A SUITE PASSED. Nothing else earns the word — a list
          // where everything says stable tells you nothing.
          const mark = r.stable ? C.green('✓ stable') : r.tests ? C.yellow('✗ failing') : C.dim('· untested');
          w('  ' + C.bold(String(i + 1).padEnd(3)) + mark + C.dim('  ' + when) + '\n');
          if (r.label) w('      ' + r.label + '\n');
          if (r.tests) w(C.dim(`      ${r.tests.passed} passed, ${r.tests.failed} failed`) + '\n');
          if (r.reason) w(C.dim('      ' + r.reason) + '\n');
          w(C.dim(`      ${r.files} files`
            + (r.config ? ` · config ${String(r.config).slice(0, 8)}` : '')
            + (r.v1 ? ` · V1 ${r.v1}` : '')) + '\n');
        });
        w(C.dim('\n  /backup restore <n> — explicit, and it checkpoints the current state first.') + '\n');
        return rows;
      };

      if (sub === 'list' || !rest) { show(); return; }

      if (sub === 'create' || sub === 'new') {
        const label = rest.slice(args[0].length).trim();
        w(C.dim('  copying the project…') + '\n');
        const r = B.create(app.session.cwd, { label, reason: 'asked for by you' });
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ checkpoint taken') + C.dim(`  ${r.row.files} files`) + '\n');
        // SAID PLAINLY: a checkpoint nobody tested is not a safe harbour, and
        // calling it one would be the whole failure this design exists to avoid.
        w(C.dim('    untested — run the suite, then /backup create again to record a stable one.') + '\n');
        return;
      }

      if (sub === 'restore') {
        const rows = B.list();
        const n = Number(args[1]);
        const row = rows[n - 1];
        if (!row) {
          w(C.yellow(`  There is no checkpoint ${args[1] || ''}.`) + C.dim(' /backup list') + '\n');
          return;
        }
        const r = B.restore(app.session.cwd, row.id);
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ restored')
          + C.dim(`  ${r.written} file(s) from ${String(row.at).replace('T', ' ').slice(0, 16)}`) + '\n');
        if (r.safety) w(C.dim('    the state before this restore is itself checkpoint 1.') + '\n');
        // WHAT WAS NOT TOUCHED. A restore never deletes, so files created since
        // the checkpoint are still there — saying so is the difference between a
        // restore you can trust and one you have to go and verify by hand.
        if (r.extra.length) {
          w(C.dim(`    ${r.extra.length} file(s) newer than the checkpoint were LEFT IN PLACE:`) + '\n');
          for (const f of r.extra.slice(0, 8)) w(C.dim('      ' + f) + '\n');
          if (r.extra.length > 8) w(C.dim(`      … ${r.extra.length - 8} more`) + '\n');
        }
        return;
      }

      w(C.dim('  /backup · /backup create [label] · /backup restore <n>') + '\n');
    },
  });

  /**
   * `/sessions` and `/resume` — sessions named by WHAT THEY WERE.
   *
   * Both listed and took raw ids, which are filenames: a timestamp plus four
   * random characters, saying nothing about the work. The implementation is in
   * resume.js, which also explains why `Session.resume(id)` remains the only path
   * that crosses a session boundary.
   */
  define('/sessions', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    args: '[text]',
    desc: 'List saved sessions by what they were (does not resume any)',
    run(app, ctx) { return require('./resume').listCommand(app, ctx, { C }); },
  });

  define('/resume', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[text | today | <n> | <id>]',
    desc: 'Browse recent sessions and restore one — no id to remember',
    run(app, ctx) { return require('./resume').runCommand(app, ctx, { C }); },
  });
}

module.exports = { register };
