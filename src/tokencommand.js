'use strict';

/**
 * `/token` — WHAT THIS CONVERSATION HAS COST, AND WHAT IT IS MADE OF.
 *
 * Split out of commands.js, which had reached the god-object guard. The seam is
 * the one routecommands.js, sessioncommands.js and jobcommands.js already draw:
 * commands.js owns the REGISTRY and the rules about what may run during a turn;
 * a family of commands that share a subject owns its own file.
 *
 * ------------------------------------------------------------------------
 * THE HEADER CARRIES ONE NUMBER AND THIS CARRIES THE REST.
 *
 * The permanent row shows the OUTPUT TOKENS OF THE RESPONSE IN FRONT OF YOU,
 * because that is the figure that moves and the one that proves the model is
 * still writing. Every other token question — what the session has cost, how
 * much of the window is occupied, whether caching is working, why the last
 * request was so large — is asked occasionally, and is answered here.
 */

const { C } = require('./render');

/** A literal newline, written this way for the reason commands.js states. */
const EOL = String.fromCharCode(10);

function register({ define }) {
  /**
   * `/tokens` — WHERE THE INPUT WENT, for the requests this turn actually made.
   *
   * THE CONDITION THIS EXISTS FOR was reported as requests of 325,000-343,000
   * input tokens against a few hundred output, exhausting a rate limit in
   * minutes. Nothing inside LAIN could say why: `usage.inputTokens` is one number
   * handed back after the fact, and it cannot tell a system prompt from a tool
   * schema from the ninth replay of a file read an hour ago.
   *
   * So token growth is now EXPLAINABLE rather than merely observable. The
   * breakdown is measured at the one place the transmitted array exists
   * (contextfit.js) and kept on the turn record; this reads it back.
   */
  const EOL = String.fromCharCode(10);

  /**
   * `/token` — THE WHOLE OF THE TOKEN ACCOUNTING, on demand.
   *
   * ------------------------------------------------------------------------
   * THE HEADER CARRIES ONE NUMBER AND THIS CARRIES THE REST.
   *
   * The permanent row shows the OUTPUT TOKENS OF THE RESPONSE IN FRONT OF YOU,
   * because that is the figure that moves and the one that proves the model is
   * still writing. Every other token question — what the session has cost, how
   * much of the window is occupied, whether caching is working, why the last
   * request was so large — is asked occasionally and answered here.
   *
   * SINGULAR, `/token`, at the user's instruction. It was `/tokens`.
   *
   * THREE SECTIONS, AND THE ORDER IS A DECISION. The panel shows about a
   * dozen rows before it scrolls, so what sits above the fold is what somebody
   * gets for typing this:
   *
   *   1. THE CONTEXT WINDOW  two rows: how much of it this conversation
   *                          occupies, read from ui/projection.js
   *                          `contextUsage` — the SAME function the header used
   *                          before this number moved here, so there is one
   *                          computation and not two.
   *   2. THE LAST REQUESTS   src/tokenaudit.js — what the request that just
   *                          went out was actually made of, which is the only
   *                          thing that answers "why was that so big".
   *   3. THE SESSION LEDGER  ui/tokenview.js — every figure labelled MEASURED,
   *                          ESTIMATED, PENDING or UNKNOWN, so a provider's
   *                          silence is never drawn as a zero. The longest and
   *                          the least urgent, so it is what you scroll to.
   */
  define('/token', {
    flashMs: 0,
    surface: true,
    desc: 'The full token account: session totals, context occupancy, and what the last requests carried',
    run(app) {
      const w = (s) => app.render.write(s);
      const turns = (app.session && app.session.turns) || [];

      // ---- 1. HOW MUCH OF THE WINDOW IS OCCUPIED --------------------------
      //
      // Two rows, and they go first because they are the two rows somebody
      // reads and then closes the panel. It used to be on the header
      // (`42k/128k`) and it is a genuinely useful number — the one that decides
      // whether the next long paste forces a compaction. It is not a number
      // that MOVES, which is what a permanent row needs, so it lives here.
      //
      // ESTIMATED, and it says so: `contextChars` over the pessimistic
      // `CHARS_PER_TOKEN` src/session.js compacts against, so the figure a
      // person reads and the figure that acts cannot disagree.
      try {
        let pc = {};
        try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
        const ctx = require('./ui/projection').contextUsage(app, pc);
        w(EOL + C.bold('Context window') + C.dim('  — estimated; what a new request would carry') + EOL);
        if (ctx) {
          const pct = Math.round((ctx.used / ctx.window) * 100);
          w(`  ${ctx.used.toLocaleString('en-US')} of ${ctx.window.toLocaleString('en-US')} tokens  ${C.dim(`(${pct}%)`)}` + EOL);
        } else {
          w(C.dim('  unknown — this route states no context length, so there is no denominator' + EOL));
        }
        // ---- WHAT THE LAST COMPACTION KEPT ------------------------------
        //
        // THE DETAIL THE TRANSIENT NOTICE NO LONGER CARRIES. Auto-compaction
        // used to print its whole account over the conversation - what it
        // elided, and a `kept:` line naming the objective, the user's own
        // corrections, the plan and the last check. That is a reassurance a
        // person wants ONCE, when they go looking, and `/token` is where they
        // go looking. The notice is one line now (src/contextfit.js).
        //
        // It is a statement about the session AS IT NOW STANDS, checked against
        // the live objects rather than remembered from the moment of the fold -
        // so it cannot claim to have kept a plan that has since been retired.
        const kept = require('./continuity').compactionSummary(app.session).kept;
        if (kept.length) w(C.dim('  kept through compaction: ' + kept.join(' · ') + EOL));
      } catch { /* the sections below still stand */ }

      // ---- 2. WHERE THE LAST REQUEST'S INPUT WENT -------------------------
      //
      // THE CONDITION `/token` EXISTS FOR, and the reason this is the second
      // section rather than the last: 325,000-343,000 input tokens against a
      // few hundred output, exhausting a rate limit in minutes, and nothing
      // inside LAIN able to say of WHAT. `usage.inputTokens` is one number
      // handed back after the fact; it cannot tell a system prompt from a tool
      // schema from the ninth replay of a file read an hour ago.
      //
      // The panel shows about a dozen rows before it scrolls, so what is put
      // above the fold is a decision rather than an ordering. This and the
      // context figure are what somebody types `/token` to find out.
      //
      // The finished turn's record is what the session keeps; a turn still in
      // flight has not been appended yet, which is why this reads the last
      // COMPLETED one rather than reaching into a running turn's state.
      const audits = (turns.length && turns[turns.length - 1].audits) || [];
      w(EOL + C.bold('Token accounting') + C.dim('  — estimated from characters; see src/tokenaudit.js') + EOL);
      if (!audits.length) {
        w(C.dim('  no request has been measured yet in this session.' + EOL));
      } else {
        const ta = require('./tokenaudit');
        // THE LAST FEW, NEWEST LAST, because the question is always about the
        // request that just happened and how it compares with the one before.
        for (let i = 0; i < audits.length; i++) {
          for (const line of ta.report(audits[i], { n: i + 1 })) w(C.dim('  ' + line) + EOL);
          w(EOL);
        }
        const last = audits[audits.length - 1];
        // AMPLIFICATION, MEASURED NOT ENFORCED: real provider requests the
        // session made per turn it recorded. A turn that needed N attempts
        // (retries, post-413 folds) shows here as N, because each attempt was
        // admitted and closed as its own request.
        const turnsAll = turns.filter((x) => x.usage && x.usage.requests > 0);
        if (turnsAll.length) {
          const reqs = turnsAll.reduce((a, x) => a + x.usage.requests, 0);
          const steps = turnsAll.reduce((a, x) => a + (x.steps || 1), 0);
          w(C.dim(`  amplification: ${reqs} request(s) over ${turnsAll.length} turn(s), ${steps} model step(s)`)
            + (reqs > steps ? C.yellow(` — ${reqs - steps} retry/fold attempt(s)`) : '') + EOL);
        }
        if (last && last.overBudget) {
          w('  ' + C.yellow('this request was over budget and was compacted before it was sent') + EOL);
        }
      }

      // ---- 3. THE SESSION LEDGER ------------------------------------------
      //
      // Every figure labelled MEASURED, ESTIMATED, PENDING or UNKNOWN, so a
      // provider's silence is never drawn as a zero — see ui/tokenview.js, and
      // the 59-million-token incident in its header. It is the longest section
      // and the least urgent, which is why it is last and scrolled to.
      //
      // THIS IS WHERE THE `tokens` PANE WENT. It was one of the nine workspace
      // panes and the only one of them with no command, which is how "what has
      // this session actually cost" came to be a question with no door.
      const ui = app.ui || {};
      for (const line of require('./ui/tokenview').render({
        usage: (app.session && app.session.usage) || null,
        live: ui.liveUsage || null,
        audit: ui.lastAudit || null,
        requests: (app.session && app.session.usage && app.session.usage.requests) || 0,
        open: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
        model: app.cfg.model || '',
        width: (app.render && app.render.width) || 80,
      })) w(line + EOL);
    },
  });
}

module.exports = { register };
