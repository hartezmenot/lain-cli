'use strict';

/**
 * THE NODE SIDE OF THE RUNTIME AUTHORITY.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT. It is not a second copy of the Guardian. Every decision in
 * here is made in rust/lain-supervisor/src/guardian.rs and this file carries
 * the question there and the answer back — because the one thing §23 forbids
 * outright is a Rust copy and a Node copy of the same truth, disagreeing on the
 * day it matters.
 *
 * So there is exactly one piece of policy in this file, and it is a policy about
 * ABSENCE rather than about state: what LAIN does when no supervisor is there to
 * ask. The answer is "exactly what LAIN did before one existed" — see `DEGRADED`.
 *
 * ------------------------------------------------------------------------
 * THREE RULES THAT KEEP THIS OFF THE HOT PATH.
 *
 * 1. NOTHING HERE EVER SPAWNS A SUPERVISOR EXCEPT `wake()`, and `wake()` is
 *    called once, in the background, when a turn begins. A person's Enter key
 *    must never wait eight seconds for a compiler artefact to boot.
 *
 * 2. EVERY WRITE IS FIRE-AND-FORGET. A phase note, a usage note and a turn end
 *    are observations; a socket that is slow, wedged or missing must not add a
 *    second failure to a turn that may already be failing.
 *
 * 3. EXACTLY ONE CALL IS AWAITED — `offer`, the gateway — because its answer
 *    changes what happens next. It is bounded by a short timeout and answers
 *    `deliver` on every kind of failure, so a broken supervisor costs LAIN
 *    latency and never a person's sentence.
 *
 * ------------------------------------------------------------------------
 * THE HOT MIRROR. `last()` is a synchronous read of the most recent snapshot
 * any call returned. The status strip redraws on every keystroke and cannot
 * await a socket, so it reads this — the same shape `availability.js` uses in
 * front of provider health, for the same reason. It is a CACHE and is described
 * as one: nothing decides anything from it, and the gateway never consults it.
 */

const supervisor = require('./supervisor');

/**
 * The gateway's budget. Local, so anything slower than this is a fault.
 *
 * IT IS PER CALL, not per queue: a call chained behind two observations may
 * legitimately take longer than this to return, and each link is timed out on
 * its own.
 *
 * IT WAS RAISED TO 4,000 ONCE, TO HIDE A BUG, and the number is back where it
 * belongs now the bug is gone. The supervisor's Windows liveness check used to
 * shell out to `tasklist` — about three seconds a call on a real machine — so
 * every gateway question timed out, and a timed-out gateway DELIVERS. Raising
 * the budget would have made the tests pass while leaving a person's Enter key
 * three seconds slower. See `alive` in rust/lain-supervisor/src/jobs.rs, which
 * now answers in microseconds.
 */
const OFFER_TIMEOUT_MS = 1500;

/**
 * WHAT LAIN DOES WITH NO SUPERVISOR: what it always did.
 *
 * Frozen so a caller cannot accidentally write policy into the absence case,
 * and named so a reader can see at a glance that degrading means DELIVERING.
 * The alternative — holding input when the runtime cannot say why — would be a
 * zero-dependency Node program refusing to work because a Rust binary was not
 * built, which is the one thing supervisor.js's hard rule forbids.
 */
const DEGRADED = Object.freeze({
  deliver: true,
  reason: '',
  inputId: '',
  state: null,
  available: false,
});

/** The most recent snapshot, per session. See THE HOT MIRROR above. */
const mirror = new Map();

/**
 * ------------------------------------------------------------------------
 * ONE ORDERED STREAM PER SESSION, and it is a correctness property rather than
 * an optimisation.
 *
 * Every call here opens its own connection, which is right — a client holding a
 * socket open is a client whose death is invisible to the server, and that is
 * the one thing this whole component exists to detect. But separate connections
 * arrive in whatever order the loopback stack feels like, and these messages are
 * not commutative:
 *
 *     turnEnd('provider')  then  turnBegin(newModel)
 *
 * reordered becomes a session that STARTED a turn and then had a failure
 * recorded on top of it — which reads as a turn that failed before it began, and
 * arms the wrong recovery. Observed while writing the regression tests: a model
 * switch went unrecorded roughly one run in three.
 *
 * So calls about ONE SESSION are chained. Different sessions do not wait for
 * each other, the chain never rejects, and a call that fails is still a link —
 * dropping it would let the next one overtake the gap it left.
 *
 * A READ JOINS THE SAME CHAIN. `guardian_state` issued after `turn_end` must see
 * `turn_end`; letting reads jump the queue would make the runtime's answer
 * depend on socket scheduling, which is the same defect with a shorter fuse.
 */
