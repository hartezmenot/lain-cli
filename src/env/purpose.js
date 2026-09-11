'use strict';

/**
 * WHAT A HARNESS BROWSER IS *FOR* — the three purposes, named once.
 *
 * ------------------------------------------------------------------------
 * THIS FILE EXISTS BECAUSE THE BOUNDARY WAS TRUE BUT UNWRITTEN.
 *
 * Three modules already kept three separate profile roots and each explained,
 * in its own header, why it must not share with the other two. The reasoning
 * was right and it was TRIPLICATED, which means the rule lived nowhere: a
 * fourth consumer (a guest runner, a Computer MCP target) had nothing to import
 * and would have had to re-derive the boundary from prose. This is the rule as
 * a value.
 *
 *   VERIFY    disposable. A fresh `mkdtemp` profile per launch, deleted with
 *             the task. Pointed at code under test — the code least worth
 *             trusting with a person's cookies. A verdict that depended on
 *             leftover state would not be a verdict.
 *
 *   WORKSHOP  project-bound. One profile per project, kept across a
 *             development session so the preview keeps its localStorage, its
 *             dev login and its scroll position. Fast, and NOT pristine — that
 *             is the trade it exists to make. Keyed by project so
 *             `localhost:3000` in project A cannot collide with project B.
 *
 *   WEBMODEL  persistent and authenticated. Holds a person's real ChatGPT /
 *             Google login. Headful, because a human logs in by hand. This one
 *             is the reason the other two exist: everything else must be
 *             provably NOT this.
 *
 * ------------------------------------------------------------------------
 * OWNERSHIP IS PART OF THE PURPOSE, NOT A SEPARATE FLAG.
 *
 * Every one of these is a HARNESS-OWNED profile. None of them is the person's
 * normal Chrome profile, and there is deliberately no purpose that names it.
 * The user's own browser is reachable only by a future Computer MCP target that
 * a person explicitly asks for, and it will not arrive by adding a fourth
 * constant here — it is a different kind of thing (someone else's session,
 * borrowed) and it must not be able to masquerade as a Harness profile.
 */

const path = require('path');

/** The four, and each says why it is not one of the others. */
const PURPOSE = {
  VERIFY: 'verify',
  WORKSHOP: 'workshop',
  WEBMODEL: 'webmodel',
  /**
   * THE HARNESS APPLICATION'S OWN WINDOW — a fourth purpose, added on purpose.
   *
   * The three above are INSTRUMENTS: browsers LAIN drives, on profiles LAIN
   * owns, pointed at something under test. This one is not an instrument. It is
   * the shell LAIN's own graphical surface runs in, and nothing drives it — a
   * person does.
   *
   * IT IS NOT ANY OF THE OTHER THREE, and each would be wrong differently:
   * VERIFY is headless and thrown away, so the window would vanish with a task;
   * WORKSHOP is bound to the project under development, and the Harness is not
   * one project's tool; WEBMODEL holds a person's ChatGPT login, which has no
   * business in the application chrome.
   *
   * IT IS STILL NOT THE PERSON'S BROWSER. The window runs on a Harness profile
   * with no personal cookies. What it gets from Chromium is a WINDOW — no tab
   * strip, no address bar, its own taskbar entry — which is the difference
   * between "a page in a browser" and "an application", and the reason a person
   * can alt-tab to it rather than hunting for a tab.
   *
   * THIS IS A STEP TOWARD THE NATIVE SHELL, NOT THE NATIVE SHELL. See
   * harnessapp/desktop.js for what it does and does not buy.
   */
  HARNESSAPP: 'harnessapp',
};

const ALL = [PURPOSE.VERIFY, PURPOSE.WORKSHOP, PURPOSE.WEBMODEL, PURPOSE.HARNESSAPP];

/**
 * HOW EACH PURPOSE BEHAVES. Read by the runtime instead of by `if` chains
 * scattered across three launchers, which is how the three drifted apart.
 *
 *   lifetime   'task'     dies with the task that opened it
 *              'project'  outlives tasks, dies with the project session
 *              'session'  outlives everything until the person disconnects
 *   headless   the DEFAULT only; a caller may still override deliberately.
 *   extensions WEBMODEL keeps them: a person's password manager is genuinely
 *              part of their login flow. The other two do not, because an
 *              extension is uncontrolled input to a verdict.
 */
const TRAITS = {
  [PURPOSE.VERIFY]: {
    lifetime: 'task', headless: true, extensions: false, disposable: true,
    why: 'a verdict must not depend on state a previous run left behind',
  },
  [PURPOSE.WORKSHOP]: {
    lifetime: 'project', headless: false, extensions: false, disposable: false,
    why: 'a preview you cannot keep is not a workshop',
  },
  [PURPOSE.WEBMODEL]: {
    lifetime: 'session', headless: false, extensions: true, disposable: false,
    why: 'it holds a person login and must outlive every task',
  },
  [PURPOSE.HARNESSAPP]: {
    // NEVER HEADLESS: a window nobody can see is not an application. And never
    // disposable — window position, zoom and scroll are the small things that
    // make a tool feel like one you have used before.
    lifetime: 'session', headless: false, extensions: false, disposable: false,
    why: 'it is the application window, and a person is looking at it',
  },
};

function traits(purpose) {
  const t = TRAITS[String(purpose || '').toLowerCase()];
  if (!t) throw new Error(`unknown browser purpose: ${purpose}`);
  return t;
}

function isPurpose(p) { return Object.prototype.hasOwnProperty.call(TRAITS, String(p || '').toLowerCase()); }

/**
 * THE ASSERTION THAT TWO PURPOSES HAVE NOT MERGED ON DISK.
 *
 * A function rather than a comment because the failure it guards is SILENT: a
 * refactor that handed the Workshop the web-model profile root would work
 * perfectly on the day, and would put a real ChatGPT login inside a browser
 * pointed at code under development. Containment either way is a violation —
 * a parent directory is not a safe distance, it is the same disk.
 */
function separate(aPath, bPath, aName = 'a', bName = 'b') {
  const a = path.resolve(String(aPath || ''));
  const b = path.resolve(String(bPath || ''));
  if (!a || !b) return { ok: true, why: '' };
  if (a === b) return { ok: false, why: `${aName} and ${bName} are the same profile directory: ${a}` };
  if (a.startsWith(b + path.sep)) return { ok: false, why: `${aName} (${a}) lives inside ${bName} (${b})` };
  if (b.startsWith(a + path.sep)) return { ok: false, why: `${bName} (${b}) lives inside ${aName} (${a})` };
  return { ok: true, why: '' };
}

module.exports = { PURPOSE, ALL, TRAITS, traits, isPurpose, separate };
