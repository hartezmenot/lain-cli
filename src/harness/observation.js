'use strict';

/**
 * THE OBSERVATION PLANE — one question shape, many ways of answering it.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM.
 *
 * "Is the submit button disabled?" has at least five possible answers on this
 * machine: read the DOM, read the accessibility tree, evaluate JavaScript in
 * the page, take a screenshot and look at it, or drive the desktop. They differ
 * by three orders of magnitude in cost and by a lot in reliability, and the
 * cheapest correct one depends on facts the asker does not have — whether a
 * browser is attached, whether the UI is a canvas, whether a bridge is
 * configured.
 *
 * Left to itself a model picks a screenshot, because a screenshot always works.
 * That is the expensive habit this plane exists to remove: the asker states the
 * GOAL and the ROUTER picks the source.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT src/observe.js, AND HOW THE TWO ARE JOINED.
 *
 * `src/observe.js` is a RUN WATCHER. It attaches capture rules to a long
 * program, records what happened while it ran, and refuses to merge evidence
 * from different kinds of witness — its five SOURCE values (LOG, VISUAL,
 * MEMORY, PROCESS, USER) exist so that "the log said it worked" can never be
 * confused with "a screenshot showed it worked". That distinction is older than
 * this file and is right.
 *
 * This is a QUESTION ANSWERER. It is asked one thing, now, and returns one
 * answer. Its sources are finer-grained because the choice between DOM and
 * screenshot is exactly the decision being made.
 *
 * They are joined rather than parallel: `COARSE_OF` maps every source here onto
 * one of observe.js's five, so an observation made through this plane can be
 * filed as evidence in that one without a second opinion about what kind of
 * witness it was. Two vocabularies that disagree is the failure; two
 * vocabularies with a total function between them is a layering.
 *
 * ------------------------------------------------------------------------
 * A SOURCE THAT CANNOT ANSWER SAYS SO. It never guesses, and it never returns
 * a confident-sounding "not found" for a question it had no way to ask. `ok:
 * false` with a reason is how the router knows to try the next one, and it is
 * also what makes a verification INCONCLUSIVE rather than FAILED.
 */

const fs = require('fs');
const path = require('path');

/**
 * WHERE AN ANSWER CAME FROM. Fine-grained on purpose — see the header.
 */
const SOURCE = Object.freeze({
  FILESYSTEM: 'filesystem',
  AST: 'ast',
  GIT: 'git',
  PROCESS: 'process',
  LOGS: 'logs',
  HTTP: 'http',
  DOM: 'dom',
  ACCESSIBILITY: 'accessibility',
  CONSOLE: 'console',
  NETWORK: 'network',
  SCREENSHOT: 'screenshot',
  VISION: 'vision',
  OCR: 'ocr',
  SYSTEM: 'system',
});

/**
 * THE JOIN WITH observe.js. Total: every source here has a coarse kind there,
 * so nothing observed through this plane is unfileable as evidence.
 */
const COARSE_OF = Object.freeze({
  [SOURCE.FILESYSTEM]: 'MEMORY',
  [SOURCE.AST]: 'MEMORY',
  [SOURCE.GIT]: 'MEMORY',
  [SOURCE.PROCESS]: 'PROCESS',
  [SOURCE.LOGS]: 'LOG',
  [SOURCE.HTTP]: 'LOG',
  [SOURCE.DOM]: 'MEMORY',
  [SOURCE.ACCESSIBILITY]: 'MEMORY',
  [SOURCE.CONSOLE]: 'LOG',
  [SOURCE.NETWORK]: 'LOG',
  [SOURCE.SCREENSHOT]: 'VISUAL',
  [SOURCE.VISION]: 'VISUAL',
  [SOURCE.OCR]: 'VISUAL',
  [SOURCE.SYSTEM]: 'PROCESS',
});

/**
 * WHAT SOMEBODY MIGHT WANT TO KNOW. A closed list, because the router's whole
 * value is that a goal maps to an ORDERED set of sources, and a goal nobody
 * mapped would fall through to "take a screenshot", which is the habit being
 * removed.
 */
const GOAL = Object.freeze({
  FILE: 'file',
  CODE: 'code',
  CHANGES: 'changes',
  PROCESS: 'process',
  LOGS: 'logs',
  ENDPOINT: 'endpoint',
  ELEMENT: 'element',
  PAGE: 'page',
  ERRORS: 'errors',
  REQUESTS: 'requests',
  SCREEN: 'screen',
  SYSTEM: 'system',
});

