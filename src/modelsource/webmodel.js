'use strict';

/**
 * THE WEB MODEL ORCHESTRATOR — one implementation, every website.
 *
 * ------------------------------------------------------------------------
 * IT CONTAINS NO SELECTOR AND NO SITE NAME, ON PURPOSE.
 *
 * Everything site-specific lives behind a SURFACE (websurface.js, built from a
 * plan). What is here is the part that must be identical for ChatGPT, for
 * Gemini and for any future site: when a send is allowed, what proves it
 * happened, what may be retried, how a thread is bound, what a failure means and
 * what is written down about it.
 *
 * That is also what makes the conformance suite meaningful. The fixture
 * implements the same surface with no browser at all, so the suite exercises
 * THIS file — the decisions — rather than a mock of it.
 *
 * ------------------------------------------------------------------------
 * THE FOUR RULES THAT SHAPE THIS FILE.
 *
 * 1. AUTHENTICATION IS THE PERSON'S. LAIN opens the window; a human logs in,
 *    answers the MFA prompt and solves the CAPTCHA. There is no credential
 *    entry, no stored password, no anti-bot evasion, and AUTH_REQUIRED is a
 *    first-class result rather than an error.
 *
 * 2. A SEND IS PROVED, NOT ASSUMED. Before the prompt goes anywhere: signed in,
 *    the right conversation, the intended model. After it: the assistant turn
 *    count GREW, and the reply settled. Any of those unestablished and the
 *    result is FAILED with a reason — never a fabricated success, and never the
 *    previous answer read back as this turn's.
 *
 * 3. AN UNCERTAIN SEND IS NEVER REPEATED. If the composer refused the text,
 *    nothing left and a bounded retry is safe. If the prompt may have been
 *    submitted, LAIN does not send it again — a duplicate message in somebody's
 *    ChatGPT thread cannot be taken back. This is the same principle the bot
 *    delivery layer applies to an uncertain send.
 *
 * 4. THE MODEL LIST IS DISCOVERED AND EXPIRES. Today's public line-up is not
 *    architectural truth; the account decides. The inventory is cached briefly,
 *    refreshable by hand, and thrown away when authentication changes — and a
 *    stale entry is never reported as definitely AVAILABLE.
 */

const { CONNECTION, MODEL_STATE, STATUS, KIND, ModelSource, capabilities, result } = require('./contract');
const { AUTH } = require('./websurface');
const activity = require('./activity');
const binding = require('./binding');
const externalstate = require('../externalstate');

/** How long a discovered inventory is trusted before it is read again. */
const INVENTORY_TTL_MS = 10 * 60 * 1000;
/** A whole send, including waiting for the reply. */
const SEND_TIMEOUT_MS = 300_000;
/** How many times a prompt that provably never left may be re-attempted. */
const SAFE_RETRIES = 1;

class WebModelSource extends ModelSource {
  /**
   * @param {object} o.surface  the site driver — see websurface.js / fixture.js
   * @param {object} o.app      for events and for the session that owns bindings
   */
  constructor({ surface, app = null, id = null, label = null } = {}) {
    super({ id: id || (surface && surface.id), label: label || (surface && surface.label), kind: KIND.WEB });
    this.surface = surface;
    this.app = app;
    /** The last inventory read off the site, and when. Bounded — see the header. */
    this._inventory = null;
    this._inventoryAt = 0;
    /** What `authState` said last, so a change can invalidate the inventory. */
    this._auth = null;
    this._state = CONNECTION.DISCONNECTED;
    this._why = '';
    /** ONE send at a time per source. Two would interleave on one page. */
    this._sending = false;
    this._abort = null;
  }

  get session() { return this.app && this.app.session ? this.app.session : null; }

  capabilities() {
    return capabilities({
      // PROVEN, not advertised. Text in and text out is what this driver
      // establishes; attachments would need an upload path this does not have,
      // and claiming them would make a picker offer something that fails.
      text: true,
      imageInput: false,
      fileInput: false,
      // The page streams; LAIN observes the settled reply. Saying `true` would
      // promise incremental delivery the contract does not carry.
      streaming: false,
      cancel: true,
      authoritativeUsage: false,
    });
  }

  _to(state, why = '', extra = {}) {
    this._state = state;
    this._why = String(why || '');
    activity.connection(this.app, this.id, state, { why: this._why, ...extra });
    return state;
  }

  // ------------------------------------------------------------- connecting --

