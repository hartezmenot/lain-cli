'use strict';

/**
 * `/runtime` — WHAT IS TRUE OUTSIDE THIS PROCESS.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION IT ANSWERS, and why nothing else could answer it.
 *
 * `/jobs` shows the work THIS LAIN started and is still watching. `/provider
 * status` shows what this process has learned about routes since it booted. Both
 * are honest and both are scoped to a process that may be thirty seconds old.
 *
 * The Guardian is not. It was running before this LAIN started and will be
 * running after it stops, and it holds the three facts that outlive a process:
 * which conversations are mid-something, what is still executing, and which
 * roads are shut. `/runtime` is the one screen where those are shown together,
 * as the runtime states them rather than as this process remembers them.
 *
 * ------------------------------------------------------------------------
 * IT IS ALSO THE FIRST CLIENT OF runtimefeed.js, and that is deliberate rather
 * than incidental. That module is the boundary a second surface will attach to —
 * `/dash` in a browser, a notifier somewhere else — and a boundary with no
 * caller is a boundary that is wrong in ways nobody has noticed. Having the
 * terminal go through it means the shape is exercised on every use, by the
 * surface whose bugs are cheapest to find.
 *
 * SAFE DURING A TURN. It reads; it starts nothing, sends nothing and cancels
 * nothing — see runtimefeed.js on why the verbs are absent from that boundary
 * entirely.
 */

const feed = require('./runtimefeed');

/** Rows per section. A briefing, not an inventory. */
const MAX_SESSIONS = 8;
const MAX_JOBS = 8;
const MAX_ROUTES = 6;
const MAX_EVENTS = 10;

function tok(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) { const k = v / 1000; return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`; }
  const m = v / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

function ago(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return '';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} ago`;
}

/** The word for a turn state, coloured by whether it needs somebody. */
function stateWord(s, C) {
  const w = s.effective_state || s.state || 'UNKNOWN';
  if (w === 'LOST' || w === 'PROVIDER_FAILED') return C.yellow(w);
  if (w === 'RATE_LIMITED') return C.yellow(w);
  if (w === 'COMPLETED') return C.green(w);
  if (w === 'CANCELLED' || w === 'IDLE') return C.dim(w);
  return C.cyan(w);
}

