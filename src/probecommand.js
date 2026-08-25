'use strict';

/**
 * `/mcp probe` — the command surface for the Probe seam.
 *
 * Kept out of `commands.js` for the reason the architecture guard exists: the
 * Probe is a whole second seam beside the desktop bridge, and a command module
 * that absorbs every seam is how V1's 17,511-line repl.js happened. This owns
 * the words the user reads; `probe.js` owns the connection.
 *
 * THE PROBE ASKS FOR ITS OWN PERMISSION, in its own always-on-top window, per
 * capability, at the moment it acts. Nothing here re-implements that or gates
 * it a second time — asking the user twice for one decision is how prompts
 * become things people click through without reading.
 *
 * WHAT THIS DOES ASK, ONCE, is LAIN's own desktop question, and only because
 * the alternative was asking it every ten minutes for the length of a session
 * the user had already started and was watching. See `authoriseSession` below
 * for the trace and for exactly what a yes does and does not buy.
 */

const probeMod = require('./probe');

/** `/mcp probe` and `/mcp stop probe`. Returns true if it handled the input. */
function handles(sub, args) {
  return sub === 'probe'
    || (sub === 'stop' && String(args[1] || '').toLowerCase() === 'probe');
}

async function run(app, sub, w, C) {
  if (!app._probe) app._probe = new probeMod.Probe(app.cfg, app);
  const probe = app._probe;

  if (sub === 'stop') {
    probe.close('you stopped it');
    w('  ' + C.green('STOPPED') + C.dim(' - the Probe is closed') + '\n');
    return;
  }

  const st = probe.status();
  if (!st.configured) {
    w('  ' + C.yellow('NOT CONFIGURED') + C.dim(' - ' + st.reason) + '\n');
    w(C.dim('    add to ' + require('./config').configFile() + ':') + '\n');
    w(C.dim('    "probe": { "python": "<absolute path to python 3.11>",') + '\n');
    w(C.dim('               "path": "<path to lain-probe>" }') + '\n');
    w(C.dim('    you choose the target in the Probe window; no allowlist needed.') + '\n');
    if (st.tried && st.tried.length) w(C.dim('    looked in: ' + st.tried.join(', ')) + '\n');
    return;
  }

  w(C.dim('  starting the Probe... it opens a window of its own.') + '\n');
  wire(app, probe);

  const r = await probe.connect(app.session ? app.session.cwd : (app.cwd || process.cwd()));
  if (!r.ok) { w('  ' + C.red('FAILED ' + r.state) + C.dim(' - ' + r.reason) + '\n'); return; }
  w('  ' + C.green('CONNECTED') + C.dim('  ' + r.info.name + (r.info.version ? ' ' + r.info.version : '')) + '\n');
  w(C.dim('    ' + r.capabilities.length + ' tool(s) available') + '\n');
  w(C.dim('    project: ' + probe.projectRoot) + '\n');
  // THE TARGET POLICY, EVERY TIME. A restriction inherited from a config key
  // written months ago is invisible until it refuses somebody.
  const pol = probe.status();
  if (pol.targetRestricted) {
    w('    ' + C.yellow('target policy: ' + pol.targetPolicy) + '\n');
    w(C.dim('    only those names can be authorised. remove "allowTargets" from') + '\n');
    w(C.dim('    ' + require('./config').configFile() + ' to choose any process.') + '\n');
  } else {
    w(C.dim('    target policy: USER SELECTABLE - pick the process in the Probe window') + '\n');
  }
  await capabilityStatus(probe, w, C);
  await authoriseSession(app, probe, w, C);
}

