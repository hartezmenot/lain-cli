'use strict';

/**
 * ADAPTERS FOR THE ACTOR AND SESSION PICKERS.
 *
 * Split from ui/panel.js, which owns the panel STATE MACHINE and was already
 * close to the god-object guard. The seam is the one that file already draws:
 * an adapter is DATA — it reads state that already exists and never draws — and
 * the panel renders whatever it is handed. These are three more of them.
 *
 * Neither picker knows anything about the catalog or the session store. WHAT to
 * offer is decided by the caller; this arranges it.
 */

const { KIND, MODE, pad, clip } = require('./panel');

/**
 * `/external` — WHO reviews, not WHICH MODEL.
 *
 * The command used to answer "which model from the catalog", so the top-level
 * question was a 900-row list and every non-model reviewer had to be spelled as
 * a model or not exist. Four actors, one row each, and the row says what each
 * one COSTS you: automated, or a page you drive yourself.
 *
 * Choosing the API actor drills into the ordinary model picker. That is a
 * SECOND question, asked only once the first is answered, and it is the same
 * picker `/models` opens — because there is only one.
 */
function externalActorAdapter({ status, onPick, onPickApi = null }) {
  // "Currently" MUST NOT NAME AN ACTOR THAT IS NOT SET UP. The chosen kind
  // defaults to API so an existing model-only config keeps working — but with
  // nothing configured at all that made the panel announce "Currently: API
  // model" over a reviewer that does not exist. What is currently true is that
  // there is none.
  const live = status.off ? null : status.actors.find((a) => a.chosen && a.ok);
  const items = [
    { label: 'Who gives LAIN a second opinion on an investigation.', selectable: false },
    {
      label: `Currently: ${status.off
        ? 'OFF — /troubleshoot stays local'
        : (live ? live.label : 'NOT CONFIGURED — /troubleshoot stays local')}`,
      selectable: false,
    },
    { label: '', selectable: false },
  ];

  for (const a of status.actors) {
    // WHAT IT COSTS YOU, in the row. "automated" versus "you paste the reply
    // back" is the whole difference between these, and burying it one screen
    // deeper is how a browser page comes to be mistaken for an API.
    //
    // SHORT ENOUGH TO SURVIVE THE COLUMN. The first version of these ran past
    // the field and was clipped to "paste the reply b…" — the row explaining
    // what you were about to choose was cut off exactly where the meaning was.
    const note = a.kind === 'API'
      ? (a.ok ? `automated · ${a.model}` : (a.model ? `automated · ${a.why}` : 'automated · no model chosen'))
      : a.kind === 'BROWSER' ? 'you drive the page; LAIN preps the packet'
        : a.kind === 'HUMAN' ? 'packet to clipboard; paste the reply back'
          : a.why;
    items.push({
      label: `${a.chosen ? '● ' : '  '}${pad(clip(a.label, 28), 30)}${clip(note, 46)}`,
      value: a.kind,
      actor: a,
    });
  }

  items.push({ label: '', selectable: false });
  items.push({ label: '  off — no external reviewer at all', value: 'OFF', off: true });

  return {
    title: 'EXTERNAL ACTOR',
    kind: KIND.PROVIDER_SELECTION,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter choose · Esc cancel',
    onSelect(item) {
      if (item.off) { onPick({ kind: 'OFF' }); return { close: { kind: 'OFF' } }; }
      const a = item.actor;
      if (!a) return undefined;
      // NOT CONFIGURED IS NOT A DEAD ROW. Choosing the reverse adapter says what
      // it would be and that it is not built, which is the honest answer;
      // silently doing nothing would read as a broken menu.
      if (a.kind === 'REVERSE') {
        onPick({ kind: a.kind, unavailable: a.why });
        return { close: { kind: a.kind } };
      }
      // The API actor still needs a MODEL. That is the second question, and it
      // is asked by pushing the one model picker rather than by a copy of it.
      if (a.kind === 'API' && onPickApi) {
        const next = onPickApi();
        if (next) return { push: next };
      }
      onPick({ kind: a.kind });
      return { close: { kind: a.kind } };
    },
  };
}

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

module.exports = { externalActorAdapter, sessionListAdapter, sessionDetailsAdapter };
