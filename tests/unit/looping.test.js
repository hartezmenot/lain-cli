'use strict';

/**
 * THE LOOP ADVISORY — shown to the user, never sent to the model.
 *
 * The behaviour being pinned, in the user's words: it shows the question, it
 * "never stop or wait the LLM", and "if it ever done doing that stuff the mcq
 * hide itself and not asking the question until the LLM run the same hard
 * issues again".
 *
 * Three properties, and each of them is a thing the old mechanism got wrong:
 *   RAISES   past a threshold, naming what is repeating
 *   RETRACTS by itself when the model does something new
 *   RE-ARMS  when the same loop starts again
 *
 * The keyboard half is proved through the real binary in the smoke tier; this
 * is the policy, which is pure and therefore provable without a terminal.
 */

const assert = require('assert');
const { test } = require('../helpers');
const looping = require('../../src/looping');
const { Lifecycle } = require('../../src/lifecycle');
const { KIND, InteractionPanel } = require('../../src/ui/panel');

/** Feed one tool observation and ask what the user should see. */
function step(life, call) {
  const v = life.observeTool(call);
  return { v, say: looping.verdict(v, life.quiet, v.key) };
}

const A = { name: 'read_file', input: { path: 'a.js' }, output: 'SAME' };
const B = { name: 'read_file', input: { path: 'b.js' }, output: 'DIFFERENT' };

