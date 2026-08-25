'use strict';

/**
 * THE ONE FILESYSTEM GATE — may this call touch that path?
 *
 * Called from `tools/index.js:execute`, which is the single door every tool
 * call goes through. Putting it there rather than at each `resolve()` is the
 * whole point: there were six resolve sites across three files, and six places
 * to remember is one place to forget. A tool written tomorrow is covered
 * without its author knowing this exists.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT DO, deliberately:
 *
 *   NO COMMAND ALLOWLIST. An architecture guard forbids one, and it is right
 *     to: a list of permitted shell commands is either so short the shell is
 *     useless or so long it is decorative, and every entry is a promise about
 *     what a command means that the next flag breaks. What is gated is the
 *     DIRECTORY, which is a fact, not a guess about intent.
 *
 *   NO REWRITING. A refused call is refused and says so. It is never silently
 *     redirected somewhere safer, because a model that is lied to about where
 *     its file went writes the next one to the same wrong place.
 *
 *   NOTHING WHEN THERE IS NO APP. A turn run headless — a unit test, a piped
 *     one-shot — has no `app` to ask and no config to read, and gating it would
 *     make the whole tool surface untestable. That is not a hole: the gate is
 *     about asking a PERSON, and in that situation there is nobody there.
 */

const path = require('path');

const trust = require('./trust');

/** The argument names a tool uses for "a path on disk". */
const PATH_KEYS = ['path', 'file', 'dest', 'to', 'from', 'src'];

/** Every path this call names, absolute. */
function pathsIn(input, cwd) {
  const out = [];
  const i = input && typeof input === 'object' ? input : {};
  for (const k of PATH_KEYS) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) out.push(path.resolve(cwd, v));
  }
  return out;
}

/**
 * Is the model asking about the machine or about the project?
 *
 * @returns {Promise<{ok:boolean, output?:string}>}
 */
async function check(name, input, ctx, { mutates = false } = {}) {
  const app = ctx && ctx.app;
  const cwd = (ctx && ctx.cwd) || process.cwd();
  // NO APP, NO GATE. See the header — there is nobody to ask.
  if (!app || !app.cfg) return { ok: true };
  // ---- AND NO GATE WITHOUT A UI, WHICH IS THE SAME RULE -------------------
  //
  // The gate enforces a DECISION. On a pipe — `lain -p`, a one-shot, a test —
  // the trust question was never asked, because there was nobody to ask it. An
  // undecided directory would then refuse every read and every write, which is
  // not caution: it is punishing the user for a question the program never put
  // to them, and it would break every non-interactive run of LAIN.
  //
  // A person who typed `lain -p "fix the parser"` in a directory has said which
  // directory they mean about as plainly as it can be said.
  if (!app.ui || !app.ui.enabled) return { ok: true };

  const root = (app.session && app.session.cwd) || cwd;
  const targets = pathsIn(input, cwd);
  if (!targets.length) return { ok: true };

  for (const target of targets) {
    const verdict = trust.check({
      cfg: app.cfg,
      root,
      target,
      write: mutates,
      // THE MODE, FROM THE ONE PLACE THAT DERIVES IT. AUTO is allowed to say
      // yes outside the project, but never for a system or credential location
      // — trust.check enforces that whatever the mode is. See trust.NEVER_AUTO.
      mode: trust.modeOf(app.cfg),
    });
    if (verdict.ok) continue;

    // ---- ASK, IF THERE IS ANYONE TO ASK ----------------------------------
    if (verdict.ask) {
      let allowed = false;
      try {
        allowed = await require('./trustask').askOutside(app, {
          target, why: verdict.why, write: mutates,
        });
      } catch { allowed = false; }
      if (allowed) continue;
    }

    // ---- REFUSED, AND RECORDED -------------------------------------------
    //
    // On the list rather than only in this result, so `/permissions` can show
    // what has been turned down and let it be allowed afterwards. A refusal the
    // user never sees is one they cannot reconsider.
    try { require('./rejected').note(app, { tool: name, target, why: verdict.why, write: mutates }); } catch { /* the refusal still stands */ }

    return {
      ok: false,
      output: `refused: ${verdict.why || 'that path is outside what this session may touch'}`
        + `\n  ${target}`
        + '\n\nThe user can allow it with /permissions, or trust the directory with /trust.',
    };
  }
  return { ok: true };
}

module.exports = { check, pathsIn, PATH_KEYS };
