'use strict';

/**
 * THE HARNESS — one object that owns the runtime, the processes, the browser,
 * the observation plane and the verification engine, and wires them together.
 *
 * ------------------------------------------------------------------------
 * WHY A FACADE, WHEN A FACADE IS USUALLY A SMELL.
 *
 * Because the alternative is worse and was tried first. Every one of these
 * pieces needs two or three of the others: a verification check needs the
 * process manager to ask whether the dev server is healthy AND the browser to
 * run a flow AND the runtime to file the screenshot. Wiring that at each call
 * site means every caller — the turn loop, five CLI commands, the dashboard —
 * assembles the same context object, and the day one of them forgets the
 * browser, browser checks silently return INCONCLUSIVE with a confusing reason.
 *
 * So the wiring happens once, here, and `ctx()` is the assembled context. This
 * file holds no policy and no state of its own; everything it exposes belongs
 * to one of the modules it composes.
 *
 * ------------------------------------------------------------------------
 * IT ATTACHES TO AN App AND SURVIVES WITHOUT ONE.
 *
 * `Harness.forApp(app)` is what production uses. A unit test constructs one
 * with `{workspace, persist:false}` and gets the whole thing in memory with no
 * bus, no session and no disk. That is not a testing convenience bolted on — it
 * is the same property every module in this project has, and the reason the
 * suite can run thousands of tests in one process.
 */

const { EventBus, EVENT } = require('../events');
const { TaskRuntime } = require('./runtime');
const { ProcessManager } = require('./processes');
const { BrowserHarness } = require('./browserharness');
const { Observatory } = require('./observation');
const verify = require('./verify');
const recovery = require('./recovery');
const registry = require('./registry');
const timeline = require('./timeline');
const state = require('./state');
const { ArtifactStore, KIND } = require('./artifacts');

class Harness {
  constructor({ app = null, bus = null, workspace = null, persist = true } = {}) {
    this.app = app;
    this.workspace = String(workspace || (app && app.cwd) || process.cwd());
    // THE APP'S BUS IF THERE IS ONE. A harness with its own private bus beside
    // the app's would put half the facts on one channel and half on the other,
    // and the companion window would show a timeline with holes in it.
    this.bus = bus || (app && app.events) || new EventBus();
    this.runtime = new TaskRuntime({ bus: this.bus, workspace: this.workspace, persist });
    this.processes = new ProcessManager({ bus: this.bus, runtime: this.runtime });
    this.browser = new BrowserHarness({ bus: this.bus, runtime: this.runtime, processes: this.processes });
    this.observer = new Observatory({ runtime: this.runtime });
    this.attempts = new recovery.Attempts();
    this.registry = registry;
    this._cleanups = new Map();
    this._cleanupErrors = [];
    this._offCleanup = this.bus.on((ev) => {
      if (ev.type === EVENT.TASK_STATE && state.TERMINAL.has(ev.to)) {
        this.cleanupTask(ev.taskId).catch((e) => this._cleanupErrors.push(e));
      }
    });
  }

  static forApp(app) { return new Harness({ app }); }

  /**
   * THE CONTEXT every check and every observation is run with.
   *
   * Assembled in one place — see the header. `taskId` defaults to the active
   * task, so a caller that has one need not pass it and a caller that does not
   * still gets a working context.
   */
  ctx(taskId = null, extra = {}) {
    return {
      cwd: this.workspace,
      taskId: taskId || this.runtime.activeId,
      processes: this.processes,
      browser: this.browser,
      observer: this.observer,
      app: this.app,
      runtime: this.runtime,
      signal: (this.app && this.app.signal) || null,
      ...extra,
    };
  }

  // ------------------------------------------------------------ the verbs --

  /** Open a task. See runtime.create — created is not started. */
  begin({ title = '', objective = '', sessionId = null } = {}) {
    return this.runtime.create({ title, objective, sessionId });
  }

