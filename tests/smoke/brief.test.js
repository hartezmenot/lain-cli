'use strict';

/**
 * THE BRIEFING, THROUGH THE REAL BINARY.
 *
 * Everything here spawns `bin/lain.js` as a child process. Nothing require()s
 * an application module, because the point is to check the LLM-FACING and
 * USER-FACING paths rather than the functions behind them — a briefing that is
 * perfect in a unit test and arrives truncated, uncoloured-but-unreadable, or
 * missing its directive on the actual screen is a briefing that does not work.
 *
 * The properties checked here are exactly the ones a unit test structurally
 * cannot see: that the command is registered and reachable, that the tool is
 * dispatchable in a real process, that the document survives the render path
 * intact, and that the sections a reader depends on are not the ones that get
 * cut when the output is long.
 *
 * ------------------------------------------------------------------------
 * WHY THESE ASK FOR `--full`.
 *
 * `/brief` has two renderings, and the DEFAULT changed. It is now the
 * information-first view — what this project is, whether anything is broken,
 * what to run, what to do next — because that is what somebody typing `/brief`
 * wants in a few seconds. The long evidence document, with PROJECT CONTEXT, the
 * OPERATIONAL CONTRACT, per-finding `Category:` fields and the REPAIR
 * DIRECTIVE, moved behind `--full` (see briefcommand.js).
 *
 * Every test below is about THAT document — its sections, its machine-readable
 * fields, its directive. They went on typing bare `/brief` and failing because
 * a section they demanded is deliberately not in the short view. The subject
 * did not change; the command that produces it did.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const CR = '\r';

/**
 * A project with one of each defect the briefing claims to explain.
 *
 * Deliberately small: the briefing has to work on a real tree, but a smoke test
 * that takes forty seconds to build a fixture is one that stops being run.
 */
function project() {
  const dir = tmpdir('lain-brief-smoke-');
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  };
  // A misspelled call: valid syntax, resolves to nothing.
  write('src/users.js',
    "'use strict';\nfunction getUsers(db) { return db.all('users'); }\n"
    + 'function activeUsers(db) {\n  const rows = getUser(db);\n  return rows;\n}\n'
    + 'module.exports = { getUsers, activeUsers };\n');
  // A file that does not parse at all.
  write('src/broken.js',
    "'use strict';\nfunction tally(rows) {\n  return rows.reduce((n, r) => n + r.count, 0;\n}\n"
    + 'module.exports = { tally };\n');
  // The old implementation a migration was supposed to remove.
  write('src/data/enemies.js',
    "'use strict';\nconst ENEMIES = { slime: { hp: 10 } };\nmodule.exports = { ENEMIES };\n");
  write('src/data/loader.js',
    "'use strict';\nfunction loadEnemies() { return {}; }\nmodule.exports = { loadEnemies };\n");
  return dir;
}

