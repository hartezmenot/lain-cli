'use strict';

/**
 * THE ENVIRONMENT SECTIONS OF `/env` — where work runs, which browser runs it.
 *
 * ------------------------------------------------------------------------
 * IT EXTENDS THE EXISTING `/env`; IT DOES NOT DEFINE A SECOND ONE.
 *
 * `/env` already existed (harnesscommands.js) and already reported managed
 * processes, browser availability and health. This adds the EXECUTION
 * ENVIRONMENT and the HARNESS BROWSER to it, as further sections of the same
 * command, reached through the same dispatch. A `/env` of my own would have
 * been a second command with the same name — the registry rejects that outright,
 * and it was right to.
 *
 * ------------------------------------------------------------------------
 * A PROJECTION, NOT A SECOND SOURCE OF TRUTH.
 *
 * Every figure here is read from the authority that already owns it:
 *
 *   the task's environment    the task record (harness), never re-derived
 *   registered VMs            the ONE config authority (env/environments.js)
 *   VMware's state            `vmrun`, at the moment of asking
 *   Chromium                  env/chromium.js, which owns every launch
 *   running browsers          the runtime's own instance list
 *
 * §13 says "do not duplicate process truth. Consume existing Harness process
 * ownership" and that is the whole design of this file: it formats and it
 * refuses to compute. A `/env` that maintained its own idea of which browser
 * was running would be wrong within one turn of anything else changing.
 *
 * ------------------------------------------------------------------------
 * READING IS FREE; ACTING IS EXPLICIT.
 *
 * Bare `/env` launches nothing, downloads nothing and powers on nothing — it
 * stats files and asks `vmrun` for a list. The subcommands that COST something
 * (installing a browser, starting a guest) are separate words a person types,
 * for the same reason model discovery is a route and not a poll.
 */

const PAD = 20;

/**
 * HANDLE ONE `/env` INVOCATION, or decline it.
 *
 * Returns `handled` so the caller can fall through to the sections it owns —
 * `/env processes` is still harnesscommands.js's and must stay that way.
 */
async function sections(app, C, args = []) {
  // `render.write` takes raw text; every caller here passes one line.
  const w = (s) => app.render.write(`${String(s)}\n`);
  const environments = require('./env/environments');
  const chromium = require('./env/chromium');
  const chromiuminstall = require('./env/chromiuminstall');
  const vmware = require('./env/vmware');

  // A COLOUR NAME THAT DOES NOT EXIST MUST NOT TAKE THE COMMAND DOWN.
  // `C.bad` was not in render.js's palette (the names are red/yellow/dim/…)
  // and `C[colour](text)` threw `C[colour] is not a function` halfway through
  // printing — found by running `/env` through the real binary, not by reading.
  // A diagnostic surface that crashes while reporting a diagnostic is the
  // worst possible failure, so an unknown name now degrades to plain text.
  const paint = (name, text) => {
    const fn = name && C && typeof C[name] === 'function' ? C[name] : null;
    return fn ? fn(text) : text;
  };
  const row = (label, value, colour = null) => {
    w(paint(colour, `  ${String(label).padEnd(PAD)}${value}`));
  };

  const sub = String(args[0] || '').toLowerCase();
  const rest = args.slice(1);

  // ---------------------------------------------------------- chromium --
  if (sub === 'chromium') {
    const verb = String(rest[0] || '').toLowerCase();
    if (verb === 'install') {
      const plan = chromiuminstall.plan();
      if (!plan.ok) { w(`  ${plan.why}`); return { handled: true }; }
      w('');
      w(paint('bold', 'Installing the Harness browser'));
      row('version', plan.version);
      row('from', plan.url);
      row('into', plan.dest);
      w('');
      let shown = -1;
      const r = await chromiuminstall.install({
        onProgress(size, total) {
          if (!total) return;
          const pct = Math.floor((size / total) * 100);
          // A PERCENTAGE PER TEN, not per chunk: this is a terminal, and
          // 4,000 progress lines is not progress.
          if (pct >= shown + 10) { shown = pct; w(`  ${String(pct).padStart(3)}%  ${(size / 1048576).toFixed(0)}MB of ${(total / 1048576).toFixed(0)}MB`); }
        },
      });
      w('');
      if (!r.ok) { w(paint('red', `  ${r.why}`)); return { handled: true }; }
      w(r.already ? `  already installed: ${r.path}` : `  installed ${r.version} — ${r.files} files`);
      return { handled: true };
    }
    if (verb === 'remove') {
      const r = chromiuminstall.remove();
      w(r.ok ? `  removed ${r.removed}` : `  ${r.why}`);
      return { handled: true };
    }
    // A bare `/env chromium` is the browser section on its own.
    w('');
    await printChromium(w, row, paint, app, chromium, chromiuminstall);
    return { handled: true };
  }

  // ---------------------------------------------------------------- vm --
  if (sub === 'vm') {
    const id = String(rest[0] || '');
    const verb = String(rest[1] || 'status').toLowerCase();
    if (!id) { w('  /env vm <id> [status|start|stop]'); return { handled: true }; }
    const env = environments.describe(`vm:${id}`);
    if (!env.ok) {
      w(paint('red', `  ${env.why}`));
      if (env.detail) w(`  ${env.detail}`);
      if (env.remedy) w(`  ${env.remedy}`);
      return { handled: true };
    }
    const avail = vmware.available();
    if (!avail.available) {
      w(paint('red', `  ${avail.why}`));
      return { handled: true };
    }
    let r;
    if (verb === 'start') r = await require('./env/guest').ready(env.spec);
    else if (verb === 'stop') r = await vmware.stop(env);
    else r = await vmware.health(env);
    if (!r.ok) {
      w(paint('red', `  ${r.code || 'FAILED'}: ${r.why}`));
      if (r.detail) w(`  ${String(r.detail).split('\n')[0]}`);
      return { handled: true };
    }
    row(id, r.state + (r.ready === false ? ' · not ready' : ''));
    if (r.why) row('', r.why);
    return { handled: true };
  }

  // ------------------------------------------------------- the overview --
  w('');
  w(paint('bold', 'Environment'));
  // WHERE THE CURRENT TASK LIVES. Read from the task record — this is the
  // authoritative binding, not a guess from what happens to be running.
  const task = currentTask(app);
  row('current task', task.spec + (task.why ? `  ${task.why}` : ''));
  row('policy', chromium.forApp(app).policy());

  w('');
  w(paint('bold', 'VMware'));
  const avail = vmware.available();
  if (!avail.available) {
    row('state', avail.state, 'red');
    row('', avail.why);
  } else {
    row('state', avail.state);
    row('vmrun', avail.path);
  }
  const vms = environments.list().filter((e) => e.kind === 'vm');
  if (!vms.length) {
    row('registered', 'none');
    // WHY THERE ARE NONE, because an empty list looks like a failure and
    // this one is a deliberate safety property. See §19.
    row('', 'LAIN only controls VMs registered explicitly — it never adopts');
    row('', 'machines it finds in your VMware library.');
  } else {
    for (const v of vms) {
      const state = avail.available ? await vmState(vmware, v) : 'UNAVAILABLE';
      row(v.id, `${state}${v.owned ? '' : ' · not Harness-owned'}`);
    }
  }

  w('');
  await printChromium(w, row, paint, app, chromium, chromiuminstall);
  w('');
  return { handled: true };
}

