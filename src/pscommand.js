'use strict';

/**
 * `/ps` — THE PROCESSES LAIN OWNS.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A `tasklist` CLONE, AND IT MAINTAINS NO REGISTRY OF ITS OWN.
 *
 * Everything below is PROJECTED from state two existing systems already hold:
 *
 *   SERVICES   harness/processes.js `ProcessManager.list()` — things started to
 *              stay up. Each carries a pid, a port, a STATUS (STARTING,
 *              RUNNING, STOPPED, CRASHED, FAILED), a HEALTH, and the id of the
 *              task that owns it. That ownership is what makes `cleanup(taskId)`
 *              possible, and it is why roughly ninety orphaned supervisor
 *              processes are a documented incident in this repository rather
 *              than a recurring one.
 *
 *   JOBS       jobs.js `Jobs.all()` — commands started and left running, held
 *              on the App as `app._jobs` by tools/jobs.js. Each is one child
 *              process with a state machine that ends: QUEUED -> RUNNING ->
 *              {SUCCEEDED, FAILED, CANCELLED, TIMED_OUT}.
 *
 * This file adds no third vocabulary and stores nothing. Ask it twice in a row
 * and the second answer comes from the same two objects the first did; kill a
 * service behind LAIN's back and the row changes because the ProcessManager's
 * own `exit` handler changed it, not because this polled anything.
 *
 * ------------------------------------------------------------------------
 * ONLY WHAT LAIN OWNS IS LISTED, AND THAT IS THE POINT.
 *
 * A row here is a claim of ownership: it says LAIN started this, LAIN knows
 * which task it belongs to, and LAIN will take it down. Listing an arbitrary
 * host process beside those would make the claim meaningless — and the whole
 * reason to want this command is to answer "what has LAIN left running on my
 * machine", which a host-wide process list cannot answer at all.
 *
 * There is deliberately NO `/ps all`. Host-wide scanning does not exist in this
 * tree and adding it for a display would be a new capability wearing a
 * formatting change.
 *
 * ------------------------------------------------------------------------
 * `/ps` NEVER STARTS ANYTHING. `/bg` is the door work comes in through; this is
 * the window you look at it through. See src/jobcommands.js.
 */

/** Full table above this width; two columns below it. */
const WIDE = 64;
/** Beyond this, a service's health and a job's exit code earn their column. */
const VERY_WIDE = 92;

/**
 * The managed services, as plain rows. Straight from `toJSON()` so a field
 * cannot mean something different here than it does in `/env` or the dashboard.
 */
function serviceRows(app) {
  const h = require('./harnesslink').existing(app);
  if (!h || !h.processes) return [];
  return h.processes.list().map((p) => {
    const j = p.toJSON();
    return {
      pid: j.commandPid || j.pid || null,
      type: 'service',
      // LOWER CASE, because the STATUS vocabulary is the harness's and it is
      // shouted there for a reason — this is a table, not a verdict.
      state: String(j.status || '').toLowerCase(),
      name: j.name,
      port: j.port || null,
      owner: j.taskId || null,
      since: j.startedAt || 0,
      // UNKNOWN IS AN ANSWER AND IT IS PRINTED AS ONE. A service with no health
      // check configured is not healthy — nothing looked. See processes.js.
      extra: j.health && j.health !== 'UNKNOWN' ? j.health.toLowerCase() : '',
      done: ['stopped', 'crashed', 'failed'].includes(String(j.status || '').toLowerCase()),
    };
  });
}

/** The shell jobs, from the collection tools/jobs.js holds on the App. */
function jobRows(app) {
  const jobs = app && app._jobs;
  if (!jobs || typeof jobs.all !== 'function') return [];
  return jobs.all().map((j) => ({
    // A JOB'S PID IS ITS CHILD'S, and it is gone once the child has exited —
    // printing the pid of a process that no longer exists would invite somebody
    // to kill a number the OS has since reused.
    pid: j.child && !j.done ? j.child.pid : null,
    type: 'job',
    state: String(j.state || '').toLowerCase(),
    name: String(j.command || '').replace(/\s+/g, ' '),
    port: null,
    owner: null,
    since: j.startedAt || 0,
    extra: j.done && j.exitCode != null ? `exit ${j.exitCode}` : '',
    done: Boolean(j.done),
  })).filter((r) => r.name);
}

/** Everything LAIN owns, services first — they are the ones that stay up. */
function rows(app) {
  return [...serviceRows(app), ...jobRows(app)];
}

