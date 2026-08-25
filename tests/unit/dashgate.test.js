'use strict';

/**
 * THE DASHBOARD PASSWORD BOX, DRIVEN THE WAY A PERSON DRIVES IT.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE, exactly: you click the box, you type, and what you typed
 * disappears.
 *
 * It was not focus and it was not the keyboard. `tick()` polls `/api/state`
 * every 1500ms, and its first line is:
 *
 *     if(!T){lock('');return;}
 *
 * While somebody is STANDING AT THE GATE there is no session key, so every
 * tick re-entered `lock()` — and `lock()` ended with:
 *
 *     $('pw').value='';$('pw').focus();
 *
 * Typing a password takes longer than a second and a half. The field emptied
 * underneath every user, every time. The gate was not awkward, it was
 * IMPOSSIBLE TO PASS, and the dashboard was unreachable for anyone who had set
 * a password.
 *
 * ------------------------------------------------------------------------
 * WHY THE TEST LOOKS LIKE THIS.
 *
 * The gate is browser JavaScript inside a template string, and LAIN has no
 * dependencies — there is no jsdom here and adding one to test forty lines
 * would be a poor trade. So this builds the smallest DOM those forty lines
 * actually touch and runs the REAL script from `page()` against it.
 *
 * That matters: asserting on the page SOURCE ("does it contain a guard") would
 * pass for a guard that does not work. This types characters, fires ticks
 * between them, and reads the value back — which is the thing that was broken.
 */

const assert = require('assert');
const vm = require('vm');
const { test } = require('../helpers');

const { page } = require('../../src/dashpage');

/** The script the page actually ships, pulled out of the served HTML. */
function gateScript() {
  const html = page();
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'the page must carry its script');
  return m[1];
}

/** The smallest element the gate code uses: value, textContent, classList. */
function makeEl(id) {
  return {
    id,
    value: '',
    textContent: '',
    placeholder: '',
    disabled: false,
    innerHTML: '',
    focused: false,
    _cls: new Set(),
    classList: {
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    addEventListener(ev, fn) { (this._on = this._on || {})[ev] = fn; },
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  };
}

/**
 * Run the gate script in a sandbox and hand back the handles a test needs.
 *
 * `fetch` is answered rather than mocked away: the gate asks `/api/auth` what
 * credential to want, and a gate that never gets an answer is not the gate
 * anybody uses.
 */
function mount({ password = true, stateStatus = 401, loginStatus = 401 } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const e = makeEl(id);
      e.classList._set = e._cls;
      els.set(id, e);
    }
    return els.get(id);
  };
  // Every id the script reaches for.
  for (const id of ['gate', 'gatehint', 'gateform', 'gatemsg', 'pw', 'proj', 'task',
    'insts', 'thread', 'detail', 'live', 'msg', 'steer', 'send', 'facts']) el(id);

  const timers = [];
  const calls = [];
  const sandbox = {
    document: { getElementById: (id) => el(id) },
    sessionStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    location: { href: 'http://127.0.0.1:9/', pathname: '/' },
    history: { replaceState() {} },
    URL,
    console,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    setTimeout: () => 0,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/auth')) {
        return { ok: true, status: 200, json: async () => ({ password, lockedOut: false }) };
      }
      // THE LOGIN ANSWER IS THE REAL SHAPE. `session` is what the server sends;
      // a test that invented a different field would prove nothing about the
      // page that has to read it.
      if (String(url).includes('/api/login')) {
        return {
          ok: loginStatus === 200,
          status: loginStatus,
          json: async () => (loginStatus === 200
            ? { session: 'SESSIONKEY', token: 'SESSIONKEY' }
            : { error: 'wrong password' }),
        };
      }
      return { ok: stateStatus === 200, status: stateStatus, json: async () => ({}) };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(gateScript(), sandbox);
  /** Run every registered interval callback once — one 1.5s tick. */
  const tick = async () => { for (const fn of timers) await fn(); };
  /** Press Enter in the gate form, through the page's own handler. */
  const submit = async () => {
    const form = el('gateform');
    assert.ok(form._on && form._on.submit, 'the page must register a submit handler');
    return form._on.submit({ preventDefault() {} });
  };
  return { el, tick, submit, sandbox, calls };
}

/** Let the script's own pending promises settle. */
const settle = () => new Promise((r) => setImmediate(r));

