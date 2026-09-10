'use strict';

/**
 * WATCHING WITHOUT STARING, and comparing what two sources said.
 *
 * The behaviours pinned here are the ones the design is about:
 * the model is not called per event; evidence accumulates
 * a high-value event captures evidence AT THE MOMENT it happens
 * log and visual stay apart until they are deliberately compared
 * SENT_UNCONFIRMED never becomes SUCCESS
 * a denied channel is recorded as absent evidence, not as failure
 * a held key is registered so something can lift it after a crash
 */

const assert = require('assert');
const { test } = require('../helpers');
const observe = require('../../src/observe');
const correlate = require('../../src/correlate');
const { Channels, CHANNEL, STATE: CH } = require('../../src/channels');
const heldKeys = require('../../src/heldkeys');

/** An observation with the rules the user's minigame example needs. */
function watching() {
  const obs = new observe.Observation({
    command: 'node bot.js',
    expectation: ['start', 'play the minigame', 'continue after it', 'stop when asked'],
    rules: [
      { name: 'MINIGAME_STARTED', pattern: 'MINIGAME_STARTED', capture: true, why: 'the indicator is only up for seconds' },
      { name: 'ROUND_COMPLETE', pattern: 'ROUND_COMPLETE', capture: true },
      { name: 'CLICK_ACCEPTED', pattern: 'CLICK_ACCEPTED' },
    ],
  });
  obs.state = observe.STATE.OBSERVING;
  obs.startedAt = Date.now();
  return obs;
}

