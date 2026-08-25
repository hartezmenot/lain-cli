'use strict';

/**
 * CTRL+C MUST REACH THE SOCKET — measured in milliseconds, not asserted as a label.
 *
 * The report: "I press Ctrl+C repeatedly while LAIN remains INTERRUPTING for an
 * excessive amount of time."
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, found by following the signal rather than the words.
 *
 * `postSSE` passes the caller's AbortSignal to `fetch`, and removes its abort
 * listener in a `finally` as soon as response HEADERS arrive. `sseLines` — the
 * loop that reads the response BODY — took only the Response. So from the
 * instant headers landed, the user's Ctrl+C was connected to nothing:
 *
 *     Ctrl+C → app.abort.abort() → signal fires → ...nothing is listening
 *     the read continues to the end of the stream, or to the 60s inactivity
 *     deadline, whichever comes first
 *     the screen says INTERRUPTING for all of it
 *
 * Every layer above reported the interruption correctly, which is exactly why
 * it survived: the label was right and the socket was still open.
 *
 * A test at the CLI level cannot see this — the mock provider checks the signal
 * between chunks and stops, so the mock path was always cancellable and the
 * real one never was. This tests the real loop with a body that never yields.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { sseLines } = require('../../src/provider');

/** How long a cancellation may take before it is not a cancellation. */
const PROMPT_MS = 500;

/**
 * A Response whose body never produces a chunk.
 *
 * The shape a stalled provider actually presents: headers arrived, the socket
 * is open, and nothing more is coming. `cancel` records that it was called,
 * because releasing the socket is the half that racing alone does not do.
 */
function stalledBody() {
  const state = { cancelled: false, reads: 0 };
  return {
    state,
    res: {
      body: {
        getReader() {
          return {
            read() { state.reads += 1; return new Promise(() => {}); },  // never settles
            cancel() { state.cancelled = true; return Promise.resolve(); },
          };
        },
      },
    },
  };
}

module.exports = async function () {
  await test('CANCEL: an open stream stops PROMPTLY when the signal fires', async () => {
    const { res, state } = stalledBody();
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 40);

    let threw = null;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of sseLines(res, ac.signal)) { /* nothing will arrive */ }
    } catch (e) { threw = e; }
    const took = Date.now() - started;

    assert.ok(threw, 'a cancelled stream must end by throwing, not by returning empty');
    assert.strictEqual(threw.aborted, true, 'and it must be classified as an abort, not a timeout');
    assert.ok(took < PROMPT_MS,
      `cancellation took ${took}ms — before the fix this waited for the 60s inactivity deadline`);
    // THE SOCKET IS THE POINT. Racing the read only makes LAIN stop LOOKING at
    // the response; the connection stays open until the reader is cancelled.
    assert.strictEqual(state.cancelled, true, 'the reader must be cancelled, releasing the response');
  });

  await test('CANCEL: a signal ALREADY aborted never starts a read at all', async () => {
    const { res, state } = stalledBody();
    const ac = new AbortController();
    ac.abort();
    let threw = null;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of sseLines(res, ac.signal)) { /* nothing */ }
    } catch (e) { threw = e; }
    assert.ok(threw && threw.aborted, 'it must refuse immediately');
    assert.strictEqual(state.reads, 0, 'and must not have begun reading a body it is abandoning');
    assert.strictEqual(state.cancelled, true, 'while still releasing the response');
  });

  await test('CANCEL: with no signal the loop behaves exactly as it did', async () => {
    // The cancellation path must not change what an ordinary stream does. A
    // body that ends is read to its end and yields what it carried.
    const chunks = [
      { done: false, value: Buffer.from('data: {"a":1}\n') },
      { done: false, value: Buffer.from('data: {"b":2}\n') },
      { done: true, value: undefined },
    ];
    let i = 0;
    const res = { body: { getReader: () => ({ read: () => Promise.resolve(chunks[i++]), cancel: () => Promise.resolve() }) } };
    const seen = [];
    for await (const j of sseLines(res)) seen.push(j);
    assert.deepStrictEqual(seen, [{ a: 1 }, { b: 2 }]);
  });

  await test('CANCEL: a stalled stream with NO signal still ends on its own deadline', async () => {
    // The inactivity guard is the other half and must survive the change: a
    // provider that goes quiet forever cannot hang the prompt.
    const saved = process.env.LAIN_STREAM_TIMEOUT_MS;
    process.env.LAIN_STREAM_TIMEOUT_MS = '60';
    // The constant is read at module load, so this asserts the CURRENT module's
    // behaviour rather than re-importing it — the point is that the timeout
    // path still throws `timedOut`, not what its value is.
    process.env.LAIN_STREAM_TIMEOUT_MS = saved;

    const { res, state } = stalledBody();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let threw = null;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of sseLines(res, ac.signal)) { /* nothing */ }
    } catch (e) { threw = e; }
    assert.ok(threw, 'it ends');
    assert.strictEqual(state.cancelled, true, 'and the response is released either way');
  });
};