const chain = new Map();

function ordered(sessionId, run) {
  const key = sessionId || '';
  const prev = chain.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  // NEVER LEFT REJECTED. A rejected link poisons every call after it, and these
  // are observations — the failure of one must not silence the rest.
  chain.set(key, next.then(() => {}, () => {}));
  return next;
}

function remember(sessionId, reply) {
  if (!sessionId || !reply || !reply.ok) return reply;
  if (reply.state && typeof reply.state === 'object') mirror.set(sessionId, reply.state);
  return reply;
}

/**
 * The last snapshot for a session, synchronously, or null.
 *
 * NOTHING DECIDES ANYTHING FROM THIS. It is what the screen draws between
 * socket round trips, and it is allowed to be a moment out of date; the moment
 * it is used to answer "may this input be sent" it becomes the second authority
 * this file exists to avoid.
 */
function last(sessionId) {
  return mirror.get(sessionId) || null;
}

/** Drop a session's cached snapshot — `/new`, `/resume`, and the tests. */
function forgetLocal(sessionId) {
  if (sessionId) { mirror.delete(sessionId); chain.delete(sessionId); } else { mirror.clear(); chain.clear(); }
}

/** Is a supervisor answering right now? Never starts one. */
function running() {
  try { return Boolean(supervisor.probe().running); } catch { return false; }
}

/**
 * FIRE AND FORGET. The whole of rule 2.
 *
 * Returns nothing a caller is expected to await. Every failure — no binary, no
 * process, a timeout, a rejection — lands in the same place: silence, and the
 * mirror keeps whatever it had.
 */
function tell(op, msg, { sessionId = '' } = {}) {
  // NOT `running()` — see THE BOOT WINDOW. A turn that fails in the first second
  // of a session is exactly the turn whose failure must be recorded.
  if (!running() && !waking) return;
  ordered(sessionId, async () => {
    if (!(await reachable())) return;
    try { remember(sessionId, await supervisor.callIfRunning({ op, ...msg })); } catch {
      /* an observation that did not land is not a turn failure */
    }
  });
}

/**
 * Ask, and wait. Only the gateway and the readers do this.
 *
 * Behind whatever this session has already said — see `ordered`. That wait is
 * bounded in practice by the same thing that bounds the calls in front of it:
 * they are local, small, and individually timed out.
 */
async function ask(op, msg, { sessionId = '', timeoutMs = OFFER_TIMEOUT_MS } = {}) {
  if (!running() && !waking) return null;
  return ordered(sessionId, async () => {
    if (!(await reachable())) return null;
    try {
      const r = await supervisor.callIfRunning({ op, ...msg }, { timeoutMs });
      return remember(sessionId, r);
    } catch {
      return null;
    }
  });
}

/**
 * START A SUPERVISOR, IN THE BACKGROUND, ONCE.
 *
 * Called from the start of a turn and from nowhere else. That timing is the
 * whole judgement in this file and it mirrors the one providerhealth.js already
 * made: a supervisor is worth starting when there is WORK whose continuity
 * matters, and is not worth starting because a session opened or because
 * somebody ran a UI command. A person who types `/models` and quits has spawned
 * nothing.
 *
 * The promise is deliberately not returned to the turn. Whether the supervisor
 * is up by the time this turn fails is a race LAIN wins or loses honestly; what
 * it must never do is make the turn wait to find out.
 */
let waking = null;
function wake() {
  if (waking) return waking;
  let probe;
  try { probe = supervisor.probe(); } catch { return null; }
  if (!probe.available || probe.running) return null;
  waking = Promise.resolve()
    .then(() => supervisor.ensure())
    .catch(() => { /* reported by the next probe: nothing is running */ });
  return waking;
}

/**
 * ------------------------------------------------------------------------
 * THE BOOT WINDOW, and the hole it used to leave.
 *
 * A supervisor takes about a second to start. `wake()` is called when the first
 * turn of a session begins — and a turn can END before that second is up. A 401
 * comes back immediately; so does a refused connection.
 *
 * With a plain `if (!running()) return`, every observation made inside that
 * window was DROPPED: the failure of the very first turn went unrecorded, so the
 * `continue` that followed it found an IDLE session and was delivered bare. The
 * one turn most likely to fail on a fresh machine — the one that discovers the
 * credential is wrong — was the one turn the runtime could not protect.
 *
 * So a call made while a supervisor is coming up WAITS for it rather than
 * giving up. Bounded, because "the binary is starting" and "the binary is never
 * going to start" look identical from here, and only one of them is worth a
 * person's keystroke.
 */