/**
 * THE ROUTING TABLE — the priority order per goal, and the reason the whole
 * plane exists.
 *
 * STRUCTURED BEFORE VISUAL, ALWAYS, with one deliberate exception.
 *
 * `ELEMENT` asks about a thing in a UI. The DOM is exact, cheap and machine
 * readable, so it goes first; the accessibility tree second because it answers
 * "what would a user perceive" where the DOM answers "what is in the tree";
 * then evaluated JavaScript; and only then a picture.
 *
 * `SCREEN` is the exception and it is not an inconsistency. Some UIs are
 * genuinely pixels — a canvas, a game, a video, a native window — and there the
 * DOM is not merely more expensive to consult, it is EMPTY. Insisting on
 * structure there would produce a confident "the element is not present" about
 * something plainly visible on the screen, which is worse than the cost it
 * saved. So a caller that knows the thing is visual asks for SCREEN and gets
 * pixels first, honestly.
 */
const ROUTES = Object.freeze({
  [GOAL.FILE]: [SOURCE.FILESYSTEM],
  [GOAL.CODE]: [SOURCE.AST, SOURCE.FILESYSTEM],
  [GOAL.CHANGES]: [SOURCE.GIT, SOURCE.FILESYSTEM],
  [GOAL.PROCESS]: [SOURCE.PROCESS, SOURCE.SYSTEM],
  [GOAL.LOGS]: [SOURCE.LOGS, SOURCE.CONSOLE],
  [GOAL.ENDPOINT]: [SOURCE.HTTP, SOURCE.NETWORK],
  [GOAL.ELEMENT]: [SOURCE.DOM, SOURCE.ACCESSIBILITY, SOURCE.SCREENSHOT, SOURCE.VISION],
  [GOAL.PAGE]: [SOURCE.DOM, SOURCE.ACCESSIBILITY, SOURCE.SCREENSHOT],
  [GOAL.ERRORS]: [SOURCE.CONSOLE, SOURCE.LOGS],
  [GOAL.REQUESTS]: [SOURCE.NETWORK, SOURCE.LOGS],
  [GOAL.SCREEN]: [SOURCE.SCREENSHOT, SOURCE.VISION, SOURCE.OCR, SOURCE.DOM],
  [GOAL.SYSTEM]: [SOURCE.SYSTEM, SOURCE.PROCESS],
});

/** How much of any observed value is carried back. The rest becomes an artifact. */
const MAX_VALUE = 8000;

