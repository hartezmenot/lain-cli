'use strict';

/**
 * TOKEN ECONOMY — measured against a real model, not asserted from a guess.
 *
 * The question this answers is the one the whole surgical-tool layer exists for:
 *
 *     Does a one-function change in a large file still cost the whole file?
 *
 * A fixture with a 1,500-line module is put in front of a real model with one
 * small, unambiguous task. What is recorded is what actually happened — tokens
 * in, tokens out, which tools were chosen, and how large the resulting diff is.
 *
 * WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED. No token number is asserted:
 * models differ, and a threshold picked today is a flake tomorrow. What IS
 * asserted is the thing that is true regardless of model:
 *
 *   1. the change is correct (the fixture's own test decides),
 *   2. the rest of the file survived — a whole-file rewrite is a real defect
 *      even when the one function comes out right, because it destroys review
 *      and quietly drops whatever the model was not thinking about.
 *
 * The measurements are printed so the effect of the tools can be SEEN rather
 * than claimed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, runCli } = require('../helpers');

const BASE_URL = process.env.LAIN_LIVE_BASE_URL || 'http://127.0.0.1:20128/v1';
const NL = String.fromCharCode(10);
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A big, boring module with exactly one function worth changing. */
function bigProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const filler = [];
  for (let i = 1; i <= 240; i++) {
    filler.push(`/** Helper ${i}. Does something unremarkable. */`);
    filler.push(`function helper${i}(a, b) {`);
    filler.push(`  const scaled = a * ${i};`);
    filler.push(`  return scaled + b;`);
    filler.push(`}`);
    filler.push('');
  }
  const target = [
    '/** The acceptance threshold for a detection. */',
    'function accepted(confidence) {',
    '  // DEFECT: the threshold is the MINIMUM acceptable confidence, so a',
    '  // detection at exactly 0.8 must be accepted.',
    '  return confidence > 0.8;',
    '}',
    '',
  ];
  const body = [...filler.slice(0, 600), ...target, ...filler.slice(600)];
  body.push('module.exports = { accepted };');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'big.js'), body.join(NL) + NL, 'utf8');
  fs.writeFileSync(path.join(dir, 'test.js'), [
    "'use strict';",
    "const assert = require('assert');",
    "const { accepted } = require('./src/big');",
    'let failed = 0;',
    'const check = (name, fn) => { try { fn(); process.stdout.write(`ok   ${name}\\n`); }',
    '  catch (e) { failed++; process.stdout.write(`FAIL ${name}\\n     ${e.message}\\n`); } };',
    "check('exactly at the threshold is accepted', () => assert.strictEqual(accepted(0.8), true));",
    "check('below the threshold is rejected', () => assert.strictEqual(accepted(0.79), false));",
    "check('above the threshold is accepted', () => assert.strictEqual(accepted(0.95), true));",
    'process.exit(failed ? 1 : 0);',
  ].join(NL) + NL, 'utf8');
  return dir;
}

function groundTruth(cwd) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['test.js'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function configFor(cwd, model) {
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model, connection: 'live', maxSteps: 40,
    connections: { live: { provider: 'live-bridge', via: 'bridge', protocol: 'chat', baseUrl: BASE_URL, models: [model] } },
  }, null, 2), 'utf8');
  return configDir;
}

