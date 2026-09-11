'use strict';

/**
 * WHICH WEBSITE CONVERSATION BELONGS TO WHICH LAIN SESSION.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE.
 *
 * A website keeps its own conversations. The naive way to continue one is to
 * open the site and use whatever thread is on screen — "the latest chat". Do
 * that with two LAIN sessions and the second one resumes the first one's
 * conversation: project context from `toradb` lands inside the thread that
 * belongs to `lain-v2`, and the answer that comes back is attributed to the
 * wrong session's history. Nothing about that is visible; it reads as a model
 * being confused.
 *
 * So a binding is EXACT and it is OWNED. It records which LAIN session minted
 * it, and `resolve` refuses to hand a binding to a session that is not its
 * owner. There is no "close enough" and no most-recent fallback.
 *
 * ------------------------------------------------------------------------
 * FAIL CLOSED ON AMBIGUITY.
 *
 * If the site is showing a thread whose id does not match the binding, that is
 * not an invitation to adopt it — it is a mismatch, and the caller is told so
 * and starts a new thread instead. Adopting an unknown thread is how a person's
 * unrelated ChatGPT conversation acquires their source code.
 *
 * ------------------------------------------------------------------------
 * THE BINDING IS OPAQUE. LAIN stores what the adapter gives it and reads none
 * of it. A thread id is a site-side identifier and this module deliberately has
 * no opinion about its shape, so a site that changes its URL scheme changes one
 * adapter and not this.
 */

/** A session cannot accumulate bindings forever; one per source is all there is. */
function store(session) {
  if (!session) return {};
  if (!session.providerBindings || typeof session.providerBindings !== 'object') {
    session.providerBindings = {};
  }
  return session.providerBindings;
}

/**
 * REMEMBER a thread as this session's, for this source.
 *
 * `model` travels with it because a website thread carries the model it was
 * started with: resuming a GPT-x thread and then claiming the answer came from
 * GPT-y would be a provenance lie that no amount of later checking can undo.
 */
function remember(session, sourceId, { threadId, model = null, url = null } = {}) {
  const id = String(threadId || '').trim();
  if (!session || !sourceId || !id) return null;
  const entry = {
    threadId: id,
    model: model == null ? null : String(model),
    url: url == null ? null : String(url),
    /** THE OWNER. `resolve` refuses to serve any other session. */
    sessionId: String(session.id || ''),
    at: Date.now(),
  };
  store(session)[String(sourceId)] = entry;
  return entry;
}

/**
 * THE BINDING THIS SESSION MAY USE, or a stated reason there is not one.
 *
 * @returns {{ok:boolean, binding:object|null, why:string}}
 */
function resolve(session, sourceId) {
  if (!session) return { ok: false, binding: null, why: 'no session' };
  const entry = store(session)[String(sourceId)] || null;
  if (!entry || !entry.threadId) return { ok: false, binding: null, why: 'no thread has been bound to this session yet' };
  if (String(entry.sessionId || '') !== String(session.id || '')) {
    // A session file copied, renamed or merged. The recorded owner is the
    // authority, and a thread whose owner is somebody else is not ours to open.
    return { ok: false, binding: null, why: 'the recorded thread belongs to a different session' };
  }
  return { ok: true, binding: entry, why: '' };
}

/**
 * IS THE PAGE SHOWING THE THREAD WE THINK IT IS?
 *
 * Called immediately before a prompt is submitted. The whole point is that the
 * answer may be NO — a site that redirected, a session that expired into a
 * fresh chat, a person who clicked something in the window — and the correct
 * response to NO is to refuse the send, never to send anyway.
 */
function matches(binding, observedThreadId) {
  const want = binding && binding.threadId ? String(binding.threadId) : '';
  const got = String(observedThreadId == null ? '' : observedThreadId);
  if (!want) return { ok: false, why: 'there is no bound thread to compare against' };
  if (!got) return { ok: false, why: 'the page did not report which conversation it is showing' };
  if (want !== got) return { ok: false, why: 'the page is showing a different conversation than the one bound to this session' };
  return { ok: true, why: '' };
}

/** Drop the binding for one source. Used when a thread is gone or auth changed. */
function forget(session, sourceId) {
  if (!session) return false;
  const s = store(session);
  const had = Object.prototype.hasOwnProperty.call(s, String(sourceId));
  delete s[String(sourceId)];
  return had;
}

/**
 * WHAT SURVIVES THE SESSION FILE. Ids and stamps — never a page, never a
 * cookie, never the words that were said in the thread.
 */
function toJSON(session) {
  const out = {};
  for (const [k, v] of Object.entries(store(session))) {
    if (!v || !v.threadId) continue;
    out[k] = { threadId: String(v.threadId), model: v.model || null, url: v.url || null, sessionId: v.sessionId || '', at: Number(v.at) || 0 };
  }
  return out;
}

/** Rebuild from a saved session. Anything malformed is simply absent. */
function from(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object' || !v.threadId) continue;
    out[String(k)] = {
      threadId: String(v.threadId),
      model: v.model == null ? null : String(v.model),
      url: v.url == null ? null : String(v.url),
      sessionId: String(v.sessionId || ''),
      at: Number(v.at) || 0,
    };
  }
  return out;
}

module.exports = { remember, resolve, matches, forget, toJSON, from, store };
