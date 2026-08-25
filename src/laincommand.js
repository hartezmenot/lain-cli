'use strict';

/**
 * `/lain` — WHAT THE PROJECT REMEMBERS ABOUT ITSELF.
 *
 * The `.lain/` directory is the layer that survives compaction, clears, model
 * switches and restarts: the intended architecture, the wiring, the
 * vocabulary, the verified facts, the scratches of turns that never finished.
 * Everything in it got there through the `concept`, `architecture`, `wiring`
 * and `scratch` tools — this command is the human's read of all of it at once,
 * and the one place an interrupted turn's leftover findings are surfaced
 * without a model having to look for them.
 *
 * It changes nothing. Reading reconciles the architecture against the disk
 * (that is a read of the disk, not a write of intent), and says plainly when
 * something recorded as IMPLEMENTED is no longer there.
 */

function register({ define, C }) {
  define('/lain', {
    surface: true,
    args: '',
    desc: 'What .lain remembers: architecture, wiring, vocabulary, facts, unfinished turns',
    run(app) {
      const root = app.session ? app.session.cwd : process.cwd();
      const lainstore = require('./lainstore');
      const dictionary = require('./dictionary');
      const architecture = require('./architecture');
      const reconcile = require('./reconcile');
      const wiring = require('./wiring');
      const scratch = require('./scratch');

      const survey = lainstore.survey(root);
      if (!survey.exists) {
        app.render.write(C.dim('\n  No .lain/ in this project yet — nothing has been recorded.\n'
          + '  The concept, architecture, wiring and scratch tools write here as the model '
          + 'establishes things worth keeping.\n'));
        return;
      }

      // THE SURVEY ITSELF: what exists and how fresh, before any content.
      const slots = Object.entries(survey.slots)
        .filter(([, s]) => s.present)
        .map(([name, s]) => `${name} (${Math.max(1, Math.round(s.bytes / 1024))}k, `
          + `${new Date(s.updatedAt).toISOString().slice(0, 10)})`);
      app.render.write(C.green(`\n  .lain/ — ${slots.length ? slots.join(' · ') : 'empty slots'}`));

      // THE VOCABULARY, one line each.
      app.render.write(C.dim('\n  -- vocabulary --'));
      app.render.write(indent(dictionary.list(dictionary.load(root)), '  '));

      // INTENT vs DISK, reconciled now: alarms first, counts after.
      app.render.write(C.dim('\n  -- architecture (reconciled against the disk just now) --'));
      const { model, report } = reconcile.run(root);
      app.render.write(indent(architecture.render(model), '  '));
      app.render.write(indent(reconcile.say(model, report), '  '));

      // THE WIRING, grouped by relationship.
      app.render.write(C.dim('\n  -- wiring --'));
      app.render.write(indent(wiring.summary(wiring.load(root), { model }), '  '));

      // WHAT IS DURABLY TRUE — promoted findings, with their evidence.
      const facts = scratch.facts(root);
      app.render.write(C.dim(`\n  -- memory: ${facts.length} verified fact(s) --`));
      for (const f of facts.slice(-10)) {
        app.render.write(C.dim(`    ${f.text}`));
        app.render.write(C.dim(`      evidence: ${f.evidence}`));
      }

      // UNFINISHED TURNS — the scratches no model came back for.
      const orphans = scratch.orphans(root, { exclude: app.session ? app.session.id : '' });
      if (orphans.length) {
        app.render.write(C.yellow(`\n  ${orphans.length} unfinished turn(s) left findings behind:`));
        for (const o of orphans.slice(-5)) app.render.write(indent(scratch.say(o), '  '));
        app.render.write(C.dim('    Their scratch is kept until the work is resumed or abandoned.\n'));
      } else {
        app.render.write(C.dim('\n  No unfinished turns.\n'));
      }
    },
  });
}

function indent(text, pad) {
  return String(text || '').split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

module.exports = { register };