/**
 * ASK ONCE, FOR THE SESSION — the fix for the prompt that kept coming back.
 *
 * WHAT WAS HAPPENING. LAIN's own desktop gate (permissions.js) had two scopes,
 * both measured in minutes. Screen and input reach the Probe through that gate,
 * so an investigation the user had started and was watching raised the same
 * modal every ten minutes: same Probe, same window, same question, already
 * answered. It read as a malfunction and it trained the answer out of anybody
 * who used it for an hour.
 *
 * WHAT IT DOES NOW. `/mcp probe` is the moment the user says what this session
 * is for, so it is the moment to ask — once, in words, with the Probe's own
 * name on it. A yes is bound to THIS CONNECTION and ends when the connection
 * does; see permissions.js SCOPE and probe.js `_endAuthorisation`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   IT DOES NOT WEAKEN THE GATE. Declining changes nothing about how LAIN
 *     behaves — the model is still asked at the moment an action needs a
 *     capability, exactly as before. This buys the user one question instead of
 *     six; it does not buy the model anything it could not already ask for.
 *
 *   IT DOES NOT REACH ANY OTHER TOOL. The grant is for the four desktop
 *     capabilities and nothing else. Reading a file, running a command and
 *     editing code are not Probe operations and are not gated by this.
 *
 *   IT DOES NOT ASK WITHOUT A SCREEN. On a pipe or in a test there is nobody to
 *     ask, and recording a denial for a question nobody was shown would be a
 *     refusal the user never made.
 */
async function authoriseSession(app, probe, w, C) {
  const canAsk = Boolean(app.ui && app.ui.enabled);
  if (!canAsk) {
    w(C.dim('    the model can now investigate through it; screen and input still ask') + '\n');
    w(C.dim('    for permission when they are needed. /mcp revoke reaches it too.') + '\n');
    return;
  }
  let r = { ok: false };
  try {
    r = await require('./permissions').request(app, {
      caps: ['screen', 'window', 'mouse', 'keyboard'],
      reason: `the Probe session you just started (${probe.info && probe.info.name ? probe.info.name : 'lain-probe'})`,
    });
  } catch { r = { ok: false, why: 'the request could not be shown' }; }

  if (r.ok && r.scope === 'probe') {
    w('  ' + C.green('AUTHORISED') + C.dim('  for this Probe session — you will not be asked again') + '\n');
    w(C.dim('    it ends when the Probe exits, or immediately on /mcp revoke.') + '\n');
    return;
  }
  if (r.ok) {
    // A shorter scope was chosen deliberately. Say what was actually bought
    // rather than implying the session is covered.
    w('  ' + C.green('ALLOWED') + C.dim(`  ${r.scope} — you will be asked again when it lapses`) + '\n');
    return;
  }
  w('  ' + C.dim('not authorised in advance — screen and input will ask when they are needed') + '\n');
  w(C.dim('    the Probe still works; investigation calls need no desktop permission.') + '\n');
}

/**
 * WHERE THE PATH IS BROKEN, not merely that it is.
 *
 * `CONNECTED` was the whole answer, and it is compatible with every capability
 * being ungranted and no process being authorised — which is exactly the state
 * a real Probe sits in at rest. So "it says CONNECTED, why did the click not
 * happen" had no answer on any screen: the connection, the capability grant and
 * the target authorisation are three separate facts and only the first was
 * shown. See capability.js.
 *
 * Read from the Probe every time rather than cached, because a grant made in
 * the Probe window a second ago is precisely what someone runs this to check.
 */
async function capabilityStatus(probe, w, C) {
  const cap = require('./capability');
  const snap = await cap.readState(probe);

  if (snap.capabilities) {
    const rows = Object.entries(snap.capabilities);
    const granted = rows.filter(([, v]) => v.granted);
    w('\n' + C.dim('  capabilities') + C.dim(snap.permissionSource ? '   ' + snap.permissionSource : '') + '\n');
    // Three to a row: fifteen capabilities as fifteen lines would push the
    // target — the thing more often actually wrong — off the screen.
    for (let i = 0; i < rows.length; i += 3) {
      const cells = rows.slice(i, i + 3).map(([k, v]) => {
        const mark = v.granted ? C.green('✓') : C.dim('○');
        return `${mark} ${(v.granted ? k : C.dim(k))}${' '.repeat(Math.max(0, 20 - k.length))}`;
      });
      w('    ' + cells.join('') + '\n');
    }
    if (!granted.length) {
      w(C.dim('    none granted yet — the Probe asks when an action needs one') + '\n');
    }
  } else {
    w('\n  ' + C.yellow('capabilities UNKNOWN') + C.dim(' - this Probe does not report permission state') + '\n');
  }

  if (snap.target) {
    w('\n' + C.dim('  target') + '\n');
    if (snap.target.authorized) {
      w('    ' + C.green('✓ ' + (snap.target.selected || 'authorised'))
        + C.dim(snap.target.attached ? '  attached' : '  not attached') + '\n');
    } else {
      w('    ' + C.yellow('! ' + (snap.target.reason || 'no authorised target')) + '\n');
      if (snap.target.note) w(C.dim('    ' + String(snap.target.note).slice(0, 88)) + '\n');
    }
  } else {
    w('\n  ' + C.yellow('target UNKNOWN') + C.dim(' - this Probe does not report target status') + '\n');
  }

  // THE AIMING PROBLEM, STATED ONCE, WHERE SOMEBODY WILL READ IT. Input is
  // addressed to screen coordinates and to whatever holds keyboard focus; an
  // authorised target does not aim it. Somebody debugging "it clicked the wrong
  // thing" needs this sentence more than any other on this screen.
  w('\n' + C.dim('  note: mouse and keyboard actions address SCREEN COORDINATES and the') + '\n');
  w(C.dim('  focused window - authorising a process does not aim them at it.') + '\n');
  for (const n of snap.notes) w(C.dim('  ' + n) + '\n');
}

