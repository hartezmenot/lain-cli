'use strict';

/**
 * ARCHITECTURAL REGRESSION TESTS.
 *
 * V1's defects were structural, not behavioural: four continuation classifiers,
 * two byte-snapshot systems, a duplicate switch case, a god object, a module the
 * production path never called. Behaviour tests cannot catch a SECOND
 * implementation appearing — only a structural test can.
 *
 * These are cheap and they fail loudly the moment a rule erodes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push({ file: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

module.exports = async function () {
  const files = sources();

  await test('ARCH: the test run cannot touch the user real config home', () => {
    // A test that writes the user's config is not a failing test — it is damage
    // outside the tree that no assertion sees. One in-process command persisting
    // a partial cfg once replaced a real configuration and took a working
    // connection (and its entire model catalog) down with it. The runner sets an
    // isolated LAIN_CONFIG_DIR; this is the check that it is actually in force.
    const os = require('os');
    const configDir = require('../../src/config').configDir();
    assert.ok(process.env.LAIN_CONFIG_DIR, 'the runner must set an isolated LAIN_CONFIG_DIR');
    assert.notStrictEqual(
      path.resolve(configDir),
      path.resolve(path.join(os.homedir(), '.lain-v2')),
      'tests are pointed at the REAL config home — a save() here would destroy the user configuration',
    );
  });

  await test('ARCH: no module is a god object (V1s repl.js was 17,511 lines)', () => {
    for (const f of files) {
      const n = f.text.split('\n').length;
      assert.ok(n < 700, `${f.file} is ${n} lines — split it before it becomes repl.js`);
    }
  });

  await test('ARCH: exactly ONE task-identity classifier', () => {
    const owners = files.filter((f) => /CONTINUE_RE\s*=/.test(f.text)).map((f) => f.file);
    assert.deepStrictEqual(owners, ['task.js'], 'continuation detection must live in exactly one file');
    // Nobody else may re-derive it from raw text. Referring to task.js's OWN
    // vocabulary is the opposite of that — it is proof of consumption — so a
    // file that imports task.js and compares against `KIND.CONTINUATION` is
    // exactly what this rule wants, and is allowed. What stays banned is a
    // second local notion of continuation.
    for (const f of files) {
      if (f.file === 'task.js') continue;
      const code = stripComments(f.text)
        .replace(/\bKIND\.CONTINUATION\b|\btaskKinds\.CONTINUATION\b|\btaskId\.KIND\.CONTINUATION\b/g, '');
      assert.ok(!/continuation|isContinuation|planResumeIntent/i.test(code),
        `${f.file} must consume task.classify(), not re-interpret the input`);
    }
  });

  await test('ARCH: exactly ONE liveness/progress mechanism', () => {
    const owners = files.filter((f) => /observeTool\s*\(/.test(stripComments(f.text)) && !/opts\.|life\./.test(f.file)).map((f) => f.file);
    assert.ok(owners.every((o) => o === 'lifecycle.js' || o === 'turn.js'),
      `progress observation leaked into: ${owners.join(', ')}`);
    // Comments are stripped: a module is allowed to NAME the V1 mechanisms it
    // replaced. What is forbidden is a second implementation of them.
    const noProgress = files.filter((f) => /function noProgress|_shouldStopAutonomous|stallReason/.test(stripComments(f.text)));
    assert.strictEqual(noProgress.length, 0, `competing stall detectors in: ${noProgress.map((f) => f.file).join(', ')}`);
  });

  await test('ARCH: no regex literal has lost its backslash', () => {
    // ---- THE CORRUPTION CLASS, MADE UNABLE TO ENTER QUIETLY ---------------
    //
    // Six times in this project a shell has eaten a backslash out of a regex on
    // its way into a file. `\s+` became `s+`, which still compiles, still
    // matches, and matches the LETTER S — so `wrapItems` split "history" into
    // "hi|tory" and every test stayed green because none of them contained an
    // s in the wrong place. `\b` fared worse: it became a literal backspace
    // byte, invisible in every editor.
    //
    // The control-byte guard below catches the `\b` shape. This catches the
    // other one: a bare `s+`, `d+` or `w+` inside a regex literal, which is
    // almost always a character class that lost its escape. Character classes
    // and escaped forms are stripped first, so `[sdw]+` and `\s+` are fine.
    const suspicious = [];
    const scan = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p, path.join(rel, e.name)); continue; }
        if (!e.name.endsWith('.js')) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // prose may say anything
          const literals = line.match(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*/g) || [];
          for (const lit of literals) {
            const body = lit.slice(1, lit.lastIndexOf('/'))
              .replace(/\[[^\]]*\]/g, '')                        // character classes are literal
              .replace(/\\./g, '');                              // properly escaped forms are fine
            if (/(?:^|[^A-Za-z0-9_$.])[sdw]\+/.test(body)) {
              suspicious.push(`${path.join(rel, e.name)}:${i + 1}  ${lit.slice(0, 60)}`);
            }
          }
        });
      }
    };
    scan(SRC);
    scan(path.join(__dirname, '..'));
    assert.deepStrictEqual(suspicious, [],
      `a regex matches a bare letter where a character class was meant:\n${suspicious.join('\n')}`);
  });

  await test('ARCH: every event the turn yields has a consumer that handles it', () => {
    // ---- FOUND BY MUTATION TESTING, NOT BY READING ------------------------
    //
    // Renaming one yielded event from `looping` to `loopping` — a single
    // doubled letter — left the whole loop advisory silently dead: turn.js kept
    // producing the event, turnevents.js kept switching on the old name, and
    // nothing matched. The unit tier did not notice AT ALL. It was caught only
    // by a smoke test that drives the real binary and looks at the screen,
    // which costs fifteen minutes and needs an end-to-end run to say "a word is
    // spelled two ways".
    //
    // The producer and the consumer are twenty lines apart in two files, and
    // the link between them is a bare string. This checks that link directly,
    // in milliseconds. It is the cheapest possible guard for the exact class of
    // defect this project keeps hitting: one vocabulary word drifting away from
    // the code that reads it.
    const turn = fs.readFileSync(path.join(SRC, 'turn.js'), 'utf8');
    const events = fs.readFileSync(path.join(SRC, 'turnevents.js'), 'utf8');
    const produced = new Set();
    for (const m of turn.matchAll(/(?:yield|advise\s*=)\s*\{?\s*type:\s*'([a-z_]+)'/g)) produced.add(m[1]);
    // `yield { type: X }` where X came from a variable is invisible to a regex,
    // and that is fine: this is a guard against DRIFT between two literals, not
    // a proof of exhaustiveness.
    assert.ok(produced.size >= 4, `only ${produced.size} literal event types found — the pattern stopped matching`);
    const handled = new Set();
    for (const m of events.matchAll(/case\s*'([a-z_]+)'/g)) handled.add(m[1]);
    const orphans = [...produced].filter((t) => !handled.has(t));
    assert.deepStrictEqual(orphans, [],
      `turn.js yields ${orphans.join(', ')} and turnevents.js handles no such case — `
      + 'the event is produced and nothing acts on it');
  });

  await test('ARCH: no counter has the authority to stop the model or ask for more', () => {
    // ---- THE RULE THIS PROJECT KEPT RE-LEARNING ---------------------------
    //
    //     OBSERVE ≠ JUDGE.  WARN ≠ TERMINATE.  ACCOUNT ≠ AUTHORITY.
    //
    // Three mechanisms have been removed for breaking it: `carryon` (a step
    // limit that manufactured four more requests), the narration nudge ladder
    // (three quiet turns and the task was BLOCKED), and `maxSteps: 30` (a turn
    // ended because a variable reached a number nobody chose for the task).
    // Each looked like safety and was an opinion about how the model should
    // work.
    //
    // Counters are welcome — they are telemetry, and several tests assert on
    // them. What is checked here is that the modules which COUNT cannot also
    // DECIDE: they may not start a provider request, and they may not write a
    // terminal lifecycle state.
    const COUNTERS = ['lifecycle.js', 'looping.js', 'observe.js', 'turnclose.js', 'msgfold.js'];
    const offenders = [];
    for (const name of COUNTERS) {
      const f = files.find((x) => x.file === name);
      if (!f) continue;                       // a module may legitimately not exist
      const code = stripComments(f.text);
      // A. IT MAY NOT CREATE A MODEL REQUEST.
      if (/\.submit\s*\(/.test(code)) offenders.push(`${name}: calls submit()`);
      if (/provider\.chat\s*\(|providerMod\.chat\s*\(/.test(code)) offenders.push(`${name}: calls the provider`);
      // B. IT MAY NOT REACH A TERMINAL VERDICT FROM A THRESHOLD.
      //
      // AIMED AT THE THRESHOLD, NOT AT THE ASSIGNMENT. `fail(why)` is a plain
      // setter — an explicit "this genuinely failed", called by whoever knows
      // that — and banning the statement outright flagged it, which would have
      // pushed a legitimate API out of the module that owns the state.
      //
      // What is banned is the SHAPE the three removed mechanisms shared: a
      // count compared against a budget, and a terminal state written inside
      // that comparison. So a terminal assignment is an offence only when a
      // counter comparison appears within the few lines above it.
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (!/state\s*=\s*STATE\.(BLOCKED|FAILED)|stopReason\s*=\s*'(blocked|max-steps)'/.test(line)) return;
        const above = lines.slice(Math.max(0, i - 6), i).join('\n');
        if (/(nudges|repeated|count|steps|budget|attempts)\s*(>|>=|===)|>\s*[A-Z_]*BUDGET|>=\s*MAX_/i.test(above)) {
          offenders.push(`${name}:${i + 1} reaches a terminal verdict from a counter`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
  });

  await test('ARCH: the step budget defaults to NO LIMIT, and only the user sets one', () => {
    // `maxSteps: 30` ended turns as `STEP LIMIT`. The default is now 0 — no
    // bound — and a non-zero value means a PERSON capped their own spend.
    // Asserted on the loaded values rather than on the source text, so a
    // default that drifts in either file is caught.
    const turn = require('../../src/turn');
    assert.strictEqual(turn.DEFAULT_MAX_STEPS, 0,
      'a non-zero default is LAIN deciding how long the model may work');
    const defaults = require('../../src/config').defaults
      ? require('../../src/config').defaults()
      : null;
    if (defaults) assert.strictEqual(Number(defaults.maxSteps) || 0, 0, 'and the config default agrees');

    // AND THE LOOP HONOURS IT. A bound of 0 must not be clamped up to 1, which
    // would turn "no limit" into "one step" and stop every turn immediately.
    const src = fs.readFileSync(path.join(SRC, 'turn.js'), 'utf8');
    assert.ok(/!maxSteps \|\| step < maxSteps/.test(src),
      'the loop must run unbounded when no limit was configured');
    assert.ok(!/Math\.max\(1, Number\(opts\.maxSteps\)/.test(src),
      'clamping the floor to 1 would make "no limit" mean "one step"');
  });

  await test('ARCH: retired vocabulary cannot come back as working code', () => {
    //-M. `carryon` was removed because it decided the model should take
    // another turn and manufactured one. The NAME is allowed in prose — several
    // files explain what was removed and why, and that history is worth keeping
    // — but nothing may require it, track its counter, or submit under it.
    const offenders = [];
    for (const f of files) {
      const code = stripComments(f.text);
      if (/require\(['"]\.\/carryon['"]\)/.test(code)) offenders.push(`${f.file}: requires carryon`);
      if (/_carriedOn/.test(code)) offenders.push(`${f.file}: tracks a continuation budget`);
      if (/from:\s*'carry-on'/.test(code)) offenders.push(`${f.file}: submits a carry-on turn`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
    assert.ok(!fs.existsSync(path.join(SRC, 'carryon.js')), 'carryon.js must stay gone');
  });

  await test('ARCH: no source file contains a raw control byte', () => {
    // V1's src/tools.js embedded a literal NUL as a join separator, so the file
    // reported as binary to grep and `file`. Caught here on its first run.
    //
    // Widened past NUL after a patch script wrote real 0x08 bytes into a regex
    // in lifecycle.js: `\b` became a BACKSPACE character, the pattern silently
    // stopped matching, and nothing looked wrong — the source read normally in
    // every editor and terminal. A control byte in source is corruption
    // whatever put it there, and it is invisible exactly when it matters.
    // ---- AND THE TESTS, WHICH THIS GUARD USED TO EXEMPT --------------------
    //
    // It read `src/**` only, and a raw NUL had been sitting in
    // tests/unit/newmodels.test.js all along — written deliberately, because an
    // unreadable path is exactly what that test needs, but as a raw byte
    // instead of the escape that means the same value. The file reported as
    // binary to grep and to `file`, which is the whole defect. A test is
    // source; nothing about being a test makes an invisible byte visible.
    const roots = [SRC, path.join(__dirname, '..')];
    const scan = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p, path.join(rel, e.name)); continue; }
        if (!e.name.endsWith('.js')) continue;
        const buf = fs.readFileSync(p);
        for (const b of buf) {
          const ok = b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
          assert.ok(ok, `${path.join(rel, e.name)} contains a raw control byte `
            + `(0x${b.toString(16).padStart(2, '0')}) — write it as an escape instead`);
        }
      }
    };
    for (const r of roots) scan(r);
  });

  await test('ARCH: exactly ONE byte-snapshot / undo system', () => {
    const snap = files.filter((f) => /capture\s*\(.*Paths|function snapshot\b/.test(f.text)).map((f) => f.file);
    assert.ok(snap.length <= 1, `two snapshot systems: ${snap.join(', ')} (V1 had diffguard AND checkpoint)`);
  });

  await test('ARCH: no plan may be read from the project filesystem', () => {
    for (const f of files) {
      assert.ok(!/plan\.md/.test(stripComments(f.text)), `${f.file} references a project plan file`);
    }
  });

  await test('ARCH: no hidden module-level session/task state', () => {
    for (const f of files) {
      if (f.file === 'mockprovider.js') continue; // documented per-process test double
      const t = stripComments(f.text);
      assert.ok(!/^\s*let\s+(currentSession|boundSession|currentTask|activeSession|_session)\b/m.test(t),
        `${f.file} holds session state at module scope`);
    }
  });

  await test('ARCH: the tool registry is ONE vocabulary — every schema is dispatchable', () => {
    const tools = require('../../src/tools');
    const schemaNames = tools.schemas().map((s) => s.name).sort();
    const dispatch = tools.names().sort();
    assert.deepStrictEqual(schemaNames, dispatch,
      'V1 advertised 68 schemas against 78 dispatch entries — they must be the same list');
  });

  await test('ARCH: shell tools carry no allowlist or command rewriting', () => {
    const shell = files.find((f) => f.file === 'tools/shell.js').text;
    const t = stripComments(shell);
    assert.ok(!/allowlist|allowList|BLOCKED_COMMANDS|DENY|isSafeCommand/i.test(t), 'no command allowlist');
    assert.ok(!/mapCommand|rewriteCommand/i.test(t), 'no silent command rewriting (V1 broke `cat x | head`)');
  });

  await test('ARCH: no command name is registered twice', () => {
    const commands = require('../../src/commands');
    const names = [...commands.REGISTRY.keys()];
    assert.strictEqual(new Set(names).size, names.length, 'duplicate command (V1 shipped two /status cases)');
  });

  await test('ARCH: an extracted helper never uses `this`', () => {
    // THE BUG THIS PREVENTS, and it shipped for about twenty minutes.
    //
    // app.js is split by moving a method into a module and passing `app` in.
    // The rewrite turns `this.x` into `app.x` — and cannot see a `this` used on
    // its OWN. In a plain strict-mode function that is `undefined`, so
    // `commands.run(this, ...)` handed /steer an undefined app and it died on
    // `app.render.write` in the middle of a turn. Nothing in the unit tier
    // could notice: the module loads, exports and reads perfectly. The smoke
    // tier caught it, because it drives the real binary.
    //
    // These files export plain functions over an `app` argument. None has an
    // object to be the `this` of, so any `this` in their code is that bug
    // waiting to happen again at the next split.
    const HELPERS = [
      'repl.js', 'completion.js', 'identify.js', 'interrupt.js', 'turnevents.js',
      'companion.js', 'computer.js', 'keyboarddelivery.js',
    ];
    for (const f of HELPERS) {
      // COMMENTS **AND STRINGS** ARE STRIPPED FIRST. These files explain
      // themselves at length and talk to the user in sentences, and "this
      // Probe has no permission.request" is prose, not the keyword.
      const lines = fs.readFileSync(path.join(SRC, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .split('\n');
      const at = lines.findIndex((l) => /\bthis\b/.test(l));
      assert.strictEqual(at, -1,
        `${f}:${at + 1} uses "this" — it exports plain functions over an app `
        + 'argument, and has no object to be the "this" of');
    }
  });

  await test('ARCH: an extracted helper never uses a name nothing gives it', () => {
    // ---- THE OTHER HALF OF THE `this` RULE, AND IT COST TWO BUGS ----------
    //
    // Splitting a method out of app.js rewrites `this.x` into `app.x`. What it
    // CANNOT see is a bare name the method was reading off the FILE it used to
    // live in — `config`, imported at the top of app.js and simply absent from
    // the module the code moved to. In strict mode that is a ReferenceError,
    // and it fires only in the branch that reads it: for `handleRateLimit`,
    // "change model" during a real multi-hour rate limit.
    //
    // The same shape took the CONTEXT pane down (ui/reports.js read `app` above
    // its own `const app`), which is how often this class arrives. Neither was
    // caught by any test, because both files load, export and read perfectly.
    //
    // `typos.unresolved` will not catch it: it reports only when it can name
    // what was probably meant, and a stray `config` has no near-miss to suggest
    // — that restraint is right for the model-facing channel and wrong here.
    // This is the strict version, aimed at the small set of files where the
    // hazard actually lives: modules that are plain functions over an `app`.
    const codemodel = require('../../src/codemodel');
    const EXTRACTED = [
      'repl.js', 'completion.js', 'identify.js', 'interrupt.js', 'turnevents.js',
      'companion.js', 'computer.js', 'keyboarddelivery.js', 'ratelimit.js', 'failover.js',
      'ui/reports.js', 'ui/contextview.js',
    ];
    const offenders = [];
    for (const rel of EXTRACTED) {
      const p = path.join(SRC, rel);
      if (!fs.existsSync(p)) continue;              // a module may legitimately not exist
      const model = codemodel.scanFile(p);
      if (!model.supported) continue;
      const seen = new Set();
      for (const u of model.used) {
        if (model.bindings.has(u.name) || codemodel.GLOBALS.has(u.name)) continue;
        if (seen.has(u.name)) continue;
        seen.add(u.name);
        offenders.push(`${rel}:${u.line} uses "${u.name}", which nothing here declares, imports or provides`);
      }
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
  });

  await test('ARCH: every source file is reachable from the entry point', () => {
    // V1 shipped command-registry.js and idebridge.js with zero production
    // referrers. A module that nothing requires is dead on arrival.
    const seen = new Set();
    const visit = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const f = files.find((x) => x.file === rel);
      if (!f) return;
      // `../` as well as `./`. Following only `./` meant a module required from
      // a subdirectory by its parent path was reported as an orphan — and, far
      // worse, a genuinely dead module reachable only that way would have been
      // reported as live. The guard was under-matching in both directions.
      for (const m of f.text.matchAll(/require\('(\.\.?\/[^']+)'\)/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        visit(target.endsWith('.js') ? target : target + '.js');
        visit(target + '/index.js');
      }
    };
    visit('cli.js');
    const orphans = files.map((f) => f.file).filter((f) => !seen.has(f));
    assert.deepStrictEqual(orphans, [], `unreachable modules: ${orphans.join(', ')}`);
  });

  await test('ARCH: the evidence ledger never forbids a read', () => {
    const ev = fs.readFileSync(path.join(SRC, 'evidence.js'), 'utf8');
    const substituted = /output:\s*$|output:\s*\n?\s*`/m.test(ev);
    assert.ok(substituted, 'it does substitute');
    assert.ok(!/forbidden|not allowed|you may not|refus/i.test(stripComments(ev).replace(/^.*never.*$/gm, '')),
      'the ledger must never phrase itself as a prohibition');
  });

  await test('ARCH: no mandatory tool ordering anywhere', () => {
    for (const f of files) {
      const t = stripComments(f.text);
      assert.ok(!/must read before|mustReadFirst|requirePlanFirst|forceVerifyAfter/i.test(t),
        `${f.file} imposes a tool order`);
    }
  });
};
