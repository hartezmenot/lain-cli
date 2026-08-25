'use strict';

/**
 * THE DESKTOP PERMISSION GATE.
 *
 * Nothing in LAIN may see the screen, move the mouse, press a key or touch
 * another application until the person sitting at the machine has said yes to
 * that specific thing, in words, this session. There is no configuration option
 * that grants it in advance, no "remember this" that survives a restart, and no
 * code path that infers consent from anything else the user did.
 *
 * The properties, and why each one is here:
 *
 *   EXPLICIT    a grant only ever comes from an answered prompt. Escape, a
 *               closed panel, EOF and a non-interactive run all mean DENY,
 *               because the absence of an answer is not an answer.
 *   NARROW      capabilities are granted individually. "It wants the screen"
 *               and "it wants your keyboard" are different decisions.
 *   TEMPORARY   every grant expires. A session grant is minutes, not the life
 *               of the process, so forgetting to revoke is not a way to leave
 *               the door open.
 *   REVOCABLE   `revoke()` takes effect immediately and cannot fail.
 *   IN MEMORY   never written to disk. A permission that outlives the process
 *               that asked for it is one nobody remembers giving.
 *   LOGGED      every request, grant, denial, use and revocation is recorded
 *               and shown, so "what did it do while it had access" is always
 *               answerable.
 *
 * This module holds the state and the rules. It does NOT draw the prompt — the
 * UI owns that, through the one interaction panel every other question uses.
 */

/** What can be asked for. Nothing outside this list is grantable. */
const CAPABILITY = Object.freeze({
  screen: 'see the screen',
  keyboard: 'send keystrokes',
  mouse: 'move and click the mouse',
  window: 'list and focus windows',
});

/** How long a grant lives. Deliberately short. */
const ONCE_MS = 60_000;
const SESSION_MS = 10 * 60_000;
const MAX_LOG = 200;

/**
 * THE THREE SCOPES, and why the third one is not a longer timer.
 *
 * `once` and `session` are WALL-CLOCK grants: they expire after a fixed number
 * of minutes whatever is happening. That is exactly right for a bridge that was
 * configured once and may act at any moment — the whole argument for a short
 * expiry is that a grant nobody is watching should lapse.
 *
 * IT IS THE WRONG SHAPE FOR THE PROBE, and this was the reported defect. A
 * Probe session is something the user STARTS, with `/mcp probe`, and WATCHES —
 * it opens a window of its own. Ten minutes into an investigation the grant
 * expired mid-sequence, the next action raised the same prompt again, and the
 * answer to "may this Probe see the screen" was being asked repeatedly about
 * one session the user had already authorised and was sitting in front of. A
 * prompt that returns every ten minutes is not a stronger permission; it is one
 * people learn to click through without reading, which is strictly weaker.
 *
 * So `probe` grants are bound to a SESSION IDENTITY rather than to a clock.
 * They are valid exactly while that Probe connection is the live one, and they
 * end — completely, and by construction rather than by remembering to — the
 * moment it goes away. That is a NARROWER promise than ten minutes, not a
 * looser one: it cannot outlive the thing it was granted to, and reconnecting
 * mints a new connection id, which is a new authorisation.
 */
const SCOPE = Object.freeze({
  ONCE: 'once',
  SESSION: 'session',
  PROBE: 'probe',
});

