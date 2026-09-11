'use strict';

/**
 * ADAPTERS FOR THE SESSION PICKERS.
 *
 * Split from ui/panel.js, which owns the panel STATE MACHINE and was already
 * close to the god-object guard. The seam is the one that file already draws:
 * an adapter is DATA — it reads state that already exists and never draws — and
 * the panel renders whatever it is handed. These are two more of them.
 *
 * Neither picker knows anything about the catalog or the session store. WHAT to
 * offer is decided by the caller; this arranges it.
 */

const { KIND, MODE, pad, clip } = require('./panel');

/**
 * (An EXTERNAL ACTOR picker lived here — three rows saying who gives LAIN a
 * second opinion on an investigation, and what each one costs you. It went with
 * the `/external` command in this pass: WHO answers a chat turn is now a SOURCE
 * selection on the session rather than a reviewer configured for one command,
 * and the picker for it belongs to the Harness application. See
 * src/modelsource/registry.js `overview`, which exposes the three facts a picker
 * needs — source, state, selected model — and nothing about browsers, cookies or
 * site structure.)
 */

/**
 * `/resume` — SESSIONS DESCRIBED BY WHAT THEY WERE.
 *
 * Three rows each: when and where, the objective in the user's own words, and
 * what actually happened. The id is NOT shown, because the id is a filename —
 * a timestamp plus four random characters — and having to recognise one was
 * the whole defect.
 *
 * `D` opens the details of the highlighted session; see `shortcuts`, which the
 * panel consults for a single typed letter.
 */
function sessionListAdapter({ sessions = [], title = 'RESUME SESSION', current = null }) {
  const idx = require('../sessionindex');
  const items = [];
  let group = null;
  sessions.forEach((s, i) => {
    if (s.when.group !== group) {
      group = s.when.group;
      if (i) items.push({ label: '', selectable: false });
    }
    items.push({
      label: `${current && s.id === current ? '● ' : '  '}${pad(String(i + 1), 3)}${pad(s.when.text, 18)}${clip(s.project, 28)}`,
      value: s.id,
      session: s,
    });
    items.push({ label: `        ${clip(idx.headline(s), 66)}`, selectable: false });
    const stats = idx.statsLine(s);
    if (stats) items.push({ label: `        ${clip(stats, 66)}`, selectable: false });
  });
  if (!items.length) items.push({ label: 'no saved sessions match', selectable: false });

  return {
    title: `${title}   ${sessions.length}`,
    kind: KIND.FILE_PICKER,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter resume · D details · Esc cancel',
    /** A single typed letter, routed by the panel. Enter resumes; D looks first. */
    shortcuts: {
      d(item) {
        if (!item || !item.session) return undefined;
        return { push: sessionDetailsAdapter({ session: item.session }) };
      },
    },
    onSelect(item) {
      if (!item.session) return undefined;
      return { close: item.session.id };
    },
  };
}

/**
 * ONE SESSION, BEFORE COMMITTING TO IT.
 *
 * Every field is read from the saved session. A thing that is not there reads
 * as not there — the same rule continuity.js applies when reporting what a
 * resume actually restored, for the same reason: a reassurance that survives
 * only until the model contradicts it is worse than silence.
 */
function sessionDetailsAdapter({ session: s }) {
  const row = (k, v) => ({ label: `  ${pad(k, 16)}${clip(String(v), 56)}`, selectable: false });
  const para = (head, text) => {
    const out = [{ label: '', selectable: false }, { label: `  ${head}`, selectable: false }];
    if (!text) { out.push({ label: '    (none recorded)', selectable: false }); return out; }
    const words = String(text).replace(/\s+/g, ' ').trim();
    for (let i = 0; i < words.length && i < 306; i += 68) {
      out.push({ label: `    ${words.slice(i, i + 68)}`, selectable: false });
    }
    return out;
  };

  return {
    title: `SESSION DETAILS   ${s.project}`,
    kind: KIND.FILE_PICKER,
    mode: MODE.EXPANDED,
    items: [
      row('project', s.project),
      row('path', s.cwd || '(unknown)'),
      // BOTH TIMES IN THE SAME CLOCK. `createdAt` is stored as an ISO string in
      // UTC, and slicing it put "started 12:25" directly above "last activity
      // 20:36" for a session that ran for eleven minutes — two timestamps on one
      // panel in two different timezones, which reads as a session that began
      // eight hours before it ended.
      row('started', s.startedAt ? require('../sessionindex').when(Date.parse(s.startedAt)).text : '(unknown)'),
      row('last activity', s.when.text),
      row('status', s.state || 'no lifecycle recorded'),
      ...para('ORIGINAL TASK', s.objective),
      ...para('LAST LAIN MESSAGE', s.lastLain),
      ...para('LAST EXTERNAL REVIEW', s.lastExternal),
      { label: '', selectable: false },
      row('turns', s.turns),
      row('files changed', s.filesChanged),
      row('corrections', s.steers),
      row('plan', s.planTotal ? `${s.planDone}/${s.planTotal} steps done` : 'no plan in this session'),
      row('last check', s.lastCommand
        ? `${s.lastCommand.command} — ${s.lastCommand.ok ? 'passed' : 'FAILED'}`
        : 'nothing was run, so nothing is verified'),
      { label: '', selectable: false },
      { label: '  resume this session', value: s.id, resume: true },
    ],
    footer: 'Enter resume · ← back · Esc close',
    onSelect(item) { return item.resume ? { close: item.value } : undefined; },
  };
}

module.exports = { sessionListAdapter, sessionDetailsAdapter };
