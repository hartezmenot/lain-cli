'use strict';

/**
 * LIVE CERTIFICATION — the only thing in this package that touches a real site.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS A COMMAND AND NOT A TEST.
 *
 * The conformance suite proves the ORCHESTRATION: the send guard, the thread
 * binding, the retry rule, the rate-limit classification, the provenance. It
 * runs against the deterministic fixture, needs no account and no network, and
 * is in the default tiers because it can be.
 *
 * What it CANNOT prove is that chatgpt.com's model menu still has the shape
 * chatgpt.js declares. Only the real site can say that, and asking it requires a
 * paid account, a logged-in browser and a person to complete a login — none of
 * which may ever be a precondition for `npm test`. A suite that quietly skips
 * when an account is missing teaches people to read a green run as more than it
 * is, and this repository's status labels exist precisely to stop that.
 *
 * So: LIVE VERIFIED is a claim only this command can earn, it is run by hand,
 * and it says at the end exactly what it did and did not establish.
 *
 * ------------------------------------------------------------------------
 * IT IS HARMLESS BY CONSTRUCTION.
 *
 * One short, content-free prompt into a NEW conversation. It sends no project
 * context, no session facts and no file. It reads the reply, checks it arrived,
 * and stops. Nothing it does can change the account, the settings or an existing
 * thread.
 */

const { CONNECTION, MODEL_STATE, STATUS } = require('./contract');

/** The prompt. Deliberately trivial, and deliberately not about this project. */
const PROBE = 'Reply with the single word: ready.';

function line(ok, text) { return `${ok === null ? '·' : ok ? '✓' : '✕'} ${text}`; }

/**
 * Run the five things a live check can establish, in order, stopping at the
 * first that fails — because every later step assumes the earlier ones.
 *
 * @returns {Promise<string[]>} lines to print. Never throws.
 */
async function run(app, source, { rest = '' } = {}) {
  const out = [];
  if (!source) return ['✕ no chat source selected'];
  out.push(`LIVE CHECK — ${source.label}`);
  out.push('');

  // 1. CAN A BROWSER RUN HERE AT ALL?
  let st;
  try { st = await source.status({ open: false }); } catch (e) { return [...out, line(false, `status failed: ${(e && e.message) || e}`)]; }
  if (st.state === CONNECTION.UNAVAILABLE) {
    return [...out, line(false, `unavailable — ${st.why}`), '', 'NOT LIVE VERIFIED.'];
  }
  out.push(line(true, 'a browser is available on this machine'));

  // 2. IS THE ACCOUNT SIGNED IN?
  let conn;
  try { conn = await source.connect(); } catch (e) { return [...out, line(false, `connect failed: ${(e && e.message) || e}`), '', 'NOT LIVE VERIFIED.']; }
  if (conn.state === CONNECTION.AUTH_REQUIRED) {
    return [...out, line(false, `sign in required — ${conn.why}`),
      '', 'Log in in the browser window LAIN opened, then run this again.',
      'NOT LIVE VERIFIED.'];
  }
  if (conn.state !== CONNECTION.READY) {
    return [...out, line(false, `not ready — ${conn.why}`), '', 'NOT LIVE VERIFIED.'];
  }
  out.push(line(true, 'the account is signed in'));

  // 3. DOES THE MODEL SELECTOR STILL READ?
  const began = Date.now();
  const inv = await source.discoverModels({ refresh: true });
  if (!inv.ok) {
    return [...out, line(false, `model discovery failed — ${inv.why}`),
      '', 'This is the failure a site redesign produces. The adapter must be updated;',
      'nothing was sent and nothing was guessed.',
      'NOT LIVE VERIFIED.'];
  }
  const discoverMs = Date.now() - began;
  out.push(line(true, `${inv.models.length} model(s) discovered in ${discoverMs}ms`));
  for (const m of inv.models.slice(0, 12)) {
    out.push(`    ${m.id}${m.state === MODEL_STATE.AVAILABLE ? '' : `  ${m.state}`}`);
  }

  // 4. CAN A SPECIFIC MODEL BE SELECTED AND VERIFIED?
  const wanted = String(rest || '').trim() || source.selectedModel() || (inv.models.find((m) => m.state !== MODEL_STATE.UNAVAILABLE) || {}).id;
  if (!wanted) return [...out, line(false, 'no selectable model in the list'), '', 'NOT LIVE VERIFIED.'];
  const picked = await source.selectModel(wanted);
  if (!picked.ok) return [...out, line(false, `could not select "${wanted}" — ${picked.why}`), '', 'NOT LIVE VERIFIED.'];
  out.push(line(true, `selected ${picked.modelId}, and the page confirms it`));

  // 5. ONE HARMLESS PROMPT, END TO END.
  const sendBegan = Date.now();
  const res = await source.send({ prompt: PROBE, modelId: picked.modelId });
  const sendMs = Date.now() - sendBegan;
  if (res.status === STATUS.RATE_LIMITED) {
    return [...out, line(false, `rate limited — ${res.error || 'no detail'}`),
      '', 'The transport works; this account is capped right now.',
      'PARTIALLY LIVE VERIFIED — discovery and selection only.'];
  }
  if (res.status !== STATUS.COMPLETED) {
    return [...out, line(false, `the prompt did not produce an answer — ${res.error || res.status}`), '', 'NOT LIVE VERIFIED.'];
  }
  out.push(line(true, `a reply arrived in ${sendMs}ms (${res.text.length} characters)`));
  out.push(line(true, `provenance: ${res.provenance.label}`));
  out.push('');
  out.push('LIVE VERIFIED — connect, discover, select, send, extract, provenance.');
  // SAID OUT LOUD, because a check that implies more than it did is worse than
  // no check. None of these were exercised by the run above.
  out.push('NOT covered by this run: cancellation, rate-limit handling, thread');
  out.push('resumption across sessions, and recovery from a changed page structure.');
  return out;
}

/**
 * THE SAME FIVE STEPS, OVER THE DETERMINISTIC FIXTURE.
 *
 * `/source check fixture` — and it is not a toy. When a live check fails, the
 * first question is whether the CHECK is broken or the SITE has changed, and
 * without this there is no way to tell them apart: both look like a red run
 * against a site nobody can inspect from here.
 *
 * It contacts nothing. A green fixture check and a red live check together say
 * "the certification pipeline works and this site does not match its adapter",
 * which is a diagnosis rather than a symptom.
 */
async function selfTest(app) {
  const fixture = require('./fixture');
  const { WebModelSource } = require('./webmodel');
  const id = 'fixture-web';
  const surface = fixture.create({ id, label: 'Fixture', reply: 'ready' });
  const src = new WebModelSource({ surface, app, id, label: 'Fixture (no site, no network)' });
  const lines = await run(app, src, {});
  return [
    ...lines,
    '',
    'This exercised the certification pipeline itself against a fake site.',
    'It says NOTHING about chatgpt.com or gemini.google.com.',
  ];
}

module.exports = { run, selfTest, PROBE };
