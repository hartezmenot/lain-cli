'use strict';

/**
 * THE EXECUTION ENVIRONMENT AND THE HARNESS BROWSER.
 *
 * The properties asserted here are the ones that are SILENT when they break:
 * a browser that quietly attaches to the person's own Chrome, two purposes
 * sharing a profile directory, a VM control operation reaching a machine
 * nobody handed over, and a task whose subsystems disagree about which
 * computer they are on.
 *
 * NOTHING HERE LAUNCHES A BROWSER OR TOUCHES A HYPERVISOR. These are the
 * structural guarantees; the live proof is tests/smoke/environment-browser.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { test } = require('../helpers');

const purpose = require('../../src/env/purpose');
const failures = require('../../src/env/failures');
const environments = require('../../src/env/environments');
const chromium = require('../../src/env/chromium');
const chromiuminstall = require('../../src/env/chromiuminstall');
const vmware = require('../../src/env/vmware');
const unzip = require('../../src/env/unzip');

const SRC = path.join(__dirname, '..', '..', 'src');

module.exports = async function () {
  // ------------------------------------------------------- ONE LAUNCHER --

  await test('ENV: env/chromium.js is the ONLY thing in the tree that spawns a browser', () => {
    // The defect this replaced: three modules each with their own fifty-line
    // launch body, drifted apart on details nobody had decided.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const rel = path.relative(SRC, p).replace(/\\/g, '/');
        if (rel === 'env/chromium.js') continue;
        const text = fs.readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // A browser launch is recognisable by the flag no other process takes.
        if (/--user-data-dir|remote-debugging-port=/.test(text)) offenders.push(rel);
      }
    };
    walk(SRC);
    assert.deepStrictEqual(offenders, [],
      `these still build browser launch flags of their own: ${offenders.join(', ')}`);
  });

  await test('ENV: nothing attaches to a debug port it did not open', () => {
    // 9222 is the DevTools convention. Probing it before launching is how the
    // verification harness silently adopted the person's real browser.
    const hot = [];
    for (const f of ['harness/browserharness.js', 'workshop/index.js', 'modelsource/webbrowser.js', 'env/chromium.js']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/cdp\.endpoint\(\s*(this\.port|9222|DEFAULT_PORT)\s*\)/.test(text)) hot.push(f);
    }
    assert.deepStrictEqual(hot, [],
      `${hot.join(', ')} probes a well-known debug port — that is how it adopts the user browser`);
  });

  await test('ENV: every launch asks for port 0, so two Harness browsers cannot collide', () => {
    // COMMENTS STRIPPED. The file NAMES 9222 in its header, explaining the
    // defect it replaced — a guard that cannot tell an explanation from an
    // instruction would force the code to stop documenting its own history.
    const text = fs.readFileSync(path.join(SRC, 'env', 'chromium.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(text, /--remote-debugging-port=0/);
    assert.ok(!/--remote-debugging-port=9222/.test(text), 'a fixed port is how one browser adopts another');
  });

  // --------------------------------------------------------- PURPOSES ----

  await test('ENV: the browser purposes are a closed set, and none of them is the person browser', () => {
    // FOUR NOW. `harnessapp` was added deliberately: the other three are
    // INSTRUMENTS that LAIN drives, and the application window is not one —
    // nothing drives it, a person does. Each of the three would have been wrong
    // for it in a different way, which is the test that it deserved its own.
    assert.deepStrictEqual([...purpose.ALL].sort(), ['harnessapp', 'verify', 'webmodel', 'workshop']);
    for (const p of purpose.ALL) assert.ok(purpose.traits(p).why, `${p} states why it is separate`);

    // THE RULE THAT MUST NOT ERODE, whatever the count: there is no purpose
    // that names the person's own browser or profile. Reaching one is a
    // different verb, needs a person to ask, and belongs to Computer MCP.
    assert.throws(() => purpose.traits('personal'), /unknown browser purpose/);
    assert.throws(() => purpose.traits('chrome'), /unknown browser purpose/);
    for (const p of purpose.ALL) {
      assert.ok(!/personal|user|chrome|edge/i.test(p), `${p} reads like the person browser`);
    }

    // AND THE APPLICATION WINDOW IS NEVER HEADLESS OR DISPOSABLE — a window
    // nobody can see is not an application, and one that forgets where it was
    // is not one either.
    const appTraits = purpose.traits(purpose.PURPOSE.HARNESSAPP);
    assert.strictEqual(appTraits.headless, false);
    assert.strictEqual(appTraits.disposable, false);
  });

  await test('ENV: the three profile roots are provably disjoint', () => {
    const wp = require('../../src/workshop/profile').root();
    const mp = require('../../src/modelsource/webprofile').root();
    const cp = chromiuminstall.root();
    for (const [a, b, an, bn] of [[wp, mp, 'workshop', 'webmodel'], [wp, cp, 'workshop', 'browser install'], [mp, cp, 'webmodel', 'browser install']]) {
      const sep = purpose.separate(a, b, an, bn);
      assert.ok(sep.ok, sep.why);
    }
  });

  await test('ENV: separate() catches containment in BOTH directions', () => {
    const parent = path.resolve('/tmp/a');
    const child = path.resolve('/tmp/a/b');
    assert.strictEqual(purpose.separate(parent, child).ok, false, 'a parent is not a safe distance');
    assert.strictEqual(purpose.separate(child, parent).ok, false, 'nor is a child');
    assert.strictEqual(purpose.separate(parent, parent).ok, false, 'nor is the same directory');
    assert.strictEqual(purpose.separate(path.resolve('/tmp/a'), path.resolve('/tmp/ab')).ok, true,
      'a shared prefix that is not a path boundary is a different directory');
  });

  await test('ENV: only VERIFY is disposable, and only WEBMODEL keeps extensions', () => {
    assert.strictEqual(purpose.traits(purpose.PURPOSE.VERIFY).disposable, true);
    assert.strictEqual(purpose.traits(purpose.PURPOSE.WORKSHOP).disposable, false,
      'a preview you cannot keep is not a workshop');
    assert.strictEqual(purpose.traits(purpose.PURPOSE.WEBMODEL).extensions, true,
      'a password manager is part of a person login flow');
    assert.strictEqual(purpose.traits(purpose.PURPOSE.VERIFY).extensions, false,
      'an extension is uncontrolled input to a verdict');
  });

  await test('ENV: the verification profile is fresh every time', () => {
    const rt = new chromium.ChromiumRuntime();
    const a = rt.profileFor(purpose.PURPOSE.VERIFY);
    const b = rt.profileFor(purpose.PURPOSE.VERIFY);
    assert.notStrictEqual(a, b, 'reusing one directory reintroduces the state the purpose excludes');
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  });

  await test('ENV: launch flags differ by purpose, from the table rather than by hand', () => {
    const verify = chromium.argsFor(purpose.PURPOSE.VERIFY, '/p', { headless: true });
    const web = chromium.argsFor(purpose.PURPOSE.WEBMODEL, '/p', { headless: false });
    assert.ok(verify.includes('--disable-extensions'));
    assert.ok(!web.includes('--disable-extensions'));
    assert.ok(verify.includes('--headless=new'));
    assert.ok(!web.includes('--headless=new'));
    for (const a of [verify, web]) assert.ok(a.includes('--user-data-dir=/p'), 'never the person real profile');
  });

  // ----------------------------------------------------- OWNED BROWSER ----

  await test('ENV: a managed build outranks whatever Chrome the machine happens to have', () => {
    const r = chromium.resolve({ policy: 'prefer-managed' });
    if (chromiuminstall.installed().ok) {
      assert.strictEqual(r.owned, true, 'the managed build must win when it is installed');
      assert.strictEqual(r.source, 'managed');
      assert.ok(r.version, 'and the version is known — it goes into the evidence');
    } else {
      // Honest either way: with nothing installed, a borrowed binary is
      // LABELLED rather than passed off as Harness-owned.
      if (r.ok) assert.strictEqual(r.owned, false, 'a system browser is borrowed, and says so');
    }
  });

  await test('ENV: policy "managed" refuses to borrow, and names the remedy', () => {
    if (chromiuminstall.installed().ok) return;   // nothing to refuse
    const r = chromium.resolve({ policy: 'managed' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, failures.CODE.CHROMIUM_FAILED);
    assert.match(r.remedy || '', /install/);
  });

  await test('ENV: an explicitly configured browser that is missing is an error, not a fallback', () => {
    const r = chromium.resolve({ explicit: path.join(__dirname, 'no-such-browser.exe') });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /configured browser is missing/);
  });

  await test('ENV: the pinned version is a source constant, not a "latest" lookup', () => {
    assert.match(chromiuminstall.PINNED, /^\d+\.\d+\.\d+\.\d+$/);
    const plan = chromiuminstall.plan();
    assert.ok(plan.url.includes(chromiuminstall.PINNED), 'the download is pinned to that exact build');
    // NO INSTALL FROM A RUN. §14: there must be no path from verifying to
    // downloading a browser, or two runs are not comparable and nothing says why.
    const launcher = fs.readFileSync(path.join(SRC, 'env', 'chromium.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/install\s*\(/.test(launcher), 'the launch path must never trigger an install');
  });

  // --------------------------------------------------------- THE ZIP ------

  await test('ENV: the extractor refuses traversal, absolute paths and NUL bytes', () => {
    const dest = path.resolve('/tmp/dest');
    for (const bad of ['../escape', 'a/../../escape', '/etc/passwd', 'C:\\Windows\\x', 'a\0b']) {
      assert.ok(unzip.reject(bad, dest), `${JSON.stringify(bad)} must be refused`);
    }
    assert.strictEqual(unzip.reject('a/b/c.txt', dest), null, 'an ordinary path is fine');
  });

  // ------------------------------------------------ EXECUTION ENVIRONMENT --

  await test('ENV: an environment spelling parses back to itself, and garbage is refused', () => {
    assert.deepStrictEqual(environments.parse('host').spec, 'host');
    assert.deepStrictEqual(environments.parse(null).spec, 'host');
    assert.deepStrictEqual(environments.parse('vm:win11-test').spec, 'vm:win11-test');
    for (const bad of ['somewhere else', 'vm:', 'vm:../etc', 'vm:a b']) {
      assert.strictEqual(environments.parse(bad).ok, false, `${bad} must not parse`);
    }
  });

  await test('ENV: an unreadable environment is NEVER silently treated as the host by parse', () => {
    // The value has to be refused HERE so a caller has to decide. Quietly
    // returning `host` is how work escapes an isolation boundary unnoticed.
    const r = environments.parse('vm:../../elsewhere');
    assert.strictEqual(r.ok, false);
    assert.ok(!r.spec);
  });

  await test('ENV: an unregistered VM is refused, and the refusal explains the rule', () => {
    const d = environments.describe('vm:definitely-not-registered');
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.code, failures.CODE.VM_UNAVAILABLE);
    assert.match(d.detail, /never enumerates the hypervisor/);
  });

  await test('ENV: a VM without owned:true cannot be started, stopped or restored', async () => {
    const unowned = { id: 'someone-elses', vmx: 'X.vmx', owned: false, cleanSnapshot: 'LAIN-CLEAN' };
    for (const [name, call] of [
      ['start', () => vmware.start(unowned)],
      ['stop', () => vmware.stop(unowned)],
      ['snapshot', () => vmware.snapshot(unowned, 'x')],
      ['restore', () => vmware.restore(unowned)],
      ['exec', () => vmware.exec(unowned, 'cmd')],
      ['copyIn', () => vmware.copyIn(unowned, 'a', 'b')],
    ]) {
      const r = await call();
      assert.strictEqual(r.ok, false, `${name} must refuse an unowned VM`);
      assert.match(r.why, /not registered as Harness-owned/, `${name}: ${r.why}`);
    }
  });

  await test('ENV: restore refuses any snapshot but the registered clean one', async () => {
    const owned = { id: 'lab', vmx: 'X.vmx', owned: true, cleanSnapshot: 'LAIN-CLEAN' };
    const r = await vmware.restore(owned, 'someone-elses-work');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /refusing to revert/);
    const none = await vmware.restore({ id: 'lab', vmx: 'X.vmx', owned: true });
    assert.strictEqual(none.ok, false);
    assert.match(none.why, /no clean snapshot registered/);
  });

  await test('ENV: a guest password never survives into a reportable command string', () => {
    const line = vmware.redact(['-gu', 'tester', '-gp', 'hunter2', 'runProgramInGuest', 'X.vmx']);
    assert.ok(!line.includes('hunter2'), `the password leaked: ${line}`);
    assert.ok(line.includes('********'));
    assert.ok(line.includes('tester'), 'the user is not a secret and stays legible');
  });

  await test('ENV: VMware reports its real availability on THIS machine', () => {
    const a = vmware.available();
    assert.strictEqual(typeof a.available, 'boolean');
    if (!a.available) {
      assert.strictEqual(a.state, vmware.STATE.UNAVAILABLE);
      assert.ok(a.tried.length, 'and it names where it looked, so the failure is diagnosable');
    }
  });

  await test('ENV: the provider can never answer READY — only the guest handshake can', () => {
    // §24. A powered-on VM is not a VM that can take work.
    const text = fs.readFileSync(path.join(SRC, 'env', 'vmware.js'), 'utf8');
    const status = text.slice(text.indexOf('async function status('), text.indexOf('function ownership('));
    assert.ok(!/STATE\.READY/.test(status), 'status() must not be able to report READY from the hypervisor alone');
  });

  // ------------------------------------------------------ FAILURE CODES ---

  await test('ENV: failures are distinguished, and only one of them means the code is wrong', () => {
    for (const code of Object.values(failures.CODE)) {
      assert.ok(failures.SUMMARY[code], `${code} needs a sentence a person reads`);
    }
    assert.strictEqual(failures.isInfrastructure(failures.CODE.VM_UNAVAILABLE), true);
    assert.strictEqual(failures.isInfrastructure(failures.CODE.CHROMIUM_FAILED), true);
    assert.strictEqual(failures.isInfrastructure(failures.CODE.ARTIFACT_TRANSFER_FAILED), true);
    assert.strictEqual(failures.isInfrastructure(failures.CODE.BROWSER_VERIFICATION_FAILED), false,
      'only a real verdict may be reported as the code failing');
  });

  await test('ENV: a failure keeps its detail out of the one-line summary', () => {
    const f = failures.fail(failures.CODE.VM_START_FAILED, 'the VM would not start', 'x'.repeat(4000));
    assert.ok(failures.line(f).length < 120, 'the status line must not carry a stderr dump');
    assert.strictEqual(f.detail.length, 4000, 'and the detail is kept whole for diagnostics');
  });

  await test('ENV: an unrecognised failure code is reported as such, not invented', () => {
    const f = failures.fail('NOT_A_REAL_CODE', '');
    assert.strictEqual(f.code, 'UNKNOWN');
    assert.match(f.why, /unrecognised failure code/);
  });

  // ------------------------------------------------- TASK BINDING (§6) ----

  await test('ENV: a task carries where it runs, and it survives a round trip', () => {
    const { TaskRecord } = require('../../src/harness/record');
    assert.strictEqual(new TaskRecord({ objective: 'x' }).environment, 'host');
    const vm = new TaskRecord({ objective: 'y', environment: 'vm:win11-test' });
    assert.strictEqual(vm.environment, 'vm:win11-test');
    assert.strictEqual(TaskRecord.from(JSON.parse(JSON.stringify(vm))).environment, 'vm:win11-test');
  });

  await test('ENV: a task can never end up with no answer to "where does this run"', () => {
    const { TaskRecord } = require('../../src/harness/record');
    // Unreadable input falls back to the host — never undefined, and never a VM.
    assert.strictEqual(new TaskRecord({ objective: 'z', environment: 'nonsense' }).environment, 'host');
    assert.strictEqual(new TaskRecord({ objective: 'z', environment: 'vm:../escape' }).environment, 'host');
    // And a record written before the field existed ran on the host.
    assert.strictEqual(TaskRecord.from({ id: 't1', state: 'PLANNED' }).environment, 'host');
  });

  await test('ENV: isolation does not destroy speed — cheap work stays on the host', () => {
    for (const cheap of ['unit-test', 'grep', 'source-read', '']) {
      assert.strictEqual(environments.recommend(cheap).spec, 'host', `${cheap} must not go near a hypervisor`);
    }
    // And work that WANTS isolation says so honestly when it cannot have it,
    // rather than silently running on the host as though it had.
    const iso = environments.recommend('isolated-smoke');
    assert.strictEqual(iso.spec, 'host');
    assert.strictEqual(iso.honoured, false, 'degrading to the host must be reported, never assumed');
  });

  await test('ENV: an explicit request is honoured over the recommendation', () => {
    const r = environments.recommend('unit-test', { requested: 'vm:lab' });
    assert.strictEqual(r.spec, 'vm:lab');
    assert.strictEqual(r.honoured, true);
  });

  // -------------------------------------------------- NO SECOND HARNESS ---

  await test('ENV: the guest runs primitives, not a second Harness', () => {
    const text = fs.readFileSync(path.join(SRC, 'env', 'guest.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // WHAT MUST NOT BE IN THERE is a second thing that DECIDES: a turn loop, a
    // session, a permission check, a task engine, a model. `provider` is
    // deliberately NOT on this list — in this file it means the VMware
    // execution adapter, which is transport, not authority.
    for (const forbidden of ['runTurn', 'new Session', 'permissions', 'TaskRuntime', 'anthropic', 'completions', 'systemPrompt']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'i').test(text),
        `guest.js references ${forbidden} — the guest must not host a second authority`);
    }
    // And the transport it DOES use is the host-side provider adapter, driven
    // from the host — proof of consumption, the opposite of a second engine.
    assert.match(text, /b\.provider\./, 'the guest bridge drives the host-side provider');
  });

  await test('ENV: nothing copies a host browser profile into a guest', () => {
    const text = fs.readFileSync(path.join(SRC, 'env', 'guest.js'), 'utf8');
    assert.ok(!/webprofile|workshop\/profile/.test(text),
      'a VM smoke must never receive the authenticated web-model cookies');
  });

  await test('ENV: guest operations refuse a host-bound environment rather than running locally', async () => {
    const guest = require('../../src/env/guest');
    const r = await guest.exec('host', 'whoami');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /needs a VM environment/);
  });
};
