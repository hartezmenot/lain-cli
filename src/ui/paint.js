'use strict';

/**
 * THE SEMANTIC PALETTE — colour that means something.
 *
 * Not decoration and not a theme: each name here is a MEANING, and the colour is
 * only how that meaning is currently spelled. Code says `P.bad('FAILED')` rather
 * than `C.red(...)`, so the question "what is red for?" has one answer in one
 * file, and a colour can be changed without hunting through the views.
 *
 *   ok      it worked, it is stable, it was added        green
 *   warn    partial, retrying, needs attention, modified yellow
 *   bad     failed, missing, removed, an error           red
 *   head    a section heading, a column title            bold cyan
 *   path    a file, a directory, a command               cyan
 *   info    a fact with no verdict attached              cyan
 *   meta    timestamps, counts, explanatory text         dim
 *   key     the thing the eye should land on             bold
 *
 * DEGRADATION IS AUTOMATIC. Every function is `C.*` from render.js, which
 * returns the string unchanged when stdout is not a TTY, when NO_COLOR is set,
 * or when LAIN_NO_COLOR=1. So the same view code produces a coloured screen on a
 * terminal and plain text in a pipe or a test, and no caller has to ask.
 *
 * NESTING RULE: an inner reset closes the outer colour too, so `P.meta('a' +
 * P.ok('b') + 'c')` loses the dim on `c`. Compose by concatenation, not by
 * wrapping — every call site here does.
 */

const { C } = require('../render');

const P = {
  ok: (s) => C.green(s),
  warn: (s) => C.yellow(s),
  bad: (s) => C.red(s),
  info: (s) => C.cyan(s),
  // CYAN, as the table above has always said. It was `C.blue` — SGR 34, which
  // on a dark terminal is a navy so close to the background that a changed
  // path was the least legible thing in a view whose whole job is naming
  // files. This file exists so "what colour is a path" has one answer; it was
  // the one place where the answer disagreed with itself.
  path: (s) => C.cyan(s),
  cmd: (s) => C.cyan(s),
  head: (s) => C.bold(C.cyan(s)),
  key: (s) => C.bold(s),
  meta: (s) => C.dim(s),
  /**
   * WORK THAT IS DONE AND HAS BECOME CONTEXT — one step quieter than `meta`.
   *
   * The activity feed drew every completed call at `meta`, which is also the
   * weight of the call happening right now. Thirty finished reads therefore
   * carried exactly the force of the one in flight, and the screen preserved
   * every past event with equal visual weight instead of following the current
   * work. See ui/feed.js: the LAST run of calls keeps `meta`, everything
   * earlier recedes to this.
   */
  faint: (s) => C.faint(s),
  /** A distinct reading surface — currently the diff, which is its own thing. */
  surface: (s) => C.onGray(s),
  /**
   * THE DIFF EDITOR'S GROUND — lighter than `surface`, and that is the point.
   *
   * The diff window is not another region of the terminal with a border round
   * it; it is a surface the editor writes on, and it has to read as one from
   * across the room. `surface` is the quiet ground a user message sits on;
   * this is the panel a change is performed on.
   */
  editor: (s) => C.onSurface(s),
  /**
   * CODE THAT IS APPEARING RIGHT NOW. Not `ok` — `ok` means finished.
   *
   * Three states, three meanings: `bad` is going, `writing` is arriving, `ok`
   * has arrived. Painting the middle one green is the presentation layer
   * claiming a line is settled while it is still half written.
   */
  writing: (s) => C.brightBlue(s),
  /** Code on its way out, while it is still on screen. Composes with `bad`. */
  struck: (s) => C.strike(s),
  plain: (s) => String(s),
  /**
   * THE SECOND MODEL, in its own colour.
   *
   * When two models are working on one problem, "which of them said this" is the
   * single most important thing on the screen — an external reviewer's hypothesis
   * read as LAIN's own finding is exactly the confusion the relay must not
   * create. Magenta belongs to the EXTERNAL model and to nothing else.
   */
  external: (s) => C.magenta(s),
};

/**
 * WHO IS ACTING. Five actors, five fixed colours, one place.
 *
 * The status strip and the activity feed both label lines with these, so a
 * person can tell at a glance whether the thing that just happened was LAIN
 * deciding, an external model reviewing, a tool running on this machine, the
 * desktop bridge, or the user.
 */
const ACTOR = Object.freeze({
  LAIN: { id: 'LAIN', short: 'LAIN', paint: 'info' },
  EXTERNAL: { id: 'EXTERNAL', short: 'EXT', paint: 'external' },
  TOOL: { id: 'TOOL', short: 'TOOL', paint: 'ok' },
  MCP: { id: 'MCP', short: 'MCP', paint: 'warn' },
  USER: { id: 'USER', short: 'YOU', paint: 'key' },
  // THE NETWORK IS AN ACTOR, and separating it is the point of: a gateway
  // timeout is not LAIN failing, not the model refusing and not a tool going
  // wrong. Labelling it `LAIN  ERROR` sent people to check their API key
  // while their connection was down.
  NET: { id: 'NET', short: 'NET', paint: 'warn' },
});

function paintActor(actor, text) {
  const a = ACTOR[actor] || ACTOR.LAIN;
  const fn = P[a.paint];
  return fn ? fn(text) : String(text);
}

/**
 * Paint by STATE NAME, for the tables whose rows already carry one.
 *
 * health.js and projecthealth.js label every row with a state ('STABLE',
 * 'MISSING', 'EXCLUDED', …) that already declares a colour. This is the one
 * place that mapping is applied, so a state cannot be green in one pane and
 * yellow in another.
 */
const BY_COLOUR = { green: P.ok, yellow: P.warn, red: P.bad, cyan: P.info, dim: P.meta };

function byColour(name, s) {
  const fn = BY_COLOUR[name];
  return fn ? fn(s) : String(s);
}

module.exports = { P, byColour, ACTOR, paintActor };
