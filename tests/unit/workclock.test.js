'use strict';

/**
 * ONE TRUTHFUL WORK CLOCK — the properties that make an elapsed figure mean
 * something, each asserted against the thing that would otherwise make it lie.
 *
 * A clock on a screen is trusted the moment it appears, and a clock that counted
 * four minutes of provider backoff as four minutes of work would be believed
 * about that too. So these are not really about arithmetic: they are about the
 * clock agreeing with what the rest of the screen says is happening.
 */

const assert = require('assert');
const { test } = require('../helpers');

const wc = require('../../src/ui/workclock');
const status = require('../../src/ui/status');
const termtitle = require('../../src/termtitle');
const { PHASE } = require('../../src/turn');

/** A clock started at t=0, for readable arithmetic. */
const started = () => { const c = wc.create(); wc.start(c, 0); return c; };

module.exports = async function () {
  // ------------------------------------------------------------ the shape --

  await test('CLOCK: it is HH:MM:SS, always, with leading zeroes', () => {
    assert.strictEqual(wc.hhmmss(0), '00:00:00');
    assert.strictEqual(wc.hhmmss(4000), '00:00:04');
    assert.strictEqual(wc.hhmmss(451000), '00:07:31');
    assert.strictEqual(wc.hhmmss(4449000), '01:14:09');
    // PAST A DAY IT KEEPS COUNTING HOURS. Rolling over would be a false reading
    // on the second day of a long run.
    assert.strictEqual(wc.hhmmss(26 * 3600 * 1000), '26:00:00');
    // A SHAPE THAT NEVER CHANGES WIDTH, so the column beside a spinner cannot
    // twitch at four frames a second.
    for (const ms of [0, 1000, 61000, 3601000]) assert.strictEqual(wc.hhmmss(ms).length, 8);
  });

  await test('CLOCK: nothing is shown until a turn has actually started', () => {
    const fresh = wc.create();
    assert.strictEqual(wc.reading(fresh, 9999).shown, false,
      'an idle prompt must not carry 00:00:00 beside it');
    assert.strictEqual(wc.reading(started(), 1000).shown, true);
  });

  // ------------------------------------------------------- start and stop --

  await test('CLOCK: it starts when the user submits, and only then', () => {
    const turnstate = require('../../src/ui/turnstate');
    const ui = {
      clock: wc.create(),
      story: { beginTurn() {}, endTurn() {} },
      liveOutput: null,
      app: { session: { turns: [] } },
      refresh() {},
      op: { text: 'Copied 2 lines', at: Date.now() },
    };
    turnstate.beginTurn(ui);
    assert.strictEqual(ui.clock.state, wc.STATE.RUNNING, 'Enter starts it');
    // AND THE TRANSIENT OPERATION ROW IS HANDED BACK TO THE WORK.
    assert.strictEqual(ui.op, null, 'a stale operation note does not outlive the turn it preceded');
  });

  await test('CLOCK: a second submission is a second task and starts from zero', () => {
    const c = started();
    wc.settle(c, 60000);
    assert.strictEqual(wc.reading(c, 60000).text, '00:01:00');
    wc.start(c, 60000);
    assert.strictEqual(wc.reading(c, 60000).text, '00:00:00',
      'a task inheriting the previous one would report somebody else of wait');
  });

  await test('CLOCK: a stopped clock KEEPS its figure — the receipt is the point', () => {
    const c = started();
    wc.settle(c, 728000);
    assert.strictEqual(wc.reading(c, 728000).text, '00:12:08');
    // And it does not keep counting afterwards.
    assert.strictEqual(wc.reading(c, 9999999).text, '00:12:08');
  });

  // ------------------------------------------ it does not reset mid-task --

  await test('CLOCK: reads, writes, tests and retries do NOT restart it', () => {
    // THE DEFECT THIS REPLACED: the row carried `phaseSince` as `12s`, so every
    // phase change started again at zero and the screen never once said how long
    // the person had been waiting. One submission is one clock.
    const c = started();
    const phases = [
      { phase: PHASE.WAITING_MODEL },
      { phase: PHASE.RECEIVING },
      { phase: PHASE.RUNNING_TOOL, tool: 'read_file', target: 'a.js' },
      { phase: PHASE.RUNNING_TOOL, tool: 'edit_file', target: 'a.js' },
      { phase: PHASE.RUNNING_TOOL, tool: 'run_bash', target: 'npm test' },
      { phase: PHASE.WAITING_MODEL },
    ];
    let t = 0;
    for (const phase of phases) {
      t += 30000;
      // Each phase is freshly entered — `phaseSince` is NOW — which is exactly
      // the condition under which the old per-phase figure read zero.
      wc.apply(c, termtitle.stateOf(status.liveState({ phase, phaseSince: t }, t)), t);
      assert.strictEqual(c.state, wc.STATE.RUNNING, 'still running through ' + phase.phase);
    }
    assert.strictEqual(wc.reading(c, t).text, '00:03:00',
      'six phases over three minutes is three minutes, not six fresh counters');
  });

  // ------------------------------------------------- pausing and resuming --

  await test('CLOCK: a rate limit PAUSES it, and the figure is held', () => {
    const c = started();
    const limited = { waitingUntil: 600000, waitingLabel: 'the provider is rate limited' };
    // Six minutes seventeen of real work, then the provider refuses.
    wc.apply(c, termtitle.stateOf(status.liveState({ phase: { phase: PHASE.RECEIVING }, phaseSince: 0 }, 377000)), 377000);
    assert.strictEqual(wc.reading(c, 377000).text, '00:06:17');
    const paused = termtitle.stateOf(status.liveState(limited, 377000));
    assert.strictEqual(paused, termtitle.STATE.PAUSED, 'a rate limit is not work');
    wc.apply(c, paused, 377000);
    // Thirty seconds pass with the provider still refusing.
    wc.apply(c, termtitle.stateOf(status.liveState(limited, 407000)), 407000);
    assert.strictEqual(wc.reading(c, 407000).text, '00:06:17',
      'rate-limit downtime is not active work time');
    assert.strictEqual(wc.reading(c, 407000).paused, true);
  });

  await test('CLOCK: when the provider comes back it RESUMES, it does not restart', () => {
    const c = started();
    wc.pause(c, 377000);
    // The provider answers again at t=407s; one second of real work follows.
    const live = status.liveState({ phase: { phase: PHASE.RECEIVING }, phaseSince: 407000 }, 407000);
    wc.apply(c, termtitle.stateOf(live), 407000);
    assert.strictEqual(c.state, wc.STATE.RUNNING);
    assert.strictEqual(wc.reading(c, 408000).text, '00:06:18',
      'one more second of work on top of the banked six minutes seventeen');
  });

  await test('CLOCK: every state that cannot progress pauses it', () => {
    // Read off `liveState` rather than listed here, so a new waiting state that
    // forgets to pause the clock is caught by the same table that names it.
    const cases = [
      ['rate limited', { waitingUntil: 9e12, waitingLabel: 'limit' }],
      ['interrupted', { interrupted: true }],
      ['waiting on a person', { awaitingUser: 'which file did you mean?' }],
      ['stopped retrying', { retryCancelled: true }],
    ];
    for (const [why, state] of cases) {
      const c = started();
      wc.apply(c, termtitle.stateOf(status.liveState(state, 1000)), 1000);
      assert.strictEqual(c.state, wc.STATE.PAUSED, why + ' must pause the clock');
    }
  });

  await test('CLOCK: IDLE does not stop a running clock', () => {
    // THE FLICKER DEFENCE. There is a real gap between Enter and the turn loop
    // announcing its first phase, and `liveState` has nothing to say during it.
    // Treating that as "the task ended" would stop the clock one frame after
    // starting it, on every single turn.
    const c = started();
    wc.apply(c, termtitle.stateOf(status.liveState({}, 500)), 500);
    assert.strictEqual(c.state, wc.STATE.RUNNING, 'an unannounced moment is not an ending');
    assert.strictEqual(wc.reading(c, 500).text, '00:00:00');
  });

  // ---------------------------------------------- stopping for real only --

  await test('CLOCK: it stops on a settled verdict, not on a quiet moment', () => {
    const done = { lastTurn: { toolCalls: 3, filesChanged: 1, stopReason: null } };
    const settled = termtitle.stateOf(status.liveState(done, 1000));
    assert.ok(settled === termtitle.STATE.SUCCESS || settled === termtitle.STATE.ERROR,
      'a finished turn is terminal, not idle: got ' + settled);
    const c = started();
    wc.apply(c, settled, 120000);
    assert.strictEqual(c.state, wc.STATE.STOPPED);
    assert.strictEqual(wc.reading(c, 999999).text, '00:02:00', 'and it keeps what it measured');
  });

  await test('CLOCK: the turn lifecycle ending stops it too', () => {
    const turnstate = require('../../src/ui/turnstate');
    const ui = {
      clock: started(),
      story: { beginTurn() {}, endTurn() {} },
      liveOutput: null,
      liveUsage: {},
      app: { session: { turns: [] } },
      refresh() {},
    };
    turnstate.endTurn(ui);
    assert.strictEqual(ui.clock.state, wc.STATE.STOPPED);
  });

  // ------------------------------------------------------------ the screen --

  await test('CLOCK: the live row draws it, and the per-phase age is gone', () => {
    const row = status.statusStrip({
      phase: { phase: PHASE.RECEIVING },
      phaseSince: 1,
      clock: wc.reading(started(), 451000),
    }, 80, 1, 452000).join('');
    assert.match(row, /00:07:31/, 'the task clock is on the live row');
    assert.ok(!/ \d+s(\s|$)/.test(row), 'no per-phase seconds figure survives: ' + row);
  });

  await test('CLOCK: it cannot be advanced by drawing', () => {
    // The redraw rate must not be able to change what the clock says — which is
    // the same property the spinner has, for the same reason.
    const c = started();
    const of = () => status.statusStrip({
      phase: { phase: PHASE.RECEIVING }, phaseSince: 0, clock: wc.reading(c, 5000),
    }, 80, 1, 5000);
    assert.deepStrictEqual(of(), of());
  });

  await test('CLOCK: there is ONE elapsed vocabulary — /bg spells it the same way', () => {
    // A background job's duration read `3m18s` while the foreground read
    // `HH:MM:SS`. Two formats for one idea on one screen is a conversion a person
    // should not have to do, so `/bg` imports the same function rather than
    // owning a second one.
    const jobs = require('../../src/jobcommands');
    assert.strictEqual(jobs.elapsedOf(198000), wc.hhmmss(198000));
    assert.strictEqual(jobs.elapsedOf(198000), '00:03:18');
    // AND THE BACKGROUND REGION, which was the THIRD copy of the same function.
    // Found by reading a real frame: the live row said `00:00:02`, `/bg` said
    // `3m18s`, and this region said `0s`.
    const region = require('../../src/ui/jobsview').draw({
      jobs: [{ id: 2, state: 'RUNNING', request: 'run the integration suite', elapsedMs: 198000, primary: false }],
    }, 100, 2).join(' ');
    assert.match(require('../../src/ui/text').strip(region), /00:03:18/,
      'the background region spells elapsed time the same way');
  });

  await test('CLOCK: no module declares a second duration formatter', () => {
    // Three copies of `s < 60 ? s+'s' : …` existed, one per surface. They are one
    // import now, which is what stops them drifting apart again.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src');
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (p.endsWith(path.join('ui', 'workclock.js'))) continue;
        const text = fs.readFileSync(p, 'utf8');
        // The shape all three copies had: minutes and seconds glued together.
        if (/\$\{Math\.floor\(s \/ 60\)\}m\$\{String\(s % 60\)/.test(text)) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepStrictEqual(hits, [], 'a second duration formatter came back: ' + hits.join(', '));
  });

  await test('CLOCK: exactly ONE module advances it', () => {
    // A second caller of `apply` would be a second opinion about whether LAIN is
    // working, and the whole point is that the clock and the window title read
    // one classification of one state.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src');
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        // Both spellings: a held reference, and the inline `require(…).apply(`
        // this tree actually uses.
        const text = fs.readFileSync(p, 'utf8');
        if (/workclock\.apply\(/.test(text) || /workclock'\)\.apply\(/.test(text)) {
          hits.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    assert.deepStrictEqual(hits, [path.join('ui', 'projection.js')],
      'only the one peripheral projection may advance the clock: ' + hits.join(', '));
  });
};
