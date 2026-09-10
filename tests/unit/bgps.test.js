'use strict';

/**
 * `/bg` AND `/ps` — the two altitudes of background work.
 *
 * ------------------------------------------------------------------------
 *     USER INTENT
 *          ↓
 *        /bg          logical background task — what you asked for
 *          ↓
 *     HARNESS / JOBS / SERVICES
 *          ↓
 *        /ps          physical projection — pids, services, state
 *
 * The two properties that matter most here are NEGATIVE, and they are the
 * reason this file exists rather than a couple of rendering assertions:
 *
 *   `/bg` MUST NOT BE A SECOND EXECUTION SYSTEM. It delegates to
 *   `app.startBackground` (src/jobrunner.js), which opens an AgentJob running
 *   the ordinary turn loop. Whether the work becomes a JOB or a SERVICE is
 *   decided by the tools the model reaches for, using semantics that already
 *   exist in src/jobs.js and harness/processes.js.
 *
 *   `/ps` MUST NOT KEEP A SECOND PROCESS REGISTRY. Every row is projected from
 *   the ProcessManager and the Jobs collection. Ask it twice and the second
 *   answer comes from the same two objects the first did.
 *
 * And one that is neither: `COMPLETED` IS NOT `PASSED`. A background task that
 * ran to completion has proved nothing by doing so, and only the harness's
 * `settle()` — which takes a verification result — may say otherwise.
 */

const assert = require('assert');
const { test } = require('../helpers');

const jobcommands = require('../../src/jobcommands');
const pscommand = require('../../src/pscommand');
const { STATE } = require('../../src/jobs');

/** Colour helpers that return the string, so assertions read the plain text. */
const C = new Proxy({}, { get: () => (s) => String(s) });

/** A collector for the `w` writer the commands take. */
function lines() {
  const out = [];
  const w = (s) => out.push(String(s));
  w.text = () => out.join('\n');
  w.out = out;
  return w;
}

/** The smallest AgentJob-shaped double `/bg` and `/ps` actually read. */
function job(over = {}) {
  return Object.assign({
    id: '1', request: 'run the integration suite', primary: false,
    state: STATE.RUNNING, elapsedMs: 12000, needsInput: false, waiting: false,
    question: null, error: null, done: false, taskId: null,
    cancel() { this.state = STATE.CANCELLED; this.done = true; this.cancelled = true; },
  }, over);
}

/** An App double with a jobs collection and nothing else. */
function app(list = []) {
  return {
    jobs: {
      list,
      all: () => list.slice(),
      running: () => list.filter((j) => !j.done),
      get: (id) => list.find((j) => String(j.id) === String(id)) || null,
      changed() { this.changes = (this.changes || 0) + 1; },
    },
    started: [],
    startBackground(text) {
      const j = job({ id: String(list.length + 1), request: text });
      list.push(j);
      this.started.push(text);
      return j;
    },
    render: { width: 100, write() {} },
  };
}

