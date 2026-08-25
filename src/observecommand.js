'use strict';

/**
 * `/stop` AND `/observing` — stopping the BOT without stopping LAIN.
 *
 *: "Separate STOP BOT from STOP INVESTIGATION. These must not be the same
 * operation."
 *
 * ------------------------------------------------------------------------
 * THE THREE THINGS "STOP" COULD MEAN, and why they must not share a key.
 *
 *   STOP THE BOT            the thing being watched should stop moving. The
 *                           evidence is the point and is kept; LAIN is now
 *                           expected to look at it.
 *   STOP THE TURN           LAIN should stop working. Ctrl+C, and it already
 *                           means exactly that everywhere in the program.
 *   STOP LAIN               leave. `/exit`, and it saves the session.
 *
 * They were one key in every version of this the user has used elsewhere, which
 * is why "stop" during a bot run is frightening: it might end the run, or it
 * might end the investigation of the run — including everything collected so
 * far — and nothing on screen says which. So the bot gets its own word, and the
 * word says what survives.
 *
 * NOTHING HERE ANALYSES ANYTHING. It stops the child and hands the observation
 * to the model, which is the half that reads evidence. The command exists so
 * the USER can stop a run at the moment they see it go wrong, without having to
 * ask the model to do it and without waiting for a turn to come round.
 */

function register({ define, DURING_TURN, C }) {
  define('/stop', {
    // MACHINERY: about the run, not about the conversation. It goes to the
    // bottom surface and clears itself.
    surface: true,
    // NOT BLOCKED DURING A TURN, and that is the whole point of it. The moment
    // a person most needs to stop a bot is while LAIN is mid-turn watching it;
    // a command that waits for the turn to end would arrive after the thing it
    // was meant to prevent. It touches only the child process and the
    // observation's own state — never the session, the plan or the messages —
    // so there is nothing for a turn in flight to lose.
    duringTurn: DURING_TURN.SAFE,
    desc: 'Stop the observed run — LAIN keeps the evidence and keeps working',
    run(app, { rest } = {}) {
      const w = (s) => app.render.write(s);
      const yard = app._observatory;
      const obs = yard && yard.current;
      if (!obs || !obs.running) {
        w(C.dim('  Nothing is being observed. ') + C.dim('Ctrl+C stops the turn; /exit leaves LAIN.\n'));
        return;
      }
      const observe = require('./observe');
      if (obs.job && typeof obs.job.cancel === 'function' && !obs.job.done) {
        try { obs.job.cancel('you stopped the run'); } catch { /* already gone */ }
      }
      observe.finish(obs, String(rest || '').trim() || 'you stopped it');
      const s = obs.summary();
      w('\n' + C.green('  RUN STOPPED') + C.dim(`  ${obs.command}\n`));
      w(C.dim(`  ${Math.round(s.elapsedMs / 1000)}s · ${s.events} event(s) · ${s.captures} capture(s) kept.\n`));
      // SAID EXPLICITLY, because the fear this command answers is that stopping
      // throws the work away.
      w(C.dim('  The investigation is still open and every piece of evidence is kept.\n'));
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  define('/observing', {
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'What is being watched right now, and what has been collected',
    run(app) {
      const w = (s) => app.render.write(s);
      const yard = app._observatory;
      const obs = yard && (yard.current || yard.past[yard.past.length - 1]);
      if (!obs) { w(C.dim('  Nothing has been observed in this session.\n')); return; }
      const s = obs.summary();
      w('\n' + C.bold(`  ${s.state}`) + C.dim(`  ${s.command}\n`));
      w(C.dim(`  ${Math.round(s.elapsedMs / 1000)}s · ${s.lines} line(s) · ${s.events} event(s) · `
        + `${s.captures} capture(s)${s.capturesRefused ? `, ${s.capturesRefused} refused` : ''}\n`));
      if (s.expectation.length) {
        w('\n' + C.dim('  EXPECTED\n'));
        s.expectation.forEach((e, i) => w(C.dim(`    ${i + 1}. ${e}\n`)));
      }
      if (s.kinds.length) {
        w('\n' + C.dim('  SEEN\n'));
        for (const k of s.kinds) w(C.dim(`    ${k.kind} ×${k.n}\n`));
      }
      // WHAT IS CURRENTLY HELD DOWN belongs here more than anywhere: a bot that
      // was stopped while a key was down leaves a keyboard that does not work,
      // and the person needs to know which key rather than to discover it.
      const held = require('./heldkeys').list();
      if (held.length) {
        w('\n' + C.yellow('  KEYS STILL HELD\n'));
        for (const h of held) w(C.yellow(`    ${h.key}`) + C.dim(` — ${Math.round(h.heldMs / 1000)}s\n`));
      }
      if (obs.running) w('\n' + C.dim('  /stop ends the run and keeps everything.\n'));
    },
  });
}

module.exports = { register };