function clip(v, n = MAX_VALUE) {
  const s = String(v == null ? '' : v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function miss(source, why) { return { ok: false, source, why, value: null, summary: why }; }
function hit(source, value, summary) { return { ok: true, source, value, summary: summary || clip(value, 200) }; }

/**
 * THE PROVIDERS. One per source, each answering only what it can.
 *
 * Every one of them is allowed — required — to return `ok: false` when it is
 * not attached, not configured or not applicable. That is not an error path; it
 * is the router's input.
 */
const PROVIDERS = {
  async [SOURCE.FILESYSTEM](spec, ctx) {
    const p = spec.path;
    if (!p) return miss(SOURCE.FILESYSTEM, 'no path to look at');
    const abs = path.resolve(ctx.cwd || process.cwd(), String(p));
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const names = fs.readdirSync(abs).slice(0, 200);
        return hit(SOURCE.FILESYSTEM, names.join('\n'), `${names.length} entries in ${p}`);
      }
      const text = fs.readFileSync(abs, 'utf8');
      return hit(SOURCE.FILESYSTEM, clip(text), `${p} — ${st.size} bytes`);
    } catch (e) {
      if (e && e.code === 'ENOENT') return hit(SOURCE.FILESYSTEM, '', `${p} does not exist`);
      return miss(SOURCE.FILESYSTEM, `${p} could not be read: ${(e && e.code) || e}`);
    }
  },

  async [SOURCE.AST](spec, ctx) {
    if (!spec.path) return miss(SOURCE.AST, 'no file to parse');
    const abs = path.resolve(ctx.cwd || process.cwd(), String(spec.path));
    let model;
    try { model = require('../codemodel').scanFile(abs); } catch (e) { return miss(SOURCE.AST, `could not parse: ${(e && e.message) || e}`); }
    if (!model || !model.supported) return miss(SOURCE.AST, 'this file type has no code model');
    const names = [...(model.bindings || [])].slice(0, 200);
    return hit(SOURCE.AST, names.join('\n'), `${names.length} top-level names in ${spec.path}`);
  },

  async [SOURCE.GIT](spec, ctx) {
    let git;
    try { git = require('../gitsense'); } catch { return miss(SOURCE.GIT, 'git support is not available'); }
    // gitsense.status answers {ok, files:[{file, staged, untracked, deleted, renamed}]}
    // and reports `ok:false` with the real git error when this is not a
    // repository. That is a MISS, not an empty answer: "no changed files" and
    // "not a git repository" must never render the same.
    const st = await git.status(ctx.cwd || process.cwd());
    if (!st || !st.ok) return miss(SOURCE.GIT, (st && st.error) || 'git could not report on this directory');
    const files = (st.files || []).map((f) => {
      const marks = [f.staged ? 'staged' : '', f.untracked ? 'new' : '', f.deleted ? 'deleted' : '', f.renamed ? `renamed from ${f.from}` : ''].filter(Boolean);
      return `${f.file}${marks.length ? `  (${marks.join(', ')})` : ''}`;
    });
    return hit(SOURCE.GIT, files.join('\n'), `${files.length} changed file${files.length === 1 ? '' : 's'}`);
  },

  async [SOURCE.PROCESS](spec, ctx) {
    const pm = ctx.processes;
    if (!pm) return miss(SOURCE.PROCESS, 'no process manager attached');
    const p = spec.process_id ? pm.get(spec.process_id) : (spec.name ? pm.named(ctx.taskId, spec.name) : null);
    if (!p) {
      const all = pm.list(ctx.taskId);
      if (!all.length) return miss(SOURCE.PROCESS, 'no managed processes are running');
      return hit(SOURCE.PROCESS, all.map((x) => `${x.name} ${x.status} ${x.health}`).join('\n'), `${all.length} managed process${all.length === 1 ? '' : 'es'}`);
    }
    const r = await pm.check(p.processId);
    return hit(SOURCE.PROCESS, `${p.name} ${p.status} ${r.health}`, `${p.name}: ${p.status}, ${r.health} — ${r.why}`);
  },

  async [SOURCE.LOGS](spec, ctx) {
    const pm = ctx.processes;
    if (!pm) return miss(SOURCE.LOGS, 'no process manager attached');
    const p = spec.process_id ? pm.get(spec.process_id) : (spec.name ? pm.named(ctx.taskId, spec.name) : pm.list(ctx.taskId)[0]);
    if (!p) return miss(SOURCE.LOGS, 'no managed process to read logs from');
    const tail = p.tail(Number(spec.lines) || 60);
    return hit(SOURCE.LOGS, clip(tail), `last lines of ${p.name}`);
  },

  async [SOURCE.HTTP](spec, ctx) {
    if (!spec.url) return miss(SOURCE.HTTP, 'no url to fetch');
    const { httpProbe } = require('./processes');
    const r = await httpProbe(String(spec.url), Number(spec.timeout_ms) || 5000);
    if (r.status == null) return miss(SOURCE.HTTP, `nothing answered at ${spec.url} — ${r.why}`);
    return hit(SOURCE.HTTP, String(r.status), `${spec.url} answered ${r.why}`);
  },

  async [SOURCE.DOM](spec, ctx) {
    if (!ctx.browser) return miss(SOURCE.DOM, 'no browser is attached');
    return ctx.browser.observe(SOURCE.DOM, spec, ctx);
  },
  async [SOURCE.ACCESSIBILITY](spec, ctx) {
    if (!ctx.browser) return miss(SOURCE.ACCESSIBILITY, 'no browser is attached');
    return ctx.browser.observe(SOURCE.ACCESSIBILITY, spec, ctx);
  },
  async [SOURCE.CONSOLE](spec, ctx) {
    if (!ctx.browser) return miss(SOURCE.CONSOLE, 'no browser is attached');
    return ctx.browser.observe(SOURCE.CONSOLE, spec, ctx);
  },
  async [SOURCE.NETWORK](spec, ctx) {
    if (!ctx.browser) return miss(SOURCE.NETWORK, 'no browser is attached');
    return ctx.browser.observe(SOURCE.NETWORK, spec, ctx);
  },

  async [SOURCE.SCREENSHOT](spec, ctx) {
    // A BROWSER SCREENSHOT IS PREFERRED TO A DESKTOP ONE when a browser is
    // attached: it is scoped to the page, needs no permission from the person,
    // and cannot capture their email client by accident.
    if (ctx.browser) {
      const r = await ctx.browser.observe(SOURCE.SCREENSHOT, spec, ctx);
      if (r.ok) return r;
    }
    return desktopLook(SOURCE.SCREENSHOT, spec, ctx);
  },
  async [SOURCE.VISION](spec, ctx) { return desktopLook(SOURCE.VISION, spec, ctx); },
  async [SOURCE.OCR](spec, ctx) { return desktopLook(SOURCE.OCR, spec, ctx); },

  async [SOURCE.SYSTEM](spec, ctx) {
    const os = require('os');
    const facts = [
      `platform ${process.platform}`,
      `node ${process.version}`,
      `cwd ${ctx.cwd || process.cwd()}`,
      `free ${Math.round(os.freemem() / 1e6)}MB of ${Math.round(os.totalmem() / 1e6)}MB`,
      `load ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`,
    ];
    return hit(SOURCE.SYSTEM, facts.join('\n'), facts[0]);
  },
};

