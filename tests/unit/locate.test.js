'use strict';

/**
 * `locate` — four answers, one pass, one round trip.
 *
 * ------------------------------------------------------------------------
 * WHAT THESE TESTS ARE ACTUALLY PROTECTING.
 *
 * The measured incident was 815 requests at ~65,000 input tokens each returning
 * ~36 output tokens. The model was not being wasteful; asked to change one
 * function it had to run `symbols` -> `read_symbol` -> `dependents` -> maybe a
 * `read_file`, and every arrow is a full request. Four hops for four facts that
 * one walk over the tree already knows.
 *
 * So what is pinned here is the COMPOSITION: that a single call answers where a
 * thing is declared, what it is, who references it and what imports it — and
 * that it stays honest about being lexical while doing so.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const locate = require('../../src/locate');

/** A tiny project with a real shape: a definition, callers, and an importer. */
function project() {
  const root = tmpdir('lain-locate-');
  const write = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('src/settings.js', [
    "'use strict';",
    '',
    '// The one place a setting is written down.',
    'function saveSettings(next) {',
    '  const merged = { ...current(), ...next };',
    '  writeToDisk(merged);',
    '  return merged;',
    '}',
    '',
    'function current() { return {}; }',
    'function writeToDisk(x) { return x; }',
    '',
    'module.exports = { saveSettings, current };',
  ].join('\n'));
  write('src/ui/settingspane.js', [
    "const { saveSettings } = require('../settings');",
    'function onSave(form) {',
    '  saveSettings(form.values);',
    '  saveSettings(form.extra);',
    '}',
    'module.exports = { onSave };',
  ].join('\n'));
  write('src/app.js', [
    "const settings = require('./settings');",
    'function boot() { return settings.saveSettings({}); }',
    'module.exports = { boot };',
  ].join('\n'));
  write('README.md', '# demo\n\nCall saveSettings to persist.\n');
  return root;
}

module.exports = async function () {
  await test('LOCATE: one call answers where, what, who and what-breaks', () => {
    const root = project();
    const r = locate.locate(root, 'saveSettings');
    assert.ok(r.ok, r.text);

    // ---- WHERE ------------------------------------------------------------
    assert.match(r.text, /DECLARED in 1 place/);
    assert.match(r.text, /src\/settings\.js:4/);

    // ---- WHAT — the definition itself, because that is what gets changed ---
    assert.match(r.text, /DEFINITION src\/settings\.js:4-8/);
    assert.match(r.text, /const merged = \{ \.\.\.current\(\), \.\.\.next \};/);

    // ---- WHO — counted per file, not forty lines of matches ---------------
    assert.match(r.text, /REFERENCED \d+ time\(s\) across \d+ file\(s\)/);
    assert.match(r.text, /src\/ui\/settingspane\.js/);
    assert.match(r.text, /src\/app\.js/);

    // ---- WHAT BREAKS ------------------------------------------------------
    assert.match(r.text, /src\/settings\.js IS IMPORTED BY 2 file\(s\)/);

    // AND IT SAYS WHAT IT IS. A very good index is not a compiler.
    assert.match(r.text, /LEXICAL/);
  });

  await test('LOCATE: references are counted per file rather than listed line by line', () => {
    // THE COST THAT MADE THE OLD ANSWER EXPENSIVE. "2 uses in settingspane.js"
    // is what a decision is made with; the individual lines behind it are what
    // a `read_file` is for.
    const root = project();
    const r = locate.locate(root, 'saveSettings');
    const refBlock = r.text.split('REFERENCED')[1].split('\n\n')[0];
    // THREE, not two: the destructuring `require` line mentions the name as
    // well as the two calls. That is the honest lexical count, and the caveat
    // on every answer says as much — a reader deciding where to work wants the
    // import line counted, not silently discounted.
    assert.match(refBlock, /3\s+src\/ui\/settingspane\.js/);
    // No line:column rows in the reference section — that is the whole point.
    assert.ok(!/settingspane\.js:\d+:/.test(refBlock), 'references must be counted, not enumerated');
  });

  await test('LOCATE: a path asks a different question and gets a different answer', () => {
    const root = project();
    const r = locate.locate(root, 'src/settings.js');
    assert.ok(r.ok, r.text);
    assert.strictEqual(r.meta.kind, 'file');
    // What the file DEFINES, and what depends on it.
    assert.match(r.text, /DEFINES \d+ symbol\(s\)/);
    assert.match(r.text, /saveSettings/);
    assert.match(r.text, /IMPORTED BY 2 file\(s\)/);
  });

  await test('LOCATE: a name that exists nowhere says so plainly', () => {
    const root = project();
    const r = locate.locate(root, 'saveSettingz');
    assert.ok(r.ok, 'a miss is an answer, not an error');
    assert.match(r.text, /does not appear in \d+ file\(s\)/);
    assert.match(r.text, /has not been written yet/);
    assert.strictEqual(r.meta.refs, 0);
  });

  await test('LOCATE: a name used but never declared is reported as exactly that', () => {
    // The two things this distinguishes are a typo and an import from a
    // dependency, and a reader can tell them apart only if it is said.
    const root = tmpdir('lain-locate-undef-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function go() { return lodashy(1); }\n');
    const r = locate.locate(root, 'lodashy');
    assert.match(r.text, /DECLARED nowhere in this project/);
    assert.match(r.text, /comes from a dependency, or it is misspelled/);
  });

  await test('LOCATE: free text is refused toward the tool that handles it', () => {
    const root = project();
    const r = locate.locate(root, 'where do we save the settings');
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /neither a file in this project nor an identifier/);
    assert.match(r.text, /grep/, 'and it names what to use instead');
  });

  await test('LOCATE: a long definition is cut with the range named and a way to get the rest', () => {
    const root = tmpdir('lain-locate-long-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const body = ['function huge() {'];
    for (let i = 0; i < 200; i++) body.push(`  const v${i} = ${i};`);
    body.push('  return 0;', '}');
    fs.writeFileSync(path.join(root, 'src', 'huge.js'), body.join('\n'));
    const r = locate.locate(root, 'huge');
    assert.match(r.text, /DEFINITION .*\(function, 20[0-9] lines\)/);
    // ESCALATION, NOT A WALL: the cap is reported and the next step is named.
    assert.match(r.text, /more lines — read_symbol huge for the whole definition/);
  });

  await test('LOCATE: the tool is registered and reachable from the live tool list', () => {
    // §31: a capability that is not advertised is not implemented. This is the
    // assertion that would fail if the composition existed only as a module.
    const tools = require('../../src/tools');
    assert.ok(tools.names().includes('locate'), 'locate must be in the live vocabulary');
    // It moved to its own family when search.js crossed the god-object guard —
    // see src/tools/intel.js. The assertion is about the LIVE vocabulary, so it
    // follows the tool rather than pinning the file it used to live in.
    const schema = require('../../src/tools/intel').tools.locate.schema;
    assert.match(schema.description, /START HERE/, 'and it must say when to reach for it');
    assert.match(schema.description, /LEXICAL/, 'and be honest about what it is not');
    assert.strictEqual(require('../../src/tools/intel').tools.locate.mutates, false);
  });
};
