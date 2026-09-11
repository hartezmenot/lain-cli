'use strict';

/**
 * THE APPLICATION'S BEHAVIOUR — lanes, sessions, conversation, composer, picker.
 *
 * ------------------------------------------------------------------------
 * IT HOLDS UI STATE AND NOTHING ELSE.
 *
 * `LAIN.ui` is which lane is showing, which drawer is open, what is typed, and
 * the session token. Every FACT — the sessions, the conversation, the changes,
 * the verification, the model sources, the Workshop — arrives from
 * `/api/state` and is re-rendered from it.
 *
 * So there is no client-side model of the session to fall out of step with the
 * real one, and the terminal and this window cannot disagree: they are two
 * renderings of the same `App`, in the same process.
 *
 * ------------------------------------------------------------------------
 * THE POLL IS THE ONLY CLOCK.
 *
 * A turn runs for minutes; `POST /api/turn` returns as soon as it is accepted
 * and the answer appears in a later poll. Nothing here counts elapsed time
 * itself — the activity row renders what the Harness reports, because inventing
 * a "thinking" animation on a timer is exactly the fake state the design
 * forbids.
 */

/** Emitted into the page inside a `<script>`; it is JS, not a template. */
function js() {
  return `
window.LAIN = (function () {
  'use strict';
  var S = null;                    // the last state from the server
  var ui = {
    lane: 'engineering',
    drawer: null,                  // 'changes' | 'verification' | null
    // THE LAUNCH HAND-OFF FIRST. \`/app\` opened this page with a one-time
    // token; the server exchanged it for a session and injected the result.
    // Preferring it over sessionStorage matters when a stale credential from
    // an earlier server is still stored: without this the person would be sent
    // to a password prompt they were told they would never see.
    token: (window.__LAIN_HANDED__ || sessionStorage.getItem('lain.session') || ''),
    busy: false,
    picked: null,                  // the element selected in the preview
    source: false,                 // is the Source Workspace showing
    pollMs: 1500,
  };

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function esc(s) { return String(s == null ? '' : s); }

  // ---- talking to the server -------------------------------------------
  async function api(path, body) {
    var res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: Object.assign({ 'content-type': 'application/json' },
        ui.token ? { 'x-lain-session': ui.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body || {}),
    });
    if (res.status === 401) { gate(true); throw new Error('unauthorised'); }
    return res.json();
  }

  function notice(text, bad) {
    var n = $('notice');
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.className = 'note' + (bad ? ' bad' : '');
    n.textContent = text;
  }

  // ---- the password gate ------------------------------------------------
  function gate(show) {
    $('gate').hidden = !show;
    $('app').hidden = show;
    if (show) setTimeout(function () { $('pw').focus(); }, 0);
  }

  async function login(ev) {
    ev.preventDefault();
    var r = await (await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }),
    })).json();
    if (!r.ok) { $('gateWhy').textContent = r.why; return; }
    ui.token = r.session;
    sessionStorage.setItem('lain.session', ui.token);
    gate(false);
    poll();
  }

  // ---- sessions ---------------------------------------------------------
  function renderSessions() {
    var box = $('sessions');
    box.textContent = '';
    var list = (S.sessions && S.sessions[ui.lane]) || [];
    $('asideHead').textContent = ui.lane === 'engineering' ? 'Engineering sessions' : 'Cowork sessions';
    if (!list.length) {
      var e = el('div', 'empty');
      e.textContent = ui.lane === 'engineering'
        ? 'No engineering sessions yet. Ask something to start one.'
        : 'No Cowork sessions. LAIN binds one when work arrives from Telegram, Discord, WhatsApp or here.';
      box.appendChild(e);
      return;
    }
    list.forEach(function (s) {
      var b = el('button', 'sess');
      b.setAttribute('aria-current', String(!!s.current));
      var p = el('div', 'p', s.project || '(no project)');
      if (s.source && s.source !== 'harness') p.appendChild(el('span', 'src', s.source));
      b.appendChild(p);
      b.appendChild(el('div', 't', s.title));
      b.appendChild(el('div', 'w', s.when + (s.turns ? '  \\u00b7  ' + s.turns + ' turns' : '')));
      // ---- SWITCHING SESSIONS IS \`/resume\`, AND IT IS NOT THIS BUTTON ---
      //
      // A session becomes current in exactly one place, and doing it from here
      // would be a second way in — with a turn possibly running against the one
      // being replaced. The row says what it is; the terminal owns the switch.
      b.title = s.current ? 'The open session' : 'Resume in the terminal:  lain --resume ' + s.short;
      b.onclick = function () {
        if (s.current) return;
        notice('Resume this session from the terminal:  lain --resume ' + s.short);
      };
      box.appendChild(b);
    });
  }

  // ---- the conversation -------------------------------------------------
  function renderStream() {
    var box = $('stream');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.textContent = '';
    (S.conversation || []).forEach(function (m) {
      var wrap = el('div', 'msg ' + m.role);
      var who = el('div', 'who', m.role === 'user' ? 'You' : 'LAIN');
      // WHO ANSWERED, when it was not LAIN's own runtime. Stamped at execution
      // time and carried on the message — never re-derived from what the picker
      // happens to show now.
      if (m.provenance) who.appendChild(el('span', 'prov', m.provenance.label));
      wrap.appendChild(who);
      wrap.appendChild(el('div', 'body', m.text));
      box.appendChild(wrap);
    });
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---- activity, from the Harness's own words ---------------------------
  function renderActivity() {
    var h = S.harness;
    var row = $('act');
    if (!h || !h.task) { row.hidden = true; return; }
    row.hidden = false;
    var a = h.activity || {};
    var state = String(a.state || h.task.state || '');
    var dot = $('actDot');
    dot.className = 'dot' + (
      /RUNNING|READING|WRITING|THINKING|EXECUTING|OBSERVING|VERIFYING/.test(state) ? ' run'
        : /PASSED/.test(h.task.state) ? ' ok'
        : /FAILED|ERROR/.test(state + h.task.state) ? ' bad'
        : /WAITING|BLOCKED/.test(state) ? ' warn' : '');
    $('actText').textContent = [state.toLowerCase(), a.action, a.target].filter(Boolean).join('  \\u00b7  ')
      || h.task.title || '';
    $('actClock').textContent = '';
  }

  // ---- contextual drawers ----------------------------------------------
  function renderDrawers() {
    var bar = $('drawers');
    var body = $('drawer');
    bar.textContent = '';
    var tabs = [];
    if ((S.changes || []).length) tabs.push({ id: 'changes', label: 'Changes', n: S.changes.length });
    if (S.harness && S.harness.verification) tabs.push({ id: 'verification', label: 'Verification', n: null });
    if (S.plan) tabs.push({ id: 'plan', label: 'Plan', n: S.plan.done + '/' + S.plan.total });
    if (!tabs.length) { body.hidden = true; return; }
    tabs.forEach(function (t) {
      var b = el('button', 'tab', t.label);
      if (t.n != null) b.appendChild(el('span', 'n', t.n));
      b.setAttribute('aria-selected', String(ui.drawer === t.id));
      b.onclick = function () { ui.drawer = ui.drawer === t.id ? null : t.id; render(); };
      bar.appendChild(b);
    });
    if (!ui.drawer) { body.hidden = true; return; }
    body.hidden = false;
    body.textContent = '';
    if (ui.drawer === 'changes') {
      (S.changes || []).forEach(function (c) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'path', c.path));
        if (c.added) r.appendChild(el('span', 'add', '+' + c.added));
        if (c.removed) r.appendChild(el('span', 'del', '-' + c.removed));
        body.appendChild(r);
      });
    } else if (ui.drawer === 'verification') {
      var v = S.harness.verification;
      var d = el('div', 'verdict');
      d.appendChild(el('b', v.verdict, v.verdict));
      d.appendChild(el('span', '', '  ' + [
        v.passed ? v.passed + ' passed' : '',
        v.failed ? v.failed + ' failed' : '',
        v.inconclusive ? v.inconclusive + ' inconclusive' : '',
      ].filter(Boolean).join('  \\u00b7  ')));
      body.appendChild(d);
      if (v.why) body.appendChild(el('div', 'obs', v.why));
    } else if (ui.drawer === 'plan') {
      (S.plan.steps || []).forEach(function (s) {
        var r = el('div', 'row');
        r.appendChild(el('span', '', s.status === 'done' ? '\\u2713' : s.status === 'active' ? '\\u25b8' : '\\u25cb'));
        r.appendChild(el('span', 'path', s.text));
        if (s.origin && s.origin !== 'llm') r.appendChild(el('span', 'src', s.origin));
        body.appendChild(r);
      });
    }
  }

  // ---- the source and model pickers ------------------------------------
  function sourceOf(id) {
    return ((S.sources && S.sources.sources) || []).filter(function (x) { return x.id === id; })[0] || null;
  }

  function renderPicker() {
    var sel = S.sources ? S.sources.selected : 'lain';
    var s = sourceOf(sel);
    $('srcName').textContent = s ? s.label : 'LAIN';
    var dot = $('srcDot');
    dot.className = 'st' + (!s ? '' : s.state === 'READY' ? ' ready'
      : s.state === 'AUTH_REQUIRED' ? ' auth'
      : (s.state === 'FAILED' || s.state === 'UNAVAILABLE') ? ' bad' : '');
    $('modelName').textContent = (s && s.model) || 'no model';
    $('srcPill').title = s && s.why ? s.why : '';
  }

  /**
   * THE ENVIRONMENT CHIP: "host · Chromium 141", or "VM · READY".
   *
   * NO BACKTICKS BELOW THIS LINE, comments included — everything from here to
   * the end of the emitted script lives inside one template literal.
   *
   * It shows the BROWSER only when there is something worth saying: a
   * Harness-owned build is the quiet normal case and gets its version; a
   * BORROWED browser is called out, because that is the state a person may
   * want to fix. Nothing here polls a hypervisor — see state.js.
   */
  function renderEnv() {
    var el = $('envPill');
    if (!el) return;
    var e = S.environment;
    if (!e) { el.textContent = ''; el.hidden = true; return; }
    el.hidden = false;
    var bits = [e.kind === 'vm' ? 'VM · ' + e.task.replace(/^vm:/, '') : 'host'];
    if (e.browser) {
      bits.push(e.browser.owned
        ? 'Chromium ' + (e.browser.version || '').split('.')[0]
        : 'borrowed browser');
    } else if (e.why) {
      bits.push('no browser');
    }
    if (e.running && e.running.length) bits.push(e.running.join(' · '));
    el.textContent = bits.join('  ·  ');
    el.className = 'pill env' + (e.browser && !e.browser.owned ? ' warn' : '');
    el.title = e.browser
      ? (e.browser.owned ? 'Harness-owned Chromium ' + e.browser.version : 'borrowed from this machine — /env chromium install')
      : (e.why || 'no browser available');
  }

  function popover(anchor, build) {
    closePop();
    var p = el('div', 'pop');
    p.id = 'pop';
    build(p);
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(8, r.top - p.offsetHeight - 8) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', onAway, true); }, 0);
  }
  function onAway(e) { var p = $('pop'); if (p && !p.contains(e.target)) closePop(); }
  function closePop() {
    var p = $('pop');
    if (p) p.remove();
    document.removeEventListener('mousedown', onAway, true);
  }

  function openSources() {
    popover($('srcPill'), function (p) {
      p.appendChild(el('h4', '', 'Chat source'));
      ((S.sources && S.sources.sources) || []).forEach(function (s) {
        var b = el('button', 'opt');
        b.setAttribute('aria-selected', String(s.chosen));
        b.appendChild(el('span', '', s.label));
        // THE STATE IS SHOWN AND NEVER GUESSED AT: a website source that needs a
        // login says so here, which is the one thing a person can act on.
        var why = s.state === 'READY' ? (s.model || 'no model chosen')
          : s.state === 'AUTH_REQUIRED' ? 'sign in required'
          : s.state === 'DISCONNECTED' ? 'not connected'
          : (s.why || s.state);
        b.appendChild(el('small', '', why));
        b.onclick = async function () {
          closePop();
          notice('');
          var r = await api('/api/source/select', { source: s.id });
          if (!r.ok) return notice(r.why, true);
          await poll();
          if (s.kind === 'WEB') openModels();
        };
        p.appendChild(b);
      });
    });
  }

  /**
   * THE MODEL LIST — DISCOVERED, never hard-coded.
   *
   * For LAIN it is the configured catalog; for a website source it is what THAT
   * LOGGED-IN ACCOUNT offers, read off the page. A list that cannot be read is
   * an explicit failure here, not an empty menu that reads as "no models".
   */
  async function openModels() {
    var sel = S.sources ? S.sources.selected : 'lain';
    var s = sourceOf(sel);
    if (!s) return;
    popover($('modelPill'), function (p) {
      p.appendChild(el('h4', '', s.label + ' \\u00b7 reading models\\u2026'));
    });
    var r = await api('/api/source/models', { source: sel });
    if (!r.ok || (!r.models || !r.models.length)) {
      popover($('modelPill'), function (p) {
        p.appendChild(el('h4', '', s.label));
        var b = el('div', 'empty', r.why || 'no models were returned');
        p.appendChild(b);
        if (r.authRequired || (r.why || '').match(/sign in/i)) {
          var c = el('button', 'opt', 'Open ' + s.label + ' to sign in');
          c.appendChild(el('small', '', 'LAIN opens the window; you log in there.'));
          c.onclick = async function () {
            closePop();
            notice('Opening ' + s.label + ' \\u2014 sign in in the window LAIN opened, then choose a model.');
            await api('/api/source/connect', { source: sel });
            poll();
          };
          p.appendChild(c);
        }
      });
      return;
    }
    popover($('modelPill'), function (p) {
      p.appendChild(el('h4', '', s.label + (r.cached ? ' \\u00b7 cached' : '')));
      r.models.forEach(function (m) {
        var b = el('button', 'opt');
        b.setAttribute('aria-selected', String(m.id === s.model));
        b.appendChild(el('span', '', m.label || m.id));
        if (m.state && m.state !== 'AVAILABLE') b.appendChild(el('small', '', m.state));
        b.onclick = async function () {
          closePop();
          var sr = await api('/api/source/select', { source: sel, model: m.id });
          if (!sr.ok) return notice(sr.why, true);
          poll();
        };
        p.appendChild(b);
      });
      var re = el('button', 'opt', 'Refresh from the account');
      re.onclick = async function () { closePop(); await api('/api/source/models', { source: sel, refresh: true }); openModels(); };
      p.appendChild(re);
    });
  }

  // ---- asking -----------------------------------------------------------
  async function send() {
    var t = $('ask').value.trim();
    if (!t || ui.busy) return;
    ui.busy = true;
    $('send').disabled = true;
    notice('');
    var r = await api('/api/turn', { text: t });
    ui.busy = false;
    $('send').disabled = false;
    if (!r.ok) return notice(r.why, true);
    $('ask').value = '';
    $('ask').style.height = 'auto';
    poll();
  }

  // ---- the frame --------------------------------------------------------
  function render() {
    if (!S) return;
    $('proj').textContent = S.current.project || '(no project)';
    $('goal').textContent = S.current.goal ? '\\u00b7  ' + S.current.goal : '';
    renderSessions();
    renderStream();
    renderActivity();
    renderDrawers();
    renderPicker();
    LAIN.workshop.render(S, ui);
    $('conn').textContent = S.current.lane === 'cowork' ? 'Cowork session' : '';
  }

  async function poll() {
    try {
      var r = await api('/api/state');
      if (r && r.ok) { S = r.state; render(); }
    } catch (e) { /* the gate is already up, or the server went away */ }
  }

  function boot() {
    $('gateForm').addEventListener('submit', login);
    $('laneEng').onclick = function () { ui.lane = 'engineering'; syncLanes(); render(); };
    $('laneCo').onclick = function () { ui.lane = 'cowork'; syncLanes(); render(); };
    $('srcPill').onclick = openSources;
    $('modelPill').onclick = openModels;
    $('send').onclick = send;
    $('ask').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(180, this.scrollHeight) + 'px';
    });
    $('ask').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    LAIN.workshop.boot(api, notice, function () { return ui; }, poll);
    LAIN.source.boot(api, notice, poll);
    $('srcPill').onclick = function () {
      ui.source = !ui.source;
      $('srcPanel').hidden = !ui.source;
      $('main').classList.toggle('with-source', ui.source);
      $('srcPill').setAttribute('aria-selected', String(ui.source));
      if (ui.source) LAIN.source.loadRoot();
    };
    // ---- THE LAUNCH TOKEN LEAVES THE ADDRESS BAR IMMEDIATELY -------------
    //
    // It is already spent by the time this runs — the server consumed it
    // serving this document — but a spent credential sitting in the address
    // bar is still something a person can copy into a message, and it is what
    // a browser puts in history and in a bookmark. Erasing it costs one call.
    if (window.__LAIN_HANDED__) {
      sessionStorage.setItem('lain.session', ui.token);
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// and the like */ }
      window.__LAIN_HANDED__ = null;
    }
    if (!ui.token) gate(true); else { gate(false); poll(); }
    setInterval(function () { if (!$('app').hidden) poll(); }, ui.pollMs);
  }

  function syncLanes() {
    renderEnv();
    // THE EDITOR LEARNS ABOUT LAIN'S EDITS ON THE SAME CLOCK as everything
    // else — one poll, not a second timer with its own idea of when.
    if (ui.source && LAIN.source) LAIN.source.refresh();
    $('laneEng').setAttribute('aria-selected', String(ui.lane === 'engineering'));
    $('laneCo').setAttribute('aria-selected', String(ui.lane === 'cowork'));
  }

  return { boot: boot, api: function () { return api.apply(null, arguments); },
           state: function () { return S; }, ui: function () { return ui; },
           notice: notice, el: el, poll: poll };
})();
`;
}

module.exports = { js };
