'use strict';

/**
 * THE FRONTEND WORKSHOP, IN THE APPLICATION.
 *
 * ------------------------------------------------------------------------
 * IT IS CONTEXTUAL, NOT A TAB.
 *
 * The Workshop is the right-hand half of an ENGINEERING SESSION, and only while
 * it is open. There is no top-level Workshop destination, because a person does
 * not go to the Workshop — they are fixing a page, and the page is the thing
 * they need beside the conversation.
 *
 * ------------------------------------------------------------------------
 * IT DRIVES THE REAL BROWSER; IT IS NOT AN IFRAME.
 *
 * The preview is a project-bound Chromium the Harness launched, driven over
 * CDP by src/workshop. An iframe would give the page a chance to refuse
 * framing, would give LAIN no console, no network, no accessibility tree and no
 * element picker, and would run in the browser the APPLICATION is in rather
 * than the one under test.
 *
 * So what this panel shows is a SCREENSHOT stream plus structured observations
 * — the DOM, the accessibility tree, the console, the network — which is what
 * the instruments actually produce.
 *
 * ------------------------------------------------------------------------
 * IT PRODUCES EVIDENCE AND SETTLES NOTHING.
 *
 * `Verify` collects observations at each viewport and files screenshots as
 * Harness artifacts. Whether the TASK is done remains harness/verify.js and
 * completion.js's decision, from that evidence. A green panel here is not a
 * finished task and never says it is.
 */

