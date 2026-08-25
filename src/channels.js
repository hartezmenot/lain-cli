'use strict';

/**
 * WHICH WAYS OF ACTING AND SEEING ARE STILL OPEN — the refusal ledger.
 *
 * A permission decision is not an error, and it is not a failed task. It closes
 * ONE CHANNEL and leaves every other one open.
 *
 *     permission denied ≠ investigation failure
 *     it means that evidence/action channel is unavailable
 *
 * ------------------------------------------------------------------------
 * WHAT WENT WRONG WITHOUT THIS.
 *
 * The refusal was per-call text and nothing remembered it. So a model that was
 * told "the user did not allow keyboard.press. Do not ask again." had exactly
 * one thing standing between it and asking again: its own good manners. Three
 * calls later the same prompt appeared on the user's screen for a decision they
 * had already made — and each of those calls was a model request spent on a
 * question that was answered the first time.
 *
 * Worse, the refusal read like a failure. A task whose keyboard was denied is
 * not a task that failed; it is a task that must now ask the person to press
 * the key. Nothing was carrying that distinction, so an investigation stopped
 * when it should have changed hands.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS DOES, AND THE TWO THINGS IT REFUSES TO DO.
 *
 * It records the state of each channel, answers "may I still do this?" BEFORE a
 * transport is contacted, and — the part that matters — carries the FALLBACK:
 * what remains possible when the channel is shut.
 *
 *   IT NEVER RE-ASKS. A DENIED channel is answered from here. No transport
 *     call, no second prompt, no permission dialog the user has already
 *     dismissed. `reopen` exists because a person may change their mind, but
 *     only they can trigger it.
 *
 *   IT NEVER DOWNGRADES THE TRUTH. A denied screenshot does not become "the
 *     screen looked fine". The channel is UNAVAILABLE, visual evidence is
 *     absent, and anything that would have relied on it says NOT SEEN.
 */

/**
 * THE CHANNELS, named for what they GIVE YOU rather than for the syscall.
 *
 * `fallback` is the whole reason this file is not a boolean: it is what LAIN
 * can still do, in words the model can act on, so a refusal produces a changed
 * plan rather than a stopped one.
 */
const CHANNEL = Object.freeze({
  KEYBOARD: 'KEYBOARD',
  MOUSE: 'MOUSE',
  SCREEN: 'SCREEN',
  OCR: 'OCR',
  WINDOWS: 'WINDOWS',
});

const FALLBACK = Object.freeze({
  KEYBOARD: 'ask the user to press the keys themselves, then confirm what happened',
  MOUSE: 'ask the user to click it themselves, then confirm what happened',
  SCREEN: 'use logs, files and the target\'s own output, or ask the user what is on screen',
  OCR: 'use logs and files, or ask the user to read the text out',
  WINDOWS: 'ask the user which window is in front',
});

/** What each `computer` operation needs. One place, so a rename cannot drift. */
const OP_CHANNEL = Object.freeze({
  windows: CHANNEL.WINDOWS,
  focus: CHANNEL.WINDOWS,
  screenshot: CHANNEL.SCREEN,
  ocr: CHANNEL.OCR,
  move: CHANNEL.MOUSE,
  click: CHANNEL.MOUSE,
  type: CHANNEL.KEYBOARD,
  key: CHANNEL.KEYBOARD,
  hold: CHANNEL.KEYBOARD,
});

/**
 * The state of one channel.
 *
 * OPEN and UNKNOWN are deliberately different. UNKNOWN means nothing has been
 * tried, which is not a promise that it will work — claiming a channel is open
 * before anything has used it is how "CONNECTED" came to mean nothing.
 */
const STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  OPEN: 'OPEN',
  DENIED: 'DENIED',
  UNAVAILABLE: 'UNAVAILABLE',
});

class Channels {
  constructor() {
    /** channel -> { state, why, at, asked } */
    this.byName = new Map();
  }

  _entry(name) {
    return this.byName.get(name) || { state: STATE.UNKNOWN, why: '', at: 0, asked: 0 };
  }

  /** What a channel is, right now. Never throws, never guesses. */
  state(name) { return this._entry(name).state; }

  /** The whole record, for the surfaces that explain themselves. */
  get(name) { return { channel: name, ...this._entry(name), fallback: FALLBACK[name] || '' }; }

  /** The user said no. Final until they say otherwise. */
  deny(name, why = 'the user did not allow it') {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.DENIED, why: String(why), at: Date.now(), asked: prev.asked + 1 });
    return this;
  }

  /**
   * Nothing can carry it — no transport, no bridge, the feature is absent.
   *
   * SEPARATE FROM DENIED because they call for different things from the user:
   * a denial is reversed by changing their mind, an absence by starting
   * something. Collapsing them into "unavailable" loses which one to tell them.
   */
  unavailable(name, why = 'nothing can carry it') {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.UNAVAILABLE, why: String(why), at: Date.now(), asked: prev.asked });
    return this;
  }

  /** It worked. Recorded on success only — see STATE.UNKNOWN. */
  open(name) {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.OPEN, why: '', at: Date.now(), asked: prev.asked });
    return this;
  }

  /**
   * The user changed their mind. The ONLY way out of DENIED.
   *
   * Deliberately not called from any automatic path: a channel that reopened
   * itself would be a permission prompt that comes back, which is the exact
   * behaviour people learn to click through.
   */
  reopen(name) {
    if (this.byName.has(name)) this.byName.delete(name);
    return this;
  }

  /**
   * May this operation be attempted at all?
   *
   * Answered WITHOUT TOUCHING A TRANSPORT, which is the point: a denied channel
   * costs nothing and cannot raise a second prompt.
   *
   * @returns {{ok:boolean, channel:string, state:string, why:string, fallback:string}}
   */
  check(op) {
    const channel = OP_CHANNEL[op] || null;
    if (!channel) return { ok: true, channel: null, state: STATE.UNKNOWN, why: '', fallback: '' };
    const e = this._entry(channel);
    if (e.state === STATE.DENIED || e.state === STATE.UNAVAILABLE) {
      return { ok: false, channel, state: e.state, why: e.why, fallback: FALLBACK[channel] || '' };
    }
    return { ok: true, channel, state: e.state, why: '', fallback: '' };
  }

  /** Every channel that is shut, for the context block and the report. */
  closed() {
    const out = [];
    for (const [name, e] of this.byName) {
      if (e.state === STATE.DENIED || e.state === STATE.UNAVAILABLE) out.push(this.get(name));
    }
    return out;
  }

  /**
   * What the model is told about the closed channels — facts and a way forward.
   *
   * PHRASED AS A CHANGED SITUATION, not as an error. "KEYBOARD UNAVAILABLE —
   * you can ask the user to press the keys" is something to plan around; "tool
   * failed: permission denied" is something to retry, and retrying is exactly
   * what must not happen.
   */
  brief() {
    const shut = this.closed();
    if (!shut.length) return '';
    const lines = shut.map((c) => `${c.channel} UNAVAILABLE — ${c.why}. Instead: ${c.fallback}.`);
    return `These channels are closed for this session and asking again will not reopen them:\n${lines.join('\n')}`;
  }
}

module.exports = { Channels, CHANNEL, STATE, FALLBACK, OP_CHANNEL };
