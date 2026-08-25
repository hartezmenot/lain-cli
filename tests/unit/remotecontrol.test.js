'use strict';

/**
 * REMOTE CONTROL, at the tier that needs no runtime.
 *
 * ------------------------------------------------------------------------
 * WHAT IS WORTH ASSERTING WITHOUT A SUPERVISOR, and what is not.
 *
 * The behaviour of remote control — pairing, authorization, dedupe, capability
 * validation, the model that invents a number — is proved against the REAL
 * binary in tests/integration/remote.test.js, because none of it is true unless
 * the process that implements it says so.
 *
 * What belongs here is the part that is true of the CODE rather than of the
 * runtime: that the credential cannot reach a prompt, that the command surface
 * is what it claims to be, that a local-only rule is actually local-only, and
 * that nothing in the Node half quietly grew a second implementation of
 * something the runtime owns.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  // ---- THE COMMAND SURFACE ------------------------------------------------

  await test('RC: /rc, /session, /ready and /dash are four things, none an alias', () => {
    const commands = require('../../src/commands');
    for (const name of ['/rc', '/session', '/ready', '/dash']) {
      assert.ok(commands.REGISTRY.has(name), `${name} must exist`);
    }
    const runs = ['/rc', '/session', '/ready', '/dash'].map((n) => commands.REGISTRY.get(n).run);
    assert.strictEqual(new Set(runs).size, 4, 'two of them share an implementation');
  });

  await test('RC: typing a complete command name runs THAT command, not a longer one', () => {
    // ---- A REAL COLLISION, FOUND BY DRIVING THE CLI ----------------------
    //
    // `/session` and `/sessions` are different commands about different
    // subjects — live runtime state, and saved transcripts. The palette listed
    // matches in registry order, so typing the whole of `/session` and pressing
    // Enter ran `/sessions`. The user had typed a complete, unambiguous name
    // and got something else.
    const { commandPaletteAdapter } = require('../../src/ui/adapters');
    const commands = [
      { name: '/sessions', args: '[text]', desc: 'saved sessions' },
      { name: '/session', args: '[n]', desc: 'runtime sessions' },
    ];
    const a = commandPaletteAdapter({ commands, filter: '/session' });
    assert.strictEqual(a.items[0].command, '/session', 'the exact match must be the default');
    // AND NOTHING ELSE MOVED. A partial prefix keeps the order it had.
    const partial = commandPaletteAdapter({ commands, filter: '/sess' });
    assert.deepStrictEqual(partial.items.map((i) => i.command), ['/sessions', '/session']);
  });

  await test('RC: /session and /rc are safe during a turn — both only read', () => {
    const commands = require('../../src/commands');
    // A command that could not run while work was running would be useless
    // precisely when it is wanted: a person checks on a session BECAUSE one is
    // busy. Neither may be BLOCKED.
    for (const name of ['/rc', '/session']) {
      const cmd = commands.REGISTRY.get(name);
      assert.notStrictEqual(cmd.duringTurn, commands.DURING_TURN.BLOCKED, `${name} must not block`);
    }
  });

  await test('RC: the token is asked for through the masked panel, never on a command line', () => {
    const { tokenAdapter } = require('../../src/rccommand');
    const a = tokenAdapter();
    // `secret: true` is read by ui/inputbox.js, which draws dots, and by
    // ui/index.js, which keeps the line out of ↑/↓ history. Without it the
    // credential is on screen and in the scrollback the moment it is typed.
    assert.strictEqual(a.secret, true, 'the token panel must be masked');
    assert.strictEqual(a.takes, 'TEXT');
    const words = JSON.stringify(a);
    assert.match(words, /masked/i, 'and it must SAY so — a person pasting a secret deserves to know');
    assert.match(words, /never written to history/i);
  });

  // ---- THE LOCAL-ONLY RULE ------------------------------------------------

  await test('RC: the remote voice must run on this machine, and the check is by host', () => {
    const { isLocal } = require('../../src/rccommand');
    for (const good of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
      assert.ok(isLocal(good), `${good} is local`);
    }
    // ---- THE ONES THAT MATTER ---------------------------------------------
    //
    // A message from a chat is untrusted text typed by whoever found the bot.
    // Sending it to a hosted API would forward a stranger's words to a third
    // party, and the user would have no way to notice. The lookalike hostnames
    // are the ones a naive `startsWith` check would let through.
    for (const bad of [
      'https://api.openai.com/v1',
      'http://localhost.evil.example/v1',
      'http://127.0.0.1.evil.example/v1',
      'http://not-localhost/v1',
      '',
      'garbage',
    ]) {
      assert.ok(!isLocal(bad), `${bad} must not pass as a local model`);
    }
  });

  await test('RC: the voice picker offers the local routes, the known runners, and a way out', () => {
    const { brainAdapter, LOCAL_DEFAULTS } = require('../../src/rccommand');
    const a = brainAdapter([{ label: 'lain:local   qwen', value: '{"baseUrl":"http://127.0.0.1:11434/v1"}' }]);
    // A PLAIN LIST, like `/api`'s provider picker — not the model screen, whose
    // Enter handler reaches for `item.model` and drills into routes.
    assert.strictEqual(a.kind, 'PROVIDER_SELECTION');
    const last = a.items[a.items.length - 1];
    // ---- SKIPPING MUST ALWAYS BE OFFERED ---------------------------------
    //
    // Remote control without a local model is a real configuration: every
    // command still works, only plain English does not. A picker with no way
    // out would make the voice mandatory, which it is not.
    assert.strictEqual(last.value, '__skip__');
    assert.match(last.label, /commands only/i);
    // The defaults are suggestions, and all of them are loopback.
    const { isLocal } = require('../../src/rccommand');
    for (const d of LOCAL_DEFAULTS) assert.ok(isLocal(d.baseUrl), `${d.baseUrl} must be local`);
  });

  // ---- NO SECOND IMPLEMENTATION -------------------------------------------

  await test('RC: the Node half computes no session state of its own', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // ---- THE VIEW MAY NOT DERIVE WHAT THE RUNTIME DECIDES -----------------
    //
    // §20: one runtime, several windows. A window that worked out for itself
    // whether a session was RUNNING would be a second authority, and on the day
    // the two disagreed there would be no way to say which was wrong. So the
    // terminal view is allowed to COLOUR the runtime's words and nothing else.
    const view = strip(fs.readFileSync(path.join(root, 'sessionview.js'), 'utf8'));
    for (const derived of ['owner_alive', 'in_flight', 'effective_state', 'turn_started_at', 'held_count']) {
      assert.ok(!view.includes(derived), `sessionview.js reads ${derived} — that is the runtime's job`);
    }
    // The client is a transport. It must not grow verbs of its own either.
    const client = strip(fs.readFileSync(path.join(root, 'remotecontrol.js'), 'utf8'));
    for (const f of ['getUpdates', 'sendMessage', 'api.telegram.org']) {
      assert.ok(!client.includes(f), `remotecontrol.js speaks ${f} — Telegram belongs to the runtime`);
    }
  });

  await test('RC: the terminal view colours the runtime words without rewriting them', () => {
    const { paint } = require('../../src/sessionview');
    const C = { cyan: (s) => `<c>${s}</c>`, green: (s) => `<g>${s}</g>`, yellow: (s) => `<y>${s}</y>`, dim: (s) => `<d>${s}</d>` };
    assert.strictEqual(paint('  RUNNING · 61%', C), '  <c>RUNNING</c> · 61%');
    // RATE_LIMITED must not be painted as if it contained LIMITED — a word
    // boundary, not a substring.
    assert.strictEqual(paint('  RATE_LIMITED', C), '  <y>RATE_LIMITED</y>');
    // A project genuinely called "Running Costs" is not a state word.
    assert.strictEqual(paint('+ 2. Running Costs', C), '+ 2. Running Costs');
    // Nothing is added, removed or reordered.
    const line = '  COMPLETED';
    assert.strictEqual(paint(line, C).replace(/<\/?[cgyd]>/g, ''), line);
  });

  // ---- THE WATCHER --------------------------------------------------------

  await test('RC: only input queued by a surface with no prompt is picked up', () => {
    const watch = require('../../src/remotewatch');
    assert.deepStrictEqual([...watch.REMOTE_KINDS].sort(), ['remote', 'telegram']);
    // A `user` hold is a sentence somebody typed AT THIS TERMINAL and is
    // recovered by the gateway when they press Enter again. Draining it from a
    // timer would run their words without them asking twice.
    assert.ok(!watch.REMOTE_KINDS.includes('user'));
    assert.ok(!watch.REMOTE_KINDS.includes('steer'));
  });

  await test('RC: a model name the runtime does not recognise changes nothing', () => {
    const watch = require('../../src/remotewatch');
    const notices = [];
    const app = {
      cfg: { model: 'before', connection: 'conn-before' },
      render: { notice: (kind, text) => notices.push(`${kind}: ${text}`) },
    };
    // `targetOf` refuses to invent a route from a word it does not know — which
    // matters most here, because the word arrived from a chat by way of a small
    // model that may have made it up.
    const changed = watch.applyModel(app, 'a-model-that-does-not-exist-anywhere');
    assert.strictEqual(changed, false);
    assert.strictEqual(app.cfg.model, 'before', 'the session was repointed on a guess');
    assert.strictEqual(app.cfg.connection, 'conn-before');
    assert.match(notices.join('\n'), /matches no model or connection/);
  });

  await test('RC: the watcher starts nothing until it is started, and stops cleanly', () => {
    const watch = require('../../src/remotewatch');
    const app = {};
    const t = watch.start(app);
    assert.ok(t, 'a timer was created');
    assert.strictEqual(watch.start(app), null, 'starting twice must not make two timers');
    watch.stop(app);
    assert.strictEqual(app._remoteWatch, null);
    // Held on the app, never at module scope: two sessions in one process must
    // not share a timer.
    assert.ok(!Object.prototype.hasOwnProperty.call(watch, '_timer'));
  });

  // ---- DEGRADING WITHOUT A RUNTIME ----------------------------------------

  await test('RC: with no runtime answering, everything reports absence rather than guessing', async () => {
    const rc = require('../../src/remotecontrol');
    assert.strictEqual(rc.ABSENT.available, false);
    assert.strictEqual(rc.ABSENT.configured, false);
    assert.strictEqual(Object.isFrozen(rc.ABSENT), true, 'a shared "nothing" must not be mutable');
    // The capability door answers with `available: false` rather than throwing,
    // which is what lets `/session` say "no runtime is answering" instead of
    // showing an empty table that reads as "nothing is happening".
    const out = await rc.capability('session.list');
    assert.strictEqual(typeof out.available, 'boolean');
    assert.strictEqual(typeof out.ok, 'boolean');
  });
};
