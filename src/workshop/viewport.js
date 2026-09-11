'use strict';

/**
 * DESKTOP, TABLET, MOBILE — and why three is the right number.
 *
 * ------------------------------------------------------------------------
 * NOT A DEVICE DATABASE.
 *
 * There are hundreds of real device sizes and testing against all of them is a
 * job for a device lab, not for a person asking "does this work on a phone".
 * Three named widths answer that question, they are the three a designer
 * actually laid the page out for, and each one names a real breakpoint most
 * CSS frameworks share. A dropdown of ninety devices would be a worse answer to
 * the same question.
 *
 * ------------------------------------------------------------------------
 * A REAL EMULATION, NOT A RESIZED WINDOW.
 *
 * `Emulation.setDeviceMetricsOverride` changes what the PAGE believes: the
 * viewport that media queries read, the device pixel ratio, and — for mobile —
 * that this is a touch device at all. Just making the window narrower leaves
 * `hover` working, leaves `pointer: fine`, and leaves any layout gated on
 * `matchMedia('(pointer: coarse)')` in its desktop branch. That is how a mobile
 * verification passes against a layout no phone would ever render.
 *
 * ------------------------------------------------------------------------
 * A RELOAD IS PART OF THE SWITCH, and it is not optional.
 *
 * Load-time device gates — a framework that reads the width once at mount, an
 * image `srcset` already resolved, a component that branched on touch support
 * in its constructor — do not re-run on a metrics change. Verifying mobile on a
 * page that booted as desktop is verifying a hybrid that exists nowhere.
 */

/** The three, with the properties that make each one a real device class. */
const PRESETS = Object.freeze({
  desktop: { label: 'Desktop', width: 1440, height: 900, scale: 1, mobile: false },
  tablet: { label: 'Tablet', width: 768, height: 1024, scale: 2, mobile: false },
  mobile: { label: 'Mobile', width: 390, height: 844, scale: 3, mobile: true },
});

const ORDER = Object.freeze(['desktop', 'tablet', 'mobile']);

/** A preset by name, or null. Unknown names are refused rather than guessed. */
function preset(name) {
  const k = String(name || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRESETS, k) ? { key: k, ...PRESETS[k] } : null;
}

/**
 * APPLY ONE, THROUGH CDP.
 *
 * @param {object} session  a harness BrowserSession — its `conn` is the wire.
 * @param {boolean} [o.reload]  re-run the page's load-time device gates. On by
 *   default; see the header for why turning it off is usually a mistake.
 */
async function apply(session, name, { reload = true } = {}) {
  const p = preset(name);
  if (!p) return { ok: false, why: `"${name}" is not a viewport (${ORDER.join(', ')})` };
  if (!session || !session.conn) return { ok: false, why: 'no browser session to resize' };
  try {
    await session.conn.send('Emulation.setDeviceMetricsOverride', {
      width: p.width,
      height: p.height,
      deviceScaleFactor: p.scale,
      mobile: p.mobile,
    });
    // TOUCH IS PART OF BEING A PHONE. A layout gated on `(pointer: coarse)` or
    // on `ontouchstart` is otherwise still rendering its desktop branch inside
    // a 390px box, which looks like a passing mobile check and is not one.
    try {
      await session.conn.send('Emulation.setTouchEmulationEnabled', {
        enabled: p.mobile, maxTouchPoints: p.mobile ? 5 : 0,
      });
    } catch { /* older builds refuse this; the metrics still hold */ }
  } catch (e) {
    return { ok: false, why: `the browser refused the viewport: ${(e && e.message) || e}` };
  }
  if (reload) {
    try {
      await session.conn.send('Page.reload', { ignoreCache: false });
      // Settle briefly so the caller reads the page AFTER its gates re-ran
      // rather than during the reload. Bounded and short.
      await new Promise((r) => setTimeout(r, 400));
    } catch { /* a page that will not reload is still emulated */ }
  }
  session.viewport = p.key;
  return { ok: true, viewport: p.key, width: p.width, height: p.height, why: `${p.label} ${p.width}px` };
}

/** Hand the page back its real window. */
async function clear(session) {
  if (!session || !session.conn) return { ok: true };
  try { await session.conn.send('Emulation.clearDeviceMetricsOverride'); } catch { /* already clear */ }
  try { await session.conn.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 }); } catch { /* fine */ }
  session.viewport = null;
  return { ok: true };
}

/**
 * IS THE PAGE OVERFLOWING ITS VIEWPORT SIDEWAYS?
 *
 * The single most common real mobile defect, and one a screenshot shows only if
 * somebody is looking carefully. `scrollWidth > clientWidth` is exact, and it
 * names the widest offender so the answer is actionable rather than a verdict.
 */
async function overflow(session) {
  if (!session || typeof session.evaluate !== 'function') return { ok: false, why: 'no page' };
  const r = await session.evaluate(`(() => {
    const d = document.documentElement;
    const over = d.scrollWidth - d.clientWidth;
    let worst = null;
    if (over > 0) {
      let widest = 0;
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        const right = b.x + b.width;
        if (right > d.clientWidth + 1 && b.width > widest) {
          widest = b.width;
          worst = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
            + '  ' + Math.round(b.x) + '..' + Math.round(right) + 'px';
        }
      }
    }
    return { over, clientWidth: d.clientWidth, scrollWidth: d.scrollWidth, worst };
  })()`);
  if (!r.ok) return { ok: false, why: r.why };
  const v = r.value || {};
  return {
    ok: true,
    overflowing: Number(v.over) > 0,
    by: Number(v.over) || 0,
    clientWidth: v.clientWidth,
    scrollWidth: v.scrollWidth,
    worst: v.worst || null,
  };
}

module.exports = { PRESETS, ORDER, preset, apply, clear, overflow };