module.exports = async function () {
  await test('OBSERVE: an ordinary line is counted and captures nothing', () => {
    const obs = watching();
    const wants = obs.feed('tick 1');
    assert.deepStrictEqual(wants, [], 'nothing matched, so nothing is worth a picture');
    assert.strictEqual(obs.lines, 1);
    assert.strictEqual(obs.events.length, 0, 'a line that matches no rule is not an event');
  });

  await test('OBSERVE: a rule that matters fires AT THE MOMENT it happens', () => {
    // The user's case: an indicator visible for seconds. Nothing polls for it —
    // the log line that announces it is what triggers the look, so the timing
    // cannot be missed by being between two glances.
    const obs = watching();
    const wants = obs.feed('12:00:01 MINIGAME_STARTED round=4');
    assert.strictEqual(wants.length, 1);
    assert.strictEqual(wants[0].name, 'MINIGAME_STARTED');
    assert.strictEqual(obs.events.length, 1, 'and it is on the record');
    assert.strictEqual(obs.events[0].source, observe.SOURCE.LOG);
  });

  await test('OBSERVE: a rule WITHOUT capture is recorded and costs nothing', () => {
    const obs = watching();
    const wants = obs.feed('CLICK_ACCEPTED at 100,200');
    assert.deepStrictEqual(wants, [], 'not everything worth recording is worth a screenshot');
    assert.strictEqual(obs.events.length, 1, 'but it is still evidence');
  });

  await test('OBSERVE: the same rule does not capture twice inside its cooldown', () => {
    // A bot printing the same line in a tight loop would otherwise take a
    // screenshot per line until the disk filled. A mechanical runaway guard,
    // which is the kind the design keeps.
    const obs = watching();
    assert.strictEqual(obs.feed('MINIGAME_STARTED a').length, 1);
    assert.strictEqual(obs.feed('MINIGAME_STARTED b').length, 0, 'suppressed by the cooldown');
    assert.strictEqual(obs.events.length, 2, 'both are still RECORDED — only the picture is skipped');
  });

  await test('OBSERVE: two different rules on one line both fire', () => {
    // Per-rule cooldown, not global: two rules matching the same line are two
    // different things worth seeing, and the second is exactly the correlation
    // the capture was for.
    const obs = new observe.Observation({
      rules: [
        { name: 'A', pattern: 'BOOM', capture: true },
        { name: 'B', pattern: 'BOOM', capture: true },
      ],
    });
    obs.startedAt = Date.now();
    assert.strictEqual(obs.feed('BOOM').length, 2);
  });

  await test('OBSERVE: sources are kept apart', () => {
    const obs = watching();
    obs.feed('MINIGAME_STARTED');
    obs.addCapture({ rule: 'MINIGAME_STARTED', kind: 'screenshot', path: 'a.png', text: 'minigame' });
    assert.strictEqual(obs.from(observe.SOURCE.LOG).length, 1);
    assert.strictEqual(obs.from(observe.SOURCE.VISUAL).length, 1);
    // The whole point: neither is allowed to become the other.
    assert.notStrictEqual(obs.from(observe.SOURCE.LOG)[0], obs.from(observe.SOURCE.VISUAL)[0]);
  });

  await test('CORRELATE: log and screen agreeing is CORROBORATED', () => {
    const obs = watching();
    obs.feed('MINIGAME_STARTED');
    obs.addCapture({ rule: 'MINIGAME_STARTED', kind: 'screenshot', path: 'a.png', text: 'MINIGAME indicator visible' });
    const r = correlate.compare(obs, {
      claims: ['MINIGAME_STARTED'],
      expect: { MINIGAME_STARTED: { present: ['indicator'] } },
    });
    assert.strictEqual(r.counts.CORROBORATED, 1);
    assert.strictEqual(r.question, null, 'nothing to ask about — they agree');
  });

  await test('CORRELATE: the user\'s exact case — log says complete, screen still shows it', () => {
    const obs = watching();
    obs.feed('ROUND_COMPLETE');
    obs.addCapture({ rule: 'ROUND_COMPLETE', kind: 'screenshot', path: 'b.png', text: 'minigame still here' });
    const r = correlate.compare(obs, {
      claims: ['ROUND_COMPLETE'],
      expect: { ROUND_COMPLETE: { absent: ['minigame'] } },
    });
    assert.strictEqual(r.counts.CONTRADICTED, 1);
    assert.ok(r.question, 'a contradiction becomes a QUESTION');
    assert.match(r.question.why, /still shows minigame/i);
    // AND NOT A DIAGNOSIS. LAIN does not get to decide which source is wrong.
    assert.ok(!/the bot is broken|the log is wrong/i.test(r.question.why));
  });

  await test('CORRELATE: a claim nobody looked at is UNRESOLVED, not confirmed', () => {
    const obs = watching();
    obs.feed('ROUND_COMPLETE');
    const r = correlate.compare(obs, { claims: ['ROUND_COMPLETE'] });
    assert.strictEqual(r.counts.UNRESOLVED, 1);
    assert.strictEqual(r.counts.CORROBORATED, 0, 'an unwatched claim is never corroborated');
  });

  await test('CORRELATE: a screenshot nobody READ is NOT SEEN', () => {
    // A PNG on disk supports exactly one claim: that a PNG exists. Promoting
    // that to visual evidence is the "I saw the image" lie in another form.
    const obs = watching();
    obs.feed('ROUND_COMPLETE');
    obs.addCapture({ rule: 'ROUND_COMPLETE', kind: 'screenshot', path: 'c.png', text: '' });
    const r = correlate.compare(obs, {
      claims: ['ROUND_COMPLETE'], expect: { ROUND_COMPLETE: { absent: ['minigame'] } },
    });
    assert.strictEqual(r.counts.UNRESOLVED, 1);
    assert.match(r.findings[0].why, /NOT SEEN/);
  });

  await test('CORRELATE: a refused capture is UNRESOLVED and says the channel was shut', () => {
    const obs = watching();
    obs.feed('ROUND_COMPLETE');
    obs.addCapture({ rule: 'ROUND_COMPLETE', kind: 'screenshot', ok: false, why: 'SCREEN DENIED — the user said no' });
    const r = correlate.compare(obs, { claims: ['ROUND_COMPLETE'] });
    assert.strictEqual(r.counts.UNRESOLVED, 1);
    assert.match(r.findings[0].why, /could not be captured/);
    assert.match(correlate.lines(r).join('\n'), /NOT CAPTURED/);
  });

  await test('CORRELATE: something on screen with no log line is UNEXPLAINED', () => {
    // The direction a log-only investigation structurally cannot look.
    const obs = watching();
    obs.startedAt = Date.now() - 60000;
    obs.addCapture({ rule: 'watchdog', kind: 'screenshot', path: 'd.png', text: 'FATAL ERROR dialog' });
    const r = correlate.compare(obs, { watchFor: ['fatal error'] });
    assert.strictEqual(r.counts.UNEXPLAINED, 1);
    assert.match(r.findings[0].why, /no log line was written/);
  });

  await test('CHANNELS: a denial is answered without asking again', () => {
    const ch = new Channels();
    assert.strictEqual(ch.check('key').ok, true, 'nothing decided yet');
    ch.deny(CHANNEL.KEYBOARD, 'you said no');
    const v = ch.check('key');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.state, CH.DENIED);
    // THE FALLBACK IS THE POINT: a refusal must produce a changed plan.
    assert.match(v.fallback, /ask the user to press/i);
    assert.strictEqual(ch.check('type').ok, false, 'the whole channel, not one operation');
    assert.strictEqual(ch.check('screenshot').ok, true, 'and only that channel');
  });

  await test('CHANNELS: denied is not the same as nothing can carry it', () => {
    const ch = new Channels();
    ch.deny(CHANNEL.KEYBOARD, 'the user said no');
    ch.unavailable(CHANNEL.OCR, 'this bridge has no OCR');
    assert.strictEqual(ch.state(CHANNEL.KEYBOARD), CH.DENIED, 'reversed by changing their mind');
    assert.strictEqual(ch.state(CHANNEL.OCR), CH.UNAVAILABLE, 'reversed by installing something');
    const brief = ch.brief();
    assert.match(brief, /KEYBOARD UNAVAILABLE/);
    assert.match(brief, /OCR UNAVAILABLE/);
    assert.match(brief, /asking again will not reopen/i, 'the model is told not to retry');
  });

  await test('CHANNELS: only the user reopens one', () => {
    const ch = new Channels();
    ch.deny(CHANNEL.SCREEN, 'no');
    ch.open(CHANNEL.SCREEN);
    assert.strictEqual(ch.state(CHANNEL.SCREEN), CH.OPEN,
      'open() is what a SUCCESS records — a denial that survives a success would be a lie too');
    ch.deny(CHANNEL.SCREEN, 'no');
    ch.reopen(CHANNEL.SCREEN);
    assert.strictEqual(ch.state(CHANNEL.SCREEN), CH.UNKNOWN, 'back to nothing decided');
  });

  await test('CHANNELS: UNKNOWN is not OPEN — a channel nobody used promises nothing', () => {
    const ch = new Channels();
    assert.strictEqual(ch.state(CHANNEL.MOUSE), CH.UNKNOWN);
    assert.deepStrictEqual(ch.closed(), [], 'and it is not reported as closed either');
  });

  await test('DEGRADE: one refusal, and the transport is never asked again', async () => {
    // end to end, through the real `perform`. The failure being prevented is
    // a model spending a request per attempt rediscovering the same no, and the
    // user watching a permission prompt they already dismissed come back.
    const computer = require('../../src/computer');
    const capMod = require('../../src/capability');
    let calls = 0;
    const app = {
      desktop: () => ({ bridge: { call: async () => { calls += 1; return { ok: false, denied: true, capability: 'screen', error: 'no' }; } } }),
    };
    const first = await computer.perform(app, 'screenshot', {}, {});
    assert.strictEqual(first.stage, capMod.STAGE.REFUSED);
    assert.strictEqual(calls, 1, 'the first attempt really did ask');

    const second = await computer.perform(app, 'screenshot', {}, {});
    assert.strictEqual(second.stage, capMod.STAGE.REFUSED);
    assert.strictEqual(calls, 1, 'the second must be answered from the ledger, not the transport');
    // IT READS AS A CHANGED SITUATION, not as a failure to retry.
    assert.match(second.why, /asking again will not change it/);
    assert.match(second.why, /Instead: use logs/);
    assert.ok(!/\.\./.test(second.why), 'and it is one sentence, not two glued together');

    // A DIFFERENT CHANNEL IS UNTOUCHED — a denied screen does not deny the mouse.
    await computer.perform(app, 'click', { x: 1, y: 2 }, {});
    assert.strictEqual(calls, 2, 'the mouse was still attempted');
  });

  await test('DEGRADE: only a REFUSAL closes a channel — a broken transport does not', async () => {
    // Recording a transport error as DENIED would suppress a retry that might
    // well work, and would blame the user for a bridge that fell over.
    const computer = require('../../src/computer');
    let calls = 0;
    const app = {
      desktop: () => ({ bridge: { call: async () => { calls += 1; throw new Error('socket closed'); } } }),
    };
    await computer.perform(app, 'screenshot', {}, {});
    await computer.perform(app, 'screenshot', {}, {});
    assert.strictEqual(calls, 2, 'a transport failure is retryable and must be retried');
    assert.deepStrictEqual(computer.channelsOf(app).closed(), [], 'and nothing was closed');
  });

  await test('AIM: an exact title beats a partial one', () => {
    // A game called "Client" must not lose to a browser tab that mentions it.
    // The transport double is the desktop bridge (the Probe transport that
    // these were first written against was removed in 2026-09); the resolution
    // rule being pinned is LAIN's own and sits above the dialect either way.
    const computer = require('../../src/computer');
    const app = { desktop: () => ({ bridge: { call: async (op) => (op === 'window.list'
      ? { ok: true, result: { windows: [
        { title: 'Notes about Client — Chrome', rect: { x: 0, y: 0, width: 100, height: 100 } },
        { title: 'Client', rect: { x: 500, y: 500, width: 640, height: 480 } },
      ] } }
      : { ok: false, error: 'no' }) } }) };
    return computer.regionOf(app, 'Client').then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.title, 'Client');
      assert.deepStrictEqual(r.region, { x: 500, y: 500, width: 640, height: 480 });
    });
  });

  await test('AIM: a window that is not there REFUSES rather than reading the desktop', async () => {
    // Silently substituting a whole-desktop capture is how "what does the game
    // show" came back as LAIN's own panels: an answer that looks like an answer
    // and is about something else.
    //
    // Pinned at regionOf, where the rule lives. It cannot go through the full
    // perform path on the desktop bridge — the only transport now — because the
    // bridge cannot take a region at all, and the capability-gate refusal that
    // fires there is the NEXT test's subject. Driven directly, the capture
    // counter still proves resolution itself looks at nothing.
    const computer = require('../../src/computer');
    let captures = 0;
    const app = { desktop: () => ({ bridge: { call: async (op) => {
      if (op === 'window.list') return { ok: true, result: { windows: [{ title: 'LAIN', rect: { x: 0, y: 0, width: 10, height: 10 } }] } };
      if (op === 'screen.capture') { captures += 1; return { ok: true, result: { path: 'all.png' } }; }
      return { ok: false, error: 'no' };
    } } }) };
    const r = await computer.regionOf(app, 'RuneScape');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(captures, 0, 'nothing may be captured when the aim could not be established');
    assert.match(r.why, /no window titled/);
    assert.match(r.why, /LAIN/, 'and it says what IS open, so the next call can be right');
  });

  await test('AIM: a transport that cannot take a region says so instead of faking it', async () => {
    //: "If window targeting is impossible on a particular transport, return
    // a truthful capability limitation. Do NOT silently substitute
    // whole-desktop OCR."
    const computer = require('../../src/computer');
    let captured = 0;
    const app = { desktop: () => ({ bridge: { call: async () => { captured += 1; return { ok: true, result: { path: 'all.png' } }; } } }) };
    const r = await computer.perform(app, 'screenshot', {}, { window: 'RuneScape' });
    assert.strictEqual(r.stage, require('../../src/capability').STAGE.NO_TARGET);
    assert.strictEqual(captured, 0, 'a whole-desktop capture must not be returned under a window\'s name');
    assert.match(r.why, /no region parameter/);
    assert.match(r.why, /omitting `window`/, 'and it says how to ask for the whole screen deliberately');
  });

  await test('AIM: an UNAIMED read is still allowed — the whole screen is a valid question', async () => {
    // No window named means no region — deliberately. The whole screen is a
    // valid question, and the refusal above is only for a window that was
    // NAMED and could not be found. (This used to ride the Probe dialect's OCR,
    // which could read text; the bridge carries screenshots, so the unaimed
    // read it can actually perform is a capture with no region.)
    const computer = require('../../src/computer');
    let asked = 'nothing';
    const app = { desktop: () => ({ bridge: { call: async (op, params) => {
      asked = params; return { ok: true, result: { path: 'all.png' } };
    } } }) };
    const r = await computer.perform(app, 'screenshot', {}, {});
    assert.strictEqual(r.stage, require('../../src/capability').STAGE.SUCCEEDED);
    assert.deepStrictEqual(asked, {}, 'no window named means no region — that is the whole screen, on purpose');
  });

  await test('EVIDENCE: the five sources stay five, so none can be ranked before comparing', () => {
    // "Memory correlation is the stronger evidence anyway" was said mid-run,
    // before anything had been compared, and the visual channel was abandoned
    // on the strength of it. Sources are recorded separately so that a ranking
    // is a CONCLUSION rather than a preference.
    const obs = new observe.Observation({ rules: [] });
    obs.startedAt = Date.now();
    obs.note(observe.SOURCE.LOG, 'ROUND_COMPLETE', 'the bot said so');
    obs.note(observe.SOURCE.MEMORY, 'STATE', 'flag=0 in memory');
    obs.note(observe.SOURCE.PROCESS, 'ALIVE', 'pid 4321');
    obs.note(observe.SOURCE.USER, 'SAW', 'I saw the indicator');
    obs.addCapture({ rule: 'x', kind: 'screenshot', path: 'a.png', text: 'indicator visible' });
    for (const s of ['LOG', 'MEMORY', 'PROCESS', 'USER', 'VISUAL']) {
      assert.strictEqual(obs.from(observe.SOURCE[s]).length, 1, `${s} must be its own record`);
    }
  });

  await test('HELD KEYS: a key down is registered so something can lift it later', () => {
    heldKeys.reset();
    let lifted = 0;
    heldKeys.down('W', () => { lifted += 1; }, 'holding W in the game');
    assert.deepStrictEqual(heldKeys.list().map((h) => h.key), ['W']);
    assert.match(heldKeys.warnIfStillHeld(), /W still held/);
    return heldKeys.releaseAll('test').then((r) => {
      assert.deepStrictEqual(r.released, ['W']);
      assert.strictEqual(lifted, 1);
      assert.deepStrictEqual(heldKeys.list(), [], 'and it is no longer held');
      assert.strictEqual(heldKeys.warnIfStillHeld(), '', 'so there is nothing to warn about');
    });
  });

  await test('HELD KEYS: one key that will not lift does not strand the others', async () => {
    heldKeys.reset();
    heldKeys.down('A', () => { throw new Error('transport gone'); });
    heldKeys.down('B', () => {});
    const r = await heldKeys.releaseAll('test');
    assert.deepStrictEqual(r.released, ['B'], 'B came up even though A threw');
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].key, 'A');
    heldKeys.reset();
  });
};
