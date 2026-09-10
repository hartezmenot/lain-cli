'use strict';

/**
 * A RATE LIMIT THAT LASTS HOURS IS NOT A RETRY — it is a decision.
 *
 * The bounded retry in turn.js is right for a limit that clears in seconds:
 * wait, try again, get on with it. It is wrong for the one this exists for.
 * Measured against a real router: `retry in 4 hours`. Sitting inside the retry
 * for that means a LAIN that looks alive, answers nothing, and holds the
 * session hostage to a number nobody was shown — and the retry budget is spent
 * long before the limit clears, so the ending is a failure either way.
 *
 * There are only two useful answers, and both belong to the person:
 *
 *   WAIT          the model is worth the wait. LAIN says so plainly, counts
 *                 down, and picks the work up by itself when the clock runs
 *                 out. No `continue` typed by hand.
 *   CHANGE MODEL  the work matters more than the route. The model picker
 *                 opens, and the turn is retried on whatever is chosen.
 *
 * ------------------------------------------------------------------------
 * WHY THE THRESHOLD, AND WHY IT IS THIS SIDE OF A MINUTE.
 *
 * Being asked a question is an interruption, and a question about a
 * twenty-second wait costs more attention than the wait does. Below the
 * threshold the existing retry handles it silently, which is what it is good
 * at. Above it, the wait is long enough that a person would want to know — and
 * long enough that they might reasonably choose the other model.
 */

/** Longer than this and it is worth asking rather than sitting through. */
const ASK_ABOVE_MS = 90_000;

/** How often the countdown redraws. Once a second is all a clock needs. */
const TICK_MS = 1000;

/** Is this failure a wait long enough to be worth a question? */
function worthAsking(failure) {
  if (!failure || failure.kind !== 'RATE_LIMITED') return false;
  return Number(failure.retryAfterMs) > ASK_ABOVE_MS;
}

/**
 * `4h 12m`, `12m 30s`, `45s` — a duration at the scale a person reads it.
 *
 * NEVER "0s" WHILE TIME REMAINS. A countdown that reads zero and keeps counting
 * is a clock nobody believes; anything under a second rounds up to one.
 */
