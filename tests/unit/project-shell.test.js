'use strict';

/**
 * Project orientation and shell selection — the two places where deterministic
 * local work replaces something the model would otherwise pay a round-trip for.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const project = require('../../src/project');
const shell = require('../../src/tools/shell');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-proj-'));
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test/a.js', build: 'tsc' } }));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), '');
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), '');
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), '');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), '');
  return root;
}

module.exports = async function () {
  const root = fixture();

  await test('PROJECT: the brief names the source files, not just the top level', () => {
    const b = project.brief(root);
    // These three facts cost the model three tool calls on a measured real run.
    assert.match(b, /src\/:/, 'the source directory must be described');
    assert.match(b, /auth\.js/);
    assert.match(b, /a\.test\.js/, 'tests are where verification lives');
    assert.match(b, /npm run test/, 'how to run it is orientation, not an index');
  });

  await test('PROJECT: nested source directories are NAMED but not walked', () => {
    const b = project.brief(root);
    assert.match(b, /auth\//, 'a subdirectory is worth knowing exists');
    // One readdir per named directory. A recursive walk is how a brief becomes
    // the 6,000-token digest this deliberately is not.
    const scan = project.scan(root);
    assert.ok(scan.tree.every((t) => !/\//.test(t.dir)), 'only top-level source dirs are described');
  });

  await test('PROJECT: generated trees never appear in the brief', () => {
    assert.ok(!/node_modules/.test(project.brief(root)), 'the SKIP set is shared with completion and search');
  });

  await test('PROJECT: non-code files inside a source dir are not listed', () => {
    const scan = project.scan(root);
    const src = scan.tree.find((t) => t.dir === 'src');
    assert.ok(src.files.includes('auth.js'));
    assert.ok(!src.files.includes('notes.md'), 'the brief describes code, not every file');
  });

  await test('PROJECT: the brief NAMES the modules — that is what it is for', () => {
    // ---- WHY THIS ASSERTION CHANGED -----------------------------------
    //
    // It used to require `+N more` on THIS repository, which passed because the
    // brief showed twelve files per directory and hid a hundred and forty-two.
    // That is the defect, not the contract: a model asked for "a helper that
    // formats byte sizes" could not see that `numfmt.js` already existed, so
    // the cheapest answer to "does this already exist" was a search it had no
    // reason to run.
    //
    // The brief lives in the system prompt, which is the cached prefix of every
    // request, so listing the inventory costs ~660 tokens once per session.
    // The truncation contract still holds and is asserted below, on a tree that
    // genuinely exceeds the bound.
    const b = project.brief(path.join(__dirname, '..', '..'));
    assert.ok(b.length <= project.MAX_CHARS, `brief is ${b.length} chars, cap is ${project.MAX_CHARS}`);
    for (const mod of ['numfmt.js', 'steerqueue.js', 'promptcache.js']) {
      assert.ok(b.includes(mod), `the brief must name ${mod} — otherwise the model cannot know it exists`);
    }
  });

  await test('PROJECT: a directory too large to list is COUNTED, never dumped', () => {
    // The bound that matters, on a tree that actually needs it. The file-count
    // cap alone got this wrong in both directions — at twelve it hid an ordinary
    // project, and raised far enough to show one it turned a huge directory into
    // a single enormous line that then blew the character cap and was dropped
    // WHOLE. Characters per line is the bound that behaves at both sizes.
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bigrepo-'));
    try {
      fs.mkdirSync(path.join(big, 'src'));
      for (let i = 0; i < 1200; i++) {
        fs.writeFileSync(path.join(big, 'src', `module_with_a_longish_name_${i}.js`), '// x');
      }
      fs.writeFileSync(path.join(big, 'package.json'), JSON.stringify({ name: 'big' }));
      const b = project.brief(big);
      assert.ok(b.length <= project.MAX_CHARS, `brief is ${b.length} chars, cap is ${project.MAX_CHARS}`);
      assert.match(b, /\+\d+ more/, 'a long directory is truncated with a count, never dumped');
      // AND THE LISTING SURVIVES. Dropping the whole line would be worse than
      // truncating it: the large repository would lose its inventory entirely.
      assert.match(b, /^src\/: module_with_a_longish_name_0\.js/m,
        'the directory must still be listed, not silently omitted');
    } finally {
      fs.rmSync(big, { recursive: true, force: true });
    }
  });

  await test('PROJECT: a directory that cannot be read does not break the brief', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-empty-'));
    assert.doesNotThrow(() => project.brief(empty));
    assert.doesNotThrow(() => project.brief(path.join(empty, 'does-not-exist')));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ shell --

  // ---- ORIENTATION CARRIES MEANING, NOT ONLY NAMES ------------------------
  //
  // The measured failure: request contexts climbing 109k → 193k while the model
  // read files one at a time to learn what an unfamiliar project was, because
  // the brief gave it filenames and no meaning. Most maintained repositories
  // already answer this in prose that orientation was throwing away.
  function documented() {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'README.md'), [
      '# Widgets', '',
      '[![build](https://img.shields.io/x)](https://x)', '',
      'A service that renders widgets for downstream consumers, with a queue in front of it.', '',
      '## Install', 'run it', '',
      '## Architecture', 'the parts and how they connect', '',
      '## Tests', 'how to run them', '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'DESIGN.md'), '# design');
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ bin: { widgets: 'bin/w.js' }, main: 'src/index.js', scripts: { test: 'node t.js' } }));
    return root;
  }

  await test('PROJECT: the brief says what the project IS, in the project\'s own words', () => {
    const b = project.brief(documented());
    assert.ok(/renders widgets for downstream consumers/.test(b),
      `the README's own description of itself must reach the model:\n${b.slice(0, 300)}`);
    assert.ok(!/img\.shields\.io/.test(b), 'a badge is furniture, not a description');
    assert.ok(!/^# Widgets/m.test(b), 'the title is not the description');
  });

  await test('PROJECT: the brief POINTS at documentation with line numbers, and does not inline it', () => {
    const b = project.brief(documented());
    assert.ok(/Architecture \(line \d+\)/.test(b),
      `a section pointer must carry its line so the model can read a RANGE:\n${b.slice(0, 400)}`);
    assert.ok(/docs\/: DESIGN\.md/.test(b), 'other documentation is named');
    assert.ok(!/the parts and how they connect/.test(b),
      'the section BODY must stay on disk — a pointer, never the document');
  });

  await test('PROJECT: where execution starts is declared, not left to be inferred', () => {
    const b = project.brief(documented());
    assert.ok(/Entry point\(s\):/.test(b) && /bin\/w\.js/.test(b) && /src\/index\.js/.test(b),
      `the manifest already says this:\n${b.slice(0, 400)}`);
  });

  await test('PROJECT: MEANING COMES FIRST, so a huge tree loses names and never the description', () => {
    const b = project.brief(documented());
    assert.ok(b.indexOf('renders widgets') < b.indexOf('Top level:'),
      'the listing is what truncation must eat — it has to come last');
  });

  await test('PROJECT: a project that documents nothing gets no invented description', () => {
    const b = project.brief(fixture());
    assert.ok(!/What this project says it is/.test(b), 'silence is the honest answer');
    assert.ok(/src\/: /.test(b), 'and the rest of the brief still works');
  });

  // ---- ORIENTATION MUST BE ENOUGH TO AIM WITH -----------------------------
  //
  // The behavioural invariant, deliberately not tied to any tool name: BEFORE
  // reading a single source file, what the model is handed must answer "what is
  // this, where is it written down, where does it start, and what exists here".
  // A future change that reduces the brief to a directory listing again — the
  // state in which contexts climbed 109k -> 193k — fails this.
  await test('ORIENT: an unfamiliar project can be aimed at without reading any source', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-orient-'));
    fs2.mkdirSync(path2.join(root, 'src'), { recursive: true });
    fs2.writeFileSync(path2.join(root, 'README.md'), [
      '# Ledger', '',
      'A double-entry accounting service that reconciles transactions nightly.', '',
      '## Architecture', 'the reconciler and the ingest path', '',
      '## Running it', 'npm start', '',
    ].join(String.fromCharCode(10)));
    fs2.writeFileSync(path2.join(root, 'package.json'), JSON.stringify({ main: 'src/index.js', scripts: { start: 'node src/index.js' } }));
    fs2.writeFileSync(path2.join(root, 'src', 'reconciler.js'), 'const SECRET_BODY = 1;' + String.fromCharCode(10));
    fs2.writeFileSync(path2.join(root, 'src', 'index.js'), 'const OTHER_BODY = 2;' + String.fromCharCode(10));

    const b = project.brief(root);

    // WHAT it is — from prose, not guessed from a filename.
    assert.ok(/double-entry accounting/.test(b), 'the purpose must be present');
    // WHERE it is documented, precisely enough to read a range instead of a file.
    assert.ok(/Architecture \(line \d+\)/.test(b), 'documentation must be locatable by line');
    // WHERE it starts.
    assert.ok(/src\/index\.js/.test(b), 'the entry point must be named');
    // WHAT exists — so nothing gets rebuilt that is already there.
    assert.ok(/reconciler\.js/.test(b), 'the module inventory must survive alongside the meaning');

    // AND IT COST NO SOURCE READS. If a body ever appears here, orientation has
    // started doing the reading it exists to prevent.
    assert.ok(!/SECRET_BODY/.test(b) && !/OTHER_BODY/.test(b),
      'orientation must not inline source — it points, it does not read');
  });

  await test('SHELL: the WSL launcher is recognised and never chosen as bash', () => {
    assert.ok(shell.isWslShim('C:\\Windows\\System32\\bash.exe'));
    assert.ok(shell.isWslShim('c:/windows/system32/bash.exe'));
    assert.ok(shell.isWslShim('C:\\Windows\\SysWOW64\\bash.exe'));
    // A real bash never lives there.
    assert.ok(!shell.isWslShim('C:\\Program Files\\Git\\bin\\bash.exe'));
    assert.ok(!shell.isWslShim('/bin/sh'));
  });

  await test('SHELL: findBash resolves to something that is not the WSL shim', () => {
    const p = shell.findBash();
    assert.ok(p, 'a shell must always be named');
    assert.ok(!shell.isWslShim(p), `resolved to the WSL launcher: ${p}`);
    if (process.platform !== 'win32') assert.strictEqual(p, '/bin/sh');
  });

  await test('SHELL: the command string is never rewritten — pipes and redirects survive', async () => {
    const r = await shell.run('echo one && echo two | tr a-z A-Z', { shell: 'bash', cwd: root });
    // V1 rewrote shell commands into tool calls on Windows and destroyed exactly
    // this kind of pipeline. The command must reach the shell verbatim.
    assert.match(r.output, /one/);
    assert.match(r.output, /TWO/, 'the pipeline must actually run as a pipeline');
  });

  await test('SHELL: a non-zero exit is reported with its code, not hidden', async () => {
    const r = await shell.run('exit 3', { shell: 'bash', cwd: root });
    assert.strictEqual(r.exitCode, 3);
    assert.strictEqual(r.isError, true, 'the completion gate reads this');
  });

  fs.rmSync(root, { recursive: true, force: true });
};
