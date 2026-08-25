'use strict';

/**
 * `/resume` — PICK A SESSION, DO NOT RECITE ITS KEY.
 *
 * The command took an id and nothing else:
 *
 *     /resume 20260817-225319-78b1
 *
 * That id is a FILENAME — a timestamp plus four random characters — and it was
 * the only handle the user had. Continuing yesterday's work meant remembering,
 * or copying, a string that says nothing about what the work was. `/sessions`
 * did not help: it listed the same ids.
 *
 * So the browser shows sessions by their CONTENT — project, objective, when,
 * and how far each one got (see sessionindex.js) — and the id becomes metadata
 * that never has to be seen or typed.
 *
 * WHAT DOES NOT CHANGE, and must not:
 *
 *   `Session.resume(id)` is still the ONLY path that crosses a session
 *   boundary, and it is still reached only because the user asked. Nothing here
 *   auto-resumes, nothing falls back to "the most recent session", and an id
 *   that was typed still resolves exactly as it did — someone who has an id
 *   should not be refused for using it.
 *
 *   What came back is still CHECKED rather than claimed, by continuity.js. A
 *   restored transcript is not a restored context.
 */

const { Session } = require('./session');
const sessionIndex = require('./sessionindex');

/** How many sessions the browser reads. A search reads deeper — see below. */
const BROWSE = 25;
const SEARCH = 60;

/**
 * Actually adopt a session, and report what genuinely survived.
 *
 * One implementation, whether the id came from the browser, from a search, or
 * from being typed — otherwise "resume" would mean three slightly different
 * things depending on how you got there.
 */
function adopt(app, id, { C }) {
  const s = Session.resume(id);
  if (!s) { app.render.notice('error', `No session "${id}". Nothing was resumed.`); return null; }
  try { app.session.save(); } catch { /* keep the outgoing session's state */ }
  app.adopt(s, { resumedFrom: id });
  // WHAT CAME BACK, checked rather than claimed. A restored transcript is not a
  // restored context: the objective, the corrections, the changed files and the
  // state of the last check are separate facts, and each is reported as present
  // or absent by looking at the session. See continuity.js.
  // NAMED BY WHAT IT WAS, not by its key. The id is still the filename and is
  // still what `--resume` takes; it is simply not what a person is shown.
  app.render.write('\n' + C.green('  RESUMING SESSION') + C.dim(`  ${require('path').basename(s.cwd || '')}\n`));
  const continuity = require('./continuity');
  continuity.writeRows(app, continuity.resumeSummary(s, app), { C });
  // THE OTHER VOICES CAME BACK TOO, and the screen is told so — they are part
  // of the task's story and are now saved with it (see session.js). Without
  // this the Context pane would be redrawn from a session it had not read.
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return s;
}

/** The text listing, for a pipe and for anyone who prefers reading. */
function writeList(app, list, { C }) {
  if (!list.length) { app.render.write(C.dim('  No saved sessions match.\n')); return; }
  app.render.write('\n');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const mark = s.id === app.session.id ? C.green('  ● ') : '    ';
    app.render.write(`${mark}${String(i + 1).padEnd(3)}${s.when.text.padEnd(18)}${s.project}\n`);
    app.render.write(C.dim(`        ${sessionIndex.headline(s)}\n`));
    const stats = sessionIndex.statsLine(s);
    if (stats) app.render.write(C.dim(`        ${stats}\n`));
  }
  app.render.write(C.dim('\n  /resume <n> to restore one, or /resume <words> to narrow it.\n'));
}

/**
 * The command.
 *
 * `/resume`            the browser (or the listing, off a TTY)
 * `/resume dashboard`  the same, narrowed to what the session was about
 * `/resume today`      and to when it happened
 * `/resume 2`          the nth row of the listing just shown
 * `/resume <id>`       still works, unchanged
 */
async function runCommand(app, { args, rest } = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s };
  const query = String(rest || '').trim();

  // AN ID STILL RESOLVES, before anything else and without a search. Someone
  // holding one — from a `--resume` hint, from a script, from these notes — must
  // not be told to go and browse for it.
  if (query && Session.match(query)) return adopt(app, Session.match(query), { C: col });

  // ---- THIS PROJECT'S SESSIONS, UNLESS ASKED OTHERWISE --------------------
  //
  // The sessions folder is shared by every project on the machine, so this
  // offered — and would happily restore — a session belonging to a different
  // directory. Its conversation, objective and plan come back while the working
  // directory stays here, and every path the model had learned then resolves
  // into the wrong tree.
  //
  // `/resume all` looks across projects, and rows are labelled either way.
  const wantAll = /^all\b/i.test(query);
  const scoped = wantAll ? query.replace(/^all\b\s*/i, '') : query;
  const deep = Boolean(scoped) && scoped !== 'recent';
  const all = sessionIndex.summaries({
    limit: deep ? SEARCH : BROWSE,
    exclude: app.session.id,
    cwd: app.cwd,
    scope: wantAll ? 'all' : 'project',
  });
  const list = sessionIndex.search(all, scoped);

  // A BARE NUMBER IS THE ROW YOU JUST LOOKED AT.
  if (/^\d+$/.test(query)) {
    const n = Number(query);
    const row = all[n - 1];
    if (!row) { app.render.write(col.yellow(`  There is no session ${n}.`) + col.dim(' /resume to see the list.\n')); return null; }
    return adopt(app, row.id, { C: col });
  }

  if (!list.length) {
    app.render.write(query
      ? col.yellow(`  No session matches "${query}".`) + col.dim(' /resume to see them all.\n')
      : col.dim('  No saved sessions yet.\n'));
    return null;
  }

  // OFF A TTY there is no browser to open, so the listing is the answer. It is
  // the same data, and it still names sessions by what they were.
  if (!app.ui || !app.ui.enabled) { writeList(app, list, { C: col }); return null; }

  const { sessionListAdapter } = require('./ui/pickers');
  const picked = await app.ui.ask(sessionListAdapter({
    sessions: list,
    title: query ? `RESUME — matching "${query}"` : 'RESUME SESSION',
    current: app.session.id,
  }));
  // The filter text lives on the input line while a picker is open; it leaves
  // with the picker, exactly as the model browser's query does.
  if (app.input) app.input.setLine('');
  if (!picked) { app.render.write(col.dim('  nothing resumed.\n')); return null; }
  return adopt(app, picked, { C: col });
}

/** `/sessions` — the same descriptions, without ever resuming one. */
function listCommand(app, { rest } = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s };
  // SAME SCOPE AS /resume. A listing that shows sessions you cannot safely
  // resume from here would be an invitation to do exactly that.
  const q = String(rest || '').trim();
  const wantAll = /^all\b/i.test(q);
  const all = sessionIndex.summaries({
    limit: BROWSE,
    cwd: app.cwd,
    scope: wantAll ? 'all' : 'project',
  });
  const list = sessionIndex.search(all, wantAll ? q.replace(/^all\b\s*/i, '') : q);
  writeList(app, list, { C: col });
}

module.exports = { runCommand, listCommand, adopt, writeList, BROWSE, SEARCH };
