'use strict';

/**
 * THE REPORT COMMANDS — read something and say what is true of it.
 *
 * Split out of commands.js, which had grown past the god-object guard again
 * when `/stop` and `/observing` arrived. The seam is the one the other command
 * files already draw: commands.js owns the REGISTRY, the dispatcher and the
 * during-a-turn rules; a family of commands with one subject owns a file.
 *
 * THE SUBJECT HERE IS A READING. Every command below inspects something —
 * this project, another version of it, LAIN itself, the machine LAIN is running
 * on — and writes what it found. None of them changes anything, which is what
 * lets them all be safe during a turn, and none of them owns its own analysis:
 * the work is in compare.js, audit.js, projecthealth.js, health.js and
 * diagnose.js, and these are the doors.
 *
 * `/troubleshoot` is NOT here, deliberately. It reads like a report command and
 * is not one: it starts a model turn of its own, so it is BLOCKED during a turn
 * and its output belongs to the task rather than to the machinery. It stays in
 * commands.js next to the other things that start work.
 */

/**
 * @param {object} api  { define, C, config } — the registry's vocabulary,
 *                      passed in rather than imported back. A require of
 *                      commands.js from here would be a second dispatch path.
 */
function register({ define, C, config }) {
  /**
   * WHAT SURVIVED THE REWRITE, AND WHAT QUIETLY DID NOT.
   *
   * Not a diff. A diff of two versions of a program that was deliberately
   * rebuilt is noise — every file differs. This compares CAPABILITIES, detected
   * from evidence in both trees by one symmetric probe set (see compare.js),
   * and says which survived, which are done differently, and which went
   * missing.
   *
   * `add` does not copy code. It hands the capability to the ordinary task loop
   * as a request, with the old implementation named as reading material —
   * deciding how something should look in THIS architecture is work, and work
   * belongs to the model with real tools, not to a report generator.
   */
  define('/compare', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    args: '[<folder|github-url> | add <capability>]',
    desc: 'Compare this project against another version, capability by capability',
    run(app, ctx) { return require('./compare').runCommand(app, ctx, { C, config }); },
  });

  /**
   * READ THIS PROJECT BEFORE CHANGING IT.
   *
   * A plain-language, evidence-based reading of the current project —
   * structure, how it runs, what it can already do, what looks unfinished, and
   * where the work stands. Read-only, which is what lets it be the safe first
   * move on a codebase nobody in the room knows.
   *
   * With a source argument it IS `/compare` — "read this" and "read it against
   * that" are one door, and the comparison lives in exactly one place.
   */
  define('/audit', {
    surface: true,
    flashMs: 0,
    args: '[<folder|github-url>]',
    desc: 'Read this project (or compare it to another) before changing anything',
    run(app, ctx) { return require('./audit').runCommand(app, ctx, { C, config }); },
  });

  /**
   * TWO HEALTH QUESTIONS, TWO COMMANDS. They were one, and the one answered the
   * wrong question: running `/health` inside a project reported LAIN's provider,
   * context window and connections — true, and about the tool rather than the
   * work. "Is my project healthy?" and "is LAIN ready?" are asked by the same
   * person for different reasons and must never be collapsed.
   *
   *   /health  THE PROJECT — structure, code health, work state, graded findings
   *   /ready   LAIN ITSELF — RC readiness: stable, wired, missing, excluded
   *
   * `/ready` WAS `/rc`, AND THE RENAME IS NOT COSMETIC. `/rc` now means REMOTE
   * CONTROL — a Telegram bot answered by a local model over the runtime — which
   * is what somebody typing those two letters is overwhelmingly looking for.
   * The readiness report is unchanged: same engine, same output, new name. The
   * invariant the old tests protected still holds and is still tested — remote
   * control and readiness are two different commands with two different engines,
   * and neither is an alias of the other.
   */
  define('/health', {
    surface: true,
    flashMs: 0,
    args: '[folder]',
    desc: 'Is THIS project healthy? Structure, code health, work state, next action',
    run(app, ctx) { return require('./projecthealth').runCommand(app, ctx, { C }); },
  });

  define('/ready', {
    surface: true,
    flashMs: 0,
    desc: 'Is LAIN ready? RC-readiness for the CLI itself (not the project)',
    run(app, ctx) { return require('./health').runCommand(app, ctx, { C }); },
  });

  /**
   * WHY DID THAT COST SEVEN REQUESTS?
   *
   * A count answers "how many"; this answers "why", which is the only version
   * of the question you can act on. Every request that reached the wire is
   * listed with the turn and step it belongs to and the REASON the caller gave
   * for making it (see reqtrace.js), so a tool loop of seven model steps reads
   * as seven model steps — and the same step asked twice reads as a defect
   * instead of hiding inside the total.
   *
   * MEASURED, NOT ESTIMATED. Every row here is one HTTP request that really
   * happened, timed at the socket. Nothing is inferred and nothing is invented:
   * a turn with no rows says so rather than showing a plausible zero.
   */
  define('/requests', {
    surface: true,
    flashMs: 0,
    desc: 'Every provider request this session made, with the reason for each',
    run(app) {
      const reqtrace = require('./reqtrace');
      const rows = reqtrace.all();
      app.render.write('\n' + C.bold('Provider requests') + '\n');
      if (!rows.length) {
        app.render.write('  ' + C.dim('none yet — no request has reached the wire this session') + '\n');
        return;
      }
      const turns = (app.session.turns || []).map((t) => t.turnId).filter(Boolean);
      for (const id of turns) {
        const e = reqtrace.explain(id);
        if (!e) continue;
        const flag = e.duplicated ? C.yellow(`  ⚠ ${e.duplicated} repeated step(s)`) : '';
        app.render.write(`\n  ${C.bold(id)}  ${e.requests} request(s) · ${e.steps} model step(s)${flag}\n`);
        for (const r of e.rows) {
          const mark = r.ok === null ? '·' : r.ok ? '✓' : '✗';
          const where = r.step == null ? '' : ` step ${r.step}`;
          const why = r.ok === false ? `  ${C.red(r.failure.slice(0, 60))}` : '';
          app.render.write(`    ${mark} ${r.id.padEnd(5)} ${r.reason.padEnd(17)}${where.padEnd(8)} ${String(r.ms).padStart(6)}ms${why}\n`);
        }
      }
      // Requests with no turn are the machinery: catalog discovery, a review.
      const loose = rows.filter((r) => !r.turn);
      if (loose.length) {
        app.render.write(`\n  ${C.bold('not part of a turn')}\n`);
        for (const r of loose) {
          app.render.write(`    ${r.ok === false ? '✗' : '✓'} ${r.id.padEnd(5)} ${r.reason.padEnd(17)}${String(r.ms).padStart(6)}ms\n`);
        }
      }
    },
  });

  /**
   * WHAT NOTHING REACHES — the capability the design names as missing.
   *
   * Built on the SAME reference machinery `symbols` and `dependents` use (see
   * deadcode.js): no parser, no index, no second idea of what a reference is.
   *
   * IT NEVER SAYS "DELETE THIS". Every row carries how sure it is and the
   * evidence behind it, because a name can be reached by a dynamic require, by
   * a string in a config, or by a consumer outside this tree — and a report
   * that is confidently wrong about that costs somebody an afternoon.
   */
  define('/deadcode', {
    surface: true,
    flashMs: 0,
    args: '[all]',
    desc: 'Find code nothing reaches — graded, with the evidence',
    run(app, { args } = {}) {
      const dead = require('./deadcode');
      const w = (s) => app.render.write(s);
      const all = String(args[0] || '').toLowerCase() === 'all';
      w('\n' + C.bold('  Reading every reference in this tree…') + '\n');
      const r = dead.sweep(app.cwd, {});
      // THE CONFIDENT ONES FIRST AND ALONE, unless asked otherwise. Two hundred
      // rows of "this export is unused" is how the six that matter get missed.
      const rows = all ? r.findings : r.findings.filter((f) => f.confidence === dead.CONFIDENCE.CONFIRMED);
      if (!rows.length) {
        w(C.green('  Nothing unreachable was found.')
          + C.dim(` ${r.looked} exported name(s) across ${r.modules} module(s).\n`));
        return;
      }
      w(C.dim(`  ${r.looked} exported name(s) across ${r.modules} module(s)`)
        + C.dim(all ? '\n' : ` · ${r.findings.length - rows.length} lower-confidence row(s) hidden — /deadcode all\n`));
      for (const f of rows) {
        const colour = f.verdict === dead.VERDICT.UNREFERENCED ? C.yellow : C.dim;
        w('\n  ' + colour(f.verdict) + '  ' + C.bold(`${f.module} · ${f.name}`) + '\n');
        w(C.dim(`      ${f.why}\n`));
        for (const t of f.testRefs.slice(0, 2)) w(C.dim(`      test: ${t.file}:${t.line}\n`));
      }
      if (r.truncated) w(C.dim(`\n  stopped after ${r.looked} names — there are more\n`));
    },
  });

  /** The environment report. The checks themselves live in diagnose.js. */
  define('/doctor', {
    surface: true,
    flashMs: 0,
    desc: 'Check the environment LAIN is running in',
    run(app) {
      app.render.write('\n' + C.bold('Doctor') + '\n');
      for (const c of require('./diagnose').checks(app)) {
        app.render.write((c.ok ? C.green('  ✓ ') : C.yellow('  ⚠ ')) + c.text + '\n');
      }
      // ARCHITECTURE vs DISK, re-measured now — one of the four places
      // reconciliation is allowed to run (session start, here, explicit
      // inspection, handover), and the one a person asks for when something
      // looks wrong. Silent when no architecture is recorded: a doctor that
      // lectures every project about a layer it never populated is noise.
      const root = app.session ? app.session.cwd : process.cwd();
      const lainstore = require('./lainstore');
      if (lainstore.has(root, 'architecture')) {
        const reconcile = require('./reconcile');
        const { model, report } = reconcile.run(root);
        for (const l of reconcile.say(model, report).split('\n')) {
          if (l.trim()) app.render.write((/discrepanc|MISSING|DAMAGED|DRIFTED/i.test(l) ? C.yellow('  ⚠ ') : C.dim('  · ')) + l + '\n');
        }
      }
    },
  });
}

module.exports = { register };