const BOOT_WAIT_MS = 3000;

async function reachable(timeoutMs = BOOT_WAIT_MS) {
  if (running()) return true;
  const boot = waking;
  if (!boot) return false;
  await Promise.race([boot, new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)))]);
  return running();
}

// ---------------------------------------------------------------------------
// THE TURN LIFECYCLE — observations, all of them.
// ---------------------------------------------------------------------------

/**
 * A turn is starting, and THIS process is answerable for it.
 *
 * `owner_pid` is the point of the call. It is the only evidence the Guardian
 * will later accept that nobody is going to finish this turn — see `effective`
 * in guardian.rs, and see the note there about never inferring death from
 * silence.
 */
function turnBegin(sessionId, { turnId = '', model = '', provider = '', connectionId = '' } = {}) {
  if (!sessionId) return;
  wake();
  tell('guardian_turn_begin', {
    session: sessionId,
    turn_id: String(turnId || ''),
    model: String(model || ''),
    provider: String(provider || ''),
    connection_id: String(connectionId || ''),
    owner_pid: process.pid,
  }, { sessionId });
}

/**
 * A phase the turn loop already computed.
 *
 * FREE. `turn.js` calls `onStatus` before every provider request and every tool
 * whether or not anybody is listening; this is one more listener on a callback
 * that already exists, and it carries no request and no token.
 */
function turnPhase(sessionId, phase) {
  if (!sessionId || !phase) return;
  tell('guardian_turn_phase', { session: sessionId, phase: String(phase) }, { sessionId });
}

/**
 * The turn ended, and how.
 *
 * `outcome` is the word turnrecord.js already uses. Passing it through unread is
 * deliberate: the mapping from an ending to "may the next sentence be sent" is
 * the Guardian's judgement, and making it here would put half the state machine
 * in Node.
 */
function turnEnd(sessionId, { outcome = 'completed', kind = '', reason = '' } = {}) {
  if (!sessionId) return;
  tell('guardian_turn_end', {
    session: sessionId,
    outcome: String(outcome || 'completed'),
    kind: String(kind || ''),
    reason: String(reason || '').slice(0, 300),
  }, { sessionId });
}

// ---------------------------------------------------------------------------
// THE GATEWAY — the one call that is awaited.
// ---------------------------------------------------------------------------

/**
 * MAY THIS SENTENCE BE SENT?
 *
 * Returns `{ deliver, reason, inputId, state, available }`. When `deliver` is
 * false the text is already on disk in the supervisor, and the caller's job is
 * to build a packet rather than to hold anything itself — holding it in a Node
 * array is the failure mode this replaces.
 *
 * ANY FAILURE DELIVERS. A supervisor that is missing, slow or broken must cost
 * LAIN a millisecond and never a person's words; the recovery for "the Guardian
 * did not answer" cannot itself be a refusal to work.
 */
async function offer(sessionId, text, { kind = 'user' } = {}) {
  if (!sessionId || !String(text || '').trim()) return DEGRADED;
  const r = await ask('guardian_input', {
    session: sessionId,
    text: String(text),
    kind: String(kind || 'user'),
  }, { sessionId });
  if (!r || !r.ok) return DEGRADED;
  return {
    deliver: r.deliver !== false,
    reason: String(r.reason || ''),
    inputId: String(r.input_id || ''),
    state: r.state || null,
    available: true,
  };
}

/** What is still held, WITHOUT taking it — so a packet can be built around it. */
async function pending(sessionId) {
  const r = await ask('guardian_pending', { session: sessionId }, { sessionId });
  if (!r || !r.ok) return { held: [], state: null, available: false };
  return { held: Array.isArray(r.held) ? r.held : [], state: r.state || null, available: true };
}

/**
 * TAKE THE HELD INPUT. The only call that empties the queue.
 *
 * Awaited, unlike the observations, because the caller is about to send what it
 * returns and must not send an empty string instead. `keepHandover` exists for
 * the case where the sentence is delivered but the boundary is still open.
 */
async function deliver(sessionId, { keepHandover = false } = {}) {
  const r = await ask('guardian_deliver', {
    session: sessionId,
    keep_handover: Boolean(keepHandover),
  }, { sessionId });
  if (!r || !r.ok) return { taken: [], state: null, available: false };
  return { taken: Array.isArray(r.taken) ? r.taken : [], state: r.state || null, available: true };
}

/** A boundary the runtime could not observe — `/model`, `/resume` onto a stump. */
function armHandover(sessionId, reason = '') {
  if (!sessionId) return;
  tell('guardian_handover_arm', { session: sessionId, reason: String(reason || '') }, { sessionId });
}