class Permissions {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** cap -> { expiresAt, target, scope, session } */
    this.grants = new Map();
    this.log = [];
    /** Set while a request is on screen, so two cannot race. */
    this.pending = null;
    /**
     * THE LIVE PROBE SESSION, and the ONE fact that decides whether a `probe`
     * grant is still good. Null means there is no authorised Probe session, so
     * every probe-scoped grant is dead — there is no second place that can
     * disagree, and no timer that can expire it out from under a session the
     * user is watching.
     */
    this.probeSession = null;
  }

  _note(event, detail) {
    this.log.push({ at: this._now(), event, detail: String(detail || '') });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /**
   * Is this capability allowed RIGHT NOW?
   *
   * A probe-scoped grant is checked against the LIVE SESSION rather than
   * against a clock; every other scope is checked against its expiry, on every
   * use. Both are answered here so there is one answer to "may this happen".
   */
  check(cap) {
    const g = this.grants.get(cap);
    if (!g) return { ok: false, why: 'not granted' };
    if (g.scope === SCOPE.PROBE) {
      // THE SESSION IS THE EXPIRY. A grant whose session is not the live one is
      // dropped on the spot rather than merely refused, so a Probe that
      // reconnected cannot inherit the authorisation of the one before it.
      if (!g.session || g.session !== this.probeSession) {
        this.grants.delete(cap);
        this._note('ended', cap + ' — the Probe session it was granted to has ended');
        return { ok: false, why: 'the Probe session it was granted to has ended' };
      }
      return { ok: true, grant: g, msLeft: null };
    }
    if (g.expiresAt <= this._now()) {
      this.grants.delete(cap);
      this._note('expired', cap);
      return { ok: false, why: 'the grant expired' };
    }
    return { ok: true, grant: g, msLeft: g.expiresAt - this._now() };
  }

  /** Everything currently granted, for the status views. */
  state() {
    const out = {};
    for (const cap of Object.keys(CAPABILITY)) {
      const c = this.check(cap);
      out[cap] = c.ok
        ? { granted: true, msLeft: c.msLeft, target: c.grant.target || null, scope: c.grant.scope }
        : { granted: false, why: c.why };
    }
    const active = Object.values(out).some((v) => v.granted);
    return { active, capabilities: out, target: this.target(), log: this.log.slice(-20) };
  }

  /** The window a live grant is pointed at, if any. */
  target() {
    for (const g of this.grants.values()) {
      if (g.expiresAt > this._now() && g.target) return g.target;
    }
    return null;
  }

  /**
   * Apply an answered request. `scope` is 'once', 'session' or 'probe'.
   *
   * A PROBE GRANT REQUIRES A SESSION ID and is refused without one — a
   * probe-scoped grant with no session would be a grant nothing can ever end,
   * which is the opposite of what the scope is for.
   */
  grant(caps, { scope = SCOPE.ONCE, target = null, session = null } = {}) {
    if (scope === SCOPE.PROBE) {
      if (!session) return this.deny(caps, 'a Probe grant needs the session it belongs to');
      this.probeSession = String(session);
    }
    const ms = scope === SCOPE.SESSION ? SESSION_MS : ONCE_MS;
    // Infinity, not a large number: a probe grant has no clock at all, and a
    // "very long" timeout is the defect this scope exists to remove.
    const expiresAt = scope === SCOPE.PROBE ? Infinity : this._now() + ms;
    const given = [];
    for (const cap of caps) {
      if (!CAPABILITY[cap]) continue;
      this.grants.set(cap, { expiresAt, target, scope, session: scope === SCOPE.PROBE ? String(session) : null });
      given.push(cap);
    }
    this._note('granted', `${given.join(', ')} · ${scope}${target ? ` · ${target}` : ''}`);
    return given;
  }

  /**
   * THE PROBE SESSION ENDED — drop everything it bought.
   *
   * Called from the Probe's own teardown, so authorisation ends with the
   * session by construction rather than by anybody remembering to. Idempotent,
   * and safe to call for a session that is no longer the live one: a stale
   * teardown must never revoke a NEWER session's grants, which is why the id is
   * compared rather than assumed.
   */
  endProbeSession(session = null, why = 'the Probe session ended') {
    if (session && this.probeSession && String(session) !== this.probeSession) return [];
    this.probeSession = null;
    const had = [];
    for (const [cap, g] of [...this.grants]) {
      if (g.scope !== SCOPE.PROBE) continue;
      this.grants.delete(cap);
      had.push(cap);
    }
    if (had.length) this._note('ended', `${had.join(', ')} — ${why}`);
    return had;
  }

  /** Is there an authorised Probe session right now? */
  get probeAuthorised() { return Boolean(this.probeSession); }

  deny(caps, why = 'you said no') {
    this._note('denied', `${[...caps].join(', ')} — ${why}`);
    return { ok: false, why };
  }

  /** Immediate and total. Cannot fail, and is the STOP button's whole job. */
  revoke(why = 'revoked') {
    const had = [...this.grants.keys()];
    this.grants.clear();
    // A STOP BUTTON THAT LEAVES THE SESSION AUTHORISED IS NOT A STOP BUTTON.
    // Without this, revoking dropped the grants and left `probeSession` set, so
    // the next request could be re-granted at probe scope without the user
    // being asked again about the session they had just revoked.
    this.probeSession = null;
    if (had.length) this._note('revoked', `${had.join(', ')} — ${why}`);
    return had;
  }

  /** Record that a granted capability was actually used. */
  used(cap, detail) {
    this._note('used', `${cap}${detail ? ` · ${detail}` : ''}`);
  }
}

/**
 * The prompt, as data. The UI turns this into the panel; keeping the WORDS here
 * means the request the user reads and the grant that is applied come from one
 * place and cannot describe different things.
 */
