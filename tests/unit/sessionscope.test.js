'use strict';

/**
 * `/resume` MUST NOT CROSS PROJECTS, and machinery must not enter the context.
 *
 * Observed: twice: "Resuming session got glue stick on context too,
 * and /resume make sure not to mix with other project directory", then "even
 * slash clear is sticking on conversation context".
 *
 * The resume half is the dangerous one. The sessions directory is global — one
 * folder for every project on the machine — so `/resume` in one tree offered
 * sessions belonging to another, and restoring one brought back its
 * conversation, objective and plan while the working directory stayed put.
 * Every path the model had learned would then resolve into the wrong tree, and
 * the first edit would land there.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const sessionIndex = require('../../src/sessionindex');
const { REGISTRY } = require('../../src/commands');

/** A sessions directory holding sessions from two different projects. */
function twoProjects() {
  const dir = tmpdir('sessions-');
  const here = tmpdir('project-here-');
  const elsewhere = tmpdir('project-elsewhere-');
  const write = (id, cwd, objective) => {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      cwd,
      task: { objective },
      turns: [{ userInput: objective, text: 'working on it' }],
      messages: [{ role: 'user', content: objective }],
    }));
  };
  write('20260823-100000-aaaa', here, 'fix the dashboard here');
  write('20260823-110000-bbbb', elsewhere, 'rewrite the loader elsewhere');
  write('20260823-120000-cccc', here, 'second job here');
  return { dir, here, elsewhere };
}

module.exports = async function () {
  await test('SCOPE: only THIS project\'s sessions are listed', () => {
    const { dir, here } = twoProjects();
    const rows = sessionIndex.summaries({ dir, cwd: here });
    assert.strictEqual(rows.length, 2, `expected the two from this project, got ${rows.length}`);
    assert.ok(rows.every((r) => r.cwd === here), 'a foreign session must not be offered');
    const said = rows.map((r) => r.objective).join(' ');
    assert.ok(!/elsewhere/.test(said), 'the other project must not appear at all');
  });

  await test('SCOPE: `all` opts out, and every row says whether it is here', () => {
    const { dir, here } = twoProjects();
    const rows = sessionIndex.summaries({ dir, cwd: here, scope: 'all' });
    assert.strictEqual(rows.length, 3, 'all three, when explicitly asked');
    const foreign = rows.filter((r) => !r.here);
    assert.strictEqual(foreign.length, 1);
    // LABELLED EITHER WAY, so a cross-project resume is always a visible choice
    // rather than an accident.
    assert.match(foreign[0].objective, /elsewhere/);
  });

  await test('SCOPE: the limit counts sessions SHOWN, not files read', () => {
    // The first version sliced to `limit` and filtered afterwards, so a project
    // with two recent sessions among twenty foreign ones showed nothing, for a
    // reason nothing on screen explained.
    const dir = tmpdir('sessions-many-');
    const here = tmpdir('project-mine-');
    const other = tmpdir('project-other-');
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(dir, `2026082${i % 9}-1${String(i).padStart(2, '0')}00-x${i}.json`),
        JSON.stringify({ cwd: other, task: { objective: `foreign ${i}` }, turns: [], messages: [] }));
    }
    fs.writeFileSync(path.join(dir, '20260101-000000-mine.json'),
      JSON.stringify({ cwd: here, task: { objective: 'mine, and old' }, turns: [], messages: [] }));
    const rows = sessionIndex.summaries({ dir, cwd: here, limit: 5 });
    assert.strictEqual(rows.length, 1, 'the one that is mine, however deep in the list it sits');
    assert.match(rows[0].objective, /mine/);
  });

  await test('SCOPE: paths are compared the way Windows compares them', () => {
    const a = 'C:\\Users\\Someone\\Documents\\lain-v2';
    assert.strictEqual(sessionIndex.samePlace(a, a), true);
    if (process.platform === 'win32') {
      assert.strictEqual(sessionIndex.samePlace(a, a.toUpperCase()), true, 'case must not split a project in two');
      assert.strictEqual(sessionIndex.samePlace(a, `${a}\\`), true, 'nor a trailing separator');
    }
    assert.strictEqual(sessionIndex.samePlace(a, `${a}-old`), false, 'but a different folder is different');
    assert.strictEqual(sessionIndex.samePlace('', a), false, 'and a session with no cwd matches nothing');
  });

  await test('GLUE: every machinery command writes to the surface, not the conversation', () => {
    // The user's complaint, as a standing rule rather than a one-off fix. Only
    // commands that are genuinely part of the WORK may write into the context
    // the model reads.
    //
    // THE FIRST VERSION OF THIS TEST HAD THE RULE ITSELF WRONG, and it took
    // five smoke failures to notice: it treated every non-surface command as a
    // leak, which pushed `/plan` and `/task` onto the panel — and commands.js
    // already carried a paragraph explaining why they must not go there, with
    // tests/smoke/surface.test.js standing guard over it. "Machinery goes to
    // the surface" is one half of a rule whose other half is "the work stays in
    // Context", and a test that only knows one half enforces the wrong thing.
    const allowed = new Set([
      '/exit', '/quit',          // produce no output at all
      '/troubleshoot',           // starts a real turn; its findings ARE the work
      // ABOUT THE TASK, not about LAIN. `/plan done` answering "not complete —
      // nothing has been run to check" is the record of the work, and a box
      // that closes on Esc is not where a record lives.
      '/plan', '/task',
      // AND `/goal`, which is the same argument one level up. A goal is what
      // the user is trying to achieve — the direction every task in the session
      // serves — and it is the most durable statement about the work there is.
      // In a box that closes on Esc it would be absent from the record the
      // moment it was set. See src/goal.js on why it is not the task objective.
      '/goal',
      // AND `/verify`, for exactly the same reason and a sharper one. A
      // verification verdict — what was run, what passed, what could not be
      // checked — is not LAIN talking about itself; it is the EVIDENCE the task
      // is judged on. Routed to the command panel it would sit in a box that
      // closes on Esc, absent from the next turn's context, so the model would
      // carry on unaware that the suite it was told about is red. The record of
      // what was proved belongs in the record of the work.
      '/verify',
    ]);
    const leaking = [];
    for (const [name, cmd] of REGISTRY) {
      if (cmd.surface || allowed.has(name)) continue;
      leaking.push(name);
    }
    assert.deepStrictEqual(leaking, [],
      `these write machinery into the conversation: ${leaking.join(', ')}`);
  });

  await test('GLUE: /clear no longer claims to have cleared the model\'s context', () => {
    // It clears the VIEW. `contextChars()` — the number the window limit is
    // measured against — does not move, and saying otherwise sent people to
    // this command when they needed /compact or /new.
    const clean = REGISTRY.get('/clean');
    assert.ok(clean, '/clean must exist');
    assert.strictEqual(clean.surface, true, 'its receipt belongs on the surface');
    const clear = REGISTRY.get('/clear');
    assert.strictEqual(clear.surface, true, 'and so does the alias people actually type');
    assert.match(clean.desc, /model keeps its context/i, 'the description says which half it clears');
  });
};