/**
 * ONE CONVERSATION.
 *
 * A line typed in the Probe window is handed to the same emitter a line typed
 * at LAIN's prompt goes to, so it is classified, queued, or treated as an
 * answer to an outstanding question by the code that already does all three.
 * The Probe has no LLM and starts no turn of its own — wiring it any other way
 * would put a second orchestrator in one session.
 */
function wire(app, probe) {
  if (probe._wired) return;
  probe._wired = true;
  // AND THE OTHER DIRECTION: what LAIN is doing, as named facts. The window
  // used to receive only the model's final prose and had to infer everything
  // else from its wording — a second state machine, which is exactly what the
  // one-source-of-truth rule forbids. See companion.js and events.js.
  require('./companion').attach(app, probe);
  probe.onEvent(async (ev) => {
    if (ev.event !== 'user.message' || !ev.text) return;
    // THE LIVE INVESTIGATION STATE RIDES THIS MESSAGE. The Probe owns the
    // investigation (target, stage, intelligence); LAIN owns the conversation.
    // Stashing the snapshot here is how a Probe-window turn is decorated with
    // what the investigation currently IS, instead of asking the model to
    // re-derive it or fall back to generic CLI behaviour (probeskill.js).
    // A Probe that sends `investigation` carries state; one that sends null
    // explicitly says there is none now, and a Probe that never sends the
    // field (an older runtime) keeps whatever was last carried.
    if ('investigation' in ev) {
      probe._investigation = ev.investigation ? String(ev.investigation) : '';
    }
    const text = String(ev.text);
    // `from` is the ONLY thing that distinguishes this from a typed line, and
    // it exists so the turn can be told what kind of turn it is (probeskill.js).
    // It is not a second input path: everything downstream is identical.
    if (app.input && typeof app.input.emit === 'function') {
      app.input.emit('input', { text, isPaste: false, from: 'probe' });
    } else {
      await app.handle(text, { from: 'probe' });   // one-shot or a test harness
    }
  });
}

/** The Probe's rows in `/mcp status`. */
async function status(app, w, C) {
  if (!app._probe) return;
  const ps = app._probe.status();
  const ok = ps.state === probeMod.STATE.CONNECTED;
  w('\n  ' + 'Probe'.padEnd(20) + (ok ? C.green('CONNECTED') : C.dim('- ' + ps.state)) + '\n');
  if (!ok) {
    if (ps.reason) w('  ' + 'Reason'.padEnd(20) + C.dim(ps.reason) + '\n');
    return;
  }
  w('  ' + 'Tools'.padEnd(20) + C.dim(String(ps.capabilities.length)) + '\n');
  w('  ' + 'Project'.padEnd(20) + C.dim(ps.projectRoot || '-') + '\n');
  const perms = await app._probe.permissions();
  const active = perms && perms.active ? perms.active : [];
  w('  ' + 'Probe allows'.padEnd(20)
    + (active.length ? C.yellow(active.join(', ')) : C.dim('nothing')) + '\n');
}

module.exports = { handles, run, wire, status };