/** A packet was built and sent; the boundary is closed. */
function handoverDone(sessionId) {
  if (!sessionId) return;
  tell('guardian_handover_done', { session: sessionId }, { sessionId });
}

// ---------------------------------------------------------------------------
// TOKEN TELEMETRY.
// ---------------------------------------------------------------------------

/**
 * WHAT A REQUEST COST — or, while it is open, what its INPUT side cost.
 *
 * `live: true` is the input half of a request that has started and not
 * finished. It REPLACES rather than accumulates on the far side, because adding
 * a live figure to the total and then adding the final one again is how a
 * counter starts lying — see `usage_note` in guardian.rs.
 *
 * There is deliberately no live OUTPUT figure. Every provider LAIN speaks to
 * states output tokens once, at the end, and a number drawn before then would be
 * a guess wearing a measurement's clothes. §10: never fake a live number.
 */
function noteUsage(sessionId, usage = {}, { live = false } = {}) {
  if (!sessionId || !usage) return;
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const msg = {
    session: sessionId,
    live: Boolean(live),
    input_tokens: n(usage.inputTokens),
    output_tokens: n(usage.outputTokens),
    requests: n(usage.requests),
  };
  // ---- A CACHE FIGURE IS SENT ONLY WHEN THERE WAS ONE ---------------------
  //
  // THE BUG THIS FIXES was invisible and total. Sending `cache_read_tokens: 0`
  // for every provider told the runtime "a cache was reported and it was cold"
  // about providers that have never mentioned a cache in their lives - so a
  // remote `/tokens` would have answered `Cached: 0` where the only true answer
  // is `unknown`. The Rust side is careful to keep those apart (`saw_cache`),
  // and this end was destroying the distinction before it ever got there.
  //
  // `null`/`undefined` mean "nobody said". A real 0 from a provider that does
  // report caching is still sent, and still means zero.
  if (usage.cacheReadTokens != null) msg.cache_read_tokens = n(usage.cacheReadTokens);
  if (usage.cacheCreationTokens != null) msg.cache_creation_tokens = n(usage.cacheCreationTokens);
  tell('guardian_usage', msg, { sessionId });
}

// ---------------------------------------------------------------------------
// READING.
// ---------------------------------------------------------------------------

/** The authoritative snapshot for one session, or null. */
async function state(sessionId) {
  const r = await ask('guardian_state', { session: sessionId }, { sessionId });
  return r && r.ok ? (r.state || null) : null;
}

/** Every session the runtime knows about — `/jobs`, `/dash`, a future adapter. */
async function list() {
  const r = await ask('guardian_list', {}, {});
  return r && r.ok && Array.isArray(r.sessions) ? r.sessions : [];
}

/**
 * WHAT HAPPENED WHILE NOBODY WAS REASONING.
 *
 * The same shape supervisor.events() has for execution, over the runtime's own
 * stream: input held, turns interrupted, models switched, packets delivered.
 */
async function events({ after = 0, limit = 50 } = {}) {
  const r = await ask('guardian_events', { after, limit }, {});
  return r && r.ok && Array.isArray(r.events) ? r.events : [];
}

/** Forget a session in the store. `/session delete`, and the tests. */
async function forget(sessionId) {
  forgetLocal(sessionId);
  const r = await ask('guardian_forget', { session: sessionId }, {});
  return Boolean(r && r.ok && r.forgotten);
}

// ---------------------------------------------------------------------------
// WHAT THIS CONVERSATION IS, AND HOW FAR IT HAS GOT
//
// Observations, all of them, and all fire-and-forget: none is worth making a
// turn wait on a socket, and none of them decides anything. The runtime holds
// them so that a SECOND window — a phone, a dashboard — can see a session it
// has no other way to learn about.
// ---------------------------------------------------------------------------

/**
 * The name a person would recognise, and where it is running.
 *
 * The CLI is the only party that knows either. A runtime that guessed a name
 * from a path would be inventing one, and a wrong name on a status list is
 * worse than a session id.
 */
function identify(sessionId, { name = '', cwd = '' } = {}) {
  if (!sessionId) return;
  tell('guardian_identify', { session: sessionId, name: String(name || ''), cwd: String(cwd || '') }, { sessionId });
}

/**
 * SOMETHING COUNTED SOMETHING.
 *
 * `source` is mandatory and is the whole honesty of this call: it names WHO
 * counted, so a percentage can always be defended. A note with no source
 * CLEARS any stale figure and records only the activity — which is what a
 * finished plan should do, rather than leaving 80% on somebody's phone.
 */