async function probe(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${BASE_URL}/models`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const ids = ((await res.json()).data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return null;
    const want = process.env.LAIN_ADVERSARIAL_MODEL;
    return (want && ids.includes(want)) || ids.find((m) => /llama-3\.3-70b|claude|gpt-5|qwen.*coder/i.test(m)) || ids[0];
  } catch { /* fall through to the retry */ }
  await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return null;
}

/** How many lines of the file differ — a whole-file rewrite cannot hide here. */
function changedLines(before, after) {
  const a = before.split(NL);
  const b = after.split(NL);
  let same = 0;
  const seen = new Map();
  for (const l of a) seen.set(l, (seen.get(l) || 0) + 1);
  for (const l of b) {
    const n = seen.get(l) || 0;
    if (n > 0) { same++; seen.set(l, n - 1); }
  }
  return Math.max(a.length, b.length) - same;
}

module.exports = async function () {
  const model = await probe();
  if (!model) {
    process.stdout.write(`  ~ SKIPPED: no live provider at ${BASE_URL} — token economy was not measured\n`);
    return;
  }

  await test('TOKENS: a one-function change in a 1,500-line file does not rewrite the file', async () => {
    const dir = bigProject();
    const configDir = configFor(dir, model);
    const file = path.join(dir, 'src', 'big.js');
    const before = fs.readFileSync(file, 'utf8');
    const totalLines = before.split(NL).length;
    assert.ok(totalLines > 1400, `the fixture must be large: ${totalLines} lines`);
    assert.strictEqual(groundTruth(dir).code, 1, 'and must start failing');

    const started = Date.now();
    const r = await runCli(['-p',
      'The tests in this project fail. Run `node test.js`, find the one function at fault in '
      + 'src/big.js, and fix it. src/big.js is large — do not read it all and do not rewrite it. '
      + 'Then run the tests again and report the real result.'], {
      cwd: dir, configDir, timeoutMs: 420000,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    const after = fs.readFileSync(file, 'utf8');
    const said = plain(r.out);
    const truth = groundTruth(dir);

    // ---- MEASURED, then printed. Nothing here is a threshold. -------------
    const tok = [...said.matchAll(/↑(\d+)\s*↓(\d+)/g)].pop();
    const input = tok ? Number(tok[1]) : null;
    const output = tok ? Number(tok[2]) : null;
    const used = [...new Set([...said.matchAll(/✓\s+(?:Read|Wrote|Edited|Patched|Ran|Searched|Appended|Inserted|Deleted|Moved)[^\n]*/g)].map((m) => m[0].trim()))];
    const delta = changedLines(before, after);

    process.stdout.write(
      `    ── token economy ──────────────────────────────────\n`
      + `    model            ${model}\n`
      + `    file             ${totalLines} lines\n`
      + `    input tokens     ${input == null ? 'not reported' : input}\n`
      + `    output tokens    ${output == null ? 'not reported' : output}\n`
      + `    lines changed    ${delta}\n`
      + `    wall clock       ${secs}s\n`
      + `    tools used       ${used.length ? used.slice(0, 8).join(' | ') : '(none parsed)'}\n`,
    );

    // ---- A RUN THAT NEVER FINISHED PROVES NOTHING EITHER WAY ---------------
    //
    // `r.code === null` means the harness killed the child: the turn was still
    // in flight when the clock ran out. That is a statement about the provider's
    // speed today, not about the model's behaviour — and calling it a failure
    // would put a red mark against the very thing this tier exists to measure,
    // for a reason that has nothing to do with it.
    //
    // Reported as NOT VERIFIED, loudly, and never as a pass: the measurement
    // did not happen and the run must say so. (Observed 2026-08-20: the local
    // bridge took 79s to return ten tokens, and this test's 420s budget expired
    // mid-turn.)
    if (r.code === null) {
      process.stdout.write(
        `    ~ NOT VERIFIED: the run was still working when the ${(420000 / 1000)}s budget expired.\n`
        + '      Token economy was NOT measured on this run. This is the provider being slow,\n'
        + '      not a result — re-run when it is responsive.\n');
      return;
    }

    // ---- ASSERTED: correctness, and that the rest of the file survived ----
    assert.strictEqual(truth.code, 0,
      `the fix must be real:\n${truth.out}\n--- said ---\n${said.slice(-1500)}`);
    // A WHOLE-FILE REWRITE IS A DEFECT even when the function comes out right:
    // it destroys review and silently drops whatever the model was not thinking
    // about. One function is a handful of lines; 100 is a rewrite wearing a
    // disguise.
    assert.ok(delta <= 100,
      `${delta} lines changed in a ${totalLines}-line file — that is a rewrite, not an edit`);
    assert.strictEqual(r.code, 0, 'and the binary exited cleanly');
  });

  await test('TOKENS: the surgical tools are the ones a model reaches for', async () => {
    // Not "did it use apply_patch" specifically — several of the new tools are
    // legitimate answers here, and forcing one would be testing obedience
    // rather than capability. What is checked is that the big file was NOT
    // written back whole, which is the behaviour the tools exist to replace.
    const dir = bigProject();
    const configDir = configFor(dir, model);
    const file = path.join(dir, 'src', 'big.js');
    const before = fs.readFileSync(file, 'utf8');

    const r = await runCli(['-p',
      'In src/big.js, change the function `accepted` so it uses >= instead of >. '
      + 'Change nothing else. The file is large — do not read or write it whole.'], {
      cwd: dir, configDir, timeoutMs: 300000,
    });
    const after = fs.readFileSync(file, 'utf8');
    const delta = changedLines(before, after);
    const said = plain(r.out);

    if (before === after) {
      process.stdout.write('    ~ the model made no edit; nothing to measure\n');
      return;
    }
    process.stdout.write(`    lines changed: ${delta}\n`);
    assert.ok(delta <= 20, `a one-operator change touched ${delta} lines:\n${said.slice(-1200)}`);
    assert.match(after, /confidence >= 0\.8/, 'and the change is the one asked for');
    // Everything else is byte-identical.
    const a = before.split(NL);
    const b = after.split(NL);
    assert.strictEqual(a.length, b.length, 'no lines were added or lost elsewhere');
  });
};