module.exports = async function () {
  // ============================================================== /bg ======

  await test('BG: with nothing running it says so, and offers both shapes of work', () => {
    const w = lines();
    jobcommands.summary(app([]), C, w);
    const text = w.text();
    assert.match(text, /Nothing is running in the background/);
    // THE USAGE LINE IS WHAT AN EMPTY LIST SAYS, not what bare `/bg` says. It
    // used to be the whole of bare `/bg`, which answered a question nobody
    // asked: somebody typing `/bg` on its own wants to know what is running.
    assert.match(text, /a job — it ends and yields a result/);
    assert.match(text, /a service — it stays up/);
  });

  await test('BG: an instruction starts a task and hands the prompt straight back', () => {
    const a = app([]);
    const out = [];
    const fake = { render: { write: (s) => out.push(String(s)) } };
    Object.assign(a, { render: fake.render });
    // Registered for real, so this exercises the command the user types.
    const registry = new Map();
    jobcommands.register({
      define: (name, spec) => registry.set(name, spec),
      C,
    });
    registry.get('/bg').run(a, { rest: 'run the complete integration suite' });
    assert.deepStrictEqual(a.started, ['run the complete integration suite'],
      'it must delegate to startBackground — see the header');
    const text = out.join('');
    assert.match(text, /Background #1 started/);
    assert.match(text, /Keep talking/, 'the session stays interactive; nothing blocks');
    // AND IT DOES NOT SPAM THE CONVERSATION: one acknowledgement, two lines.
    assert.ok(out.length <= 2, `one concise acknowledgement, got ${out.length} lines`);
  });

  await test('BG: it creates NO second execution system', () => {
    // The whole delegation, asserted structurally: the command may reach
    // `startBackground` and nothing else that runs anything.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'jobcommands.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /app\.startBackground\(/, 'it delegates');
    // `.exec(` is a RegExp method and appears in `/steer`'s argument parsing,
    // so the check is for the child_process spellings specifically.
    for (const forbidden of ['spawn(', 'execFile(', 'child_process', 'fork(', 'new Worker']) {
      assert.ok(!src.includes(forbidden), `/bg must not start processes itself: ${forbidden}`);
    }
  });

  await test('BG: running work is listed; the CONVERSATION is not a row', () => {
    const w = lines();
    jobcommands.summary(app([
      job({ id: '17', request: 'integration tests' }),
      job({ id: '18', request: 'frontend server' }),
      job({ id: '9', request: 'what you are watching', primary: true }),
    ]), C, w);
    const text = w.text();
    assert.match(text, /#17/);
    assert.match(text, /#18/);
    assert.match(text, /RUNNING/);
    assert.ok(!/what you are watching/.test(text),
      'the conversation is the feed, the live row and the header — not a fourth copy');
  });

  await test('BG: a finished task is COMPLETED, and never PASSED on its own', () => {
    // ------------------------------------------------------------------
    // THE CONTRACT. Execution → verification → settlement. A clean exit is
    // execution finishing; it is not evidence, and `harness/state.js` refuses
    // to reach PASSED from anything but a verification result.
    // ------------------------------------------------------------------
    const w = lines();
    jobcommands.summary(app([
      job({ id: '17', state: STATE.SUCCEEDED, done: true, request: 'integration tests' }),
    ]), C, w);
    const text = w.text();
    assert.match(text, /COMPLETED/);
    assert.ok(!/PASSED/.test(text), 'a process exiting zero has proved nothing');
  });

  await test('BG: a FAILED task stays failed', () => {
    const w = lines();
    jobcommands.summary(app([
      job({ id: '17', state: STATE.FAILED, done: true, error: 'the suite exited 1' }),
    ]), C, w);
    assert.match(w.text(), /FAILED/);
  });

  await test('BG: a settled task shows the HARNESS verdict, beside the row', () => {
    // The verdict is READ from the runtime — the only thing entitled to say
    // PASSED — and it rides beside the job's own state rather than replacing
    // it, because they answer two different questions.
    const a = app([job({ id: '17', state: STATE.SUCCEEDED, done: true, taskId: 't1' })]);
    a._harness = { runtime: { get: (id) => (id === 't1' ? { state: 'PASSED', terminal: true } : null) } };
    assert.strictEqual(jobcommands.settledState(a, a.jobs.list[0]), 'PASSED');
    const w = lines();
    jobcommands.summary(a, C, w);
    assert.match(w.text(), /COMPLETED.*task PASSED/s);
  });

  await test('BG: a task still RUNNING in the harness yields no verdict at all', () => {
    const a = app([job({ id: '17', state: STATE.SUCCEEDED, done: true, taskId: 't1' })]);
    a._harness = { runtime: { get: () => ({ state: 'VERIFYING', terminal: false }) } };
    assert.strictEqual(jobcommands.settledState(a, a.jobs.list[0]), '',
      'RUNNING and VERIFYING are not verdicts, and drawing one beside a finished job reads as one');
  });

  await test('BG: `stop` cancels through the SAME cooperative path as /cancel', () => {
    const a = app([job({ id: '17' })]);
    const w = lines();
    jobcommands.stop(a, C, w, '17');
    assert.strictEqual(a.jobs.list[0].cancelled, true, 'the job itself was asked to stop');
    assert.match(w.text(), /cancelled/);
    // A SECOND STOP IS A RACE THE USER LOST BY A SECOND, not an error.
    const w2 = lines();
    jobcommands.stop(a, C, w2, '17');
    assert.match(w2.text(), /had already/);
  });

  await test('BG: `stop` with one running task needs no number, and refuses the conversation', () => {
    const a = app([job({ id: '17' })]);
    const w = lines();
    jobcommands.stop(a, C, w, undefined);
    assert.strictEqual(a.jobs.list[0].cancelled, true, 'one candidate needs no precision');

    const b = app([job({ id: '3', primary: true })]);
    const w2 = lines();
    jobcommands.stop(b, C, w2, '3');
    assert.ok(!b.jobs.list[0].cancelled, 'the conversation is not background work');
    assert.match(w2.text(), /Ctrl\+C/, 'and it says what does stop it');
  });

  await test('BG: an unknown number says so rather than acting on something else', () => {
    const a = app([job({ id: '17' })]);
    const w = lines();
    jobcommands.stop(a, C, w, '99');
    assert.match(w.text(), /No background task #99/);
    assert.ok(!a.jobs.list[0].cancelled);
  });

  await test('BG: no lifecycle beyond start, look and stop', () => {
    // §20: `/bg logs`, `/bg resume`, `/bg restart` are the parts of a job
    // manager that exist because a job manager exists.
    const registry = new Map();
    jobcommands.register({ define: (name, spec) => registry.set(name, spec), C });
    const args = registry.get('/bg').args;
    assert.match(args, /stop/);
    for (const verb of ['logs', 'resume', 'restart', 'pause', 'priority']) {
      assert.ok(!args.includes(verb), `/bg must not grow a ${verb} verb`);
    }
  });

  // ============================================================== /ps ======

  /** A ManagedProcess-shaped double, as the ProcessManager hands them out. */
  const proc = (over = {}) => ({
    toJSON: () => Object.assign({
      processId: 'proc_1', taskId: 'task_3', name: 'vite',
      command: 'npm run dev', pid: 18240, commandPid: 18240, port: 5173,
      status: 'RUNNING', health: 'HEALTHY', healthWhy: 'port 5173 accepts connections',
      exitCode: null, restarts: 0, startedAt: Date.now() - 60000, stoppedAt: null,
    }, over),
  });

  /** An App with a harness and a shell-jobs collection. */
  const psApp = ({ procs = [], jobs = [] } = {}) => ({
    _harness: { processes: { list: () => procs } },
    _jobs: { all: () => jobs },
    render: { width: 100 },
  });

  await test('PS: nothing managed says nothing is running, and points at /bg', () => {
    const out = pscommand.render(psApp(), C, 100);
    const text = out.join('\n');
    assert.match(text, /Nothing is running that LAIN owns/);
    assert.match(text, /\/bg/, 'and names the door work comes in through');
  });

  await test('PS: one managed service is one row, with pid, type, state and name', () => {
    const text = pscommand.render(psApp({ procs: [proc()] }), C, 100).join('\n');
    assert.match(text, /18240/, 'the pid');
    assert.match(text, /service/, 'the type');
    assert.match(text, /running/, 'the state');
    assert.match(text, /vite/, 'the name');
  });

  await test('PS: jobs and services are told apart, and both are listed', () => {
    const rows = pscommand.rows(psApp({
      procs: [proc()],
      jobs: [{ id: 'j1', command: 'npm run test:integration', state: 'RUNNING', done: false, child: { pid: 19716 }, startedAt: Date.now() }],
    }));
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map((r) => r.type).sort(), ['job', 'service']);
    // SERVICES FIRST — they are the ones that stay up, and the ones somebody
    // running this command is most often looking for.
    assert.strictEqual(rows[0].type, 'service');
  });

  await test('PS: a terminated process keeps its terminal state, per the manager', () => {
    const rows = pscommand.rows(psApp({ procs: [proc({ status: 'CRASHED', pid: null, commandPid: null })] }));
    assert.strictEqual(rows[0].state, 'crashed');
    assert.strictEqual(rows[0].done, true);
    // AND A PROCESS WITH NO PID IS SAID TO HAVE NONE. Printing the pid of a
    // process that no longer exists invites somebody to kill a number the OS
    // has since reused.
    const text = pscommand.render(psApp({ procs: [proc({ status: 'CRASHED', pid: null, commandPid: null })] }), C, 100).join('\n');
    assert.match(text, /—/, 'an absent pid is drawn as absent');
  });

  await test('PS: a finished JOB no longer offers a pid to kill', () => {
    const rows = pscommand.rows(psApp({
      jobs: [{ id: 'j1', command: 'npm test', state: 'SUCCEEDED', done: true, exitCode: 0, child: { pid: 19716 }, startedAt: Date.now() }],
    }));
    assert.strictEqual(rows[0].pid, null, 'the child is gone; the number is not ours to print');
    assert.strictEqual(rows[0].extra, 'exit 0', 'and the result is what is worth saying instead');
  });

  await test('PS: it maintains NO registry — it reads the two authorities', () => {
    // Structural, because the failure is a cache appearing rather than a wrong
    // value: a second registry looks correct until the moment it drifts.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pscommand.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /processes\.list\(\)/, 'the ProcessManager is one authority');
    assert.match(src, /_jobs/, 'and the Jobs collection is the other');
    for (const forbidden of ['new Map(', 'new Set(', 'spawn(', 'exec(']) {
      assert.ok(!src.includes(forbidden), `/ps must not keep or start anything: ${forbidden}`);
    }
    // AND IT DOES NOT SCAN THE HOST. §14: a row here is a claim of ownership.
    for (const forbidden of ['tasklist', 'ps -e', 'wmic', 'Get-Process']) {
      assert.ok(!src.includes(forbidden), `/ps must not enumerate the machine: ${forbidden}`);
    }
    assert.ok(!/'\/ps all'|"ps all"/.test(src), 'and there is no host-wide option to opt into');
  });

  await test('PS: the same state read twice gives the same answer', () => {
    const a = psApp({ procs: [proc()] });
    assert.deepStrictEqual(pscommand.rows(a).map((r) => r.pid), pscommand.rows(a).map((r) => r.pid));
  });

  await test('PS: ownership is stated, and the boundary of the list with it', () => {
    const text = pscommand.render(psApp({ procs: [proc()] }), C, 100).join('\n');
    assert.match(text, /Host processes are not listed/,
      'somebody asking what LAIN left running deserves the boundary of the answer');
  });

  // ====================================== NARROW AND WIDE TERMINALS ========

  await test('PS: a narrow terminal drops columns rather than clipping every value', () => {
    const wide = pscommand.render(psApp({ procs: [proc()] }), C, 120).join('\n');
    const narrow = pscommand.render(psApp({ procs: [proc()] }), C, 46).join('\n');
    assert.match(wide, /PROCESS\s+TYPE\s+STATE\s+NAME/, 'the full table is headed');
    assert.match(wide, /:5173/, 'and wide enough to carry the port');
    assert.ok(!/PROCESS\s+TYPE/.test(narrow), 'a narrow terminal drops the header, not the values');
    assert.match(narrow, /18240/, 'the pid survives');
    assert.match(narrow, /running/, 'and the state');
    assert.match(narrow, /vite/, 'and the name');
  });

  await test('PS and BG: every width renders without a row overflowing it', () => {
    const T = require('../../src/ui/text');
    const a = psApp({
      procs: [proc(), proc({ processId: 'proc_2', name: 'api', port: 8080, pid: 4242 })],
      jobs: [{ id: 'j1', command: 'npm run test:integration -- --reporter=verbose', state: 'RUNNING', done: false, child: { pid: 19716 }, startedAt: Date.now() }],
    });
    for (const w of [60, 80, 100, 120, 160]) {
      for (const line of pscommand.render(a, C, w)) {
        assert.ok(T.width(line) <= w, `/ps drew ${T.width(line)} cells at width ${w}: ${line}`);
      }
    }
    // `/bg` writes plain lines rather than a table, so the property to hold is
    // that its rows stay inside a narrow terminal too.
    const out = lines();
    jobcommands.summary(app([
      job({ id: '17', request: 'run the complete integration suite with the verbose reporter' }),
      job({ id: '18', request: 'start the frontend dev server on port 5173' }),
    ]), C, out);
    for (const line of out.out) {
      assert.ok(T.width(line) <= 100, `/bg drew ${T.width(line)} cells: ${line}`);
    }
  });

  // ============================================ NO TAB, NO PANE, NO LEAK ===

  await test('BG and PS are COMMANDS — neither is a surface', () => {
    // §22: adding a Background or Processes tab because these exist would
    // defeat the simplification they are part of.
    const { REGISTRY } = require('../../src/commands');
    assert.ok(REGISTRY.get('/bg').surface, 'output goes to the command panel');
    assert.ok(REGISTRY.get('/ps').surface);
    const panesource = require('../../src/ui/panesource');
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'ui', 'panesource.js'), 'utf8');
    assert.ok(!/switch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      'the surface still has one answer');
    assert.strictEqual(typeof panesource.workspaceLines, 'function');
  });

  await test('BG: the session cleans up what it owns when it ends', () => {
    // The CLI half of the orphan problem: a session that ends must take its
    // background work with it. `cancelAll` is the AgentJobs' own sweep and
    // `stopAll` is the shell jobs'; the harness takes its services down through
    // `cleanup(taskId)`, which is its own responsibility and its own test.
    const fs = require('fs');
    const path = require('path');
    const repl = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repl.js'), 'utf8');
    assert.match(repl, /jobs\.cancelAll\(/, 'the AgentJobs are cancelled on the way out');
    // ---- THE LEAK THIS TEST FOUND ------------------------------------
    //
    // `src/jobs.js stopAll` has always carried the comment "Called when the
    // session ends; never leaves an orphan" — and nothing called it. A suite
    // started with `run_background` and still running at `/exit` carried on
    // detached, with nobody left who knew about it. `/ps` is what made it
    // visible: a command that shows what LAIN owns has to be able to say that
    // LAIN let go of it.
    assert.match(repl, /_jobs\.stopAll\(/, 'and the shell jobs, which are real child processes');
    assert.match(repl, /harnesslink'\)\.shutdown/, 'and the harness takes its services with it');
  });
};
