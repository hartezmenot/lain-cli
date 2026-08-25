'use strict';

/**
 * `/session` — EVERY LAIN ON THIS MACHINE, NOT JUST THIS ONE.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION IT ANSWERS, and why no existing screen could answer it.
 *
 * `/status` is this process. `/sessions` is the transcripts on disk. Neither
 * can see the LAIN running in another terminal on another project — and that is
 * the question a person actually has after leaving three of them working:
 * which ones are still going, which finished, which broke.
 *
 * The runtime can see all of them, because every one of them reports to it.
 *
 * ------------------------------------------------------------------------
 * IT DRAWS WHAT THE RUNTIME SAYS AND COMPUTES NOTHING.
 *
 * The text comes from `capability::run("session.list")` in the supervisor — the
 * SAME call, returning the SAME string, that answers `/session` sent to the
 * Telegram bot. There is no formatting here, no status derivation, no second
 * idea of what RUNNING means. §20: one runtime, several windows, and a window
 * that recomputed the view would be a second runtime wearing a hat.
 *
 * ------------------------------------------------------------------------
 * A PERCENTAGE APPEARS ONLY WHERE SOMETHING COUNTED ONE. That rule is enforced
 * where the number is stored, not here — see `Progress` in guardian.rs, which
 * refuses to hold a figure with no stated source.
 */

const rc = require('./remotecontrol');

function register({ define, C }) {
  define('/session', {
    // MACHINERY: about the runtime rather than about the work.
    surface: true,
    flashMs: 0,
    args: '[n|name]',
    desc: 'Every LAIN session the runtime knows — running, finished, blocked',
    async run(app, ctx) {
      const w = (line) => app.render.write(`${line}\n`);
      const want = String((ctx.rest || '').trim());

      // A NUMBER IS A POSITION IN THE LISTING, not an identity. The runtime
      // holds no display index, so the listing is fetched and counted along —
      // the same resolution the Telegram side does, for the same reason.
      let args = {};
      let name = 'session.list';
      if (want) {
        name = 'session.get';
        const n = Number(want);
        if (Number.isInteger(n) && n > 0) {
          const list = await rc.capability('session.list');
          const rows = (list.result && list.result.sessions) || [];
          const row = rows[n - 1];
          if (!row) {
            w('');
            w(C.yellow(`  There is no session ${n}.`));
            w(C.dim('  Run /session for the list.'));
            w('');
            return;
          }
          args = { session: row.session };
        } else {
          args = { session: want };
        }
      }

      const r = await rc.capability(name, args);
      if (!r.available) {
        // NOT AN ERROR. A machine with no supervisor is a machine where nothing
        // has needed one yet, and saying so beats an empty table that reads as
        // "nothing is happening".
        w('');
        w(C.dim('  No runtime is answering on this machine.'));
        w(C.dim('  One starts when a turn begins, and from then on it knows every LAIN'));
        w(C.dim('  session on this machine — including the ones in other terminals.'));
        w('');
        return;
      }

      w('');
      for (const line of String(r.text || '').split('\n')) {
        // THE RUNTIME'S OWN WORDS, indented and coloured — never rewritten.
        // Colour is applied to the STATE WORDS only, which is presentation;
        // changing what any of them says would make this a second opinion.
        w(`  ${paint(line, C)}`);
      }
      if (!want) {
        w('');
        w(C.dim('  /session <n>  one of them in detail'));
      }
      w('');
    },
  });
}

/** The state vocabulary from guardian.rs, coloured. Words only, never meaning. */
const COLOURS = Object.freeze({
  RUNNING: 'cyan',
  COMPLETED: 'green',
  FAILED: 'yellow',
  INTERRUPTED: 'yellow',
  RATE_LIMITED: 'yellow',
  BLOCKED: 'yellow',
  WAITING: 'yellow',
  IDLE: 'dim',
  UNKNOWN: 'dim',
});

function paint(line, C) {
  for (const [word, colour] of Object.entries(COLOURS)) {
    // Word-boundaried so `RATE_LIMITED` is not painted twice by `LIMITED`, and
    // so a project called "Running Costs" is left alone.
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(line)) return line.replace(re, (m) => (C[colour] ? C[colour](m) : m));
  }
  return line;
}

module.exports = { register, paint, COLOURS };
