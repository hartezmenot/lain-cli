'use strict';

/**
 * NO HARD GLUE IN THE CONVERSATION.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS ON THE SCREEN. A turn that hit a flaky provider three times left this
 * behind, permanently, between the question and the answer:
 *
 *     WARN
 *     omniroute: 503 Service Unavailable — {"error":{"message": …
 *     retry 4/5 at 16:17:24 (6s) · Esc cancels the wait
 *
 *     NOTE
 *     the wait is over — resuming the task with everything it had
 *
 * Every field of the first was already on the live row, which draws it compactly
 * and replaces it when the wait ends. The second announced that a transient
 * condition had passed. Neither is a message, neither is actionable, and both
 * outlive their usefulness by an entire session.
 *
 * ------------------------------------------------------------------------
 * THE CLASSIFICATION THESE PIN, per source:
 *
 *   TRANSIENT   provider retry, the end of a wait, a continuation LAIN sends
 *               itself, a steer acknowledgement, an interruption, recovery,
 *               auto-compaction, a clipboard copy
 *   DURABLE     a missing credential, a turn that said nothing, a failing check,
 *               a session that could not be saved, a background job's verdict,
 *               an external model's words, a question waiting on the user
 *   DIAGNOSTICS the provider's raw words, the status code, the classification —
 *               on the turn record, read by /status and the turn detail
 *   HIDDEN      the continuation PROMPT itself, which is a control signal and
 *               must never be rendered as a user or assistant message
 *
 * Asserted structurally — on the source where a behaviour cannot be driven
 * without a live provider, and on the renderers where it can.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const LF = String.fromCharCode(10);
const T = require('../../src/ui/text');
const views = require('../../src/ui/views');
const strip = (x) => T.strip(String(x));

module.exports = async function () {
  // --------------------------------------------------------- the retry spam --

  await test('GLUE: a provider retry says NOTHING into the conversation', () => {
    const src = read('turn.js');
    // The notice that carried the provider's raw body into the feed is gone.
    assert.ok(!/retry \$\{retries\}\/\$\{maxRetries\} at/.test(src),
      'the durable retry notice came back');
    assert.ok(!/Esc cancels the wait'/.test(src),
      'and so did the countdown text that went with it');
    // THE EVENT IS STILL ANNOUNCED — to the live row, which replaces it.
    assert.match(src, /status\(opts, PHASE\.RETRYING, \{/, 'the retry still reaches the live row');
    // AND THE RAW FAILURE IS STILL KEPT, for /status and the diagnostics.
    assert.match(src, /record\.errors\.push\(\{ \.\.\.failure/, 'the provider\'s own words survive');
  });

  await test('GLUE: the end of a wait is not announced either', () => {
    const src = read('turn.js');
    assert.ok(!/the wait is over/.test(src), 'the resume note came back');
    assert.ok(!/resuming the task with everything it had/.test(src));
  });

  await test('GLUE: the live row carries the rate limit, compactly', () => {
    // What replaced the durable rows. One line, amber, with the pause mark — and
    // the provider's raw body is NOT in it.
    const status = require('../../src/ui/status');
    const { PHASE } = require('../../src/turn');
    const row = strip(status.statusStrip({
      phase: {
        phase: PHASE.RETRYING,
        attempt: 4,
        of: 5,
        waitMs: 6000,
        resumeAt: 6000,
        rateLimited: true,
        kind: 'RATE_LIMITED',
        status: 503,
        reason: '503 Service Unavailable - {"error":{"message":"upstream is busy"}}',
      },
      phaseSince: 0,
      clock: { shown: true, text: '00:00:14' },
    }, 76, 1, 0).join(''));
    assert.match(row, /Rate limited/, 'it names the condition');
    assert.match(row, /Ⅱ/, 'with the pause mark, not a spinner');
    assert.match(row, /00:00:14/, 'and the clock beside it');
    assert.ok(!/upstream is busy/.test(row), 'the raw provider body is not on the row');
    assert.ok(!/"error"/.test(row), 'nor any of its JSON');
    assert.ok(row.length <= 80, 'one compact row: ' + row.length);
  });

  // ------------------------------------------- internal control stays hidden --

  await test('GLUE: a continuation LAIN sends itself is NEVER a user message', () => {
    // THE INVARIANT: runtime control reaches the model, not the transcript. `from`
    // is what enforces it — a submission with one is drawn as a caption, never as
    // a user block.
    const conv = read('ui', 'conversation.js');
    assert.match(conv, /sayInput\(out, text, from\)/, 'the feed asks who submitted it');
    const phrasing = read('ui', 'phrasing.js');
    assert.match(phrasing, /selfAskedCaption/, 'and a non-user submission gets a caption');

    // AND THE KEY MATCHES. It was `rate-limit-wait` against a table holding
    // `rate-limit-resume`, so the caption fell through to a generic line naming an
    // internal identifier at the user.
    // EVERY `from` ANY CALLER USES, not just one: a key the table does not know
    // falls through to a generic caption that names an internal identifier at the
    // user. Two of them did.
    const known = require('../../src/ui/phrasing').SELF_ASKED;
    const used = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) { walk(q); continue; }
        if (!e.name.endsWith('.js')) continue;
        const text = fs.readFileSync(q, 'utf8');
        for (const m of text.matchAll(/submit\([^)]*from: '([a-z-]+)'/g)) used.add(m[1]);
      }
    };
    walk(SRC);
    assert.ok(used.size >= 3, 'the walk found the submissions: ' + [...used].join(', '));
    // EVERY RUNTIME CONTINUATION IS DECLARED. `src/` composes these four prompts
    // for itself, and each must be captioned rather than drawn as a user message.
    for (const key of ['rate-limit-resume', 'provider-failover', 'handover', 'steer']) {
      assert.ok(used.has(key), 'the walk should have found ' + key);
      assert.ok(Object.prototype.hasOwnProperty.call(known, key),
        'a runtime continuation needs a caption: ' + key);
    }
    // AND AN UNKNOWN `from` IS A PERSON, NOT AN IDENTIFIER. A transport nobody
    // declared here — a message relayed from a phone — must be drawn as what it
    // says, never as `carrying on (its-internal-key)` with the text thrown away.
    const { selfAskedCaption } = require('../../src/ui/phrasing');
    assert.strictEqual(selfAskedCaption('some-new-transport'), null,
      'an undeclared source is treated as the user speaking');
    // ASSERTED AS BEHAVIOUR, not as source text: the file's own comments quote the
    // removed fallback to explain why it went, and a grep for the phrase would
    // match the explanation rather than the code.
    assert.match(read('ui', 'phrasing.js'), /return SELF_ASKED\[from\] \|\| null;/,
      'an unknown source returns null rather than a composed caption');
    const said = views.activity({
      session: {
        turns: [{
          userInput: 'fix the loader', from: 'some-new-transport', text: 'Done.',
          narration: [{ step: 0, text: 'Done.' }], actions: [],
        }],
      },
      width: 90,
    }).map(strip).join(LF);
    assert.match(said, /fix the loader/, 'and their words are on the screen');
  });

  await test('GLUE: the continuation PROMPT never reaches the drawn feed', () => {
    // Driven through the renderer: a turn submitted by the runtime is drawn as its
    // caption, and the control text it carried is nowhere on screen.
    const { RESUME_PROMPT } = require('../../src/ratelimit');
    const text = views.activity({
      session: {
        turns: [{
          userInput: RESUME_PROMPT,
          from: 'rate-limit-resume',
          text: 'Carried on and finished.',
          narration: [{ step: 0, text: 'Carried on and finished.' }],
          actions: [],
        }],
      },
      width: 96,
    }).map(strip).join(LF);
    assert.ok(!/Nothing changed while it was waiting/.test(text),
      'the control prompt was rendered as a message');
    assert.ok(!/do not start again/.test(text), 'nor any of its instructions');
    assert.match(text, /continuing after the rate limit reset/,
      'what is drawn is the caption, which says why there is a gap');
    assert.match(text, /Carried on and finished/, 'and the answer is still there');
  });

  await test('GLUE: no bare `continue` is ever submitted as a prompt', () => {
    // `carryon` was removed for this reason and must not come back by another
    // route: a synthetic continuation LAIN decided on by itself.
    for (const f of ['turn.js', 'app.js', 'repl.js', 'turnevents.js', 'jobrunner.js']) {
      const src = read(f);
      assert.ok(!/submit\(\s*'continue'/.test(src), f + ' submits a bare continue');
      assert.ok(!/submit\(\s*"continue"/.test(src));
    }
  });

  // ---------------------------------------- transient versus durable, by source --

  await test('GLUE: a steer acknowledgement is transient; the steer itself is durable', () => {
    const app = read('app.js');
    assert.ok(!/noteActor\('note', `⚑ delivering/.test(app),
      'the delivery banner is no longer a durable row');
    assert.match(app, /require\('\.\/ui\/operation'\)\.note\(this\.ui/, 'it is an operation');
    // THE USER'S OWN WORDS STAY. They are recorded on the turn and replayed at the
    // step they reached, which is the one thing that cannot be recovered by
    // re-reading the repository.
    assert.match(read('turn.js'), /record\.steerTexts = record\.steerTexts \|\| \[\]/,
      'the steer is recorded on the turn');
    const text = views.activity({
      session: {
        turns: [{
          userInput: 'go', text: 'Done.',
          narration: [{ step: 0, text: 'Done.' }], actions: [],
          steerTexts: [{ step: 0, text: 'use the other loader' }],
        }],
      },
      width: 90,
    }).map(strip).join(LF);
    assert.match(text, /use the other loader/, 'and it is drawn in the conversation');
  });

  await test('GLUE: an interruption is a state, not a durable row', () => {
    const repl = read('repl.js');
    assert.ok(!/notice\('warn', 'interrupted'\)/.test(repl),
      'the durable `interrupted` row came back');
    assert.match(repl, /operation'\)\.say\(app, 'Interrupted'/, 'it is an operation');
    // AND THE LIVE ROW STILL SAYS IT, as a resting state held until the next thing
    // the user does.
    const status = require('../../src/ui/status');
    const row = strip(status.statusStrip({ interrupted: true }, 76, 1, 0).join(''));
    assert.match(row, /Interrupted/);
    assert.match(row, /Ⅱ/, 'with the pause mark');
  });

  await test('GLUE: what MUST stay durable, stays durable', () => {
    const turn = read('turn.js');
    // A missing credential: the user has to act.
    assert.match(turn, /yield \{ type: 'notice', level: 'warn', message: hint \}/,
      'a missing credential is still said durably');
    // A turn that produced nothing: silence would read as a lost reply.
    assert.match(turn, /message: EMPTY_ANSWER/, 'an empty answer is still said');
    // A session that could not be saved.
    assert.match(read('app.js'), /could not save session/, 'a failed save is still said');
    // A background job's verdict.
    assert.match(read('jobrunner.js'), /Background #\$\{j\.id\} COMPLETED/,
      'a background verdict still surfaces');
  });

  await test('GLUE: a durable question waiting on the user is never suppressed', () => {
    // §22. An `ask_user` call is durable by classification, and the panel that asks
    // it is modal — it stays until it is answered.
    const durable = require('../../src/ui/durable');
    assert.strictEqual(durable.durable({ name: 'ask_user', ok: true }), true);
    // AND A NOTICE MAY NOT TAKE A PANEL THAT IS ASKING SOMETHING. The rule lives
    // where the routing decision is made — src/render.js `openSurface`.
    assert.match(read('render.js'), /A QUESTION OUTRANKS A NOTICE/i,
      'a question may not be replaced by a notice');
  });

  // -------------------------------------------- reasoning stays out of the feed --

  await test('GLUE: streamed reasoning does NOT enter the conversation', () => {
    const src = read('turnevents.js');
    // It used to be flushed through the SAME channel as public prose.
    assert.ok(!/^\s+ctx\.reasoning = flushParagraphs\(app, ctx\.reasoning\);$/m.test(src)
      || /LAIN_SHOW_THINKING/.test(src),
      'reasoning is flushed into the narration channel unconditionally');
    assert.match(src, /LAIN_SHOW_THINKING/, 'it is behind an explicit debug switch');
    // AND IT IS STILL BILLED. Reasoning is output tokens and the header says so.
    assert.match(src, /noteOutputChars\(\(ev\.chunk \|\| ''\)\.length\)/,
      'reasoning is still counted as output');
  });

  await test('GLUE: reasoning IS shown when it is the only thing there is', () => {
    // The one case where the thinking is the answer: a model that streams only
    // `reasoning` and says nothing else.
    const text = views.activity({
      session: {
        turns: [{
          userInput: 'hello', text: '', narration: [], actions: [],
          reasoning: 'weighing the two options',
        }],
      },
      width: 90,
    }).map(strip).join(LF);
    assert.match(text, /weighing the two options/,
      'a turn with nothing but thinking must not read as a lost reply');
  });

  await test('GLUE: the prompt forbids routine narration, explicitly', () => {
    // Structural, not a test of model wording: the contract has to SAY it.
    const prompt = read('prompt.js');
    assert.match(prompt, /Say less\. Work quietly\./);
    assert.match(prompt, /WORK, THEN SPEAK/);
    for (const banned of ['One more consideration', 'Potential issue', 'To save turns',
      'Call 1', 'Continuing the final step', 'I think']) {
      assert.ok(prompt.includes(banned),
        'the contract must name "' + banned + '" as something not to say');
    }
  });
};
