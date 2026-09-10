'use strict';

/**
 * `/note` — WRITE IT DOWN BEFORE YOU FORGET IT.
 *
 * THE PROBLEM, in the user's own words: *"I wanted to complain about something
 * but forgot what it was."* A thought arrives in the middle of doing something
 * else — the spacing feels compressed, that migration left something behind,
 * the verification never actually ran — and by the time the current thing is
 * finished it is gone.
 *
 * Every mechanism LAIN already had loses it. The transcript loses it to
 * compaction. A plan step turns a passing observation into work somebody
 * committed to. A finding claims evidence that does not exist yet.
 *
 * ------------------------------------------------------------------------
 * ONE COMMAND, NOT FOUR.
 *
 * `/note`, `/remember`, `/fact` and `/decision` would be four doors into one
 * store, and the cost of four doors is that nobody remembers which one they
 * used. The KIND is an optional first word instead:
 *
 *     /note the context summary still feels compressed
 *     /note decision external JSON is the source of truth
 *     /note fact the dashboard binds 127.0.0.1 only
 *     /note limitation the fixture environment has no network
 *
 * Bare `/note` lists what is remembered. `/note drop C03` removes one.
 * ------------------------------------------------------------------------
 *
 * IT NEVER ASKS A FOLLOW-UP QUESTION. One line, recorded, done. A thought that
 * costs a workflow to record is a thought nobody records, and this exists
 * precisely for the ones that arrive at an inconvenient moment.
 */

/**
 * @param {object} api  { define, C } — the registry's vocabulary, passed in
 *                      rather than imported back, so this is not a second
 *                      dispatch path.
 */
function register({ define, C }) {
  define('/note', {
    // MACHINERY by the registry's test — it is about the project rather than
    // about the running task, so it belongs on the surface panel.
    surface: true,
    flashMs: 0,
    args: '[decision|fact|limitation|source-of-truth] <what you noticed>  ·  drop <id>',
    desc: 'Keep a RUNTIME NOTE — survives compaction/restart, this machine only (not project truth)',
    run(app, { rest }) {
      const memory = require('./memory');
      const root = (app.session && app.session.cwd) || process.cwd();
      const raw = String(rest || '').trim();

      if (!raw) return list(app, memory, root, C);

      const words = raw.split(/\s+/);
      const first = words[0].toLowerCase();

      if (first === 'drop' && words[1]) {
        const r = memory.drop(root, words[1]);
        app.render.write(r.ok ? C.dim(`  dropped ${words[1]}\n`) : C.yellow(`  ${r.why}\n`));
        return;
      }

      // A LEADING KIND WORD IS A KIND; anything else is the note itself. That
      // way the common case — just typing the thought — needs no syntax at all.
      const kinds = Object.values(memory.KIND);
      const isKind = kinds.includes(first);
      const kind = isKind ? first : memory.KIND.NOTE;
      const text = isKind ? words.slice(1).join(' ') : raw;

      const r = memory.add(root, text, { kind });
      if (!r.ok) { app.render.write(C.yellow(`  ${r.why}\n`)); return; }
      if (r.duplicate) {
        app.render.write(C.dim(`  already remembered as ${r.item.id}\n`));
        return;
      }
      app.render.write(
        `  ${C.green('kept')} ${C.dim(r.item.id)}  ${C.bold(kind.toUpperCase())}  ${r.item.text}\n`,
      );
      // WHETHER IT WILL ACTUALLY SURVIVE is the one thing worth saying: a note
      // that silently failed to reach disk is worse than no note, because the
      // user stops carrying the thought themselves.
      app.render.write(C.dim(r.persisted
        ? '  It will still be here after a restart.\n'
        : '  NOT saved to disk — it will not survive this session.\n'));
    },
  });
}

/**
 * What is remembered — THE MEMORY PANE, drawn here.
 *
 * ------------------------------------------------------------------------
 * TWO RENDERINGS OF ONE STORE BECAME ONE.
 *
 * `ui/memoryview.js` drew the MEMORY workspace pane and this function drew
 * `/note` with no arguments, off the same `memory.grouped(root)`. They said
 * different things: the pane explained what this store IS and what it is not,
 * offered the two commands that write to it, and grouped by kind with the
 * settled kinds first; this printed a bare list.
 *
 * The pane is gone; its rendering is the one that survives, because it is the
 * better answer to the same question, and because a second formatter over one
 * store is a second thing to keep in step.
 * ------------------------------------------------------------------------
 */
function list(app, memory, root, C) {
  const width = (app.render && app.render.width) || 80;
  for (const line of require('./ui/memoryview').render({ root, width })) {
    app.render.write(line + '\n');
  }
}

module.exports = { register, list };