function register({ define, C }) {
  define('/runtime', {
    // MACHINERY: LAIN talking about itself. It goes to the command surface and
    // never into the conversation the model reads.
    surface: true,
    args: '',
    desc: 'What the runtime knows — conversations, workers and routes that outlive this process',
    async run(app) {
      const state = await feed.state();
      const w = (line) => app.render.write(`${line}\n`);

      if (!state.available) {
        // NOT AN ERROR. A machine with no supervisor running is a machine where
        // nothing has needed one yet, and saying so plainly is more useful than
        // an empty table that reads as "nothing is happening".
        w('');
        w(C.dim('  No runtime is answering on this machine.'));
        w(C.dim('  One starts when a turn begins, and keeps jobs, provider limits and'));
        w(C.dim('  undelivered input alive across restarts. Nothing is lost meanwhile —'));
        w(C.dim('  LAIN simply cannot be told what happened while it was not running.'));
        w('');
        return;
      }

      // ---- CONVERSATIONS -------------------------------------------------
      w('');
      w(C.bold('  CONVERSATIONS'));
      const sessions = (state.sessions || []).slice(0, MAX_SESSIONS);
      if (!sessions.length) w(C.dim('    none recorded'));
      for (const s of sessions) {
        const id = String(s.session || '').slice(-12);
        const mine = app.session && app.session.id === s.session ? C.cyan(' ← this one') : '';
        const u = s.usage || {};
        // CACHE ONLY WHEN THERE IS SOME. `⚡0` on every row of a session that
        // never hit a cache is a column of noise that trains the eye to skip
        // the one place it would have mattered.
        const cost = (u.input_tokens || u.output_tokens)
          ? C.dim(`  ↑${tok(u.input_tokens)}${u.cache_read_tokens ? ` ⚡${tok(u.cache_read_tokens)}` : ''}`
            + ` ↓${tok(u.output_tokens)}`)
          : '';
        w(`    ${stateWord(s, C)}  ${C.dim(id)}  ${s.model || C.dim('—')}${cost}${mine}`);
        // THE TWO THINGS THAT NEED A PERSON, said in full rather than counted.
        // A held sentence is the user's own words waiting to be delivered, and
        // burying it behind a number is how it stops being noticed.
        if (s.held_count > 0) {
          const held = (s.held || []).slice(-2)
            .map((h) => `"${String(h.text || '').replace(/\s+/g, ' ').slice(0, 60)}"`).join(', ');
          w(`      ${C.yellow('held')} ${s.held_count} message(s) — ${held}`);
        }
        if (s.needs_handover && s.handover_reason) {
          w(`      ${C.yellow('handover')} ${String(s.handover_reason).slice(0, 76)}`);
        }
        // A TURN RECORDED AS RUNNING BY A PROCESS THAT IS GONE. The one fact no
        // session file can hold, because a killed process writes nothing.
        if (s.effective_state === 'LOST') {
          w(`      ${C.yellow('lost')} recorded as ${s.state} by pid ${s.owner_pid}, which no longer exists`);
        }
      }

      // ---- WORKERS -------------------------------------------------------
      w('');
      w(C.bold('  WORKERS'));
      const jobs = (state.jobs || []).slice(0, MAX_JOBS);
      if (!jobs.length) w(C.dim('    nothing is running'));
      for (const j of jobs) {
        const st = j.state === 'completed' ? C.green('completed')
          : j.state === 'failed' ? C.yellow('failed')
            : j.state === 'running' ? C.cyan('running') : C.dim(j.state);
        const code = j.exit_code === null || j.exit_code === undefined ? '' : C.dim(`  exit ${j.exit_code}`);
        w(`    ${st}  ${C.dim(j.id)}  ${String(j.command || '').replace(/\s+/g, ' ').slice(0, 46)}${code}`);
      }

      // ---- ROUTES --------------------------------------------------------
      const shut = (state.providers || []).filter((p) => p
        && (p.limited_now || p.status === 'DISABLED' || p.status === 'MAINTENANCE'));
      if (shut.length) {
        w('');
        w(C.bold('  ROUTES THAT ARE SHUT'));
        for (const p of shut.slice(0, MAX_ROUTES)) {
          const who = [p.provider, p.id].filter(Boolean).join(' · ') || p.id;
          // NO INVENTED CLOCK. `resets_in_ms` is null when the provider never
          // said when, and "unknown reset" is the honest row — a made-up
          // countdown here is a number somebody would plan around.
          const when = p.limited_now
            ? (p.resets_in_ms === null || p.resets_in_ms === undefined
              ? C.dim('unknown reset')
              : C.dim(`clears in ${require('./ratelimit').human(p.resets_in_ms)}`))
            : C.dim(String(p.status).toLowerCase());
          w(`    ${C.yellow('●')} ${who}  ${when}`);
        }
      }

      // ---- WHAT HAPPENED WHILE NOBODY WAS LOOKING ------------------------
      //
      // The NOTABLE ones only — the events a person has a decision about. A
      // phase change is worth recording and would be noise here; see
      // runtimefeed.NOTABLE for where that line is drawn and why.
      const batch = await feed.since(0, { limit: 400 });
      const notable = (batch.notable || []).slice(-MAX_EVENTS);
      if (notable.length) {
        const now = Math.floor(Date.now() / 1000);
        w('');
        w(C.bold('  RECENTLY'));
        for (const e of notable) w(`    ${C.dim(ago(now - (e.at || now)).padStart(9))}  ${feed.headline(e)}`);
      }
      w('');
    },
  });
}

module.exports = { register, tok, ago, MAX_SESSIONS, MAX_JOBS, MAX_ROUTES, MAX_EVENTS };