/**
 * THE DESKTOP, AND THE PERMISSION THAT GUARDS IT.
 *
 * Screen capture and OCR go through `src/computer.js`, which owns the dialects
 * and, crucially, the consent: permissions.js is asked on every call, not once
 * at connect time. This wrapper adds NOTHING to that — it does not cache a
 * grant, does not retry a refusal and does not have its own idea of whether
 * looking at the screen is allowed. A refusal comes back as `ok: false`, which
 * makes the observation INCONCLUSIVE, which is the truth: nobody looked.
 */
async function desktopLook(source, spec, ctx) {
  let computer;
  try { computer = require('../computer'); } catch { return miss(source, 'no desktop bridge module'); }
  const app = ctx.app || null;
  if (!app) return miss(source, 'no session context to ask for desktop permission');
  // computer.js's own vocabulary: `ocr` reads text, `screenshot` captures. Both
  // are `reads: true` operations, and both go through the permission check
  // inside `perform` on every call — this wrapper adds nothing to that.
  const op = source === SOURCE.OCR ? 'ocr' : 'screenshot';
  let r;
  try {
    r = await computer.perform(app, op, { region: spec.region || null }, { window: spec.window || null });
  } catch (e) {
    return miss(source, `the desktop bridge failed: ${(e && e.message) || e}`);
  }
  // SUCCEEDED IS THE ONLY STAGE THAT MEANS SOMETHING WAS SEEN. Every other one
  // — BRIDGE_LOST, PERMISSION_REQUIRED, REFUSED, NO_TARGET, FAILED — is a
  // reason nobody looked, and capability.js already phrases each for a person.
  const stage = r && r.stage;
  if (stage !== 'SUCCEEDED') return miss(source, `${stage || 'no answer'}${r && r.why ? `: ${r.why}` : ''}`);
  const res = r.result || {};
  const value = res.text != null ? res.text : (res.path || '(image captured)');
  return hit(source, clip(value), res.text
    ? `read ${String(res.text).length} characters from the screen`
    : `captured the screen to ${res.path || 'an image'}`);
}

/**
 * THE ROUTER.
 *
 * Given a goal, tries the sources in order and returns the FIRST that answers.
 * Every source that declined is carried in `tried`, because "the DOM was not
 * attached so we looked at a screenshot" is exactly the provenance a person
 * needs when the answer turns out to be wrong.
 */
class Observatory {
  constructor({ runtime = null } = {}) {
    this.runtime = runtime;
  }

  /** Which sources would be consulted for this goal, in order. */
  route(goal, spec = {}) {
    const g = String(goal || '').toLowerCase();
    if (Array.isArray(spec.sources) && spec.sources.length) return spec.sources.filter((s) => PROVIDERS[s]);
    return ROUTES[g] || [];
  }

  /**
   * ASK.
   *
   * @param {string} goal one of GOAL
   * @param {object} spec what to look at — path, url, selector, name, region…
   * @param {object} ctx  {cwd, taskId, processes, browser, app}
   */
  async observe(goal, spec = {}, ctx = {}) {
    const order = this.route(goal, spec);
    if (!order.length) {
      return {
        ok: false, source: null, why: `"${goal}" is not an observation goal — known: ${Object.values(GOAL).join(', ')}`,
        summary: '', tried: [],
      };
    }
    const tried = [];
    for (const source of order) {
      const provider = PROVIDERS[source];
      if (!provider) continue;
      let r;
      try {
        // eslint-disable-next-line no-await-in-loop -- the whole point is to
        // stop at the first source that answers rather than paying for all.
        r = await provider(spec, ctx);
      } catch (e) {
        r = miss(source, `the provider failed: ${(e && e.message) || e}`);
      }
      tried.push({ source, ok: Boolean(r.ok), why: r.why || '' });
      if (r.ok) {
        const out = { ...r, goal: String(goal), coarse: COARSE_OF[source] || null, tried };
        this._note(ctx, out);
        return out;
      }
    }
    const out = {
      ok: false, source: null, goal: String(goal), coarse: null, value: null,
      why: `nothing could answer — ${tried.map((t) => `${t.source}: ${t.why}`).join('; ')}`,
      summary: '', tried,
    };
    this._note(ctx, out);
    return out;
  }

  _note(ctx, out) {
    if (!this.runtime || !ctx.taskId) return;
    try {
      this.runtime.noteObservation(ctx.taskId, {
        goal: out.goal, source: out.source || 'none', ok: out.ok, summary: out.summary || out.why,
      });
    } catch { /* recording an observation must never fail the observation */ }
  }
}

module.exports = { Observatory, SOURCE, GOAL, ROUTES, PROVIDERS, COARSE_OF, MAX_VALUE };
