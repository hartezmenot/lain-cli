'use strict';

/**
 * WHAT GOES INTO EVERY REQUEST — assembled in one place, out of app.js.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS ITS OWN FILE.
 *
 * `app.js` is the REPL shell: it reads input, decides command-versus-content,
 * keeps one task identity and runs the turn. What is IN a request changes for
 * entirely different reasons — a new kind of durable state to carry, a
 * different handover packet, a project brief that learns something new — and a
 * file that owns both grows for two unrelated reasons at once. That is exactly
 * how V1's equivalent reached 17,511 lines.
 *
 * NOTHING MOVED BUT THE ADDRESS. This is the method that was on App, with
 * `this` replaced by `app` and nothing else changed: same order, same sources,
 * same comments explaining why each piece is here. `prompt.js` still composes
 * the text; this only decides what it is given.
 *
 * IT EXPORTS A PLAIN FUNCTION OVER AN `app`, and therefore has no object to be
 * the `this` of. See tests/unit/architecture.test.js on why that matters: the
 * last two splits of this kind each shipped a bug where a `this` or a bare
 * imported name survived the move.
 */

const providerMod = require('./provider');
const prompt = require('./prompt');

function build(app) {
  const pc = providerMod.resolve({ ...app.cfg, _evidence: app.connectionEvidence });
  let sys = prompt.build({
    cwd: app.session.cwd, platform: process.platform, model: pc.model,
    // The workflow this request implies — what to do FIRST. Costs nothing:
    // it was decided locally when the input arrived.
    mode: app.session.mode,
    // What is already established: decisions, files touched, the last check,
    // what has been read. See prompt.workingContext.
    session: app.session,
    // THE ONLY SOURCE THAT CAN CONTRADICT THE PREVIOUS MODEL. When the turn
    // being started is a handover — a different model, or a turn that died —
    // prompt.build re-measures the checkpoints against disk rather than
    // repeating what the tools reported. See handover.js.
    checkpoints: app.checkpoints,
    // Work the supervisor owns, which no amount of reading the session or the
    // transcript would recover — it may have finished while LAIN was not
    // running. Cached; see refreshSupervisedJobs.
    jobs: app._supervisedJobs || [],
    // WHICH ROUTES ARE SHUT, from the same place and for the same reason: a
    // handover is very often caused by a rate limit, so the model taking over
    // must not plan around a road that is closed. Cached; see
    // providerhealth.refresh.
    providers: app._supervisedProviders || [],
    // WHY THIS TURN IS A RECOVERY, when it is — set for one turn by
    // inputgate.js. It carries the two things the session file cannot: what
    // the runtime OBSERVED about the failure, and the sentences the person
    // typed that never reached a model. Without it a handover is inferred
    // from `session.turns`, which is blind to the case that matters most: a
    // process that died mid-turn wrote no ending, so the transcript reads as
    // a turn still happily in flight.
    runtime: app._handover || null,
  });
  // Built ONCE per session and capped. Orientation, not an index — the model
  // has list_dir, read_file and a shell for anything deeper.
  if (app._projectBrief === undefined) {
    try { app._projectBrief = require('./project').brief(app.session.cwd); } catch { app._projectBrief = ''; }
  }
  if (app._projectBrief) sys += `\n\n# This project\n${app._projectBrief}`;
  // ---- THE STANDING GOAL, BEFORE THE PLAN -------------------------------
  //
  // ORDER IS THE ARGUMENT: a goal is what the user is trying to achieve and a
  // plan is one strategy for reaching it, so the strategy reads under the thing
  // it serves. Marked as DIRECTION rather than as this turn's request — a model
  // handed a goal as an instruction starts working on the goal, which is almost
  // always far larger than the sentence the person just typed. See src/goal.js.
  const goalText = require('./goal').forPrompt(app.session);
  if (goalText) sys += `\n\n# Goal\n${goalText}`;
  // ONLY this session's plan can ever reach the prompt: it is a field on this
  // session object, so there is no other plan it could pick up.
  if (app.session.plan) sys += `\n\n# Plan (this session)\n${app.session.plan.digest()}`;
  return sys;
}

module.exports = { build };
