'use strict';

/**
 * WHICH SESSION WAS THAT? — sessions described by their CONTENT, not their key.
 *
 * `/resume` took an id and nothing else, and `/sessions` listed ids and nothing
 * else, so continuing yesterday's work was a memory test:
 *
 *     20260817-225319-78b1
 *     20260817-180236-cc8a
 *     20260818-042858-06yn
 *
 * Nothing there says which one was the dashboard bug. The id is a FILENAME —
 * a timestamp plus four random characters, internal bookkeeping — and it was
 * the only handle the user was given.
 *
 * So this reads what each session actually contains and describes it: the
 * project, the objective in the user's own words, when it was last touched, how
 * far it got, and whether an external reviewer was involved. The id becomes
 * metadata that the user never has to see or type.
 *
 * WHAT IT DOES NOT DO. It never resumes anything and never modifies a session
 * file — see session.js, where `Session.resume(id)` remains the only path that
 * crosses a session boundary, and it is still reached only by explicit request.
 * This is a reader.
 *
 * COST. Session files reach half a megabyte, and there are hundreds. Files are
 * ordered by mtime FIRST and only the head of that list is parsed, so the cost
 * is bounded by `limit` rather than by how long the user has been using LAIN.
 * A file that will not parse is reported as unreadable rather than skipped
 * silently — a session that exists and cannot be opened is a fact worth having.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

/** How many session files are parsed by default. Ordered by mtime first. */
const DEFAULT_LIMIT = 25;
/** The hard ceiling a search may raise the limit to. */
const MAX_LIMIT = 80;

/** `2026-08-18T09:18` → `TODAY 09:18`, in the user's own local time. */
function when(ms, now = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return { group: 'TODAY', clock, text: `TODAY  ${clock}` };
  if (days === 1) return { group: 'YESTERDAY', clock, text: `YESTERDAY  ${clock}` };
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return { group: `${month} ${d.getDate()}`, clock, text: `${month} ${d.getDate()}  ${clock}` };
}

/**
 * One session, described.
 *
 * Every field is READ. A session with no task has no objective and says so;
 * nothing here fills a gap with a plausible sentence, for the same reason the
 * investigation packet does not.
 */
function describe(id, data, stat, now = Date.now()) {
  const turns = Array.isArray(data.turns) ? data.turns : [];
  const task = data.task || null;
  const life = data.lifecycle || null;
  const plan = data.plan || null;
  const actors = Array.isArray(data.actors) ? data.actors : [];

  const filesChanged = life && life.evidence && Array.isArray(life.evidence.filesChanged)
    ? life.evidence.filesChanged.length : 0;

  const lastLain = [...turns].reverse().map((t) => String(t && t.text || '').trim()).find(Boolean) || null;
  const lastExternal = [...actors].reverse().find((a) => a && a.kind === 'external');
  const lastUser = [...turns].reverse().map((t) => String(t && t.userInput || '').trim()).find(Boolean) || null;

  return {
    id,
    shortId: id.split('-').pop(),
    cwd: data.cwd || '',
    project: data.cwd ? path.basename(data.cwd) : '(unknown)',
    objective: task && task.objective ? String(task.objective).replace(/\s+/g, ' ') : null,
    state: life && life.state ? life.state : null,
    turns: turns.length,
    messages: Array.isArray(data.messages) ? data.messages.length : 0,
    filesChanged,
    steers: task && Array.isArray(task.steers) ? task.steers.length : 0,
    planDone: plan && Array.isArray(plan.steps) ? plan.steps.filter((s) => s.status === 'done').length : 0,
    planTotal: plan && Array.isArray(plan.steps) ? plan.steps.length : 0,
    lastCommand: life && life.lastCommand ? life.lastCommand : null,
    externalRounds: actors.filter((a) => a && a.kind === 'external').length,
    lastExternal: lastExternal ? lastExternal.text : null,
    lastLain,
    lastUser,
    startedAt: data.createdAt || null,
    lastActivity: stat.mtimeMs,
    when: when(stat.mtimeMs, now),
    unreadable: false,
  };
}

/** A session file that exists and will not open. Reported, never hidden. */
function unreadable(id, stat, why, now = Date.now()) {
  return {
    id, shortId: id.split('-').pop(), cwd: '', project: '(unreadable)',
    objective: null, state: null, turns: 0, messages: 0, filesChanged: 0, steers: 0,
    planDone: 0, planTotal: 0, lastCommand: null, externalRounds: 0,
    lastExternal: null, lastLain: null, lastUser: null, startedAt: null,
    lastActivity: stat.mtimeMs, when: when(stat.mtimeMs, now), unreadable: why,
  };
}

/** Same directory? Compared as Windows compares them, which is not by case. */
function samePlace(a, b) {
  const norm = (p) => {
    const s = path.resolve(String(p || ''));
    return process.platform === 'win32' ? s.toLowerCase().replace(/\\+$/, '') : s.replace(/\/+$/, '');
  };
  if (!a || !b) return false;
  return norm(a) === norm(b);
}