function progress(sessionId, { done = 0, total = 0, label = '', source = '', activity = '' } = {}) {
  if (!sessionId) return;
  tell('guardian_progress', {
    session: sessionId,
    done: Math.max(0, Number(done) || 0),
    total: Math.max(0, Number(total) || 0),
    label: String(label || ''),
    source: String(source || ''),
    activity: String(activity || ''),
  }, { sessionId });
}

/**
 * SOMETHING WAS CHECKED — the only claim LAIN makes that means "done" the way a
 * person means it. A test runner's own counts, never a model's summary of them.
 */
function verified(sessionId, { label = '', passed = 0, failed = 0, detail = '' } = {}) {
  if (!sessionId || !label) return;
  tell('guardian_verified', {
    session: sessionId,
    label: String(label),
    passed: Math.max(0, Number(passed) || 0),
    failed: Math.max(0, Number(failed) || 0),
    detail: String(detail || '').slice(0, 200),
  }, { sessionId });
}

/** A remote stop was honoured, or there was nothing to honour. */
function stopClear(sessionId) {
  if (!sessionId) return;
  tell('guardian_stop_clear', { session: sessionId }, { sessionId });
}

/** A requested model switch was applied, or declined. */
function clearModel(sessionId) {
  if (!sessionId) return;
  tell('guardian_model_clear', { session: sessionId }, { sessionId });
}

// ---------------------------------------------------------------------------
// THE MODEL BOUNDARY — the one call that GATES rather than reports.
// ---------------------------------------------------------------------------

/**
 * MAY A MODEL REQUEST BE MADE?
 *
 * AWAITED, unlike every observation above, because the answer decides whether
 * the request happens at all. Bounded by the same `OFFER_TIMEOUT_MS` the input
 * gateway uses, and for the same reason: a wedged supervisor must cost a turn
 * latency and never the turn.
 *
 * `null` means nothing answered, and turn.js reads that as ALLOW — a runtime
 * that is not running cannot be an authority, and failing closed would be an
 * outage LAIN caused itself.
 *
 * AND A BOOTING RUNTIME IS NOT RUNNING. This checks `running()` directly and
 * does NOT wait out the boot window, and the distinction is a measured defect
 * rather than a preference: every turn's first request fires microseconds
 * after `turnBegin`, whose `wake()` may just have started a supervisor. An
 * admission that waited for `reachable()` there would stall the hottest path
 * in LAIN for up to the whole boot — observed as a background job that parked
 * on its question seconds late, which is the parked-turn regression the first
 * wiring attempt shipped. The lifecycle tells still cover the boot window
 * (they queue behind it and land when it completes); the REQUEST boundary
 * arms from the first request made with a runtime already up.
 */
async function requestBegin(sessionId, { turnId = '', model = '', provider = '', connectionId = '' } = {}) {
  if (!sessionId || !running()) return null;
  return ask('request_begin', {
    session: sessionId,
    turn_id: String(turnId || ''),
    model: String(model || ''),
    provider: String(provider || ''),
    connection_id: String(connectionId || ''),
  }, { sessionId });
}

/**
 * The request closed, and what it cost.
 *
 * The usage rides ALONG WITH the ending rather than in a separate call, so a
 * reader that sees a request close already has the bill for it. `live` is
 * absent, so the far side ACCUMULATES — see `usage_note` in guardian.rs.
 */
function requestEnd(sessionId, requestId, { usage = null } = {}) {
  if (!sessionId) return;
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const msg = { session: sessionId, request_id: String(requestId || '') };
  if (usage) {
    msg.input_tokens = n(usage.inputTokens);
    msg.output_tokens = n(usage.outputTokens);
    msg.requests = n(usage.requests) || 1;
    // A CACHE FIGURE ONLY WHERE ONE WAS STATED — see `noteUsage` for the bug
    // that sending a zero here would reintroduce.
    if (usage.cacheReadTokens != null) msg.cache_read_tokens = n(usage.cacheReadTokens);
    if (usage.cacheCreationTokens != null) msg.cache_creation_tokens = n(usage.cacheCreationTokens);
  }
  tell('request_end', msg, { sessionId });
}

module.exports = {
  DEGRADED, OFFER_TIMEOUT_MS,
  running, wake, reachable, last, forgetLocal,
  turnBegin, turnPhase, turnEnd,
  offer, pending, deliver, armHandover, handoverDone,
  noteUsage, identify, progress, verified, stopClear, clearModel,
  requestBegin, requestEnd,
  state, list, events, forget,
};
