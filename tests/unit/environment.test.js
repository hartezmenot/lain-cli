'use strict';

/**
 * THE ENVIRONMENT IS THE ENFORCEMENT, NOT THE SUGGESTION.
 *
 * The failure this covers was measured: "Find my health." typed at the ordinary
 * CLI prompt was classified as a generic IMPLEMENT request, and the model
 * searched the filesystem for a value that only exists in a live process. The
 * routing decision used to depend on the model remembering which workspace it
 * was in; these tests pin the runtime doing the remembering instead:
 *
 *   - a Probe task typed at the CLI enters the PROBE environment (routing)
 *   - while it is entered, a CLI tool call is refused at the gate (no fallback)
 *   - the environment survives a Probe disconnect (no silent demotion)
 *   - the objective the user typed is the objective Probe receives (round trip)
 */

const assert = require('assert');
const { test } = require('../helpers');
const environment = require('../../src/environment');
const probetask = require('../../src/probetask');
const probeskill = require('../../src/probeskill');

/** A minimal stand-in for the App: the environment keys off session.id only. */
function fakeApp(id = 'test-session') {
  return { session: { id }, _probe: null };
}

module.exports = async function () {
  // ---------------------------------------------------------------- routing
  await test('PROBE ROUTING: runtime-investigation wording classifies as a Probe task', async () => {
    for (const text of [
      'inspect this target',
      'find my health in the running game',
      'watch this process and tell me what changes',
      'continue the investigation',
      'implement the finding',
      'validate the artifact',
      'observe what changes when I open a chest',
      'the value at 0x7FF6A1B2C3D4 changed 14 times',
      'attach to authorized-test.exe and scan memory for floats',
    ]) {
      assert.ok(probetask.PROBE_TASK_RE.test(text),
        `"${text}" must classify as a Probe task`);
    }
  });

  await test('PROBE ROUTING: ordinary CLI work does not classify as a Probe task', async () => {
    for (const text of [
      'scan the project for TODO comments',
      'refactor the session module and add tests',
      'watch the test suite while it runs, then summarize failures',
      'what does environment.js do?',
    ]) {
      assert.ok(!probetask.PROBE_TASK_RE.test(text),
        `"${text}" must NOT classify as a Probe task`);
    }
  });

  await test('PROBE ROUTING: a classified task with a live Probe enters the PROBE environment', async () => {
    environment._reset();
    const app = fakeApp();
    const r = environment.enterProbe(app, {
      objective: 'find the runtime location of player position',
      probeSessionId: 'probe-1',
      targetSummary: 'authorized-test.exe pid 1234 x64',
      reason: 'test handoff',
    });
    assert.strictEqual(r.environment, 'PROBE');
    assert.strictEqual(r.entered, true, 'first entry is a real handoff');
    const st = environment.describe(app);
    assert.strictEqual(st.environment, 'PROBE');
    assert.strictEqual(st.objective, 'find the runtime location of player position');
    assert.strictEqual(st.probeSessionId, 'probe-1');
    assert.strictEqual(st.metrics.probe_entries, 1);
    assert.strictEqual(st.metrics.probe_handoffs, 1);
  });

  await test('PROBE ROUTING: continuing an active investigation is a turn, not a second handoff', async () => {
    environment._reset();
    const app = fakeApp();
    environment.enterProbe(app, { objective: 'first objective' });
    const r = environment.enterProbe(app, { objective: 'continue the investigation' });
    assert.strictEqual(r.entered, false, 'no second handoff for the same task');
    assert.strictEqual(r.metrics.probe_entries, 2, 'entries count every entry attempt');
    assert.strictEqual(r.metrics.probe_handoffs, 1, 'one handoff per task');
    assert.strictEqual(r.metrics.cli_fallbacks, 0);
  });

  await test('PROBE ROUTING: sessions do not leak environment state into each other', async () => {
    environment._reset();
    const a = fakeApp('session-a');
    const b = fakeApp('session-b');
    environment.enterProbe(a, { objective: 'a probe task' });
    assert.strictEqual(environment.describe(b).environment, 'CLI',
      'a second conversation must not inherit the first one\'s environment');
    environment._reset();
  });

  // ----------------------------------------------------------- no fallback
  await test('NO FALLBACK: while PROBE is active, a CLI tool call is refused at the gate', async () => {
    environment._reset();
    const app = fakeApp();
    environment.enterProbe(app, { objective: 'inspect the target' });
    for (const name of ['read_file', 'grep', 'run_bash', 'list_dir', 'apply_patch']) {
      const v = environment.checkToolAllowed(name, app);
      assert.strictEqual(v.ok, false, `${name} must be refused in the PROBE environment`);
      assert.ok(/probe\.bridge_cli/.test(v.output),
        `the refusal of ${name} must name the explicit bridge`);
    }
  });

  await test('NO FALLBACK: probe operations and ask_user stay reachable', async () => {
    environment._reset();
    const app = fakeApp();
    environment.enterProbe(app, { objective: 'inspect the target' });
    for (const name of ['probe', 'probe_bridge_cli', 'probe.bridge_cli', 'ask_user']) {
      const v = environment.checkToolAllowed(name, app);
      assert.strictEqual(v.ok, true, `${name} must stay available in the PROBE environment`);
    }
  });

  await test('NO FALLBACK: the gate adds nothing to ordinary CLI work', async () => {
    environment._reset();
    const app = fakeApp();
    for (const name of ['read_file', 'run_bash', 'write_file', 'grep']) {
      assert.strictEqual(environment.checkToolAllowed(name, app).ok, true,
        `${name} must be untouched in the CLI environment`);
    }
  });

  await test('NO FALLBACK: the environment survives a Probe disconnect', async () => {
    environment._reset();
    const app = fakeApp();
    environment.enterProbe(app, { objective: 'inspect the target', probeSessionId: 'probe-1' });
    // The Probe process dies; the session's environment does not silently flip
    // back to CLI, because an investigation interrupted by a dropped connection
    // is still an investigation.
    app._probe = null;
    const v = environment.checkToolAllowed('read_file', app);
    assert.strictEqual(v.ok, false,
      'a dropped connection must not silently demote the environment');
    const st = environment.describe(app);
    assert.strictEqual(st.probeConnected, false);
    assert.strictEqual(st.probeSessionId, 'probe-1',
      'the session id survives so the resume path can find it');
  });

  // ------------------------------------------------------- explicit bridge
  await test('BRIDGE: the bridge counts a CLI-level operation without refusing it', async () => {
    environment._reset();
    const app = fakeApp();
    environment.enterProbe(app, { objective: 'inspect the target' });
    assert.strictEqual(environment.describe(app).metrics.cli_fallbacks, 0);
    // Note the metric the way the bridge tool does.
    environment.note(app, 'cli_fallbacks');
    assert.strictEqual(environment.describe(app).metrics.cli_fallbacks, 1);
  });

  // ------------------------------------------------------------- round trip
  await test('ROUND TRIP: off -> on -> off restores ordinary CLI work', async () => {
    environment._reset();
    const app = fakeApp();
    assert.strictEqual(environment.describe(app).isProbe, false);

    environment.enterProbe(app, { objective: 'inspect the target' });
    assert.strictEqual(environment.checkToolAllowed('read_file', app).ok, false);
    assert.strictEqual(environment.describe(app).isProbe, true);

    environment.enterCli(app, 'task complete');
    assert.strictEqual(environment.describe(app).isProbe, false);
    assert.strictEqual(environment.checkToolAllowed('read_file', app).ok, true,
      'after the explicit exit, CLI tools are ordinary again');

    // ...and re-entering counts a fresh handoff, because it is a new task.
    const r = environment.enterProbe(app, { objective: 'a new task' });
    assert.strictEqual(r.entered, true);
    assert.strictEqual(r.metrics.probe_handoffs, 2);
  });

  // -------------------------------------------------------------- prompting
  await test('LLM CONTEXT: a PROBE-environment turn states the environment and the objective, compactly', async () => {
    environment._reset();
    const app = fakeApp();
    app._probe = { state: 'CONNECTED', _investigation: '# ACTIVE PROBE INVESTIGATION\nTarget:\n  Process: authorized-test.exe' };
    environment.enterProbe(app, {
      objective: 'determine the runtime location of player position',
      probeSessionId: 'probe-1',
      targetSummary: 'authorized-test.exe pid 1234 x64',
    });
    const sys = probeskill.decorate(app, 'BASE SYSTEM PROMPT', 'terminal');
    assert.ok(sys.includes('BASE SYSTEM PROMPT'));
    assert.ok(sys.includes('EXECUTION ENVIRONMENT: PROBE'));
    assert.ok(sys.includes('determine the runtime location of player position'),
      'the objective the user typed must reach the model verbatim');
    assert.ok(sys.includes('probe.bridge_cli'), 'the bridge must be named');
    assert.ok(sys.includes('ACTIVE PROBE INVESTIGATION'),
      'the Probe\'s own compact state must ride the prompt');
    // COMPACT BY RULE: the chat transcript never rides the Probe context.
    assert.ok(!/provider|api key|model id/i.test(sys),
      'no provider or identity metadata leaks into the Probe context');
  });

  await test('LLM CONTEXT: an ordinary CLI turn is not decorated with Probe state', async () => {
    environment._reset();
    const app = fakeApp();
    const sys = probeskill.decorate(app, 'BASE', 'terminal');
    assert.strictEqual(sys, 'BASE');
  });

  await test('METRICS: the ledger carries every counter the acceptance criteria name', async () => {
    environment._reset();
    const app = fakeApp();
    const names = ['probe_entries', 'probe_handoffs', 'cli_fallbacks',
      'repeated_scans', 'repeated_hypotheses', 'imported_intelligence_reused',
      'verified_findings', 'implementation_attempts', 'validation_attempts',
      'repair_cycles'];
    for (const n of names) {
      environment.note(app, n, 1);
    }
    const m = environment.describe(app).metrics;
    for (const n of names) assert.strictEqual(m[n], 1, `${n} must be present and bumpable`);
  });
};