/**
 * Recent sessions, newest activity first.
 *
 * ---- SCOPED TO ONE PROJECT BY DEFAULT ------------------------------------
 *
 * The sessions directory is GLOBAL — one folder under the config dir holding
 * every session from every project this machine has ever worked on. So
 * `/resume` in lain-v2 listed sessions from lain-lora, from the UX gallery,
 * from anything; and resuming one restored ITS conversation, its objective and
 * its plan while the working directory stayed here. The result is a session
 * that believes it is editing files in a folder it is not in — every path in
 * its context resolves somewhere else, and the first edit lands in the wrong
 * tree entirely.
 *
 * Sessions already record their `cwd`, so the fix is to use it. `scope` opts
 * out for the case where someone genuinely wants to look across projects, and
 * what comes back is still LABELLED with its project so a foreign session can
 * never be resumed by accident.
 *
 * @param {object} o  { limit, exclude, now, dir, cwd, scope }
 *   cwd    the project to scope to; null means do not scope
 *   scope  'project' (default when cwd is given) or 'all'
 */
function summaries({
  limit = DEFAULT_LIMIT, exclude = null, now = Date.now(), dir = null,
  cwd = null, scope = 'project',
} = {}) {
  const d = dir || config.sessionsDir();
  let names = [];
  try { names = fs.readdirSync(d); } catch { return []; }

  // MTIME FIRST, then parse. The whole point is that the cost does not grow
  // with the number of saved sessions, only with how many are being shown.
  const stats = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (exclude && id === exclude) continue;
    try { stats.push({ id, file: path.join(d, n), stat: fs.statSync(path.join(d, n)) }); } catch { /* vanished */ }
  }
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  // SCOPING READS THE FILE, so the limit is applied AFTER the filter rather
  // than before it. Slicing to `limit` first and filtering afterwards would
  // show three of this project's sessions because the other seventeen recent
  // ones belonged elsewhere — the list would be short for a reason nothing on
  // screen explained.
  const wantScope = cwd && scope !== 'all';
  const out = [];
  const cap = Math.max(1, Math.min(MAX_LIMIT, limit));
  for (const s of stats) {
    if (out.length >= cap) break;
    let data;
    try { data = JSON.parse(fs.readFileSync(s.file, 'utf8')); } catch (e) {
      // AN UNREADABLE FILE CANNOT BE SCOPED, because its cwd is exactly what
      // could not be read. Shown only when nothing is being scoped — inside a
      // project it would be an unexplained row that may not even belong here.
      if (!wantScope) out.push(unreadable(s.id, s.stat, e.message, now));
      continue;
    }
    if (!data || typeof data !== 'object') {
      if (!wantScope) out.push(unreadable(s.id, s.stat, 'not a session', now));
      continue;
    }
    if (wantScope && !samePlace(data.cwd, cwd)) continue;
    const row = describe(s.id, data, s.stat, now);
    // MARKED, ALWAYS. Even in `all` scope the caller can tell which rows would
    // resume into a different directory than the one LAIN is running in.
    row.here = samePlace(data.cwd, cwd || process.cwd());
    out.push(row);
  }
  return out;
}

/**
 * `/resume dashboard` — match on what the session was ABOUT.
 *
 * The id is still matched, because someone who has one should not be refused
 * for using it, but it is the last thing tried rather than the only thing.
 */
function search(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  if (q === 'recent') return list;
  if (q === 'today') return list.filter((s) => s.when.group === 'TODAY');
  if (q === 'yesterday') return list.filter((s) => s.when.group === 'YESTERDAY');
  const words = q.split(/\s+/).filter(Boolean);
  return list.filter((s) => {
    const hay = [s.objective, s.project, s.lastUser, s.lastLain, s.lastExternal, s.id, s.state]
      .filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The one-line headline: what this session was, in the user's words. */
function headline(s) {
  if (s.unreadable) return `unreadable — ${s.unreadable}`;
  return s.objective || s.lastUser || '(no task was ever started)';
}

/** The stats line under the headline. Only facts that are actually recorded. */
function statsLine(s) {
  if (s.unreadable) return '';
  const bits = [];
  if (s.turns) bits.push(`${s.turns} turn${s.turns === 1 ? '' : 's'}`);
  if (s.filesChanged) bits.push(`${s.filesChanged} file${s.filesChanged === 1 ? '' : 's'} changed`);
  if (s.planTotal) bits.push(`plan ${s.planDone}/${s.planTotal}`);
  if (s.externalRounds) bits.push(`${s.externalRounds} external review${s.externalRounds === 1 ? '' : 's'}`);
  if (s.steers) bits.push(`${s.steers} correction${s.steers === 1 ? '' : 's'}`);
  if (s.state) bits.push(s.state);
  return bits.join(' · ') || 'nothing happened in this session';
}

module.exports = { summaries, search, describe, headline, statsLine, when, samePlace, DEFAULT_LIMIT, MAX_LIMIT };
