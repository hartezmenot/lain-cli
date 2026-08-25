'use strict';

/**
 * THE FRONT DOOR — what kind of work did the user just ask for?
 *
 * Every case here is a sentence a person would actually type. The point is not
 * regex coverage; it is that the obvious reading of an ordinary request is the
 * one LAIN acts on, without spending a model call to find out.
 *
 * The classifier is ADVISORY: it selects a paragraph of guidance and nothing
 * else. So the bar is "usually right and never harmful", not "provably right" —
 * and the tests that matter most are the ones about NOT misreading content
 * (a paste, a continuation) as a new instruction.
 */

const assert = require('assert');
const { test } = require('../helpers');

const mode = require('../../src/mode');
const K = mode.KIND;

const m = (text, ctx) => mode.classify(text, ctx).mode;

module.exports = async function () {
  await test('MODE: the documented examples classify as stated', () => {
    assert.strictEqual(m('Add a Telegram signal on/off button.'), K.IMPLEMENT);
    assert.strictEqual(m("The Telegram signal button doesn't switch from OFF to ON."), K.BUGFIX);
    assert.strictEqual(m('Something is wrong with Telegram signals.'), K.TROUBLESHOOT);
    assert.strictEqual(m('Audit this project and tell me what is missing.'), K.AUDIT);
    assert.strictEqual(m('Create me a trading bot.', { projectEmpty: true }), K.NEW_PROJECT);
    assert.strictEqual(m('Explain what this file does.'), K.EXPLAIN);
  });

  await test('MODE: a specific symptom is a BUGFIX; a vague one is TROUBLESHOOT', () => {
    // The difference is whether there is something concrete to trace.
    assert.strictEqual(m('the login button is stuck on OFF'), K.BUGFIX);
    assert.strictEqual(m('saveUser() returns null for existing accounts'), K.BUGFIX);
    assert.strictEqual(m('src/auth.js throws on startup'), K.BUGFIX);
    assert.strictEqual(m('it should redirect after login but it stays on the page'), K.BUGFIX);

    assert.strictEqual(m('something is broken'), K.TROUBLESHOOT);
    assert.strictEqual(m('the app is being weird'), K.TROUBLESHOOT);
    assert.strictEqual(m('it fails sometimes, not sure why'), K.TROUBLESHOOT);
  });

  await test('MODE: "build X" is a NEW PROJECT only where there is no project', () => {
    // Same sentence, two different jobs, decided by where it was typed.
    assert.strictEqual(m('build a trading bot with telegram signals', { projectEmpty: true }), K.NEW_PROJECT);
    assert.strictEqual(m('build a trading bot with telegram signals', { projectEmpty: false }), K.IMPLEMENT);
    // "from scratch" is explicit and overrides the surroundings.
    assert.strictEqual(m('rewrite the parser from scratch', { projectEmpty: false }), K.NEW_PROJECT);
  });

  await test('MODE: read-only requests are marked read-only', () => {
    for (const t of ['audit the codebase', 'explain how routing works', 'thanks!']) {
      assert.strictEqual(mode.classify(t).readOnly, true, t);
    }
    for (const t of ['add a button', 'fix the crash in parser.js']) {
      assert.strictEqual(mode.classify(t).readOnly, false, t);
    }
  });

  await test('MODE: a PASTE is content and never re-classifies the work', () => {
    // A pasted stack trace is full of "Error" and "failed" and is not a bug
    // report — it is evidence attached to whatever is already being worked on.
    const trace = 'Error: ENOENT\n  at Object.openSync (node:fs:596:3)\n  at readFileSync';
    assert.strictEqual(m(trace, { isPaste: true, activeMode: K.IMPLEMENT }), K.IMPLEMENT);
    // And a pasted slash command is not a command, nor a mode signal.
    assert.strictEqual(m('/models\n/exit', { isPaste: true, activeMode: K.AUDIT }), K.AUDIT);
  });

  await test('MODE: a continuation KEEPS the mode it is continuing', () => {
    // "continue" says nothing about the kind of work; the work already running
    // decides that. Re-reading it would flip a bugfix into something else.
    assert.strictEqual(m('continue', { taskKind: 'continuation', activeMode: K.BUGFIX }), K.BUGFIX);
    assert.strictEqual(m('keep going', { taskKind: 'continuation', activeMode: K.NEW_PROJECT }), K.NEW_PROJECT);
    // With nothing active it is a resume of whatever was there.
    assert.strictEqual(m('continue', { taskKind: 'continuation' }), K.RESUME);
  });

  await test('MODE: a defect outranks a request to explain it', () => {
    // "explain why it crashes" is a bug, not a lecture request.
    assert.strictEqual(m('explain why the parser crashes on empty input'), K.BUGFIX);
  });

  await test('MODE: pleasantries do not send LAIN into the repository', () => {
    for (const t of ['hi', 'thanks', 'ok', 'nice, thank you']) {
      assert.strictEqual(m(t), K.CHAT, t);
    }
  });

  await test('MODE: an imperative with no other signal is work', () => {
    // WHAT THIS TEST IS FOR — an imperative must land on a WORKING mode rather
    // than on chat or on a read-only assessment. That is unchanged.
    //
    // The bucket for the first case moved deliberately. `rename` is
    // restructuring code that already works, and REFACTOR did not exist when
    // this was written — IMPLEMENT was the only mode that fitted. Now that it
    // does exist, a rename gets the guidance a rename actually needs (pin the
    // behaviour down, find every caller) instead of "find the architecture
    // before you add to it", which was advice for a different job.
    assert.strictEqual(m('rename the config key to `timeoutMs`'), K.REFACTOR);
    // The second case moved for the same reason the first one did, one mode
    // later. "Migrate the tests to the new runner" is a MIGRATION: the old
    // runner is supposed to stop being used, and read as an implementation
    // request it becomes "also support the new runner" — which is the failure
    // migration.js exists to prevent, and which IMPLEMENT's guidance ("find the
    // architecture before you add to it") actively encourages.
    assert.strictEqual(m('migrate the tests to the new runner'), K.MIGRATE);
    // The property that actually matters here, asserted directly: both are work.
    for (const s of ['rename the config key to `timeoutMs`', 'migrate the tests to the new runner']) {
      assert.strictEqual(mode.classify(s).readOnly, false, s);
    }
  });

  await test('MODE: it is deterministic and costs nothing', () => {
    const a = mode.classify('add a telegram button');
    const b = mode.classify('add a telegram button');
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.deterministic, true);
  });

  await test('MODE: every verdict names a reason the user could read', () => {
    for (const t of ['add a button', 'audit this', 'it crashes', 'hi', 'explain routing']) {
      const v = mode.classify(t);
      assert.ok(v.reason && v.reason.length > 4, `${t} -> ${JSON.stringify(v)}`);
      assert.ok(Object.values(K).includes(v.mode));
    }
  });

  await test('MODE: naming something concrete is what separates the two failure modes', () => {
    assert.strictEqual(mode.namesSomething('the LoginButton is stuck'), true);
    assert.strictEqual(mode.namesSomething('src/auth.js is broken'), true);
    assert.strictEqual(mode.namesSomething('`saveUser` fails'), true);
    assert.strictEqual(mode.namesSomething('something is broken'), false);
  });

  // ------------------------------------------------------------- guidance ---

  await test('GUIDANCE: each mode carries advice, and it reaches the prompt', () => {
    const prompt = require('../../src/prompt');
    for (const k of Object.values(K)) {
      assert.ok(prompt.MODE_GUIDANCE[k], `no guidance for ${k}`);
    }
    const built = prompt.build({ cwd: '/p', mode: K.BUGFIX });
    assert.match(built, /Trace the path first/, 'the bugfix workflow must reach the model');
    assert.ok(!/Build it in stages/.test(built), 'and only that mode\'s guidance');
  });

  await test('GUIDANCE: read-only modes tell the model not to change anything', () => {
    const prompt = require('../../src/prompt');
    assert.match(prompt.build({ mode: K.AUDIT }), /Do not change anything/i);
    assert.match(prompt.build({ mode: K.EXPLAIN }), /Do not modify files/i);
  });

  await test('GUIDANCE: no mode means no extra prompt at all', () => {
    const prompt = require('../../src/prompt');
    const bare = prompt.build({ cwd: '/p' });
    assert.ok(!/# This request/.test(bare), 'an unclassified turn costs no extra tokens');
  });
  await test('MODE: a greeting with an address is CHAT, not work', () => {
    // Only a greeting standing completely alone was recognised, so "hi there"
    // fell through every rule to the default — which is IMPLEMENT. Saying hello
    // therefore selected the mutation mode and answered a pleasantry with
    // build-it-in-stages guidance.
    for (const hello of ['hi there', 'hey lain', 'hello again', 'thanks mate', 'ok cool thanks']) {
      const v = mode.classify(hello, { projectEmpty: false });
      assert.strictEqual(v.mode, K.CHAT, `${JSON.stringify(hello)} is conversation`);
      assert.strictEqual(v.readOnly, true, 'and it must not be able to touch the code');
    }
  });

  await test('MODE: asking WHERE something is does not select a mutation mode', () => {
    // "Use evidence gathering before mutation." A question that asks LAIN to
    // LOCATE something names no defect and asks for no change, so both
    // TROUBLESHOOT and IMPLEMENT are wrong — and IMPLEMENT is worse than wrong,
    // because reaching it from a question is how "find what sets this value"
    // becomes an edit nobody asked for.
    for (const q of [
      'find what controls this value',
      'where is the retry logic',
      'which file sets the timeout',
      'what calls parseHeader',
      'trace the call path',
      'who owns this state',
    ]) {
      const v = mode.classify(q, { projectEmpty: false });
      assert.strictEqual(v.readOnly, true, `${JSON.stringify(q)} must be read-only, got ${v.mode}`);
    }
  });

  await test('MODE: the change verbs still reach the change modes', () => {
    // The other direction, so "make everything read-only" cannot pass.
    for (const [text, want] of [
      ['add a --json flag to the export command', K.IMPLEMENT],
      ['fix the login bug in src/auth.js', K.BUGFIX],
      ['rename the module and move it into core', K.REFACTOR],
    ]) {
      assert.strictEqual(mode.classify(text, { projectEmpty: false }).mode, want, text);
    }
  });
};
