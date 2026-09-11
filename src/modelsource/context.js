'use strict';

/**
 * WHAT ACTUALLY LEAVES THIS MACHINE WHEN A WEB MODEL IS ASKED SOMETHING.
 *
 * ------------------------------------------------------------------------
 * THE OBVIOUS IMPLEMENTATION IS THE WRONG ONE.
 *
 * Replaying the whole LAIN transcript into ChatGPT on every chat turn would be
 * four things at once: expensive, slow, duplicative (the site keeps its own
 * thread, so the earlier turns are already there), and a leak — a LAIN
 * transcript holds tool output, file bodies, command lines and whatever a test
 * printed, none of which anybody asked to send to a third party.
 *
 * So this builds a BOUNDED BRIEFING and nothing else, and it is the same
 * briefing for every source. It is INSPECTABLE by construction: `build` returns
 * the exact string that will be sent, and every caller previews that string
 * rather than a summary of it. A preview that paraphrases what is about to leave
 * is worse than no preview, because it invites a yes to something unseen.
 *
 * ------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT INCLUDED.
 *
 *   raw tool logs        the bulk, and the part most likely to hold a secret
 *   command output       ditto
 *   file bodies          the model is being consulted, not given the repository
 *   the environment      no variables, no paths beyond the project root
 *   reasoning            LAIN's own thinking is not somebody else's input
 *   credentials          structurally impossible — see the redaction below
 *
 * WHAT IS INCLUDED is the shortest thing that makes a question answerable: the
 * recent conversation, a handful of session facts the far side cannot see, and
 * whatever the user explicitly attached.
 *
 * ------------------------------------------------------------------------
 * REDACTED AT THE BUILD, NOT AT THE SEND.
 *
 * src/redact.js masks credentials at the display writers. This is a different
 * kind of exit and it gets the same filter, applied HERE so the bytes a person
 * previews are byte-for-byte the bytes that leave. Masking later would show one
 * thing and send another, which is the one way a confirmation can lie.
 *
 * (The session-facts block below is the one genuinely reusable idea from the
 * retired `/external` packet builder, brought across whole rather than
 * reinvented: which project, which runtimes, what changed this session, where
 * the plan is, and whether the last check passed.)
 */

const redact = require('../redact');

/** A briefing, not a conversation. Bounded like every other payload in the tree. */
const MAX_PROMPT = 8_000;
const MAX_TOTAL = 24_000;
/** How many earlier messages of context ride along on a FIRST turn in a thread. */
const RECENT_TURNS = 6;
/** How much of any one recalled message is reproduced. */
const RECENT_CHARS = 600;

/**
 * SESSION FACTS THE FAR SIDE CANNOT SEE.
 *
 * Read from state that already exists — never re-derived, never a model call,
 * never a filesystem walk. Every entry is short and every entry is listed in the
 * preview, so nothing here is smuggled.
 */