function requestAdapterSpec({ caps, target = null, reason = '', probeSession = null }) {
  const wanted = caps.filter((c) => CAPABILITY[c]);
  // WHEN A PROBE SESSION IS RUNNING, THE MIDDLE OPTION CHANGES ITS MEANING.
  //
  // "for this session (10 minutes)" is a promise about a clock, and against a
  // Probe the user started and is watching it is the wrong promise in both
  // directions: it expires in the middle of an investigation, and it keeps
  // running for ten minutes after the Probe has gone. Bound to the session, it
  // covers exactly the thing the user said yes to and ends with it.
  const middle = probeSession
    ? { label: 'Allow for this Probe session (until the Probe exits)', value: SCOPE.PROBE }
    : { label: 'Allow for this session (10 minutes)', value: SCOPE.SESSION };
  return {
    title: 'DESKTOP CONTROL REQUEST',
    // NO BLANK SPACER ROWS. The panel scrolls, and every row spent on air is a
    // row that pushes an option — including Deny — below the fold on a normal
    // terminal. Everything here has to be visible at once.
    lines: [
      'An external model is asking for temporary control of this machine.',
      ...wanted.map((c) => `  ✓ ${CAPABILITY[c]}`),
      target ? `  target window: ${target}` : null,
      reason ? `  reason: ${reason}` : null,
    ].filter((x) => x !== null),
    options: [
      { label: 'Allow once (1 minute)', value: SCOPE.ONCE },
      middle,
      { label: 'Deny', value: 'deny' },
    ],
    caps: wanted,
    target,
    probeSession,
  };
}

/**
 * ASK THE PERSON AT THE KEYBOARD, and apply what they say.
 *
 * Through the ONE interaction panel every other question uses, so a desktop
 * request looks and behaves like every other thing LAIN asks — and so Escape,
 * Ctrl+C and EOF already do the right thing, which here is DENY.
 *
 * WITHOUT AN INTERACTIVE UI THERE IS NO GRANT. A piped run, a one-shot `-p`
 * invocation and a test all take the same path: nobody can be asked, so the
 * answer is no. Inferring consent from "there was no way to object" is exactly
 * the failure this gate exists to prevent.
 */
async function request(app, { caps = [], target = null, reason = '' } = {}) {
  const perms = app.desktop().permissions;
  // WHICH PROBE SESSION, ASKED OF THE PROBE and not remembered here. A second
  // copy of "is a Probe running" is a second thing that can be wrong, and the
  // one that is wrong is always the copy.
  let probeSession = null;
  try {
    const live = require('./probe').live();
    probeSession = live ? live.connectionId : null;
  } catch { probeSession = null; }
  const spec = requestAdapterSpec({ caps, target, reason, probeSession });
  if (!spec.caps.length) return { ok: false, why: 'nothing was actually requested' };

  if (perms.pending) return { ok: false, why: 'another desktop request is already on screen' };
  if (!app.ui || !app.ui.enabled) {
    perms.deny(spec.caps, 'there is no interactive terminal to ask');
    return { ok: false, why: 'no interactive terminal — desktop access is never granted unattended' };
  }

  perms._note('requested', `${spec.caps.join(', ')}${target ? ` · ${target}` : ''}`);
  // THE BRIDGE ASKS OUT LOUD, IN THE CONVERSATION.
  //
  // The request already opened a modal, but the Context — the record of who did
  // what — said nothing about it, so a session where the desktop was touched
  // read afterwards as though LAIN had done it alone. MCP is an actor; when it
  // needs something it says so in its own voice, and the grant or the refusal
  // is part of the story rather than a fact buried in an audit log.
  if (app.ui) {
    app.ui.noteActor('mcp', `Permission required: ${spec.caps.join(', ')}${target ? ` · ${target}` : ''}`);
  }
  perms.pending = spec;
  let picked = null;
  try {
    const { askAdapter } = require('./ui/panel');
    picked = await app.ui.ask(askAdapter({
      // The panel's own title carries the headline, and each line of the
      // request is its own row — the capability list is the whole point of
      // showing this, and it must not be clipped away.
      title: spec.title,
      question: spec.lines.join('\n'),
      options: spec.options.map((o) => o.label),
    }));
  } finally {
    perms.pending = null;
  }

  // Escape, Ctrl+C, a closed panel and EOF all arrive here as null. None of
  // them is a yes.
  const chosen = spec.options.find((o) => o.label === picked);
  if (!chosen || chosen.value === 'deny') {
    perms.deny(spec.caps, picked ? 'you denied it' : 'you dismissed the request');
    if (app.ui) app.ui.noteActor('mcp', picked ? 'Permission denied — nothing was touched.' : 'Request dismissed — nothing was touched.');
    return { ok: false, why: picked ? 'denied' : 'dismissed' };
  }
  const given = perms.grant(spec.caps, { scope: chosen.value, target, session: spec.probeSession });
  // SOMETHING IS ABOUT TO MOVE YOUR MOUSE. A second window opens above the work
  // saying what is permitted, counting it down, showing each action, and
  // carrying a STOP that does not depend on LAIN being responsive.
  try { require('./controlwindow').open(app); } catch { /* the terminal is still the stop button */ }
  // Said AFTER the stop window is up, not before: the announcement is part of
  // the story, and the safety surface comes first.
  if (app.ui) app.ui.noteActor('mcp', `Granted ${spec.caps.join(', ')} · ${chosen.value}${target ? ` · ${target}` : ''}`);
  return { ok: true, granted: given, scope: chosen.value, target };
}

module.exports = { Permissions, CAPABILITY, SCOPE, requestAdapterSpec, request, ONCE_MS, SESSION_MS };