  /**
   * PROVE IT.
   *
   * The one call that produces a verdict: runs the contract, keeps the report
   * as an artifact, and settles the task from the result. A task that was not
   * already VERIFYING is moved there first, because a verdict without a
   * verification phase is exactly the shortcut state.js exists to prevent.
   */
  async verify(contract, { taskId = null, settle = true } = {}) {
    const id = taskId || this.runtime.activeId;
    const task = id ? this.runtime.get(id) : null;
    // A BLOCKED TASK IS UNBLOCKED BY SOMEBODY ASKING FOR EVIDENCE. It reached
    // BLOCKED because it was waiting on something outside itself, and running a
    // contract IS that something happening. Without this the checks ran, the
    // report printed, and the state silently did not move — because BLOCKED
    // cannot become PASSED — which reads as the command having done nothing.
    if (task && task.state === state.STATE.BLOCKED) {
      this.runtime.resume(id, 'a verification contract was run');
    }
    if (task && this.runtime.get(id).state === state.STATE.RUNNING) {
      this.runtime.verifying(id, 'a verification contract was run');
    }
    const report = await verify.run(contract, this.ctx(id));
    if (id) {
      this.runtime.keep(id, {
        kind: KIND.VERIFICATION,
        name: `${report.verdict.toLowerCase()}.txt`,
        body: verify.render(report),
        note: report.why,
      });
      // THE OUTPUT OF EVERY CHECK IS KEPT SEPARATELY. A test run's 4,000 lines
      // do not belong in the summary a person reads, and they are exactly what
      // somebody wants twenty minutes later. Kept beside it, named, addressable.
      for (const req of report.requirements) {
        for (const c of req.checks) {
          if (!c.output) continue;
          this.runtime.keep(id, {
            kind: c.kind === 'tests' ? KIND.TEST : KIND.LOG,
            name: `${c.label}.txt`, body: c.output, note: c.why,
          });
        }
      }
      if (settle && task && !task.terminal) {
        this.runtime.settle(id, report);
        if (task.terminal) await this.cleanupTask(id);
      }
    }
    return report;
  }

  /**
   * WHAT SHOULD HAPPEN ABOUT THIS FAILURE. See recovery.js — it classifies and
   * recommends; nothing here acts on the recommendation.
   */
  recover(failure, operation = '') {
    const verdict = recovery.recommend(failure, { operation, attempts: this.attempts });
    this.bus.emit(EVENT.RECOVERY_STARTED, {
      taskId: String(this.runtime.activeId || ''), kind: verdict.kind, action: verdict.action, why: verdict.why,
    });
    return verdict;
  }

  /** Ask something, without having to know how it would be answered. */
  observe(goal, spec = {}, taskId = null) {
    return this.observer.observe(goal, spec, this.ctx(taskId));
  }

  timeline(taskId = null, opts = {}) { return timeline.build(this, taskId, opts); }

  // ---------------------------------------------------------- the reports --