function human(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return 'now';
  // WHOLE SECONDS FIRST, THEN SPLIT INTO FIELDS.
  //
  // Rounding each field on its own produced durations that do not exist: with
  // 3,599,500ms remaining the minutes floored to 59 while the seconds ceiled to
  // 60, and the panel read "59m 60s". It also made a test flaky rather than
  // wrong — `resumeAt = now + 1h` is a fraction of a millisecond short of an
  // hour by the time it is formatted, so the label came out "1h 0m" or
  // "59m 60s" depending on how busy the machine was, and the suite disagreed
  // with itself between runs. Ceiling the total ONCE cannot disagree with
  // itself, and rounding up keeps the promise above: a countdown never reads
  // zero while there is still time left to wait.
  const total = Math.ceil(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The absolute clock time the limit clears, for "can I go and do something". */
function at(resumeAt) {
  try { return new Date(resumeAt).toTimeString().slice(0, 5); } catch { return '—'; }
}

/**
 * What LAIN sends itself when the clock runs out.
 *
 * IT NAMES WHAT HAPPENED. Without that the model receives a bare "continue"
 * after an unexplained gap and quite reasonably re-plans, or asks what it was
 * doing — which is the whole cost of resuming badly. Everything it needs is
 * still in the conversation; this only says why there is a gap in it.
 */
const RESUME_PROMPT = 'The rate limit has reset. Nothing changed while it was waiting and nothing '
  + 'was lost. Continue from exactly where you stopped — do not start again, and do not repeat '
  + 'work you have already done. If you were in fact finished, say so and say what you concluded.';

/**
 * The answers, as the panel's values.
 *
 * FAILOVER WAS ADDED FIRST IN THE LIST AND FIRST IN IMPORTANCE. "This model is
 * rate limited, would you like a different MODEL" was the only offer, and it is
 * the wrong one whenever the same model is configured on a second connection:
 * the model was never the problem, the road to it was. Changing model changes
 * the answers, the tool behaviour, the context size and the cost, in the middle
 * of a task the user picked that model for. Changing provider changes none of
 * them. See failover.js.
 */
const CHOICE = Object.freeze({ WAIT: 'WAIT', CHANGE: 'CHANGE', FAILOVER: 'FAILOVER' });

/**
 * The question itself, as an adapter for the ONE interaction panel.
 *
 * No bespoke prompt: it is the same surface `/model` and every confirmation
 * uses, so a question about a rate limit looks like every other question.
 */
function adapter({ provider, resumeAt, model, alternative = null, exhausted = false, routes = 0 }) {
  const left = Math.max(0, resumeAt - Date.now());
  const { KIND, MODE } = require('./ui/panel');
  const items = [
    // NAMES THE ROUTE, NOT THE MODEL. "opus is rate limited" is the sentence
    // that causes the confusion this whole offer exists to correct.
    { label: `${provider || 'the provider'} is rate limited${model ? ` for ${model}` : ''}.`, selectable: false },
    { label: `It clears in ${human(left)} — around ${at(resumeAt)}.`, selectable: false },
  ];
  if (exhausted && routes > 1) {
    // THE HONEST SENTENCE FOR THE CASE WITH NO WAY OUT. Not "the model is
    // unavailable" — every road to it is closed at once, which is a different
    // fact and has a different fix.
    items.push({ label: `All ${routes} configured providers for this model are rate limited.`, selectable: false });
  }
  items.push({ label: '', selectable: false });

  // FIRST, WHEN IT EXISTS, because it is the answer that costs nothing.
  if (alternative) {
    items.push({
      label: `Switch provider — same model (${model}) on ${alternative.connectionId}, now`,
      value: CHOICE.FAILOVER,
    });
  }
  items.push({ label: `Wait for the reset — LAIN carries on by itself in ${human(left)}`, value: CHOICE.WAIT });
  items.push({ label: 'Change model — pick another model and retry now', value: CHOICE.CHANGE });
  return {
    title: 'RATE LIMITED',
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items,
    cursor: items.findIndex((i) => i.value),
    footer: '↑↓ choose · Enter confirm · Esc = wait',
  };
}

/**
 * ASK WHAT TO DO ABOUT A LONG LIMIT, THEN DO IT.
 *
 * Lifted out of app.js when that file crossed the god-object guard, and it
 * belongs here: everything it consults — the threshold, the question, the
 * resume prompt — was already in this module, and the flow was the only part
 * of the subject living somewhere else.
 *
 * A PLAIN FUNCTION OVER `app`, never a method, and it uses no `this`. See the
 * architecture guard: these extractions are exactly where a surviving `this`
 * becomes `undefined` in strict mode and takes a turn down with it.
 *
 * @param {object} app     the running app
 * @param {object} record  the turn that stopped
 * @param {string} text    the original request, to retry on the new route
 */
async function handle(app, record, text) {
  const f = record.providerFailure;
  const resumeAt = f.resumeAt || (Date.now() + (f.retryAfterMs || 0));

  // NOBODY TO ASK is not a reason to invent an answer. Off a TTY it reports
  // the limit and stops, exactly as any other provider failure would.
  if (!app.ui.enabled) {
    // NOBODY TO ASK still means saying which of the two facts is true — the
    // report is the only thing a scripted run gets, so "one route is limited"
    // and "every route is limited" must not read identically.
    const alt = require('./failover').pick(app, { model: app.cfg.model, exclude: [f.connectionId] });
    const tail = alt.ok
      ? ` The same model is available on ${alt.route.connectionId} — /steer to ${alt.route.connectionId}.`
      : alt.exhausted ? ` ${alt.why}.` : '';
    app.render.notice('warn',
      `${f.provider} is rate limited — it clears in ${human(resumeAt - Date.now())} (${at(resumeAt)}).${tail}`);
    return record;
  }

  // ---- IS THE MODEL RATE LIMITED, OR IS ONE ROAD TO IT? ----------------
  //
  // These are different facts and only one of them was ever reported. A model
  // configured on three connections is not unavailable because one of them
  // said no — and offering "change model" there asks the user to give up the
  // thing they chose in order to fix something that was never wrong with it.
  // See failover.js.
  const failover = require('./failover');
  const alt = failover.pick(app, { model: app.cfg.model, exclude: [f.connectionId] });

  const choice = await app.ui.ask(adapter({
    provider: f.provider, resumeAt, model: app.cfg.model,
    alternative: alt.ok ? alt.route : null,
    exhausted: alt.exhausted,
    routes: alt.routes.length,
  }));

  // ---- SAME MODEL, DIFFERENT PROVIDER ----------------------------------
  //
  // A FAILOVER, not a model change: `cfg.model` is not touched, and it is not
  // written to the config either. This is a detour for one session, and
  // persisting it would quietly make the user's route change permanent.
  if (choice === CHOICE.FAILOVER && alt.ok) {
    const moved = failover.apply(app, alt.route);
    app.transient('info', `${moved.kind} — ${app.cfg.model} via ${alt.route.connectionId}`);
    return await app.submit(text, { sameTask: true, from: 'provider-failover' });
  }

  // ---- CHANGE MODEL ----------------------------------------------------
  if (choice === CHOICE.CHANGE) {
    const before = `${app.cfg.model}::${app.cfg.connection}`;
    await require('./modelcommand').pickCommand(app, { args: [], rest: '' }, {
      // REQUIRED HERE, not inherited. In app.js `config` was a module-level
      // import; carried across as a bare name it was simply undefined, and the
      // only way to find out was for a user to pick "change model" during a
      // real rate limit — the same shape of bug as the CONTEXT crash, in the
      // one branch nothing routinely exercises.
      C: require('./render').C, config: require('./config'), refreshCatalog: () => {},
    });
    // ONLY RETRY IF SOMETHING ACTUALLY CHANGED. Escaping out of the picker
    // means "no" — retrying on the same rate-limited route would produce the
    // identical refusal and look like LAIN ignoring the answer.
    if (`${app.cfg.model}::${app.cfg.connection}` === before) {
      app.transient('info', 'unchanged — still rate limited');
      return record;
    }
    return await app.submit(text, { sameTask: true, from: 'rate-limit-switch' });
  }

  // ---- WAIT (also what Escape means) -----------------------------------
  //
  // ESCAPE FALLS HERE ON PURPOSE. Cancelling the question is not a decision
  // to abandon the task; waiting is the answer that changes nothing, so it is
  // the safe default for a keypress that means "not now".
  //
  // A FRESH CONTROLLER: `submit`'s `finally` already nulled `app.abort` by
  // the time this runs, so the signal `waitForReset` listens on (its own
  // comment: "through the same abort signal everything else is cancelled
  // by") never existed — Escape and Ctrl+C were both wired to a wait with no
  // way out (found live, against a real multi-hour reset). Cleared the same
  // way `submit` clears its own, once the wait ends.
  app.abort = new AbortController();
  let ok;
  try {
    ok = await app.ui.waitForReset(resumeAt, {
      provider: f.provider,
      label: `waiting for ${f.provider || 'the provider'} to reset`,
    });
  } finally {
    app.abort = null;
  }
  // Interrupted mid-wait: the user came back and wants control. Not a failure
  // and not a completion — the prompt simply returns to them.
  if (!ok) { app.transient('info', 'stopped waiting — the prompt is yours'); return record; }
  if (app.ui.enabled) app.ui.noteActor('note', 'the rate limit reset — carrying on');

  // ---- THE ONE PLACE LAIN STILL COMPOSES A PROMPT, AND WHY -------------
  //
  // This is a synthetic continuation prompt, which is exactly the shape that
  // was removed with `carryon`. It survives for one reason and it is not a
  // loophole: THE USER CHOSE IT, in a question, knowing what it does. The
  // panel above offered "wait for the reset — LAIN carries on by itself in
  // 3h 59m" against "change model", and they picked the first.
  //
  // The difference from carry-on is who decided. Carry-on had LAIN conclude
  // that the model did not mean to stop and act on that conclusion, four
  // times, unasked. Here a person was shown the cost and the alternative and
  // said yes — once, for one continuation, at a moment they chose. Escaping
  // the wait cancels it, and nothing resumes if they do.
  //
  // If this ever becomes automatic — resuming without the question, or
  // resuming more than the once that was authorised — it has become carry-on
  // again under a different name.
  // `from` IS WHAT KEEPS THIS OUT OF THE TRANSCRIPT AS A FAKE USER MESSAGE, and
  // the key has to match the one ui/phrasing.js knows: it was `rate-limit-wait`
  // against a table holding `rate-limit-resume`, so the caption fell through to the
  // generic `carrying on (rate-limit-wait)` — which named an internal identifier at
  // the user. See SELF_ASKED.
  return await app.submit(RESUME_PROMPT, { sameTask: true, from: 'rate-limit-resume' });
}

module.exports = { worthAsking, human, at, adapter, handle, CHOICE, RESUME_PROMPT, ASK_ABOVE_MS, TICK_MS };