/** The task's environment binding, from the record that owns it. */
function currentTask(app) {
  try {
    // `latest()`, which is the accessor the runtime actually has. This read
    // `runtime.current()` — a method that does not exist — so the guard fell
    // through to `null` and `/env` reported `host` for every task including one
    // genuinely bound to a VM. A projection that cannot fail loudly must at
    // least be built from names that exist.
    const harness = require('./harnesslink').existing(app);
    const task = harness && harness.runtime && typeof harness.runtime.latest === 'function'
      ? harness.runtime.latest()
      : null;
    const spec = task && task.environment ? String(task.environment) : 'host';
    return { spec, why: task ? '' : 'no task yet' };
  } catch {
    return { spec: 'host', why: '' };
  }
}

async function vmState(vmware, v) {
  try {
    const h = await vmware.health(v, { timeoutMs: 10_000 });
    return h.ok ? h.state : (h.code || 'FAILED');
  } catch { return 'FAILED'; }
}

/**
 * THE BROWSER SECTION. Shared by the overview and `/env chromium`, so the two
 * cannot describe the same browser differently.
 */
async function printChromium(w, row, paint, app, chromium, chromiuminstall) {
  w(paint('bold', 'Chromium'));
  const rt = chromium.forApp(app);
  const h = rt.health();
  const d = chromiuminstall.describe();

  if (!h.available) {
    row('state', 'UNAVAILABLE', 'red');
    row('', h.why);
    if (h.remedy) row('', h.remedy);
  } else {
    // OWNED vs BORROWED IS THE HEADLINE, because it is the question §14 asks
    // and the one a person cannot answer by looking at a path.
    row('binary', h.browser.owned ? 'Harness-owned' : 'borrowed from this machine');
    row('version', h.browser.version || 'unknown');
    row('path', h.browser.path);
    if (!h.browser.owned) row('', chromiuminstall.INSTALL_HINT);
  }
  row('pinned build', d.pinned + (d.installed && d.version === d.pinned ? ' · installed' : d.installed ? ` · installed ${d.version}` : ' · not installed'));

  // WHAT IS ACTUALLY RUNNING, from the runtime's own instances — never from a
  // process scan, which would report browsers LAIN did not start.
  const running = h.running || [];
  const purposes = ['workshop', 'verify', 'webmodel'];
  for (const p of purposes) {
    const live = running.filter((i) => i.purpose === p && i.state === 'RUNNING');
    row(p, live.length ? `RUNNING · ${live.map((i) => i.environment).join(', ')}` : 'IDLE');
  }
}

module.exports = { sections, printChromium, PAD };