  /**
   * WHERE THIS SOURCE IS, WITHOUT CHANGING ANYTHING.
   *
   * `open: false` is the cheap form: it reports what is already known and never
   * launches a browser. A picker rendering four sources must not start four
   * Chromiums to draw its list.
   */
  async status({ open = false, signal = null } = {}) {
    const avail = this.surface.availability();
    if (!avail.available) {
      return this._snapshot(this._to(CONNECTION.UNAVAILABLE, avail.why));
    }
    if (!open) {
      const profile = require('./webprofile').describe(this.id);
      if (this._state === CONNECTION.DISCONNECTED && profile.everUsed) {
        // A saved profile is evidence somebody logged in ONCE. It is not
        // evidence the login is still valid, and this deliberately does not
        // claim it is: the state stays DISCONNECTED and `why` says what to do.
        this._why = 'a saved login exists — connect to check whether it is still valid';
      }
      return this._snapshot(this._state, { profile });
    }
    return this.connect({ signal });
  }

  /**
   * OPEN THE SITE AND FIND OUT WHERE WE STAND.
   *
   * This is also the LOGIN path: with no valid session the browser window is on
   * screen showing the site's own sign-in page, and the person completes it
   * there. LAIN returns AUTH_REQUIRED and waits to be asked again.
   */
  async connect({ signal = null } = {}) {
    this._to(CONNECTION.CONNECTING);
    const got = await this.surface.ensurePage({ signal });
    if (!got.ok) return this._snapshot(this._to(CONNECTION.FAILED, got.why));
    const auth = await this.surface.authState(got.page);
    this._noteAuth(auth.state);
    if (auth.state === AUTH.AUTH_REQUIRED) return this._snapshot(this._to(CONNECTION.AUTH_REQUIRED, auth.why));
    if (auth.state !== AUTH.READY) return this._snapshot(this._to(CONNECTION.FAILED, auth.why));
    return this._snapshot(this._to(CONNECTION.READY, ''));
  }

  /**
   * STOP USING THIS SOURCE. It does NOT log the person out.
   *
   * Those are different requests and conflating them would mean "switch back to
   * LAIN for a minute" silently destroyed a login. Forgetting the saved profile
   * is webprofile.forget, reached only when somebody asks for it by name.
   */
  async disconnect() {
    this._abortInFlight('the source was disconnected');
    this._inventory = null;
    this._inventoryAt = 0;
    this._auth = null;
    await this.surface.close();
    return this._snapshot(this._to(CONNECTION.DISCONNECTED, ''));
  }

  /**
   * AUTHENTICATION CHANGED — so the inventory is no longer about this account.
   *
   * A different account has a different model list, and serving the previous
   * one would offer models this login does not have. Cheap and absolute: any
   * transition drops it.
   */
  _noteAuth(state) {
    if (this._auth && this._auth !== state) {
      this._inventory = null;
      this._inventoryAt = 0;
    }
    this._auth = state;
  }

  _snapshot(state, extra = {}) {
    return {
      source: this.id,
      label: this.label,
      kind: this.kind,
      state,
      why: this._why,
      selected: this.selectedModel(),
      models: this._inventory ? this._inventory.models : null,
      modelsAt: this._inventoryAt || null,
      capabilities: this.capabilities(),
      ...extra,
    };
  }

  // -------------------------------------------------------------- inventory --

  /** What this session has chosen for THIS source, or null. */
  selectedModel() {
    const s = this.session;
    const picks = (s && s.sourceSelections) || {};
    return picks[this.id] || null;
  }

