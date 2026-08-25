'use strict';

/**
 * START → RUN → STOP → EVIDENCE, on the real binary.
 *
 * the design asks for exactly this run as a test. What it proves that the unit tier
 * cannot: the tools are actually offered to a model, the run is a real child
 * process on this machine, its output really reaches the rules, and stopping it
 * really does leave the evidence behind.
 *
 * THE COST PROPERTY IS THE ONE THAT MATTERS and it is asserted directly: a
 * whole bot run must cost a bounded, small number of model requests. The mock
 * provider is scripted, so the number of requests is the number of scripted
 * responses consumed — which is exactly the measurement wanted. If observation
 * ever regresses into polling, this test is what notices.
 *
 * LIVE CLI VERIFIED, never LIVE PROVIDER VERIFIED: the network call is the
 * mock. Everything else — argv, REPL, session, turn loop, tool dispatch, the
 * child process, the filesystem — is the real thing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * A "bot": a real script that prints the log lines the user's example has.
 *
 * It runs long enough that the observation is genuinely concurrent with the
 * turn — a script that exits instantly would prove nothing about watching
 * something that is still going.
 */
function project() {
  const cwd = tmpdir('observe-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  fs.writeFileSync(path.join(cwd, 'bot.js'), [
    'const log = (s) => { process.stdout.write(s + "\\n"); };',
    'log("BOT_STARTED");',
    'let n = 0;',
    'const t = setInterval(() => {',
    '  n += 1;',
    '  log("MINIGAME_STARTED round=" + n);',
    '  log("WAITING_FOR_INPUT");',
    '  log("CLICK_ACCEPTED");',
    '  log("ROUND_COMPLETE round=" + n);',
    '  if (n >= 3) { clearInterval(t); log("BOT_IDLE"); }',
    '}, 120);',
    'setTimeout(() => process.exit(0), 4000);',
  ].join('\n'));
  return { cwd, configDir };
}

module.exports = async function () {
  await test('BOT: start, run, stop, and the evidence survives the stop', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'watch the bot'], {
      cwd, configDir,
      script: [
        {
          text: 'Starting the bot and watching its log.',
          tool_calls: [{
            name: 'observe_start',
            input: {
              command: 'node bot.js',
              shell: 'cmd',
              expectation: ['start', 'play the minigame', 'continue after it'],
              rules: [
                { name: 'MINIGAME_STARTED', pattern: 'MINIGAME_STARTED', capture: true, why: 'the indicator is brief' },
                { name: 'ROUND_COMPLETE', pattern: 'ROUND_COMPLETE', capture: true },
                { name: 'CLICK_ACCEPTED', pattern: 'CLICK_ACCEPTED' },
              ],
            },
          }],
        },
        // ONE waiting call, and it is a real sleep rather than a poll.
        { text: 'Letting it run.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "setTimeout(()=>{},1200)"' } }] },
        {
          text: 'Stopping and reading the evidence.',
          tool_calls: [{
            name: 'observe_stop',
            input: {
              claims: ['ROUND_COMPLETE'],
              expect: { ROUND_COMPLETE: { absent: ['minigame'] } },
              reason: 'the run has done enough rounds',
            },
          }],
        },
        { text: 'INVESTIGATION_DONE.' },
      ],
      timeoutMs: 120000,
    });
    const out = plain(r.out);

    assert.match(out, /OBSERVING/, 'the run was watched');
    assert.match(out, /STOPPED/, 'and stopping it is reported');
    // THE EVIDENCE OUTLIVED THE RUN. This is: stopping the bot is not
    // stopping the investigation.
    assert.match(out, /MINIGAME_STARTED/, 'the log events survived the stop');
    assert.match(out, /ROUND_COMPLETE/);
    assert.match(out, /event\(s\)/, 'and they are counted back to the model');
    assert.match(out, /INVESTIGATION_DONE/, 'the turn carried on afterwards');
  });

  await test('BOT: watching costs a BOUNDED number of model requests, not one per glance', async () => {
    // The whole reason this exists. A model that watched by screenshotting
    // would consume a request per look; here the run is watched by its own
    // output and the model is called only at the ends.
    const { cwd, configDir } = project();
    const script = [
      {
        text: 'Watching.',
        tool_calls: [{
          name: 'observe_start',
          input: {
            command: 'node bot.js',
            shell: 'cmd',
            rules: [{ name: 'ROUND_COMPLETE', pattern: 'ROUND_COMPLETE' }],
          },
        }],
      },
      { text: 'Waiting.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "setTimeout(()=>{},1500)"' } }] },
      { text: 'Reading it back.', tool_calls: [{ name: 'observe_stop', input: {} }] },
      { text: 'ALL_DONE.' },
    ];
    // MORE RESPONSES THAN THE RUN SHOULD NEED. If observation ever starts
    // calling the model per event, the extra responses get consumed and the
    // closing text arrives from the wrong one — so the assertion below fails
    // rather than silently passing on a more expensive program.
    for (let i = 0; i < 12; i++) script.push({ text: `EXTRA_${i}` });
    const r = await runCli(['-p', 'watch it'], { cwd, configDir, script, timeoutMs: 120000 });
    const out = plain(r.out);
    assert.match(out, /ALL_DONE/, 'the fourth response is where the run ends');
    assert.ok(!/EXTRA_/.test(out),
      'the run consumed more model requests than the four it needs — something is polling');
  });

  await test('BOT: a run that ends by itself does not leave LAIN believing it is watched', async () => {
    const { cwd, configDir } = project();
    fs.writeFileSync(path.join(cwd, 'quick.js'), 'process.stdout.write("ROUND_COMPLETE\\n");');
    const r = await runCli(['-p', 'watch the quick one'], {
      cwd, configDir,
      script: [
        {
          text: 'Watching.',
          tool_calls: [{
            name: 'observe_start',
            input: { command: 'node quick.js', shell: 'cmd', rules: [{ name: 'ROUND_COMPLETE', pattern: 'ROUND_COMPLETE' }] },
          }],
        },
        { text: 'Waiting.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "setTimeout(()=>{},800)"' } }] },
        { text: 'Reading.', tool_calls: [{ name: 'observe_stop', input: {} }] },
        { text: 'ENDED_BY_ITSELF.' },
      ],
      timeoutMs: 120000,
    });
    const out = plain(r.out);
    assert.match(out, /ENDED_BY_ITSELF/);
    assert.match(out, /ended by itself|STOPPED/, 'the ending is named');
  });

  await test('BOT: `observe_stop` with nothing running says so instead of pretending', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'stop the bot'], {
      cwd, configDir,
      script: [
        { text: 'Stopping.', tool_calls: [{ name: 'observe_stop', input: {} }] },
        { text: 'NOTHING_TO_STOP.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /nothing is being observed/i);
    assert.match(out, /NOTHING_TO_STOP/);
  });

  await test('BOT: the observe tools are offered with NO bridge connected', async () => {
    // They must be there before a Probe is, because the expensive habit —
    // screenshotting in a loop — forms on a machine with no Probe at all.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/tools\n/exit\n',
      script: [],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /observe_start/);
    assert.match(out, /observe_stop/);
  });
};