function facts(app) {
  const out = [];
  const s = (app && app.session) || {};
  if (s.cwd) out.push(['project', s.cwd]);
  try {
    const env = require('../environment').detect(s.cwd);
    const rt = Object.keys((env && env.runtimes) || {});
    if (rt.length) out.push(['runtimes', rt.join(', ')]);
    if (env && env.testRunner) out.push(['tests', env.testRunner.command]);
  } catch { /* orientation is a convenience, never a reason to fail */ }
  try {
    const changed = require('../ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: s.cwd });
    if (changed && changed.length) {
      out.push(['changed in this session', changed.slice(0, 12).map((f) => f.rel).join(', ')]);
    }
  } catch { /* no checkpoints is a normal state */ }
  if (s.plan && s.plan.steps && s.plan.steps.length) {
    out.push(['plan', `${s.plan.steps.filter((x) => x.status === 'done').length}/${s.plan.steps.length} steps done`]);
  }
  const check = s.lifecycle && s.lifecycle.lastCommand;
  if (check && check.command) {
    out.push(['last check', `${check.command} — ${check.ok ? 'passed' : 'failed'}`]);
  }
  return out;
}

/**
 * THE RECENT EXCHANGE, and only the parts a person would recognise as theirs.
 *
 * `role: 'tool'` messages are skipped wholesale — that is the bulk and the risk,
 * and it is reproducible on this side by the tools that made it. An assistant
 * message that carried tool calls contributes its PROSE and not its calls.
 */
function recent(session, { limit = RECENT_TURNS } = {}) {
  const msgs = Array.isArray(session && session.messages) ? session.messages : [];
  const kept = [];
  for (let i = msgs.length - 1; i >= 0 && kept.length < limit; i--) {
    const m = msgs[i];
    if (!m || m.role === 'tool' || m.role === 'system') continue;
    const body = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    // The message currently being asked is added by the caller as THE PROMPT;
    // including it twice would make the far side answer its own echo.
    kept.push({ role: m.role === 'assistant' ? 'LAIN' : 'user', text: body.slice(0, RECENT_CHARS) });
  }
  return kept.reverse();
}

/**
 * BUILD THE BRIEFING.
 *
 * @param {object} app
 * @param {string} prompt        what the user actually asked, this turn
 * @param {object} opts
 *   continuing   true when the website thread already holds the earlier
 *                exchange, in which case NONE of it is re-sent. This is the
 *                bounded-context rule doing its main job: on a resumed thread
 *                the payload is the question and nothing else.
 *   attachments  explicit, user-chosen items. Never discovered, never inferred.
 * @returns {{ok, text, prompt, facts, included, chars, why}}
 */
function build(app, prompt, { continuing = false, attachments = [] } = {}) {
  const words = String(prompt == null ? '' : prompt).trim().slice(0, MAX_PROMPT);
  if (!words) return { ok: false, why: 'nothing was asked', text: '', prompt: '', facts: [], included: [], chars: 0 };

  const included = ['the question'];
  const parts = [];

  if (continuing) {
    // THE THREAD ALREADY HOLDS THE STORY. Re-sending it would duplicate what the
    // site is about to show the model anyway, and pay for it twice.
    parts.push(words);
  } else {
    const f = facts(app);
    const history = recent(app && app.session);
    parts.push('A question relayed by LAIN, an agentic coding CLI running on the user\'s machine.');
    parts.push('');
    parts.push('WHAT THE USER IS ASKING');
    parts.push(words);
    if (f.length) {
      included.push('session facts');
      parts.push('', 'WHAT LAIN CAN SEE', ...f.map(([k, v]) => `  ${k}: ${v}`));
    }
    if (history.length) {
      included.push(`the last ${history.length} message(s)`);
      parts.push('', 'RECENTLY IN THIS SESSION', ...history.map((h) => `  ${h.role}: ${h.text}`));
    }
    parts.push(
      '',
      'You have no tools, no filesystem and no shell in this conversation.',
      'Never claim to have run, read or opened anything. Ask for what you need instead.',
    );
  }

  for (const a of attachments || []) {
    const label = String((a && a.label) || 'attachment');
    const body = String((a && a.text) || '');
    if (!body) continue;
    included.push(label);
    parts.push('', `ATTACHED — ${label}`, body.slice(0, 4_000));
  }

  // ---- THE FILTER, AT THE BUILD ---------------------------------------
  //
  // See the header. Applied to the assembled text so a credential that arrived
  // through ANY of the sections above — a fact, a recalled message, an
  // attachment — is masked once, here, before anybody previews or sends it.
  const text = redact.text(parts.join('\n')).slice(0, MAX_TOTAL);
  return { ok: true, text, prompt: words, facts: continuing ? [] : facts(app), included, chars: text.length, why: '' };
}

/**
 * THE EXACT BYTES, for a preview. Not a summary of them.
 */
function preview(built, { source = null, model = null } = {}) {
  if (!built || !built.ok) return ['nothing to send'];
  return [
    `WOULD SEND TO   ${source || 'the selected chat source'}${model ? ` · ${model}` : ''}`,
    `SIZE            ${built.chars} characters`,
    `INCLUDES        ${built.included.join(', ')}`,
    '',
    ...built.text.split('\n'),
  ];
}

module.exports = { build, preview, facts, recent, MAX_PROMPT, MAX_TOTAL, RECENT_TURNS, RECENT_CHARS };
