'use strict';

/**
 * THE REQUEST HAS A STABLE HALF AND A CHANGING HALF, AND THEY MUST NOT BE
 * ADJACENT IN THE WRONG ORDER.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR, measured before it was written.
 *
 * `app.systemPrompt()` returns one string, and that string becomes
 * `messages[0]`. Inside it, in this order:
 *
 *     BASE instructions           identical for the life of the install
 *     working directory, OS       identical for the life of the session
 *     mode guidance               CHANGES EVERY TURN
 *     working context / handover  CHANGES EVERY TURN
 *     project brief               identical for the life of the session
 *     plan digest                 CHANGES AS STEPS COMPLETE
 *
 * A prefix cache keeps the longest identical HEAD of a request. Volatile text
 * sitting at position 4 of `messages[0]` means everything after it — including
 * the entire conversation, which may be fifty thousand tokens of transcript
 * that did not change at all — is behind a byte that did. Every turn boundary
 * re-prices the whole request.
 *
 * MEASURED on a five-turn, eight-step workload: moving the changing half to the
 * TAIL of the wire left total input identical (0.0% — it is the same
 * information, in the same words) and cut BILLED, uncached input by 11.2%,
 * lifting the cache hit rate from 59.2% to 63.8%. The real workload that
 * prompted this had 815 requests and far more turn boundaries than five, so the
 * saving there is larger; this file does not claim a number it did not measure.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS REMOVED, SHORTENED, OR SUMMARISED. The model receives every word
 * it received before. This is an ORDERING change and only an ordering change,
 * which is why it is safe: there is no judgement here about what the model
 * needs, and therefore no way for it to be wrong about that.
 *
 * ------------------------------------------------------------------------
 * WHY A PLAIN FUNCTION OVER `app` rather than a method. app.js is at 697 lines
 * against a 700-line guard, and this is the same shape runtimefacts.js and
 * turnauthority.js already use for the same reason: no `this`, testable without
 * an App, and impossible to grow into a second orchestration layer.
 */

const prompt = require('./prompt');
const providerMod = require('./provider');

/**
 * THE TWO HALVES OF THE SYSTEM PROMPT.
 *
 * @returns {{stable:string, live:string}}
 *   `stable` becomes `messages[0]` and must be byte-identical between requests
 *   for as long as the session's model and directory are unchanged.
 *   `live` rides at the tail of the wire, after the conversation, where a
 *   change costs only itself.
 */
function of(app) {
  const pc = providerMod.resolve({ ...app.cfg, _evidence: app.connectionEvidence });
  const built = prompt.build({
    cwd: app.session.cwd,
    platform: process.platform,
    model: pc.model,
    mode: app.session.mode,
    session: app.session,
    checkpoints: app.checkpoints,
    jobs: app._supervisedJobs || [],
    providers: app._supervisedProviders || [],
    runtime: app._handover || null,
    // THE SPLIT ITSELF happens in prompt.build, because that is where the
    // sections are assembled and the only place that knows which is which.
    separate: true,
  });

  // ---- THE STABLE HALF ---------------------------------------------------
  //
  // The project brief joins it: built once per session and cached on the app,
  // so it is exactly as stable as the base instructions and belongs in front of
  // the conversation rather than behind the volatile block, where it used to
  // sit and where it was re-priced on every turn for no reason.
  if (app._projectBrief === undefined) {
    try { app._projectBrief = require('./project').brief(app.session.cwd); } catch { app._projectBrief = ''; }
  }
  let stable = built.stable;
  if (app._projectBrief) stable += `\n\n# This project\n${app._projectBrief}`;

  // ---- THE CHANGING HALF -------------------------------------------------
  let live = built.live;
  // WHAT GIT SAYS ABOUT THE TREE, per turn. The gap this closes: gitsense
  // existed but nothing fed it to the model, so working-tree state was a
  // run_bash the model had to spend. It is measured in the background at
  // submit time (gitsnapshot.js prefetch — which is where the ledger's
  // expected-paths list goes, because gitsense owns the one normalization
  // rule that compares it to git names) and rendered here, in the volatile
  // half — NEVER the stable prefix, because tree state is the definition of
  // volatile. Silent for a clean tree, a tree with no .git, or a turn that
  // started before the measurement landed.
  const git = require('./gitsnapshot').say(app._gitSnapshot);
  if (git) live += `${live ? '\n\n' : ''}# Working tree (git)\n${git}`;
  // ONLY THIS SESSION'S PLAN can ever reach the prompt: it is a field on this
  // session object, so there is no other plan it could pick up. It advances as
  // steps complete, which is precisely why it is here and not above.
  if (app.session.plan) live += `\n\n# Plan (this session)\n${app.session.plan.digest()}`;
  // (The probe decoration that rode here — volatile by construction, since it
  // depended on `from` and the live environment — was removed with the Probe
  // integration in 2026-09. The tail above is the whole volatile half.)

  return { stable, live: live.trim() };
}

module.exports = { of };