module.exports = async function () {
  await test('LOOP: silent until it is actually a loop, then it names what is repeating', () => {
    const life = new Lifecycle('investigate');
    assert.strictEqual(step(life, A).say.show, false, 'one call is not a loop');
    assert.strictEqual(step(life, A).say.show, false, 'nor is two');
    const third = step(life, A);
    assert.strictEqual(third.say.show, true, 'three identical results is worth saying');
    assert.strictEqual(third.say.count, 3, 'and it says how many, not just that it happened');
  });

  await test('LOOP: it RETRACTS ITSELF the moment the model does something new', () => {
    // The user's requirement, exactly: "if it ever done doing that stuff the
    // mcq hide itself". Nobody should have to dismiss a warning about a
    // problem that has already resolved.
    const life = new Lifecycle('investigate');
    step(life, A); step(life, A);
    assert.strictEqual(step(life, A).say.show, true);
    assert.strictEqual(step(life, B).say.show, false, 'a new observation ends the condition');
  });

  await test('LOOP: it RE-ARMS when the same loop starts again', () => {
    const life = new Lifecycle('investigate');
    step(life, A); step(life, A); step(life, A);
    step(life, B);                                  // escaped — advisory clears
    const back = step(life, A);
    assert.strictEqual(back.say.show, true, 'the loop resumed, so the advisory comes back');
    assert.strictEqual(back.say.count, 4);
  });

  await test('LOOP: "let it run" silences THAT loop and nothing else', () => {
    // A dismissal that silences everything is a dismissal you regret once. It
    // is scoped to the fingerprint — this call, these arguments, this result.
    const life = new Lifecycle('investigate');
    step(life, A); step(life, A);
    const hit = step(life, A);
    assert.strictEqual(hit.say.show, true);
    life.letRun(hit.v.key);
    assert.strictEqual(step(life, A).say.show, false, 'the user already ruled on this one');

    const C = { name: 'run_bash', input: { command: 'npm test' }, output: 'FAIL' };
    step(life, C); step(life, C);
    assert.strictEqual(step(life, C).say.show, true, 'a DIFFERENT loop is still reported');
  });

  await test('LOOP: a correction un-silences it — that decision was about the old situation', () => {
    const life = new Lifecycle('investigate');
    step(life, A); step(life, A);
    life.letRun(step(life, A).v.key);
    life.noteUserInput();                           // the user steered
    step(life, A); step(life, A);
    assert.strictEqual(step(life, A).say.show, true,
      'still looping AFTER a correction is news, not the thing that was waved through');
  });

  await test('LOOP: a call that CHANGES something is never a loop, however often it repeats', () => {
    // `npm install` run three times with identical output did three real
    // things. Motion that alters the world is progress by definition.
    const life = new Lifecycle('build');
    const W = { name: 'write_file', input: { path: 'a.js' }, output: 'wrote', mutated: ['/tmp/a.js'] };
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(step(life, W).say.show, false, `mutation ${i + 1} must not be flagged`);
    }
  });

  await test('LOOP: NOTHING is composed for the model, and the task is never stopped', () => {
    // The two defects being removed, asserted directly rather than inferred.
    const life = new Lifecycle('investigate');
    let last = null;
    for (let i = 0; i < 8; i++) last = step(life, A);
    assert.ok(!('nudge' in last.v), 'no sentence addressed to the model');
    assert.ok(!('blocked' in last.v), 'and no verdict that the task should stop');
    assert.strictEqual(life.state, 'ACTIVE', 'eight identical reads is odd, not fatal');
    assert.strictEqual(last.say.show, true, 'it is still being reported, to the person');
  });

  await test('LOOP: the panel it raises is ADVISORY, and advisory means "takes no keys while typing"', () => {
    const panel = new InteractionPanel();
    panel.open(looping.adapter({ name: 'read_file', target: 'a.js', count: 3 }, {}));
    assert.strictEqual(panel.kind, KIND.ADVISORY);
    assert.strictEqual(panel.isAdvisory, true, 'the key router and the input reader both check this');
    assert.strictEqual(panel.isPassive, true, 'nothing is awaiting an answer behind it');
    assert.strictEqual(panel.acceptsTyped, false, 'so typing is not an answer to it');
    assert.ok(panel.current, 'a row IS selectable — Up/Down/Enter on an empty line resolve it');
    assert.strictEqual(panel.current.value, 'LET', 'opened on the first real choice, not the heading');
  });

  await test('LOOP: Up/Down move the highlight and Enter does what the footer says, and only that', () => {
    const did = [];
    const panel = new InteractionPanel();
    const acts = {
      onLet: () => did.push('let'), onSay: () => did.push('say'), onStop: () => did.push('stop'),
    };
    panel.open(looping.adapter({ name: 'read_file', target: 'a.js', count: 3 }, acts));
    assert.strictEqual(panel.current.value, 'LET');
    panel.select({ key: 'enter' });
    assert.strictEqual(panel.visible, false, 'resolving it closes it');

    panel.open(looping.adapter({ name: 'read_file', target: 'a.js', count: 3 }, acts));
    panel.move(1, 10);
    assert.strictEqual(panel.current.value, 'SAY', 'Down moves to the next real choice');
    panel.select({ key: 'enter' });

    panel.open(looping.adapter({ name: 'read_file', target: 'a.js', count: 3 }, acts));
    panel.move(1, 10); panel.move(1, 10);
    assert.strictEqual(panel.current.value, 'STOP');
    panel.select({ key: 'enter' });

    assert.deepStrictEqual(did, ['let', 'say', 'stop']);
  });

  await test('LOOP: Up/Down/Enter stand down the moment you start typing', () => {
    // The advisory's own advice is "say something", so a version that stole
    // Up/Down/Enter out of composing a correction would be sabotaging the one
    // action it recommends. They are live only on an EMPTY line; from the
    // first character typed, the keyboard is unambiguously the user's.
    const { UI } = require('../../src/ui');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    const ui = new UI(app);
    ui.enabled = true;
    ui.refresh = () => {};                       // no terminal here; state still moves
    let letRun = 0;
    const raise = () => ui.panel.open(looping.adapter(
      { name: 'read_file', target: 'a.js', count: 3 }, { onLet: () => { letRun += 1; } }));

    app.input = { line: '' };
    raise();
    assert.strictEqual(ui.handleKey('enter'), true, 'on an empty line, Enter is what the footer promises');
    assert.strictEqual(letRun, 1);

    app.input = { line: 'look at the other file' };
    raise();
    assert.strictEqual(ui.handleKey('up'), false, 'mid-sentence, Up belongs to the input, not the advisory');
    assert.strictEqual(ui.handleKey('enter'), false, 'so does Enter — it must send what was typed');
    assert.strictEqual(letRun, 1, 'and nothing was triggered behind the typing');
    assert.strictEqual(ui.panel.visible, true, 'the advisory is still there, unbothered');
  });

  await test('LOOP: it never claims LAIN is waiting on you, because LAIN is not', () => {
    // The status header is the line a person acts on. An advisory raised over a
    // running turn must not turn it into WAITING FOR YOU — that is the DONE-
    // over-unfinished-work untruth in the other direction.
    const { UI } = require('../../src/ui');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    const ui = new UI(app);
    ui.panel.open(looping.adapter({ name: 'read_file', target: 'a.js', count: 3 }, {}));
    assert.strictEqual(ui.panel.isPassive, true, 'nothing is awaiting an answer');
    const { statusOf } = require('../../src/ui/views');
    const state = statusOf({ busy: true, awaitingUser: ui.panel.visible && !ui.panel.isPassive });
    assert.notStrictEqual(state, 'NEEDS_USER', 'the turn is running, and the header must say so');
  });

  await test('LOOP: with no screen it is ONE line, and it is an observation', () => {
    const said = looping.line({ name: 'run_bash', target: 'npm test', count: 4 });
    assert.match(said, /looping/, 'labelled, so it is not mistaken for the model speaking');
    assert.match(said, /npm test/, 'and it names what is repeating');
    assert.match(said, /4/);
    assert.ok(!/you must|should|do not|stop /i.test(said), 'it reports; it does not instruct');
  });
};