  /**
   * WHAT THIS ACCOUNT CAN ACTUALLY USE.
   *
   * @param {boolean} opts.refresh  ignore the cache and read the site again
   * @returns {{ok, models, cached, at, why}} — `models` entries carry a STATE,
   *   and a site that stops declaring availability produces UNKNOWN rather than
   *   an optimistic AVAILABLE. See pageops.readModelMenu.
   */
  async discoverModels({ refresh = false, signal = null } = {}) {
    const fresh = this._inventory && (Date.now() - this._inventoryAt) < INVENTORY_TTL_MS;
    if (!refresh && fresh) {
      return { ok: true, models: this._inventory.models, cached: true, at: this._inventoryAt, why: '' };
    }
    const conn = await this.connect({ signal });
    if (conn.state === CONNECTION.AUTH_REQUIRED) {
      return { ok: false, models: [], cached: false, at: 0, why: conn.why, authRequired: true };
    }
    if (conn.state !== CONNECTION.READY) return { ok: false, models: [], cached: false, at: 0, why: conn.why };

    this._to(CONNECTION.DISCOVERING);
    const got = await this.surface.ensurePage({ signal });
    if (!got.ok) { this._to(CONNECTION.FAILED, got.why); return { ok: false, models: [], cached: false, at: 0, why: got.why }; }
    const read = await this.surface.models(got.page);
    if (!read.ok) {
      // A SELECTOR THAT WILL NOT READ IS SAID OUT LOUD. Returning an empty list
      // would read as "this account has no models", which is a different and
      // wrong statement, and one a person would act on by re-subscribing.
      this._to(CONNECTION.FAILED, read.why);
      return { ok: false, models: [], cached: false, at: 0, why: read.why };
    }
    const models = read.models.map((m) => ({
      id: String(m.id),
      label: String(m.label || m.id),
      state: m.disabled ? MODEL_STATE.UNAVAILABLE
        : m.statesAvailability ? MODEL_STATE.AVAILABLE : MODEL_STATE.UNKNOWN,
      current: Boolean(m.current),
    }));
    this._inventory = { models };
    this._inventoryAt = Date.now();
    this._to(CONNECTION.READY, '');
    return { ok: true, models, cached: false, at: this._inventoryAt, why: '' };
  }

  /**
   * CHOOSE ONE, AND REMEMBER IT ON THE SESSION.
   *
   * Refuses a model that is not in the discovered inventory. "Selecting
   * ChatGPT.com" must never mean "use whatever happens to be active", and
   * accepting an unknown id would reintroduce exactly that by the back door.
   */
  async selectModel(modelId, { signal = null } = {}) {
    const want = String(modelId || '').trim();
    if (!want) return { ok: false, modelId: null, why: 'no model was named' };
    const inv = await this.discoverModels({ signal });
    if (!inv.ok) return { ok: false, modelId: null, why: inv.why, authRequired: inv.authRequired };
    const row = inv.models.find((m) => m.id === want || m.label === want);
    if (!row) return { ok: false, modelId: null, why: `"${want}" is not a model this account has — /source models to see the list` };
    if (row.state === MODEL_STATE.UNAVAILABLE) {
      return { ok: false, modelId: null, why: `"${row.label}" is listed but not available on this account` };
    }
    const got = await this.surface.ensurePage({ signal });
    if (!got.ok) return { ok: false, modelId: null, why: got.why };
    const applied = await this.surface.select(got.page, row.id, row.label);
    if (!applied.ok) return { ok: false, modelId: null, why: applied.why };
    this._remember(row.id);
    return { ok: true, modelId: row.id, label: row.label, why: '' };
  }

  _remember(modelId) {
    const s = this.session;
    if (!s) return;
    if (!s.sourceSelections || typeof s.sourceSelections !== 'object') s.sourceSelections = {};
    s.sourceSelections[this.id] = String(modelId);
  }

  // ------------------------------------------------------------------ send --

  /**
   * ASK IT SOMETHING.
   *
   * The whole guarded flow, in the order the guards have to happen. Every early
   * return is a normalized result carrying its own reason and its provenance —
   * there is no path out of this function that is silent about how it ended.
   */
  async send({ prompt, modelId = null, signal = null, timeoutMs = SEND_TIMEOUT_MS } = {}) {
    const wanted = modelId || this.selectedModel();
    const fail = (status, why, extra = {}) => {
      const r = result({ source: this.id, model: wanted, status, error: why, ...extra });
      activity.settled(this.app, r);
      return r;
    };

    if (this._sending) return fail(STATUS.FAILED, 'this source is already answering — one conversation at a time');
    if (!String(prompt || '').trim()) return fail(STATUS.FAILED, 'nothing was asked');
    if (!wanted) {
      // NO SILENT DEFAULT. Sending to "whatever is selected on the site" is the
      // failure mode this whole design exists to prevent, so an unselected
      // source refuses rather than guessing.
      return fail(STATUS.FAILED, `no model is selected for ${this.label} — choose one before asking`);
    }

    this._sending = true;
    const abort = new AbortController();
    this._abort = abort;
    const onOuter = () => abort.abort();
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener('abort', onOuter, { once: true });
    }
    // WHAT LEFT THIS MACHINE, in the ledger the session already keeps for
    // exactly that question. Reused rather than reinvented — see externalstate.
    const ledger = externalstate.forSession(this.session);
    const call = ledger.open({ provider: this.id, kind: 'chat', prompt: String(prompt) });

