'use strict';

/**
 * WHAT THE PREVIEW PAGE ACTUALLY SHOWS — read structurally, bounded, and
 * scoped to what a turn can use.
 *
 * ------------------------------------------------------------------------
 * THE RULE THAT SHAPES EVERY FUNCTION HERE: NEVER SEND THE WHOLE DOM.
 *
 * A page's DOM is megabytes and almost all of it is noise. Handed to a model it
 * buries the one element the person is asking about, costs a fortune, and
 * routinely does not fit. So every reader below returns a BOUNDED, NAMED answer
 * about a specific thing: this element, these console errors, these failing
 * requests. `element()` is the point of the whole file — a person clicks one
 * button and LAIN receives that button, its box, its computed layout and its
 * accessible name, in a few hundred characters.
 *
 * ------------------------------------------------------------------------
 * EVIDENCE ORDER, the same one modelsource/pageops.js states.
 *
 *   1. semantic attributes   data-testid, id, aria-*
 *   2. accessibility state   what a user is TOLD about the element
 *   3. computed layout       the numbers that decide "is it aligned"
 *   4. a screenshot          only when the question is genuinely visual
 *
 * A screenshot is not the default reading. "Is this centred" is answered by
 * `justify-content` and a bounding box exactly, and by a picture approximately.
 */

/** Nothing read off a page is unbounded. */
const MAX_TEXT = 2000;
const MAX_NODES = 40;
const MAX_CONSOLE = 30;
const MAX_NETWORK = 40;

/** The computed properties that actually decide a layout complaint. */
const LAYOUT_PROPS = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'margin', 'padding', 'width', 'height', 'max-width', 'gap',
  'text-align', 'font-size', 'line-height', 'overflow', 'transform',
];

function lit(v) { return JSON.stringify(v === undefined ? null : v); }

/** One evaluate with a named failure, so a report points at what was attempted. */
async function ask(page, what, expression) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: `${what}: no page` };
  const r = await page.evaluate(expression);
  return r.ok ? { ok: true, value: r.value } : { ok: false, why: `${what}: ${r.why}` };
}

/**
 * EVERYTHING WORTH KNOWING ABOUT ONE ELEMENT, in one round trip.
 *
 * Identity, accessible name, box, computed layout, and the PARENT's layout —
 * which is included because most alignment complaints are about the parent's
 * `justify-content`, not the child's own properties. One evaluate rather than
 * six, because each round trip is a real millisecond against a person waiting.
 *
 * `selector` of null reads `window.__lainPicked`, which is what the click
 * picker leaves behind.
 */
function describeExpr(selectorOrNull) {
  return `(() => {
    const sel = ${lit(selectorOrNull)};
    const el = sel ? document.querySelector(sel) : (window.__lainPicked || null);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const layout = {};
    for (const p of ${lit(LAYOUT_PROPS)}) layout[p] = cs.getPropertyValue(p);
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 200);
    const ws = new RegExp('[ ' + String.fromCharCode(9, 10, 13) + ']+', 'g');
    const pathOf = (n) => {
      if (n.id) return '#' + n.id;
      if (n.getAttribute && n.getAttribute('data-testid')) return '[data-testid="' + n.getAttribute('data-testid') + '"]';
      const parts = [];
      let cur = n;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + cur.id); break; }
        const par = cur.parentElement;
        if (par) {
          const same = [].slice.call(par.children).filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : String(el.className || '');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: cls.trim().slice(0, 300),
      testid: el.getAttribute('data-testid') || null,
      role: el.getAttribute('role') || null,
      name: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(ws, ' ').trim().slice(0, 300),
      selector: pathOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      layout,
      attributes: attrs,
      parent: el.parentElement ? {
        tag: el.parentElement.tagName.toLowerCase(),
        display: getComputedStyle(el.parentElement).display,
        justify: getComputedStyle(el.parentElement).justifyContent,
        align: getComputedStyle(el.parentElement).alignItems,
      } : null,
    };
  })()`;
}

/** One element by selector, or a stated reason there is not one. */
async function element(page, selector) {
  const r = await ask(page, 'read the element', describeExpr(String(selector)));
  if (!r.ok) return r;
  if (!r.value) return { ok: false, why: `nothing matches ${selector}` };
  return { ok: true, element: r.value };
}

