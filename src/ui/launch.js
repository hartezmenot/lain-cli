'use strict';

/**
 * WHAT LAIN SHOWS BEFORE THERE IS ANY WORK.
 *
 * The splash on the shell's own screen, the plain-text banner a pipe gets, and
 * the empty-state pane the workspace shows until the first task exists. Three
 * surfaces, one question: "what is this, where is it pointed, and what do I type
 * next?" They live together and away from views.js because they are the only
 * views that describe the PROGRAM rather than the work.
 *
 * Everything here is already-known state — a cached shallow project scan and the
 * resolved route — so it costs nothing and cannot be stale by more than a
 * session.
 */

const T = require('./text');
const { P } = require('./paint');

const clip = T.clip;
const pad = T.pad;
const center = T.center;
const { shortPath, projectName } = T;

/**
 * THE SPLASH — what a shell sees before the interface takes the screen.
 *
 * Drawn on the NORMAL buffer, so it stays in the scrollback after LAIN exits,
 * which is where "what was that and where was it pointed?" belongs.
 */
function splashLines({ cwd, bold = (s) => s, dim = (s) => s }) {
  return [
    '',
    '  ' + bold('L   A   I   N'),
    '',
    '  ' + projectName(cwd),
    '  ' + dim(String(cwd || '')),
    '',
    '  ' + dim('Ready.'),
    '',
  ];
}

/** The non-TTY header. A pipe gets plain text, not a drawn screen. */
function bannerLines({ cwd, sessionId, resumed = false, tools = 0, bold = (s) => s, dim = (s) => s }) {
  return [
    bold('LAIN v2') + dim(`  ${cwd}`),
    dim(`  session ${sessionId}${resumed ? ' (resumed)' : ''} · ${tools} tools · /help`),
    '',
  ];
}

/**
 * THE EMPTY STATE — the workspace before there is any work.
 *
 * It used to be one line, "(nothing yet)", above twenty blank rows: the screen
 * answered none of the questions a person actually has on launch.
 */
function welcome({ cwd, project = null, model, provider, connection, effort, resume = null, width = 80, height = 20 }) {
  const w = Math.max(30, width);

  // Two kinds of row: CENTRED display lines, and a left-aligned block of
  // label/value pairs whose column is centred as one object — centring the
  // pairs individually would make the values wander.
  //
  // Each row carries a RANK. The start screen must always fit: rather than
  // overflowing and scrolling the wordmark off the top, the lowest-ranked rows
  // are dropped until it does. Rank 0 is what the screen exists to say.
  const rows = [];
  const mid = (text, rank = 0) => rows.push({ text, mid: true, rank });
  // The separator is EXPLICIT, not implied by the padding: "Last session" is
  // exactly 12 characters, so padding it to 12 added nothing and the value ran
  // straight into the label — "Last sessiongnum".
  const label = (k, v, rank = 0) => rows.push({ text: `${pad(P.meta(k), 12)} ${v}`, rank });
  const gap = (rank = 2) => rows.push({ text: '', mid: true, rank });

  mid(P.key('L   A   I   N'));
  gap(); gap(3);
  mid(P.key(projectName(cwd)));
  mid(P.meta(shortPath(cwd || '', w - 4)), 1);
  gap();
  mid(model ? 'Ready to work.' : P.warn('No model configured yet.'));
  gap();
  label('Model', P.info(clip(model || 'none — press / then /models', w - 18)));
  const route = [provider, connection].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
  if (route) label('Connection', clip(route, w - 18), 1);
  label('Effort', effort || 'auto', 1);
  if (project && project.languages && project.languages.length) {
    label('Project', project.languages.slice(0, 2).join(', '), 1);
  }
  if (resume) { gap(3); label('Last session', resume, 1); }
  gap(); gap(3);
  mid('Type a task below.');
  gap(3);
  mid(P.meta('/  commands        @  files'), 1);

  // Drop the least important rows until the block fits the region it is given.
  let keep = rows;
  for (const cut of [3, 2, 1]) {
    if (keep.length <= height) break;
    keep = keep.filter((r) => r.rank < cut);
  }

  const colWidth = keep.filter((r) => !r.mid).reduce((n, r) => Math.max(n, T.width(r.text)), 0);
  const left = Math.max(0, Math.floor((w - colWidth) / 2));
  const body = keep.map((r) => (r.text ? (r.mid ? center(r.text, w) : ' '.repeat(left) + r.text) : ''));

  const out = [];
  const top = Math.max(0, Math.floor((height - body.length) / 2));
  for (let i = 0; i < top; i++) out.push('');
  for (const r of body) out.push(r);
  return out;
}

/**
 * WRITING them, as well as building them.
 *
 * The splash goes to the NORMAL screen (`render.out`) so it survives in the
 * scrollback after LAIN exits; the banner goes through the renderer, because on
 * a pipe it is ordinary output. Two lines each in app.js, and app.js was at the
 * god-object limit — but the real reason they live here is that they are the
 * launch surfaces, and this is the launch-surface module.
 */
function writeSplash(app) {
  const { C } = require('../render');
  for (const l of splashLines({ cwd: app.session.cwd, bold: C.bold, dim: C.dim })) {
    app.render.out.write(l + '\n');
  }
}

function writeBanner(app) {
  const { C } = require('../render');
  const lines = bannerLines({
    cwd: app.session.cwd,
    sessionId: app.session.id,
    resumed: Boolean(app.resumedFrom),
    tools: require('../tools').names().length,
    bold: C.bold,
    dim: C.dim,
  });
  for (const l of lines) app.render.write(l + '\n');
}

module.exports = { splashLines, bannerLines, welcome, writeSplash, writeBanner };