    try {
      return await this._send({ prompt, wanted, abort, timeoutMs, call, fail });
    } catch (e) {
      call.fail((e && e.message) || String(e));
      return fail(STATUS.FAILED, `${this.label}: ${(e && e.message) || e}`);
    } finally {
      this._sending = false;
      this._abort = null;
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }

  async _send({ prompt, wanted, abort, timeoutMs, call, fail }) {
    const signal = abort.signal;
    const conn = await this.connect({ signal });
    if (conn.state === CONNECTION.AUTH_REQUIRED) { call.reject(conn.why); return fail(STATUS.AUTH_REQUIRED, conn.why); }
    if (conn.state === CONNECTION.UNAVAILABLE) { call.fail(conn.why); return fail(STATUS.UNAVAILABLE, conn.why); }
    if (conn.state !== CONNECTION.READY) { call.fail(conn.why); return fail(STATUS.FAILED, conn.why); }

    const got = await this.surface.ensurePage({ signal });
    if (!got.ok) { call.fail(got.why); return fail(STATUS.FAILED, got.why); }
    const page = got.page;

    // ---- THE RIGHT CONVERSATION ------------------------------------------
    const placed = await this._placeThread(page, signal);
    if (!placed.ok) { call.fail(placed.why); return fail(STATUS.FAILED, placed.why); }

    // ---- THE RIGHT MODEL, VERIFIED BEFORE ANYTHING IS TYPED --------------
    //
    // RE-SELECTED EVERY TURN, AND THAT COST IS DELIBERATE. Reading the trigger's
    // label and trusting it would save opening the menu — a real saving, since
    // website latency is the whole performance story here — but it trusts the
    // page about the one fact that cannot be recovered afterwards. A resumed
    // thread, a reload, or a person clicking in the window LAIN opened all
    // change the active model without changing anything LAIN can see, and the
    // consequence is an answer attributed to a model that did not produce it.
    // Provenance is only worth having if it is true, so the menu is opened,
    // the option is clicked, and the trigger is read back.
    const applied = await this.surface.select(page, wanted, wanted);
    if (!applied.ok) {
      call.reject(applied.why);
      // A MODEL THAT IS NO LONGER THERE IS NEWS, not a generic failure: the
      // session's remembered choice has to stop being trusted, or every later
      // turn re-attempts the same impossible selection.
      this._inventory = null;
      this._inventoryAt = 0;
      return fail(STATUS.UNAVAILABLE, `${applied.why} — choose another model for ${this.label}`);
    }

    // ---- WHAT THE PAGE LOOKED LIKE BEFORE THE PROMPT ---------------------
    //
    // The count is the evidence that the answer below is THIS turn's. Without
    // it, a prompt that was never accepted returns the previous reply, and
    // nothing anywhere can tell.
    const before = await this.surface.turnCount(page);
    if (!before.ok) { call.fail(before.why); return fail(STATUS.FAILED, before.why); }

    activity.sending(this.app, this.id, wanted);
    const sent = await this._submitOnce(page, prompt, signal);
    if (!sent.ok) {
      call.fail(sent.why);
      return fail(STATUS.FAILED, sent.why, {});
    }
    call.dispatch('web');

    activity.waiting(this.app, this.id, wanted);
    const settled = await this.surface.settle(page, {
      before: before.count,
      signal,
      timeoutMs,
      onProgress: (chars) => activity.receiving(this.app, this.id, wanted, chars),
    });

    if (settled.status === 'CANCELLED') {
      await this.surface.stop(page);
      call.reject('cancelled by the user');
      const r = result({ source: this.id, model: wanted, status: STATUS.CANCELLED, error: 'cancelled' });
      activity.settled(this.app, r);
      return r;
    }
    if (settled.status === 'RATE_LIMITED') {
      call.reject(settled.why);
      this._to(CONNECTION.RATE_LIMITED, settled.why, { retryAfterMs: settled.retryAfterMs || null });
      const r = result({
        source: this.id, model: wanted, status: STATUS.RATE_LIMITED,
        error: settled.why, retryAfterMs: settled.retryAfterMs || null,
      });
      activity.settled(this.app, r);
      return r;
    }
    if (!settled.ok) {
      // INCONCLUSIVE IS A FAILURE, AND IT KEEPS ITS WORDING. `settle` already
      // distinguishes "nothing arrived" from "it started and did not finish",
      // and that sentence is the only thing that tells a person whether their
      // message is now sitting in that thread.
      call.timeout(settled.why);
      const r = result({ source: this.id, model: wanted, status: STATUS.FAILED, error: settled.why });
      activity.settled(this.app, r);
      return r;
    }

    // ---- BIND THE THREAD, NOW THAT THERE IS ONE --------------------------
    const seen = await this.surface.thread(page);
    if (seen.ok && seen.threadId) {
      binding.remember(this.session, this.id, { threadId: seen.threadId, model: wanted, url: seen.url });
    }
    // RESPONDED REQUIRES A RESPONSE — externalstate refuses the transition
    // without text, which is why the ledger is asked rather than assumed.
    call.respond(settled.text);
    const r = result({
      source: this.id,
      model: wanted,
      status: call.answered ? STATUS.COMPLETED : STATUS.FAILED,
      text: settled.text,
      error: call.answered ? null : call.error,
      conversationBinding: seen.ok && seen.threadId ? { threadId: seen.threadId } : null,
    });
    this._to(CONNECTION.READY, '');
    activity.settled(this.app, r);
    return r;
  }