function since(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * Colour by state, using the vocabulary the rest of LAIN already uses: running
 * is live, a clean end is quiet, a crash is a failure.
 */
function tone(C, state) {
  if (state === 'running') return C.cyan(state);
  if (state === 'succeeded') return C.green(state);
  if (state === 'crashed' || state === 'failed' || state === 'timed_out') return C.yellow(state);
  return C.dim(state);
}

/**
 * The table, as lines, at `width`.
 *
 * ------------------------------------------------------------------------
 * THE TERMINAL DECIDES HOW MUCH DETAIL, NOT A FIXED COLUMN LIST.
 *
 *   narrow    18240  running  vite
 *   normal    PROCESS  TYPE     STATE    NAME
 *   wide      … plus PORT, OWNER, UP and the health/exit column
 *
 * Every column beyond the first three is dropped rather than squeezed: a table
 * whose values are clipped to four characters each is a table nobody can read,
 * and the previous UI's width problems were all of this shape.
 */
function render(app, C, width = 80) {
  const list = rows(app);
  const out = [];
  if (!list.length) {
    out.push(C.dim('  Nothing is running that LAIN owns.'));
    out.push(C.dim('  /bg <what you want done> starts something in the background.'));
    return out;
  }
  const w = Math.max(30, width);
  const wide = w >= WIDE;
  const veryWide = w >= VERY_WIDE;
  // NAME GETS WHAT IS LEFT. It is the only column whose content is unbounded —
  // a service is `vite`, but a job is a whole command line.
  const fixed = wide ? (veryWide ? 8 + 9 + 10 + 7 + 18 + 6 : 8 + 9 + 10) : 8 + 9;
  const nameRoom = Math.max(10, w - fixed - 4);
  const cell = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);

  if (wide) {
    let head = `  ${cell('PROCESS', 8)}${cell('TYPE', 9)}${cell('STATE', 10)}${cell('NAME', nameRoom)}`;
    if (veryWide) head += `${cell('PORT', 7)}${cell('OWNER', 18)}UP`;
    out.push(C.dim(head));
  }
  for (const r of list) {
    // A PROCESS WITH NO PID IS SAID TO HAVE NONE. A job that has finished and a
    // service that never got as far as spawning are both real states, and a
    // blank is the honest rendering of both — inventing a `0` or reusing the
    // last pid seen would be a number somebody could act on.
    const pid = r.pid ? String(r.pid) : '—';
    if (!wide) {
      out.push(`  ${cell(pid, 8)}${tone(C, r.state)} ${C.dim(String(r.name).slice(0, Math.max(8, w - 20)))}`);
      continue;
    }
    // COMPOSED WITH ITS PLAIN WIDTH ALONGSIDE IT. Colour codes carry no
    // columns, so a row measured by `.length` would report itself far wider
    // than it is — and the trailing field would be dropped on a terminal that
    // had room for it, or kept on one that did not.
    let line = `  ${cell(pid, 8)}${C.dim(cell(r.type, 9))}${tone(C, r.state)}${' '.repeat(Math.max(1, 10 - r.state.length))}${cell(r.name, nameRoom)}`;
    let used = 2 + 8 + 9 + Math.max(r.state.length + 1, 10) + nameRoom;
    if (veryWide) {
      line += `${C.dim(cell(r.port ? `:${r.port}` : '', 7))}${C.dim(cell(r.owner || '', 18))}${C.dim(since(r.since))}`;
      used += 7 + 18 + since(r.since).length;
    }
    // THE TRAILING FIELD IS A LUXURY AND IS DROPPED FIRST. A service's health
    // and a job's exit code are worth saying; they are not worth pushing the
    // row past the edge of the terminal to say.
    if (r.extra && used + 2 + r.extra.length <= w) line += C.dim(`  ${r.extra}`);
    out.push(line);
  }
  // WHAT THIS LIST IS AND IS NOT, once, at the foot. Somebody running `/ps` for
  // the first time is asking a question about their machine, and the honest
  // answer includes the boundary of what was looked at.
  //
  // SHORTENED RATHER THAN WRAPPED on a narrow terminal: the boundary is the
  // part that must survive, and a footnote folded onto three rows under a
  // two-row table is the table's own proportions inverted.
  out.push('');
  const T = require('./ui/text');
  const note = w >= 74
    ? 'Processes LAIN started and still owns. Host processes are not listed.'
    : 'Owned by LAIN. Host processes are not listed.';
  const doors = w >= 70
    ? '/bg — the work behind these · /bg stop <id> — end a background task'
    : '/bg — the work behind these';
  out.push(C.dim(T.clip('  ' + note, w)));
  out.push(C.dim(T.clip('  ' + doors, w)));
  return out;
}

function register({ define, C }) {
  define('/ps', {
    // MACHINERY: about LAIN's own runtime, not about the work. Goes to the
    // command panel and never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'Processes and services LAIN owns — pid, type, state, name',
    run(app) {
      const width = (app.render && app.render.width) || 80;
      for (const line of render(app, C, width)) app.render.write(line + '\n');
    },
  });
}

module.exports = { register, render, rows, serviceRows, jobRows, WIDE, VERY_WIDE };