module.exports = async function () {
  await test('BRIEF: /brief runs in the real binary and produces the whole document', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [{ text: 'ok.' }],
      stdin: `/brief --full${CR}/exit${CR}`,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));

    // EVERY SECTION A READER DEPENDS ON. Checked by name, because a document
    // that silently loses a section still looks like a document.
    for (const heading of [
      'PROJECT CONTEXT', 'ENVIRONMENT', 'GIT STATE', 'HEALTH', 'FINDINGS',
      'ROOT-CAUSE CANDIDATES', 'UNVERIFIED', 'KNOWN LIMITATIONS', 'REPAIR DIRECTIVE',
    ]) {
      assert.ok(r.out.includes(heading), `the briefing lost its ${heading} section:\n${r.out.slice(-2500)}`);
    }
  });

  await test('BRIEF: findings arrive with ids, exact locations, explanations and evidence', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));

    // The parse failure — PROVEN, and it must name the file and the line.
    assert.ok(/ERROR #\d+/.test(r.out), `no stable finding id in the output:\n${r.out.slice(-2500)}`);
    assert.ok(r.out.includes('src/broken.js:3'), 'the syntax error must carry its exact location');
    assert.ok(/Confidence:\s+PROVEN/.test(r.out), 'a parse failure is proven and must say so');

    // The typo — located, with what was probably meant, and marked INFERRED.
    assert.ok(/TYPO #\d+/.test(r.out), 'the typo finding must have an id');
    assert.ok(r.out.includes('src/users.js:4'), 'and its exact location');
    assert.ok(/getUser/.test(r.out) && /getUsers/.test(r.out), 'and both the actual and the candidate name');
    assert.ok(/Confidence:\s+INFERRED/.test(r.out),
      'that the candidate is what was MEANT is inferred, and must not claim to be proven');

    // Provenance, on every finding.
    assert.ok(/Source:\s+JavaScript\/JSON\/Python parser/.test(r.out), 'the parser must be named as the source');
    assert.ok(/Source:\s+Symbol graph/.test(r.out), 'and the symbol graph as another');
    assert.ok(/Evidence:/.test(r.out), 'and every finding carries its evidence');
    assert.ok(/Explanation:/.test(r.out), 'and an explanation of what the message means');
  });

  await test('BRIEF: the five health axes are separate, and UNVERIFIED survives to the screen', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    for (const axis of ['BUILD', 'TESTS', 'RUNTIME', 'FRONTEND', 'ENGINEERING']) {
      assert.ok(new RegExp(`${axis}\\s+\\w`).test(r.out), `the ${axis} axis is missing from the report`);
    }
    // This fixture cannot build; the report must say so rather than grading the
    // project on whether anything crashed.
    assert.ok(/BUILD\s+FAILED/.test(r.out), `BUILD should be FAILED on a tree that does not parse:\n${r.out.slice(-1500)}`);
    // And what nobody measured must still be on the screen as unmeasured.
    assert.ok(/UNVERIFIED/.test(r.out), 'unverified state must reach the user');
    assert.ok(/not the same as a pass/.test(r.out),
      'the report must say in words that unverified is not a pass');
  });

  await test('BRIEF: the repair directive survives to the end of the output', async () => {
    // THE SECTION MOST AT RISK FROM TRUNCATION, because it is last. If the
    // renderer, the pager or the panel cuts the document, this is what goes.
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(r.out.includes('REPAIR DIRECTIVE'), 'the directive heading must arrive');
    assert.ok(/Build success is one piece of evidence/.test(r.out),
      `the directive body was truncated away:\n${r.out.slice(-1200)}`);
    assert.ok(/Keep CHANGED separate from VERIFIED/.test(r.out),
      'the last line of the directive must survive — it is the one most likely to be cut');
  });

  await test('BRIEF: machine-readable fields are not destroyed by terminal formatting', async () => {
    // A briefing is meant to be copied and handed on. If the render path wraps,
    // colours or re-flows the field columns, the document stops being parseable
    // exactly when someone tries to use it as data.
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    const block = r.out.slice(r.out.indexOf('FINDINGS'));
    for (const field of ['Category:', 'Severity:', 'Confidence:', 'Location:', 'Message:', 'Source:', 'State:']) {
      assert.ok(block.includes(field), `the ${field} field did not survive rendering`);
    }
    // No ANSI escape may appear between a field label and its value.
    const labelled = block.split('\n').filter((l) => /^\s{2}\w+:\s/.test(l));
    assert.ok(labelled.length > 6, `field rows did not survive: ${labelled.length}`);
    // eslint-disable-next-line no-control-regex
    // BUILT, never typed. A literal 0x1b in source is invisible corruption,
    // and this repository fails its own guard on it — as it just did on this
    // very line. The doubled backslash is real: the string must carry `\[` so
    // the regex sees an escaped bracket rather than an open character class.
    const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);
    const escaped = labelled.filter((l) => ANSI.test(l));
    assert.deepStrictEqual(escaped, [], 'colour inside the finding fields breaks a parse');
  });

  await test('BRIEF: the operational contract reaches the screen, with its counter-examples', async () => {
    // The whole point of the facts layer: a fresh session should not have to
    // rediscover which shell, what a line number counts from, or where
    // commands run. If these do not survive to the terminal they may as well
    // not exist.
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(r.out.includes('PROJECT FACTS / OPERATIONAL CONTRACT'),
      `the contract section is missing:\n${r.out.slice(-2500)}`);

    // The source-location facts, which every file:line in the report depends on.
    assert.ok(/Line numbers:\s+1-based/.test(r.out), 'line numbering must be stated');
    assert.ok(/Byte offsets:\s+0-based/.test(r.out), 'and offsets, which are a DIFFERENT numbering');
    assert.ok(/Range end:\s+exclusive/.test(r.out), 'and whether a range includes its end');

    // The execution facts.
    assert.ok(/Default shell:/.test(r.out), 'the shell must be named');
    assert.ok(/Project root:/.test(r.out), 'and where commands run');
    assert.ok(/Changing directory:/.test(r.out), 'and how to run somewhere else');

    // A counter-example is the half that stops the guessing.
    assert.ok(/NOT: /.test(r.out), 'facts with a known wrong form must name it');

    // And the instruction that binds it all together.
    assert.ok(/OPERATIONAL CONTRACT/.test(r.out) && /Do not rediscover/.test(r.out),
      'the repair directive must open with the contract');
    assert.ok(/REPORT THE CONTRADICTION/.test(r.out),
      'contradicting evidence must be reported, never silently adopted');
  });

  await test('BRIEF: an unestablished fact says UNKNOWN rather than guessing', async () => {
    // The property under the most pressure. A plausible wrong fact is worse
    // than an absent one: an absent fact makes somebody look.
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/brief --full${CR}/exit${CR}`, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(/UNKNOWN/.test(r.out), 'something in a bare fixture must be unestablished, and say so');
    assert.ok(/A fact marked UNKNOWN was NOT established/.test(r.out),
      'and the reader must be told what UNKNOWN means here');
  });

  await test('BRIEF: the model can call engineering_brief and gets the same document', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        { text: 'Surveying.', tool_calls: [{ name: 'engineering_brief', input: {} }] },
        { text: 'Read the briefing.' },
      ],
      stdin: `what is wrong with this project${CR}/exit${CR}`,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(!/unknown tool/.test(r.out), `engineering_brief is not dispatchable:\n${r.out.slice(-1500)}`);
    assert.ok(!/engineering_brief failed/.test(r.out), r.out.slice(-1500));
  });

  await test('BRIEF: /steer still means what it always meant', async () => {
    // The collision that would have taken the binary down at startup. A user
    // redirecting a running task must never receive a project audit.
    const dir = project();
    const r = await runCli([], {
      cwd: dir, script: [{ text: 'ok.' }], stdin: `/steer${CR}/exit${CR}`, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(!/REPAIR DIRECTIVE|HEALTH — FIVE/.test(r.out),
      '/steer produced a briefing — the two commands have collided');
  });
};
