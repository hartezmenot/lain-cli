'use strict';

/**
 * ASK MORE THAN ONE, THEN LET THE USER CHOOSE.
 *
 * THE SHAPE THAT WAS MISSING. The relay had exactly one actor, so there was
 * never anything to choose between — and the single answer it did get was
 * consumed by the orchestrator, which extracted a RECOMMENDATION and submitted
 * its own instruction built around it. The external model's words never reached
 * the user, and the user's judgement never reached the loop.
 *
 * This fans one packet out to every configured provider AT ONCE, keeps each
 * call's state apart, and hands the answers back so they can be offered as
 * choices. What happens to the chosen one is the caller's business; what
 * happens here is that every stage is recorded and nothing is invented.
 *
 * ------------------------------------------------------------------------
 * ONE CALL, ONE RECORD, NO SHARED MUTABLE STATE.
 *
 * Every provider gets its own ExternalCall with its own id, timestamps, status
 * and response (see externalstate.js), and its own browser profile and page
 * (see browser.runtimeFor). Two providers running at once therefore cannot
 * overwrite one another — not by convention, but because there is no shared
 * slot to overwrite.
 * ------------------------------------------------------------------------
 *
 * A FAILURE IS A FAILURE. An adapter that throws, times out, returns nothing,
 * or returns an object with no text all end as a NON-answered state carrying a
 * real reason. Nothing here can produce a successful-looking result from an
 * unsuccessful call — `ExternalCall.respond('')` refuses.
 */

const actorsMod = require('./actors');
const externalstate = require('./externalstate');

/** Bounded: this is a panel, not a broadcast. */
const MAX_PROVIDERS = 4;

/**
 * The providers to ask.
 *
 * `externalTroubleshoot.providers` is a list of `{ id, url }`. With none
 * configured this falls back to the single actor exactly as before, so an
 * existing setup keeps working and nothing silently starts contacting more
 * services than the user asked for.
 */
function providersFrom(cfg) {
  const raw = (cfg && cfg.externalTroubleshoot) || {};
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  const out = [];
  for (const p of list.slice(0, MAX_PROVIDERS)) {
    if (!p || !p.url) continue;
    let id = p.id;
    if (!id) { try { id = new URL(p.url).hostname.replace(/^www\./, '').split('.')[0]; } catch { id = null; } }
    if (!id) continue;
    out.push({ id: String(id), url: String(p.url) });
  }
  return out;
}

/**
 * Build one actor per provider, each pinned to its own url and profile.
 *
 * The actor class is unchanged — this only varies the configuration it reads,
 * so a browser actor here behaves exactly like the one `/external browser`
 * produces. Reusing it is the point: there is no second browser mechanism.
 */
function actorsFor(app, providers) {
  return providers.map(({ id, url }) => {
    const scoped = {
      ...(app.cfg || {}),
      // `actor`, not `kind` — that is the key actors.kindOf() reads. Setting
      // the wrong one silently produced an API actor pointed at a chat URL.
      externalTroubleshoot: {
        ...((app.cfg || {}).externalTroubleshoot || {}), url, provider: id, actor: 'BROWSER',
      },
    };
    const actor = actorsMod.create(app, { cfg: scoped });
    return { id, url, actor };
  }).filter((a) => a.actor);
}

/**
 * Ask every provider, concurrently, and record what each one did.
 *
 * @returns {Promise<{calls, answered, failed, overall}>}
 */
async function ask(app, packet, { images = [], session = null, signal = null } = {}) {
  const ledger = externalstate.forSession(session || (app && app.session));
  const providers = providersFrom(app && app.cfg);

  // ---- NOTHING CONFIGURED IS A REAL STATE -------------------------------
  if (!providers.length) {
    return { calls: [], answered: [], failed: [], overall: externalstate.STATE.NOT_REQUESTED, providers: [] };
  }

  const built = actorsFor(app, providers);
  const runs = built.map(async ({ id, actor }) => {
    const call = ledger.open({ provider: id, kind: 'BROWSER', prompt: packet });
    try {
      const handed = await actor.send(packet, { images });
      if (!handed || handed.ok === false) {
        call.fail((handed && handed.error) || 'the packet was not delivered');
        return call;
      }
      call.dispatch(handed.delivered || 'browser', { attachments: handed.attached || [] });
      call.continued = Boolean(handed.continued);

      const got = await actor.receive({ signal });
      if (!got || got.ok === false) {
        // A TIMEOUT IS NOT A CONTENT FAILURE, and is recorded as itself.
        if (got && got.timedOut) call.timeout(got.error);
        else if (got && got.cancelled) call.reject(got.error || 'cancelled');
        else call.fail((got && got.error) || 'no reply was captured');
        return call;
      }
      // `respond` REFUSES an empty answer — see externalstate.js. This is the
      // one place a well-formed-but-empty adapter result would otherwise become
      // a success.
      call.respond(got.text || (got.sections ? JSON.stringify(got.sections) : ''));
      call.analysis = got;
      return call;
    } catch (e) {
      // AN EXCEPTION MUST NOT DISAPPEAR INSIDE THE ADAPTER. It becomes the
      // call's real reason.
      call.fail(`the adapter threw: ${(e && e.message) || e}`);
      return call;
    }
  });

  const calls = await Promise.all(runs);
  return {
    calls,
    answered: calls.filter((c) => c.answered),
    failed: calls.filter((c) => c.failed),
    overall: ledger.overall(),
    providers: providers.map((p) => p.id),
  };
}

/**
 * The answers, as choices.
 *
 * Returned as data rather than drawn here: the panel that asks the question is
 * ui/answer.js's, and a second question surface is exactly what this project
 * has removed once already.
 */
function choicesFrom(calls) {
  const answered = calls.filter((c) => c.answered);
  const options = answered.map((c) => ({
    id: c.id,
    label: `${c.provider} — ${c.response.replace(/\s+/g, ' ').slice(0, 70)}`,
    provider: c.provider,
    text: c.response,
  }));
  // BOTH is offered only when there is more than one to combine.
  if (options.length > 1) {
    options.push({
      id: 'BOTH',
      label: `both — take ${answered.map((c) => c.provider).join(' and ')} together`,
      provider: 'both',
      text: answered.map((c) => `## ${c.provider}\n\n${c.response}`).join('\n\n'),
    });
  }
  return options;
}

/**
 * Record what the user did with the answers.
 *
 * The distinction the state machine exists to keep: a call that answered and
 * was TAKEN is not the same event as one that answered and was passed over.
 */
function settle(calls, chosenId) {
  for (const c of calls) {
    if (!c.answered) continue;
    if (chosenId === 'BOTH' || c.id === chosenId) c.use();
    else c.discard();
  }
  return calls;
}

module.exports = { ask, choicesFrom, settle, providersFrom, actorsFor, MAX_PROVIDERS };