  /**
   * WHAT THIS HARNESS CAN AND CANNOT DO ON THIS MACHINE, RIGHT NOW.
   *
   * Every row is measured rather than assumed — the browser row probes a port
   * and stats a binary, the bridge row asks mcp.js. `/harness doctor` prints
   * this, and its whole value is that an unavailable capability says WHY.
   */
  async doctor() {
    const rows = [];
    const core = (name, ok, why) => rows.push({ group: 'Core', name, kind: 'core', state: ok ? 'AVAILABLE' : 'MISCONFIGURED', why });
    const opt = (group, name, ok, why) => rows.push({ group, name, kind: 'optional', state: ok ? 'AVAILABLE' : 'UNAVAILABLE', why });
    const req = (group, name, ok, why) => rows.push({ group, name, kind: 'core', state: ok ? 'AVAILABLE' : 'MISCONFIGURED', why });

    // ---- CORE: without these there is no harness -------------------------
    core('CLI', true, `lain ${(() => { try { return require('../../package.json').version; } catch { return '?'; } })()} on node ${process.version}`);
    core('runtime', true, `${this.runtime.list().length} live task(s)`);
    // PERSISTENCE OFF IS A MODE, NOT A FAULT. A test harness and a read-only
    // checkout both run in memory deliberately, and reporting that as
    // MISCONFIGURED would make `ok:false` mean "somebody chose this". What IS
    // a fault is persistence being ON and the directory not being writable, so
    // that is what is actually measured — by writing, not by hoping.
    if (!this.runtime.persist) {
      rows.push({ group: 'Core', name: 'task storage', kind: 'core', state: 'AVAILABLE', why: 'in-memory by request — nothing is written to disk' });
    } else {
      const fs = require('fs');
      const pathMod = require('path');
      const root = require('../lainstore').tasksRoot(this.workspace);
      // ---- A DOCTOR MUST NOT CREATE ANYTHING ------------------------------
      //
      // The obvious probe — mkdir the task root and write a file in it — makes
      // `lain --doctor` leave a `.lain/` behind in whatever directory somebody
      // ran it in. A diagnostic with side effects is a diagnostic people stop
      // running. So the nearest ancestor that ALREADY EXISTS is what gets
      // probed, with a uniquely-named temp file that is removed immediately.
      let probeDir = root;
      while (!fs.existsSync(probeDir)) {
        const up = pathMod.dirname(probeDir);
        if (up === probeDir) break;
        probeDir = up;
      }
      let writable = false;
      let why = root;
      try {
        const probeFile = pathMod.join(probeDir, `.lain-writable-${process.pid}-${require('crypto').randomUUID()}`);
        fs.writeFileSync(probeFile, '', { flag: 'wx' });
        fs.unlinkSync(probeFile);
        writable = true;
        if (probeDir !== root) why = `${root} (will be created; ${probeDir} is writable)`;
      } catch (e) { why = `${probeDir} is not writable: ${(e && e.code) || (e && e.message) || e}`; }
      core('task storage', writable, why);
    }
    core('event integration', Boolean(this.bus),
      `${this.bus.recent(200).length} recent event(s), ${this.bus.dropped} dropped by broken subscribers`);

    // ---- EXECUTION -------------------------------------------------------
    const shell = process.platform === 'win32' ? 'powershell / cmd' : (process.env.SHELL || '/bin/sh');
    req('Execution', 'shell', true, shell);
    const procs = this.processes.list();
    req('Execution', 'process manager', true, procs.length ? procs.map((p) => `${p.name}=${p.status}`).join(', ') : 'no managed services');

    // ---- OBSERVATION -----------------------------------------------------
    req('Observation', 'filesystem', true, this.workspace);
    req('Observation', 'logs', true, 'managed service output is captured');
    let git = false;
    try { git = (await require('../gitsense').status(this.workspace)).ok === true; } catch { git = false; }
    opt('Observation', 'git', git, git ? 'this is a git repository' : 'not a git repository — change observation falls back to the filesystem');
    const browser = await this.browser.availability();
    opt('Observation', 'browser', browser.available, browser.why);
    if (browser.state === 'MISCONFIGURED') rows[rows.length - 1].state = browser.state;

    // ---- VERIFICATION ----------------------------------------------------
    //
    // READ FROM THE PROJECT rather than assumed. "Tests: available" on a tree
    // with no suite is the false report testing.js exists to prevent.
    let profile = { found: [], empty: true };
    try { profile = require('./profile').forProject(this.workspace); } catch { /* keep the honest default */ }
    const has = (re) => profile.found.some((f) => re.test(f));
    req('Verification', 'contracts', true, 'command · http · file · process checks always available');
    opt('Verification', 'tests', has(/test|pytest|cargo test|go test/i),
      has(/test|pytest|cargo test|go test/i) ? profile.found.filter((f) => /test/i.test(f)).join(' · ') : 'this project declares no test suite');
    opt('Verification', 'build', has(/build|compile|typecheck|tsc/i),
      has(/build|compile|typecheck|tsc/i) ? profile.found.filter((f) => /build|typecheck|compile/i.test(f)).join(' · ') : 'this project declares no build');
    opt('Verification', 'browser flows', browser.available, browser.available ? 'browser checks can run' : 'browser checks will be INCONCLUSIVE');

    // ---- OPTIONAL --------------------------------------------------------
    let bridge = false;
    let bridgeWhy = 'no desktop bridge configured';
    try {
      const cfg = (this.app && this.app.cfg) || require('../config').load();
      const configured = require('../mcp').configured(cfg);
      const transport = this.app && this.app._desktop && this.app._desktop.bridge;
      bridge = Boolean(transport && transport.state === 'CONNECTED');
      if (bridge) bridgeWhy = 'a desktop bridge completed its handshake; permissions still apply';
      else if (configured) bridgeWhy = 'a desktop bridge is configured; no live handshake has been observed';
    } catch (e) { bridgeWhy = `the bridge module could not be read: ${(e && e.message) || e}`; }
    opt('Optional', 'desktop bridge', bridge, bridgeWhy);
    let remote = false;
    let remoteWhy = 'the supervisor is not running — background work will not outlive this process';
    try {
      const sup = require('../supervisor');
      remote = Boolean(sup.binary());
      if (remote) remoteWhy = 'the supervisor binary is present';
    } catch { /* keep the honest default */ }
    opt('Optional', 'supervisor binary', remote, remoteWhy);
    let remoteStatus = null;
    try { remoteStatus = await require('../remotecontrol').status(); } catch { /* no runtime answered */ }
    opt('Remote', 'remote control', Boolean(remoteStatus && remoteStatus.available),
      remoteStatus && remoteStatus.available ? 'the runtime answered; channel configuration and authorization still apply' : 'no runtime answered the remote protocol');
    opt('Remote', 'remote Harness projection', false, 'projection schema exists; no Rust transport publishes Harness task evidence');
    // ZERO HOOKS IS THE ORDINARY STATE, not a missing capability — the
    // mechanism is there either way. What would be worth flagging is a hook
    // that has been THROWING, which is a real misconfiguration somebody wrote.
    const hookFails = this.runtime.hooks.failures.length;
    rows.push({
      group: 'Optional', name: 'hooks', kind: 'optional',
      state: hookFails ? 'MISCONFIGURED' : 'AVAILABLE',
      why: `${this.runtime.hooks.count()} registered${hookFails ? `, ${hookFails} throwing` : ''}`,
    });
    return rows;
  }