module.exports = async function () {
  await test('GATE: typing SURVIVES a poll tick — the defect itself', async () => {
    // The whole defect in one assertion. Type, let the 1.5s poll fire, and the
    // password must still be there. Before the fix this was ''.
    const g = await mount();
    await settle();
    const pw = g.el('pw');
    pw.value = 'correct horse';
    await g.tick();
    await settle();
    assert.strictEqual(pw.value, 'correct horse', 'a poll must never clear the password box');
  });

  await test('GATE: it survives MANY ticks, not just the first', async () => {
    // Somebody typing a four-word password sits here for several polls.
    const g = await mount();
    await settle();
    const pw = g.el('pw');
    pw.value = 'correct horse battery staple';
    for (let i = 0; i < 8; i++) { await g.tick(); await settle(); }
    assert.strictEqual(pw.value, 'correct horse battery staple');
  });

  await test('GATE: typing character by character is not eaten mid-word', async () => {
    // The real shape of the failure: the field emptied BETWEEN keystrokes.
    const g = await mount();
    await settle();
    const pw = g.el('pw');
    for (const ch of 'hunter2') {
      pw.value += ch;
      await g.tick();
      await settle();
    }
    assert.strictEqual(pw.value, 'hunter2');
  });

  await test('GATE: backspace and paste are not undone by a tick', async () => {
    const g = await mount();
    await settle();
    const pw = g.el('pw');
    pw.value = 'hunter2';
    pw.value = pw.value.slice(0, -1);        // backspace
    await g.tick(); await settle();
    assert.strictEqual(pw.value, 'hunter');
    pw.value += 'PASTED-SECRET';               // paste
    await g.tick(); await settle();
    assert.strictEqual(pw.value, 'hunterPASTED-SECRET');
  });

  await test('GATE: focus is taken ONCE, not stolen back on every tick', async () => {
    // Re-focusing four times a minute fights the user for the caret and breaks
    // selecting text inside the field.
    const g = await mount();
    await settle();
    const pw = g.el('pw');
    pw.focused = false;
    for (let i = 0; i < 5; i++) { await g.tick(); await settle(); }
    assert.strictEqual(pw.focused, false, 'a repaint must not grab focus');
  });

  await test('GATE: a stated reason is not wiped off by the next tick', async () => {
    // "wrong password" that vanishes a second later is a message nobody reads.
    const g = await mount();
    await settle();
    g.el('gatemsg').textContent = 'wrong password';
    await g.tick(); await settle();
    assert.strictEqual(g.el('gatemsg').textContent, 'wrong password');
  });

  await test('GATE: it does not re-ask /api/auth on every tick', async () => {
    // Entering the locked state asks what credential to want. BEING in it is
    // not a new question, and asking it 40 times a minute is a busy loop.
    const g = await mount();
    await settle();
    const before = g.calls.filter((u) => u.includes('/api/auth')).length;
    for (let i = 0; i < 6; i++) { await g.tick(); await settle(); }
    const after = g.calls.filter((u) => u.includes('/api/auth')).length;
    assert.strictEqual(after, before, 'the credential question is asked once per lock');
  });

  await test('GATE: it says PASSWORD when one is set', async () => {
    const g = await mount({ password: true });
    await settle();
    assert.strictEqual(g.el('pw').placeholder, 'password');
    assert.match(g.el('gatehint').textContent, /password/i);
  });

  await test('GATE: IT SAYS PASSWORD WHEN ONE IS NOT SET, TOO', async () => {
    // ONE WORD FOR THE THING A PERSON TYPES. The gate used to relabel itself
    // "startup key" here, which read as a second KIND of credential and left
    // people guessing which one this LAIN wanted. Both are passwords; what
    // changes is only which one currently works.
    const g = await mount({ password: false });
    await settle();
    assert.strictEqual(g.el('pw').placeholder, 'password',
      'the field must never be labelled with a word nothing else in LAIN uses');
    assert.match(g.el('gatehint').textContent, /startup password/i,
      'and it must say which password it wants');
    assert.match(g.el('gatehint').textContent, /\/dash password/,
      'it must name the command that sets one you can remember');
  });

  await test('GATE: THE WORD "TOKEN" IS NOT ON THE SCREEN ANYWHERE', () => {
    // The audit, as an assertion. Comments in the script may explain the
    // history — what a person READS may not use the old vocabulary.
    const html = page();
    const visible = html
      .replace(/<script>[\s\S]*<\/script>/, '')      // the script's own comments
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/token/i.test(visible), 'the served markup still says "token"');
  });

  await test('GATE: the password box is a PASSWORD field in the served HTML', () => {
    // It is typed in front of other people, on a phone, in a kitchen.
    const html = page();
    const input = html.match(/<input id="pw"[^>]*>/);
    assert.ok(input, 'the gate must have its input');
    assert.match(input[0], /type="password"/, 'it must be masked');
  });

  await test('GATE: a REFUSED password is selected, never cleared', async () => {
    // A wrong password that vanishes means retyping the whole thing to fix one
    // character. Selecting it makes the next keystroke replace it if that is
    // what the user wants, and leaves it there if it is not.
    const g = mount({ password: true, loginStatus: 401 });
    // One tick first, so the gate has asked /api/auth and knows a password is
    // what it wants. That question is asked on entering the locked state.
    await g.tick(); await settle();
    const pw = g.el('pw');
    pw.value = 'wrong one';
    await g.submit();
    await settle();
    assert.strictEqual(pw.value, 'wrong one', 'a refusal must not empty the box');
    assert.strictEqual(pw.selected, true, 'it must be selected so one keystroke replaces it');
  });

  await test('GATE: A CORRECT password is cleared, and the KEY is what is kept', async () => {
    // The password crosses once. What survives in the tab is the session key,
    // and the password itself must not be sitting in a DOM node afterwards.
    // `stateStatus: 200` because a successful login immediately polls, and a
    // poll that comes back 401 correctly re-locks the page and drops the key —
    // which is a different behaviour being asserted elsewhere.
    const g = mount({ password: true, loginStatus: 200, stateStatus: 200 });
    await g.tick(); await settle();
    const pw = g.el('pw');
    pw.value = 'correct horse';
    await g.submit();
    await settle();
    assert.strictEqual(pw.value, '', 'the password must not linger in the field');
    assert.strictEqual(g.sandbox.sessionStorage.getItem('lain.dash.session'), 'SESSIONKEY');
    assert.strictEqual(g.sandbox.sessionStorage.getItem('lain.dash.token'), null,
      'the old storage key must not be written as well — one place, one name');
  });

  await test('GATE: no credential is ever baked into the page source', () => {
    // The page is served to anyone who asks, precisely because it knows nothing.
    const html = page();
    assert.ok(!/[0-9a-f]{32}/.test(html), 'no 32-hex credential may appear in the shell');
  });
};
