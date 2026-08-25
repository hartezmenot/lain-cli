'use strict';
/**
 * END-TO-END EXERCISE: the CLI -> Probe -> verified-result path, driven through
 * the real modules (no LLM, no live target). Proves the acceptance path:
 *
 *   CLI text -> PROBE classification -> environment entry (objective verbatim)
 *   -> CLI tool refused at the gate -> Probe vocabulary still reachable
 *   -> the turn prompt carries the environment + objective, compactly
 *   -> explicit bridge runs a real shell command and is counted
 *   -> explicit exit restores ordinary CLI work
 */

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const assert = require('assert');
const modeId = require('./src/mode');
const environment = require('./src/environment');
const probetask = require('./src/probetask');
const probeskill = require('./src/probeskill');
const tools = require('./src/tools');
const probeMod = require('./src/probe');

const app = { session: { id: `e2e-${process.pid}` }, _probe: null };
environment._reset(app);

// ---- 1. the classification -------------------------------------------------
const USER_TASK = 'inspect this target and find the runtime location of player position';
const verdict = modeId.classify(USER_TASK);
console.log(`[1] classified: ${verdict.mode} (${verdict.modeReason})`);
assert.strictEqual(verdict.mode, modeId.KIND.PROBE,
  'a runtime-investigation request must classify as PROBE, not IMPLEMENT/CHAT');

// ---- 2. the handoff ---------------------------------------------------------
environment.enterProbe(app, {
  objective: USER_TASK,
  probeSessionId: 'probe-e2e',
  targetSummary: 'authorized-test.exe pid 1234 x64',
  reason: 'e2e: task classified PROBE with a live Probe',
});
let st = environment.describe(app);
assert.strictEqual(st.environment, 'PROBE');
assert.strictEqual(st.objective, USER_TASK, 'the objective transfers verbatim');
assert.strictEqual(st.metrics.probe_handoffs, 1);
console.log('[2] environment=PROBE, objective recorded, handoffs=1');

// ---- 3. no accidental fallback ----------------------------------------------
const gate = tools.execute('read_file', { path: 'src/mode.js' }, { app });
gate.then((r) => {
  assert.strictEqual(r.isError, true, 'a CLI tool must be refused while PROBE owns the task');
  assert.ok(/probe\.bridge_cli/.test(r.output), 'the refusal must name the bridge');
  console.log('[3] read_file refused at the gate, bridge named');

  // Probe ops stay reachable...
  const probeAllowed = environment.checkToolAllowed('probe', app);
  assert.strictEqual(probeAllowed.ok, true);
  const bridgeAllowed = environment.checkToolAllowed('probe_bridge_cli', app);
  assert.strictEqual(bridgeAllowed.ok, true);
  // ...and the vocabulary still advertises them with no connection.
  const names = tools.names(app);
  assert.ok(names.includes('probe') && names.includes('probe_bridge_cli'),
    'the PROBE environment must keep the probe vocabulary, connected or not');
  console.log('[4] probe + probe_bridge_cli remain in the active vocabulary');

  // ---- 5. the turn prompt --------------------------------------------------
  app._probe = { state: 'CONNECTED', _investigation: '# ACTIVE PROBE INVESTIGATION\nTarget:\n  Process: authorized-test.exe\nLifecycle stage: OBSERVE' };
  const sys = probeskill.decorate(app, 'BASE SYSTEM PROMPT', 'terminal');
  assert.ok(sys.includes('EXECUTION ENVIRONMENT: PROBE'));
  assert.ok(sys.includes(USER_TASK));
  assert.ok(sys.includes('ACTIVE PROBE INVESTIGATION'));
  assert.ok(sys.includes('probe.bridge_cli'));
  console.log('[5] system prompt carries environment + objective + probe state');

  // ---- 6. the explicit bridge ---------------------------------------------
  const bridge = tools.execute('probe_bridge_cli', {
    command: 'node -e "console.log(\'bridge-ran\')"',
    why: 'checking the artifact landed on disk',
  }, { app });
  return bridge.then((r) => {
    assert.ok(!r.isError, `the bridge must run: ${r.output}`);
    assert.ok(r.output.includes('bridge-ran'), 'the bridge really ran the command');
    assert.ok(r.output.includes('probe.bridge_cli'), 'the trail says what ran, via what');
    st = environment.describe(app);
    assert.strictEqual(st.metrics.cli_fallbacks, 1, 'the bridge is counted');
    console.log('[6] bridge ran a real command; cli_fallbacks=1');

    // ---- 7. exit ----------------------------------------------------------
    environment.enterCli(app, 'e2e: task complete');
    st = environment.describe(app);
    assert.strictEqual(st.isProbe, false);
    return tools.execute('read_file', { path: 'C:/Users/Hartezmenot/Documents/lain-v2/src/mode.js' }, { app, cwd: 'C:/Users/Hartezmenot/Documents/lain-v2' }).then((r2) => {
      assert.ok(!r2.isError, 'after exit, CLI tools are ordinary again');
      console.log('[7] exit restores CLI; read_file succeeds again');

      console.log('\nE2E OK: CLI -> PROBE -> gated -> prompted -> bridged -> verified -> exit');
      environment._reset(app);
    });
  });
}).catch((e) => { console.error(e); process.exit(1); });
