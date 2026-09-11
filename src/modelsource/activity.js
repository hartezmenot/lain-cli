'use strict';

/**
 * WHAT A WEB MODEL SOURCE IS DOING RIGHT NOW, stated as facts.
 *
 * ------------------------------------------------------------------------
 * ONE BUS. This does not own an event channel; it is a thin, typed way of
 * putting names into the EventBus that already exists (src/events.js), where
 * they are declared alongside every other event LAIN emits and are subject to
 * the same refusal of an unknown name. A second bus for a second subsystem is
 * the shape of a companion that can disagree with the CLI about what is
 * happening, which is the exact defect events.js was written to end.
 *
 * ------------------------------------------------------------------------
 * WHY THIS MATTERS MORE FOR A WEBSITE THAN FOR AN API.
 *
 * An API call is a second or two of silence. Driving a logged-in page is
 * launching a browser, loading a site, reading a model selector, submitting, and
 * then WAITING while a model streams into somebody else's DOM — routinely a
 * minute, sometimes more. A screen that says only "working" for that long is
 * indistinguishable from a hang, and the person cannot tell whether they should
 * go and log in.
 *
 * Each name below is emitted from the point where it becomes true, never
 * inferred afterwards and never from a timer.
 *
 * ------------------------------------------------------------------------
 * NOTHING SECRET TRAVELS ON IT. The payload is a source id, a model id, a state
 * and a short reason. Never a cookie, never a URL with a token in it, never a
 * prompt, never a reply.
 */

const { EVENT } = require('../events');
const { CONNECTION, STATUS } = require('./contract');

/** State -> the event that announces it. The one mapping, in one place. */
const FOR_CONNECTION = Object.freeze({
  [CONNECTION.CONNECTING]: EVENT.WEB_MODEL_CONNECTING,
  [CONNECTION.AUTH_REQUIRED]: EVENT.WEB_MODEL_AUTH_REQUIRED,
  [CONNECTION.DISCOVERING]: EVENT.WEB_MODEL_DISCOVERING,
  [CONNECTION.READY]: EVENT.WEB_MODEL_READY,
  [CONNECTION.RATE_LIMITED]: EVENT.WEB_MODEL_RATE_LIMITED,
  [CONNECTION.FAILED]: EVENT.WEB_MODEL_FAILED,
  [CONNECTION.UNAVAILABLE]: EVENT.WEB_MODEL_FAILED,
});

/** The result of a send -> the event that ends it. */
const FOR_STATUS = Object.freeze({
  [STATUS.COMPLETED]: EVENT.WEB_MODEL_READY,
  [STATUS.CANCELLED]: EVENT.WEB_MODEL_CANCELLED,
  [STATUS.AUTH_REQUIRED]: EVENT.WEB_MODEL_AUTH_REQUIRED,
  [STATUS.RATE_LIMITED]: EVENT.WEB_MODEL_RATE_LIMITED,
  [STATUS.UNAVAILABLE]: EVENT.WEB_MODEL_FAILED,
  [STATUS.FAILED]: EVENT.WEB_MODEL_FAILED,
});

/** A bus that is always there. Same contract as events.NULL_BUS. */
function busOf(app) {
  const bus = app && app.events;
  return bus && typeof bus.emit === 'function' ? bus : { emit() { return null; } };
}

/**
 * SAY IT. Returns the delivered event, or null when nobody is listening or the
 * state has no announcement of its own (DISCONNECTED is a resting state, not
 * news).
 */
function connection(app, sourceId, state, { model = null, why = '', retryAfterMs = null } = {}) {
  const name = FOR_CONNECTION[state];
  if (!name) return null;
  return busOf(app).emit(name, {
    source: String(sourceId || ''),
    state: String(state || ''),
    model: model || undefined,
    why: why ? String(why).slice(0, 300) : undefined,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  });
}

/** The prompt is going out. Emitted BEFORE the await, or it is a report. */
function sending(app, sourceId, model) {
  return busOf(app).emit(EVENT.WEB_MODEL_SENDING, { source: String(sourceId || ''), model: model || undefined });
}

/** It is out and nothing has come back. The long, silent one. */
function waiting(app, sourceId, model) {
  return busOf(app).emit(EVENT.WEB_MODEL_WAITING, { source: String(sourceId || ''), model: model || undefined });
}

/** Text is arriving on the page. */
function receiving(app, sourceId, model, chars = 0) {
  return busOf(app).emit(EVENT.WEB_MODEL_RECEIVING, {
    source: String(sourceId || ''), model: model || undefined, chars: Number(chars) || 0,
  });
}

/** How a send ended, from the normalized result. Never from a guess. */
function settled(app, res) {
  if (!res) return null;
  const name = FOR_STATUS[res.status] || EVENT.WEB_MODEL_FAILED;
  return busOf(app).emit(name, {
    source: res.source,
    model: res.model || undefined,
    status: res.status,
    // The REASON, never the reply.
    why: res.error ? String(res.error).slice(0, 300) : undefined,
    chars: res.text ? res.text.length : 0,
    retryAfterMs: Number.isFinite(res.retryAfterMs) ? res.retryAfterMs : undefined,
  });
}

module.exports = { connection, sending, waiting, receiving, settled, FOR_CONNECTION, FOR_STATUS };