  /**
   * THE ONE-LINE VERDICT a caller acts on.
   *
   * CORE MISCONFIGURED is the only thing that means "this does not work".
   * An unavailable OPTIONAL capability is not an error and must never be
   * reported as one — an install that failed because Docker was absent would
   * fail on every server in the world.
   */
  static summarise(rows) {
    const broken = rows.filter((r) => r.kind === 'core' && r.state !== 'AVAILABLE');
    const missing = rows.filter((r) => r.kind === 'optional' && r.state === 'UNAVAILABLE');
    const wrong = rows.filter((r) => r.kind === 'optional' && r.state === 'MISCONFIGURED');
    return {
      ok: broken.length === 0,
      broken: broken.map((r) => r.name),
      unavailable: missing.map((r) => r.name),
      misconfigured: wrong.map((r) => r.name),
      why: broken.length
        ? `core capabilities are misconfigured: ${broken.map((r) => r.name).join(', ')}`
        : `core is available${missing.length ? `; optional unavailable: ${missing.map((r) => r.name).join(', ')}` : ''}`,
    };
  }

  /** Every capability, normalised. See registry.js. */
  capabilities() { return registry.all(this.app); }

  /**
   * THE STATE EVERY SURFACE READS — the CLI, the dashboard, a remote client.
   *
   * ONE SHAPE. Three readers computing their own view of "is it done" is the
   * thing this whole design replaces, so this is the only projection and they
   * all take it.
   */
  snapshot() {
    const task = this.runtime.snapshot();
    return {
      workspace: this.workspace,
      task,
      activity: require('./activity').project(task, this.bus.recent(200)),
      tasks: this.runtime.list().map((t) => ({
        id: t.id, title: t.title, state: t.state, tone: t.tone, updatedAt: t.updatedAt,
      })),
      processes: this.processes.list().map((p) => p.toJSON()),
      events: this.bus.recent(20).length,
      persisted: this.runtime.persist,
    };
  }

  // -------------------------------------------------------------- shutdown --

  /**
   * TAKE EVERYTHING DOWN. Safe to call twice, and called on exit.
   *
   * This is the answer to the orphaned-process failure this repository already
   * paid for: services and browsers are owned, so there is one call that ends
   * all of them rather than a teardown per call site that a timeout can skip.
   */
  cleanupTask(taskId) {
    if (this._cleanups.has(taskId)) return this._cleanups.get(taskId);
    const work = (async () => {
      try { await this.browser.close(taskId); }
      finally { await this.processes.cleanup(taskId); }
    })();
    this._cleanups.set(taskId, work);
    return work;
  }

  async shutdown() {
    this._offCleanup();
    const results = await Promise.allSettled([...this._cleanups.values()]);
    try { await this.browser.close(); }
    finally {
      try { await this.processes.cleanup(); }
      finally { this.runtime.detach(); }
    }
    const failed = results.find((r) => r.status === 'rejected');
    if (failed || this._cleanupErrors.length) throw (failed ? failed.reason : this._cleanupErrors[0]);
  }
}

module.exports = {
  Harness,
  // Re-exported so a caller needs one require. The modules remain the owners;
  // this is a doorway, not a second definition.
  STATE: state.STATE, VERDICT: verify.VERDICT, ARTIFACT: KIND,
  verify, recovery, registry, timeline, state,
  TaskRuntime, ProcessManager, BrowserHarness, Observatory, ArtifactStore,
};