  /**
   * SUBMIT, WITH THE ONE RETRY THAT IS SAFE.
   *
   * `submitted: false` means the prompt provably did not leave — the composer
   * refused the text, or the send control was not there — so trying again risks
   * nothing. Anything else, including an error thrown after the click, is
   * treated as MAYBE SENT and is never repeated: a second copy of somebody's
   * question in their own ChatGPT thread cannot be withdrawn.
   */
  async _submitOnce(page, prompt, signal) {
    let last = { ok: false, submitted: false, why: 'the prompt was never attempted' };
    for (let attempt = 0; attempt <= SAFE_RETRIES; attempt++) {
      if (signal && signal.aborted) return { ok: false, why: 'cancelled before the prompt was sent' };
      // eslint-disable-next-line no-await-in-loop -- a retry is sequential by
      // definition, and the bound is SAFE_RETRIES.
      last = await this.surface.submit(page, prompt);
      if (last.ok) return last;
      if (last.submitted) {
        return { ok: false, why: `${last.why} — the prompt may already have been sent, so LAIN will not send it again` };
      }
    }
    return { ok: false, why: last.why };
  }

  /**
   * MAKE SURE THE PAGE IS SHOWING THIS SESSION'S CONVERSATION.
   *
   * Resume the bound thread when there is one and it opens; otherwise start a
   * NEW one. It never adopts whatever thread happens to be on screen — that is
   * the crossover binding.js exists to prevent, and the reason a mismatch here
   * produces a fresh thread rather than a shrug.
   */
  async _placeThread(page, signal) {
    const have = binding.resolve(this.session, this.id);
    if (have.ok) {
      const opened = await this.surface.openThread(page, have.binding);
      if (opened.ok) {
        const seen = await this.surface.thread(page);
        const match = binding.matches(have.binding, seen.ok ? seen.threadId : null);
        if (match.ok) return { ok: true, resumed: true, why: '' };
      }
      // FAIL CLOSED: the bound thread could not be proved, so it is dropped
      // rather than worked around, and a new one is started below.
      binding.forget(this.session, this.id);
    }
    if (signal && signal.aborted) return { ok: false, why: 'cancelled before a conversation was opened' };
    const fresh = await this.surface.newThread(page);
    if (!fresh.ok) return { ok: false, why: fresh.why };
    return { ok: true, resumed: false, why: '' };
  }

  // ------------------------------------------------------------ cancelling --

  /**
   * STOP WHATEVER IS IN FLIGHT.
   *
   * NOT A SECOND CANCELLATION SYSTEM: `send` adopts the caller's AbortSignal —
   * the turn's own — and this simply aborts the controller that wraps it. The
   * page's stop button is pressed by the CANCELLED branch of `_send`, so the
   * site is left idle rather than streaming into a thread nobody is reading.
   * The authenticated profile is untouched, so the next request does not have
   * to log in again.
   */
  cancel(why = 'cancelled by the user') {
    if (!this._abort) return { ok: true, cancelled: false, why: 'nothing in flight' };
    this._abortInFlight(why);
    return { ok: true, cancelled: true, why };
  }

  _abortInFlight(why) {
    const a = this._abort;
    this._abort = null;
    if (a && !a.signal.aborted) { try { a.abort(String(why)); } catch { /* already gone */ } }
  }
}

module.exports = { WebModelSource, INVENTORY_TTL_MS, SEND_TIMEOUT_MS, SAFE_RETRIES };
