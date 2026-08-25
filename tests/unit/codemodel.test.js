'use strict';

/**
 * THE SCANNER, THE SYMBOL MODEL, AND THE TYPO CHECK.
 *
 * The most important test in this file is the last one, and it is not a unit
 * test at all: it runs the whole thing over THIS REPOSITORY and requires
 * silence. A checker that reports a defect in working code is worse than no
 * checker, because after two false alarms the channel is ignored and the real
 * finding goes with it. 310 correct files is the only calibration that means
 * anything.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('../helpers');

const jsscan = require('../../src/jsscan');
const codemodel = require('../../src/codemodel');
const typos = require('../../src/typos');

const ROOT = path.join(__dirname, '..', '..');

/** Every JavaScript file in the project. The calibration corpus. */
function allSources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(?:js|cjs|mjs)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['src', 'tests', 'bin', 'tools']) walk(path.join(ROOT, d));
  return out;
}

function named(model, name) { return model.symbols.filter((s) => s.name === name); }

module.exports = async function () {
  // -------------------------------------------------------------- scanner ---

  await test('SCAN: a name inside a string, a comment or a regex is NOT a name', () => {
    // The entire reason this exists rather than a regex. Every one of these
    // would be a match for /\bsend\b/ and none of them is the identifier.
    const src = [
      'const url = "https://x/send";',
      '// call send here',
      '/* send */',
      'const re = /send/;',
      'const t = `a send b`;',
      'send();',
    ].join('\n');
    const { tokens } = jsscan.tokenize(src);
    const names = tokens.filter((t) => t.type === jsscan.T.NAME && t.value === 'send');
    assert.strictEqual(names.length, 1, 'only the call is an identifier token');
  });

  await test('SCAN: division and a regex literal are told apart', () => {
    const { tokens } = jsscan.tokenize('const a = count / 2; const b = x.replace(/a+/g, "");');
    const regexes = tokens.filter((t) => t.type === jsscan.T.REGEX);
    assert.strictEqual(regexes.length, 1, 'the division must not be read as a regex');
    assert.strictEqual(regexes[0].value, '/a+/g');
  });

  await test('SCAN: a slash that does not terminate is re-read as division, not left desynchronised', () => {
    // The safety net. A tokeniser that loses its place reports confident
    // nonsense for the rest of the file, which is worse than not running.
    const src = 'const ratio = returned / total;\nconst x = 1;';
    const { tokens } = jsscan.tokenize(src);
    assert.ok(tokens.some((t) => t.type === jsscan.T.NAME && t.value === 'total'));
    assert.ok(tokens.some((t) => t.type === jsscan.T.NAME && t.value === 'x'),
      'the rest of the file must still tokenise');
  });

  await test('SCAN: a template literal holding braces and nested backticks is one token', () => {
    const src = 'const s = `a ${ { k: `${inner}` } } b`; const after = 1;';
    const { tokens } = jsscan.tokenize(src);
    assert.strictEqual(tokens.filter((t) => t.type === jsscan.T.TEMPLATE).length, 1);
    assert.ok(tokens.some((t) => t.value === 'after'), 'and the file continues past it');
  });

  await test('SCAN: every byte of every file in this project is accounted for', () => {
    // ROUND TRIP. If a byte is neither whitespace nor inside exactly one token,
    // the scanner has lost its place — and every range and every rename built
    // on it is then wrong in a way nothing else would notice.
    const files = allSources();
    assert.ok(files.length > 100, `only ${files.length} files found — the walk is broken`);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const { tokens } = jsscan.tokenize(src, { comments: true });
      let pos = 0;
      for (const t of tokens) {
        assert.strictEqual(src.slice(pos, t.start).trim(), '',
          `${path.relative(ROOT, f)}: content skipped at offset ${pos}`);
        assert.strictEqual(src.slice(t.start, t.end), t.value,
          `${path.relative(ROOT, f)}: token text does not match its own offsets`);
        pos = t.end;
      }
      assert.strictEqual(src.slice(pos).trim(), '', `${path.relative(ROOT, f)}: trailing content unconsumed`);
    }
  });

  // --------------------------------------------------------- symbol ranges ---

  await test('SYMBOL: the range of a definition is its exact bytes, and nothing else', () => {
    const src = 'const before = 1;\nfunction target(a, b) {\n  return a + b;\n}\nconst after = 2;\n';
    const m = codemodel.scan(src, 'x.js');
    const s = named(m, 'target')[0];
    assert.strictEqual(src.slice(s.start, s.end), 'function target(a, b) {\n  return a + b;\n}');
    assert.strictEqual(s.startLine, 2);
    assert.strictEqual(s.endLine, 4);
  });

  await test('SYMBOL: async, generators and their modifiers are part of the definition', () => {
    // Replacing a method without its `async` changes what it is.
    const src = 'async function* runTurn(x) { yield x; }\nclass K { static async go() { return 1; } }';
    const m = codemodel.scan(src, 'x.js');
    assert.ok(src.slice(named(m, 'runTurn')[0].start).startsWith('async function*'));
    assert.ok(src.slice(named(m, 'go')[0].start).startsWith('static async go'));
  });

  await test('SYMBOL: a class method knows the class it belongs to', () => {
    const src = 'class A { send() {} }\nclass B { send() {} }';
    const m = codemodel.scan(src, 'x.js');
    const hits = named(m, 'send');
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map((s) => s.container).sort(), ['A', 'B']);
    assert.strictEqual(codemodel.find(m, 'send', { container: 'B' }).length, 1,
      'and asking for one of them returns one');
  });

  await test('SYMBOL: an object literal is a container, so its members are not top-level', () => {
    // This project is written as registries of objects. `ENEMIES.slime` is the
    // name a person would use; reporting `slime` as a top-level declaration
    // makes "what is defined here" answer with the innards of every data table.
    const src = 'const ENEMIES = {\n  slime: { hp: 10 },\n  wolf: { hp: 30 },\n};';
    const m = codemodel.scan(src, 'x.js');
    assert.strictEqual(named(m, 'slime')[0].container, 'ENEMIES');
    assert.deepStrictEqual(m.symbols.filter((s) => !s.container).map((s) => s.name), ['ENEMIES']);
  });

  await test('SYMBOL: a declaration is registered ONCE, not once per matching shape', () => {
    // `function spawn(…) { … }` matches both "a function declaration" and "a
    // name, parens, a block". Registered twice, every lookup of it was then
    // refused as ambiguous against itself.
    const src = 'function spawn(k) { return k; }\nconst f = function named2(){ return 1; };';
    const m = codemodel.scan(src, 'x.js');
    assert.strictEqual(named(m, 'spawn').length, 1);
  });

  await test('SYMBOL: a const holding a function is a FUNCTION, and its range is the whole thing', () => {
    const src = 'const handler = async (req, res) => {\n  return res.end();\n};\n';
    const m = codemodel.scan(src, 'x.js');
    const s = named(m, 'handler')[0];
    assert.strictEqual(s.kind, codemodel.KIND.FUNCTION);
    assert.ok(src.slice(s.start, s.end).includes('res.end()'), 'the body is inside the range');
  });

  await test('SYMBOL: references inside function bodies are collected', () => {
    // They were not, once: the scanner jumped from `function` to the closing
    // brace, so `used` held only module scope and the typo check had almost
    // nothing to check — which reads exactly like a clean file.
    const src = 'function outer() {\n  return helperCall(1);\n}\n';
    const m = codemodel.scan(src, 'x.js');
    assert.ok(m.used.some((u) => u.name === 'helperCall'), 'a call inside a body is a reference');
  });

  await test('SYMBOL: a file that is not JavaScript gets a declared NO, never a guess', () => {
    const m = codemodel.scan('def f(): pass', 'x.py');
    assert.strictEqual(m.supported, false);
    assert.ok(m.why, 'and it says why');
  });

  await test('SYMBOL: every standalone declaration in this project is a range that compiles', () => {
    // The property that makes replace_symbol safe: if the extracted bytes are
    // a complete declaration, then splicing new bytes over exactly that span
    // cannot take a neighbour with it.
    let checked = 0;
    for (const f of allSources()) {
      const m = codemodel.scanFile(f);
      for (const s of m.symbols) {
        if (s.container || (s.kind !== 'function' && s.kind !== 'class')) continue;
        const text = m.source.slice(s.start, s.end);
        if (!/^(?:async\s+)?(?:function|class)\b/.test(text)) continue;
        checked += 1;
        try {
          // eslint-disable-next-line no-new
          new vm.Script(text, { filename: 'range.js' });
        } catch (e) {
          assert.fail(`${path.relative(ROOT, f)}:${s.startLine} ${s.name} — the extracted range does not `
            + `compile on its own: ${e.message}`);
        }
      }
    }
    assert.ok(checked > 500, `only ${checked} ranges checked — the corpus or the scan shrank`);
  });

  // ------------------------------------------------------------ near miss ---

  await test('TYPO: the relation is NAMED, because the name is what makes it actionable', () => {
    assert.match(typos.relation('getUser', 'getUsers'), /plural exists/);
    assert.match(typos.relation('messages', 'message'), /singular exists/);
    assert.match(typos.relation('userName', 'username'), /capitalisation/);
    assert.match(typos.relation('warth', 'width'), /two characters different/);
  });

  await test('TYPO: a name that CONTAINS the other is a naming choice, not a typo', () => {
    // `event` and `onEvent` are two edits apart and are two different names —
    // somebody added a prefix deliberately. A typo replaces characters; a
    // prefix or suffix adds them. Distinguishing those is what let the
    // distance-2 bound come down far enough to reach `warth` for `width`.
    assert.strictEqual(typos.relation('event', 'onEvent'), null);
    assert.strictEqual(typos.relation('render', 'preRender'), null);
    assert.strictEqual(typos.relation('parse', 'parseAll'), null);
  });

  await test('TYPO: short names are never near misses of each other', () => {
    // `id` and `at` are one edit apart and are not each other. Below five
    // characters the measure says nothing, so it says nothing.
    assert.strictEqual(typos.relation('id', 'at'), null);
    assert.strictEqual(typos.relation('x', 'y'), null);
    assert.strictEqual(typos.relation('cat', 'car'), null);
  });

  await test('TYPO: genuinely different names are not offered as suggestions', () => {
    assert.strictEqual(typos.relation('renderPanel', 'classifyShell'), null);
    assert.strictEqual(typos.nearMiss('somethingEntirelyNew', new Set(['renderPanel', 'classify'])), null);
  });

  await test('TYPO: a misspelled call is found, and what was meant is named', () => {
    const src = 'function getUsers(db) { return db.all(); }\n'
      + 'function main(db) { return getUser(db); }\n';
    const found = typos.unresolved(codemodel.scan(src, 'x.js'));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'getUser');
    assert.strictEqual(found[0].suggestion, 'getUsers');
    assert.strictEqual(found[0].line, 2);
  });

  await test('TYPO: an unresolved name with NOTHING close to it is not reported', () => {
    // Gate two, and the reason the channel stays worth reading. A project can
    // reach a name in ways a scanner cannot see; without a near miss there is
    // no finding specific enough to act on without checking.
    const src = 'function main() { return somethingNobodyDeclared(); }';
    assert.deepStrictEqual(typos.unresolved(codemodel.scan(src, 'x.js')), []);
  });

  await test('TYPO: imported, destructured and parameter names all resolve', () => {
    const src = [
      "const { classify, annotate } = require('./execution');",
      "const path = require('path');",
      'function run(input, ctx) {',
      '  const [head, tail] = input.split();',
      '  return classify(annotate(head, tail, ctx, path));',
      '}',
      'const arrow = (item) => item.id;',
      'try { run(); } catch (err) { arrow(err); }',
    ].join('\n');
    assert.deepStrictEqual(typos.unresolved(codemodel.scan(src, 'x.js')), []);
  });

  await test('TYPO: SILENCE over this entire repository — the only calibration that counts', () => {
    // 310 files of working code. Anything reported here is a false positive,
    // and one false positive is enough to make the whole channel worthless.
    const findings = [];
    let references = 0;
    for (const f of allSources()) {
      const m = codemodel.scanFile(f);
      references += m.used.length;
      for (const u of typos.unresolved(m)) {
        findings.push(`${path.relative(ROOT, f)}:${u.line}  ${u.name} -> ${u.suggestion} (${u.why})`);
      }
    }
    assert.ok(references > 20_000, `only ${references} references checked — the scan stopped working`);
    assert.deepStrictEqual(findings, [],
      `the checker flagged working code:\n${findings.join('\n')}`);
  });
};
