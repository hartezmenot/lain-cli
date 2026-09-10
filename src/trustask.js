'use strict';

/**
 * ASKING ABOUT A DIRECTORY — the question, and where the answer is written.
 *
 * Split from trust.js on the same seam permissions.js uses: that module holds
 * the RULES and knows nothing about a terminal; this one owns the asking. So
 * the policy stays testable without a TTY, and there is exactly one place that
 * turns an answer into a stored decision.
 *
 * IT USES THE ONE INTERACTION PANEL. No second prompt, no bespoke modal — the
 * same surface as `/model`, `ask_user` and every confirmation, so a question
 * about a directory looks and behaves like every other question LAIN asks.
 */

const path = require('path');

const config = require('./config');
const trust = require('./trust');

/**
 * Ask about the working directory, once, and remember the answer.
 *
 * SKIPPED WHEN ALREADY DECIDED, which is the point of persisting it: being
 * asked on every launch is how an answer stops being read. Skipped without a
 * TTY too — there is nobody to ask on a pipe, and a run that cannot ask must
 * not silently assume the permissive answer, so it gets READ_ONLY.
 *
 * @returns {string} the level now in force
 */
async function ensureTrusted(app) {
  const dir = app.session.cwd;
  if (trust.decided(app.cfg, dir)) return trust.levelOf(app.cfg, dir);

  // NOBODY TO ASK. Not a reason to grant everything: a piped `lain -p` on an
  // unknown directory reads, and says so if it is asked to write.
  if (!app.ui || !app.ui.enabled) return trust.LEVEL.READ_ONLY;

  const { KIND, MODE } = require('./ui/panel');
  const name = path.basename(dir) || dir;
  const answer = await app.ui.ask({
    title: 'TRUST THIS DIRECTORY?',
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items: [
      { label: dir, selectable: false },
      { label: '', selectable: false },
      { label: 'LAIN can read, write and run commands here. Only say yes to code you', selectable: false },
      { label: 'would be willing to run yourself.', selectable: false },
      { label: '', selectable: false },
      { label: `Yes — trust ${name}`, value: trust.LEVEL.TRUSTED },
      { label: 'Read only — look, but change nothing', value: trust.LEVEL.READ_ONLY },
      { label: 'No — decide later', value: trust.LEVEL.UNTRUSTED },
    ],
    // OPENS ON "READ ONLY" — index 6, counting the three unselectable rows
    // above the choices. A question answered by pressing Enter without reading
    // it should land on the answer that cannot damage anything, and read-only
    // is that answer while still being useful: LAIN can look at the project and
    // will ask before changing a single byte.
    cursor: 6,
    footer: '↑↓ choose · Enter confirm · Esc = decide later',
  });

  // ESCAPE IS NOT YES. A closed panel, EOF, or anything that is not one of the
  // three answers means no decision was made, and no decision means untrusted.
  const level = trust.LEVEL[answer] ? answer : trust.LEVEL.UNTRUSTED;
  if (level !== trust.LEVEL.UNTRUSTED) {
    app.cfg.trustedPaths = trust.remember(app.cfg, dir, level);
    try { config.save(app.cfg); } catch { /* an unwritable config still runs */ }
  }
  return level;
}

/**
 * Ask about ONE path outside the project, or a write into a read-only tree.
 *
 * ANSWERED PER PATH, not per session, with one exception: "yes, and this whole
 * directory" records a real trust decision so a project that genuinely spans
 * two folders does not ask forty times. Declining is remembered for nothing —
 * the next attempt asks again, because a no is about this moment.
 *
 * @returns {boolean} whether the operation may proceed
 */
async function askOutside(app, { target, why, write = false } = {}) {
  if (require('./interaction').port(app)) {
    const answer = await require('./interaction').ask(app, {
      title: write ? 'Allow this machine change?' : 'Allow access to this path?',
      question: `${target}\n${why || ''}`,
      options: ['Allow just this one', 'No'],
    });
    return answer === 'Allow just this one';
  }
  if (!app.ui || !app.ui.enabled) return false;   // nobody to ask means no

  const { KIND, MODE } = require('./ui/panel');
  const dir = path.dirname(path.resolve(target));
  const answer = await app.ui.ask({
    title: write ? 'WRITE OUTSIDE THE PROJECT?' : 'ACCESS OUTSIDE THE PROJECT?',
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items: [
      { label: String(target), selectable: false },
      { label: '', selectable: false },
      { label: why ? String(why) : 'this is outside the directory you trusted', selectable: false },
      { label: '', selectable: false },
      { label: 'Allow just this one', value: 'ONCE' },
      { label: `Allow, and trust ${path.basename(dir) || dir}`, value: 'DIR' },
      { label: 'No', value: 'NO' },
    ],
    cursor: 6,
    footer: '↑↓ choose · Enter confirm · Esc = no',
  });

  if (answer === 'DIR') {
    app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.TRUSTED);
    try { config.save(app.cfg); } catch { /* still runs */ }
    return true;
  }
  return answer === 'ONCE';
}

module.exports = { ensureTrusted, askOutside };