function js() {
  return `
LAIN.workshop = (function () {
  'use strict';
  var api, notice, uiOf, poll;
  var W = { open: false, shot: null, before: null, after: null, picking: false,
            element: null, verify: null, vp: 'desktop' };

  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }

  function boot(_api, _notice, _uiOf, _poll) {
    api = _api; notice = _notice; uiOf = _uiOf; poll = _poll;
    $('wsPill').onclick = toggle;
    $('wsClose').onclick = close;
    $('wsReload').onclick = async function () { await api('/api/workshop/reload'); shoot(); };
    $('wsPick').onclick = pick;
    $('wsBefore').onclick = function () { capture('before'); };
    $('wsAfter').onclick = function () { capture('after'); };
    $('wsVerify').onclick = verify;
    $('wsAttach').onclick = attach;
    Array.prototype.forEach.call(document.querySelectorAll('.vp'), function (b) {
      b.onclick = function () { viewport(b.getAttribute('data-vp')); };
    });
  }

  async function toggle() {
    if (W.open) return close();
    notice('Starting the dev server and opening the preview\\u2026');
    var r = await api('/api/workshop/open', {});
    if (!r.ok) { notice(r.why, true); return; }
    W.open = true;
    W.vp = 'desktop';
    notice('');
    layout();
    await shoot();
    poll();
  }

  async function close() {
    await api('/api/workshop/close', {});
    W = { open: false, shot: null, before: null, after: null, picking: false, element: null, verify: null, vp: 'desktop' };
    layout();
    poll();
  }

  function layout() {
    $('workshop').hidden = !W.open;
    $('main').className = W.open ? 'with-workshop' : '';
    $('wsPill').setAttribute('aria-selected', String(W.open));
  }

  /** A fresh frame of the real preview. Not persisted — see \`capture\`. */
  async function shoot() {
    var r = await api('/api/workshop/capture', {});
    if (r.ok && r.shot) { W.shot = r.shot; draw(); }
    return r;
  }

  async function viewport(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.vp'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-vp') === name));
    });
    W.vp = name;
    var r = await api('/api/workshop/viewport', { name: name });
    if (!r.ok) return notice(r.why, true);
    await shoot();
  }

  /**
   * ARM THE PICKER, then wait for the person to click IN THE PREVIEW WINDOW.
   *
   * Polled rather than pushed: the click happens in another browser entirely,
   * and there is no channel from it back to this page except asking.
   */
  async function pick() {
    var r = await api('/api/workshop/pick', {});
    if (!r.ok) return notice(r.why, true);
    W.picking = true;
    notice('Click the element in the preview window LAIN opened. Escape there cancels.');
    var tries = 0;
    var t = setInterval(async function () {
      tries += 1;
      var got = await api('/api/workshop/picked', {});
      if (got.ok && got.element) {
        clearInterval(t);
        W.picking = false;
        W.element = got.element;
        notice('');
        $('wsAttach').disabled = false;
        await api('/api/workshop/unpick', {});
        await shoot();
        draw();
      } else if (tries > 120) {
        clearInterval(t);
        W.picking = false;
        notice('');
      }
    }, 500);
  }

  async function capture(as) {
    var r = await api('/api/workshop/capture', { as: as });
    if (!r.ok) return notice(r.why, true);
    if (as === 'before') { W.before = r.shot; W.after = null; }
    else { W.after = r.shot; W.before = r.before || W.before; }
    W.shot = r.shot;
    draw();
  }

  async function verify() {
    notice('Verifying desktop and mobile\\u2026');
    var r = await api('/api/workshop/verify', { viewports: ['desktop', 'mobile'] });
    if (!r.ok) { notice(r.why || 'verification did not complete', true); return; }
    W.verify = r;
    notice('');
    draw();
    poll();
  }

  /** Send the selection and the page's own failures as the NEXT question. */
  async function attach() {
    var q = window.prompt('Ask LAIN about the selected element:',
      'Why is this misaligned, and does it work on mobile?');
    if (!q) return;
    var r = await api('/api/workshop/attach', {
      text: q, selector: W.element ? W.element.selector : null,
    });
    if (!r.ok) return notice(r.why, true);
    poll();
  }

  // ---- drawing ----------------------------------------------------------
  function shotFig(label, shot) {
    var f = document.createElement('figure');
    f.style.margin = '0';
    f.appendChild(el('figcaption', '', label));
    var i = document.createElement('img');
    i.className = 'shot';
    i.src = shot.dataUrl;
    f.appendChild(i);
    return f;
  }

  function draw() {
    var body = $('wsBody');
    body.textContent = '';
    var st = LAIN.state();
    var ws = st && st.workshop;
    $('wsUrl').textContent = (ws && ws.url) || '';

    // ---- BEFORE / AFTER, when there is a pair ---------------------------
    if (W.before && W.after) {
      var ba = el('div', 'ba');
      ba.appendChild(shotFig('Before', W.before));
      ba.appendChild(shotFig('After', W.after));
      body.appendChild(ba);
    } else if (W.shot) {
      body.appendChild(shotFig(W.before ? 'Before captured \\u00b7 live' : 'Preview \\u00b7 ' + W.vp, W.shot));
    }

    // ---- THE SELECTED ELEMENT ------------------------------------------
    if (W.element) {
      var e = W.element;
      body.appendChild(el('div', 'ws-title', 'Selected element'));
      var dl = el('dl', 'kv');
      var put = function (k, v) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
      put('selector', e.selector);
      put('role', [e.role, e.name].filter(Boolean).join(' \\u2014 '));
      put('tag', e.tag + (e.id ? '#' + e.id : ''));
      if (e.rect) put('box', e.rect.w + '\\u00d7' + e.rect.h + ' at ' + e.rect.x + ',' + e.rect.y);
      if (e.layout) {
        ['display', 'position', 'align-items', 'justify-content', 'margin', 'text-align'].forEach(function (k) {
          if (e.layout[k] && String(e.layout[k]).trim()) put(k, String(e.layout[k]).trim());
        });
      }
      if (e.parent) put('parent', '<' + e.parent.tag + '> ' + e.parent.display
        + (e.parent.justify ? ' / ' + e.parent.justify : '') + (e.parent.align ? ' / ' + e.parent.align : ''));
      body.appendChild(dl);
    }

    // ---- CONSOLE AND NETWORK, summarised ------------------------------
    //
    // COUNTS FIRST, DETAIL UNDER THEM. A panel that dumps every request by
    // default is a log, and a log is the thing nobody reads.
    if (ws && ws.observations && ws.observations.console) {
      // THE REPORTS ARE ALREADY SUMMARIES — {errors,total,entries} and
      // {total,failed,entries}. Filtering them again as arrays produced an empty
      // panel over a page that really did have errors. Found by a real run.
      var c = ws.observations.console, n = ws.observations.network || {};
      body.appendChild(el('div', 'ws-title', 'Console \u00b7 ' + (c.errors ? c.errors + ' error(s) of ' + c.total : 'clean')));
      (c.entries || []).slice(0, 6).forEach(function (x) { body.appendChild(el('div', 'obs err', x.text)); });
      body.appendChild(el('div', 'ws-title', 'Network \u00b7 ' + (n.failed ? n.failed + ' failed of ' + n.total : 'clean')));
      (n.entries || []).slice(0, 6).forEach(function (x) { body.appendChild(el('div', 'obs err', x.status + '  ' + x.url)); });
    }

    // ---- WHAT VERIFICATION OBSERVED ------------------------------------
    if (W.verify && W.verify.results) {
      body.appendChild(el('div', 'ws-title', 'Verification evidence'));
      W.verify.results.forEach(function (r) {
        var line = el('div', 'obs' + (r.ok ? '' : ' err'));
        // A check entry is {name, ok, detail}. There was never a 'what' field,
        // and reading one printed undefined beside every viewport. Found by a
        // real run against the fixture project, not by reading the code.
        var failed = (r.checks || []).filter(function (c) { return !c.ok; });
        line.textContent = (r.ok ? '\u2713 ' : '\u2717 ') + r.viewport
          + (r.width ? '  ' + r.width + 'px' : '')
          + (failed.length ? '  \u00b7  ' + failed.map(function (c) { return c.name + ' (' + c.detail + ')'; }).join(', ') : '');
        body.appendChild(line);
      });
      body.appendChild(el('div', 'obs', 'Evidence only. The task is settled by the Harness, not by this panel.'));
    }
  }

  /** Called on every poll. Keeps the panel honest about the real browser. */
  function render(S) {
    var ws = S && S.workshop;
    if (!ws) return;
    // THE PILL SAYS WHAT IS POSSIBLE, not what we wish were. A machine with no
    // browser says so here rather than failing when the button is pressed.
    $('wsPill').disabled = !ws.available && !W.open;
    $('wsPill').title = ws.available ? '' : (ws.why || 'no browser is available on this machine');
    if (!ws.open && W.open) { W.open = false; layout(); }
    if (ws.url) $('wsUrl').textContent = ws.url;
  }

  return { boot: boot, render: render, draw: draw };
})();
`;
}

module.exports = { js };