/**
 * THE ELEMENT PICKER — a real click-to-select workflow.
 *
 * Injects an overlay that highlights whatever is under the pointer and records
 * the next click, then GETS OUT OF THE WAY. Deliberately not a permanent
 * script: it removes its own listeners on selection and on Escape, because a
 * page still carrying an inspector's capture-phase handlers is not the page the
 * person is testing, and every click after that would be swallowed.
 */
const PICKER = `(() => {
  if (window.__lainPicker) return 'already';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2ea8ff;background:rgba(46,168,255,.12);border-radius:2px';
  document.documentElement.appendChild(box);
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#0b1220;color:#cfe8ff;font:11px/1.4 ui-monospace,monospace;padding:2px 6px;border-radius:3px';
  document.documentElement.appendChild(label);
  let hovered = null;
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.style.left = r.x + 'px';
    label.style.top = Math.max(0, r.y - 20) + 'px';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '  '
      + Math.round(r.width) + String.fromCharCode(215) + Math.round(r.height);
  };
  const stop = () => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', esc, true);
    box.remove(); label.remove();
    window.__lainPicker = null;
  };
  function pick(e) {
    e.preventDefault(); e.stopPropagation();
    window.__lainPicked = hovered || document.elementFromPoint(e.clientX, e.clientY);
    stop();
  }
  function esc(e) { if (e.key === 'Escape') { e.preventDefault(); stop(); } }
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', esc, true);
  window.__lainPicker = { stop };
  window.__lainPicked = null;
  return 'armed';
})()`;

/** Arm the picker. The person then clicks in the preview. */
async function pick(page) {
  const r = await ask(page, 'arm the element picker', PICKER);
  return r.ok ? { ok: true, state: r.value } : r;
}

/** What was picked, or null while nothing has been. Polled by the frontend. */
async function picked(page) {
  const r = await ask(page, 'read the picked element', describeExpr(null));
  if (!r.ok) return r;
  return { ok: true, element: r.value || null };
}

/** Put the picker away without selecting anything. */
async function unpick(page) {
  return ask(page, 'disarm the picker',
    '(() => { if (window.__lainPicker) window.__lainPicker.stop(); window.__lainPicked = null; return "off"; })()');
}

/**
 * THE ACCESSIBILITY TREE — what a user is TOLD, which is a different question
 * from what is in the document.
 *
 * A `<div onclick>` is in the DOM and invisible to this. For "can somebody
 * actually use this control", the accessible answer is the true one.
 */
async function axTree(page, selector = null) {
  if (!page || typeof page.axTree !== 'function') {
    return { ok: false, why: 'this page cannot report an accessibility tree' };
  }
  const ax = await page.axTree(selector);
  if (!ax.ok) return ax;
  const nodes = (ax.nodes || [])
    .filter((n) => !n.ignored && (n.role || n.name))
    .slice(0, MAX_NODES)
    .map((n) => ({ role: n.role || '?', name: String(n.name || '').slice(0, 120), disabled: Boolean(n.disabled) }));
  return { ok: true, nodes };
}

/**
 * THE CONSOLE, SUMMARISED FIRST.
 *
 * `2 errors` is what a person needs to see; the lines are what they expand to.
 * Returning the whole log by default is how a Workshop becomes a log viewer
 * nobody reads.
 */
function consoleReport(session) {
  const errors = session && typeof session.errors === 'function' ? session.errors() : [];
  const all = (session && Array.isArray(session.console)) ? session.console : [];
  return {
    errors: errors.length,
    total: all.length,
    entries: errors.slice(-MAX_CONSOLE).map((e) => ({
      level: e.level || 'error',
      text: String(e.text || '').slice(0, MAX_TEXT),
    })),
  };
}

/**
 * THE NETWORK, SUMMARISED THE SAME WAY, AND FAILURES FIRST.
 *
 * `POST /checkout 500` is the row that matters. Two hundred 200s are not an
 * observation, they are scenery.
 */
function networkReport(session) {
  const all = (session && Array.isArray(session.network)) ? session.network : [];
  const failed = all.filter((n) => Number(n.status) >= 400);
  return {
    total: all.length,
    failed: failed.length,
    entries: failed.slice(-MAX_NETWORK).map((n) => ({ status: n.status, url: String(n.url || '').slice(0, 300) })),
  };
}

module.exports = {
  element, pick, picked, unpick, axTree, consoleReport, networkReport,
  describeExpr, LAYOUT_PROPS, MAX_TEXT, MAX_NODES, MAX_CONSOLE, MAX_NETWORK,
};
