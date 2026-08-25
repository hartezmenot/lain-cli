'use strict';

/**
 * A STALE READ MAY NOT BLINDLY PATCH — OR OVERWRITE — A CHANGED TARGET.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS ACTUALLY WRONG, because it was not what the model said it was.
 *
 * A patch was refused and the model reported: "the apply_patch rejected because
 * the expect text isn't found EXACTLY — probably whitespace." That is a guess,
 * and it was produced by a rejection that gave nothing else to go on:
 *
 *     REASON: the expected text is not in the file.
 *
 * The symptom restated. `apply_patch` was SAFE the whole time — it re-reads the
 * file and compares content, so a changed target fails rather than corrupting
 * anything — but a refusal that cannot say WHY leaves the model two moves, and
 * both are bad: retry blind, or fall back to `write_file` and rewrite the whole
 * file from bytes that are no longer current.
 *
 * ------------------------------------------------------------------------
 * AND THAT FALLBACK WAS THE REAL HOLE. `write_file` had no staleness check at
 * all. Read a file, let another session edit it, write it back whole: the other
 * session's work is gone, and the result line says `wrote … (N bytes)`. Data
 * loss reported as success. That is the one mutation in the tool set that can
 * destroy work nobody saw, and it is reachable exactly when a second LAIN
 * session, an editor or a build step shares the tree — which is not
 * hypothetical; it was observed on this machine.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED. Real files on disk, real modification between the read and
 * the write, the real tool registry. Every case below distinguishes a CAUSE, so
 * a future refusal never has to be guessed at again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const tools = require('../../src/tools');
const { Session } = require('../../src/session');

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const NBSP = String.fromCharCode(0xa0);

/** A session whose evidence ledger has genuinely READ the file. */
async function afterReading(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  const session = new Session({ cwd: dir });
  const ctx = { cwd: dir, session };
  const r = await tools.execute('read_file', { path: name }, ctx);
  session.evidence.observe('read_file', { path: name }, r);
  return { ctx, file, session };
}

/** Something other than LAIN edits the file. The mtime must really move. */
function editedElsewhere(file, body) {
  const then = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, body, 'utf8');
  // A filesystem with coarse timestamps could report the same mtime; the size
  // differs in every case here, and `staleness` compares both.
  const now = fs.statSync(file).mtimeMs;
  return { moved: now !== then };
}

module.exports = async function () {
  await test('STALE: apply_patch names the CONCURRENT EDIT, and writes nothing', async () => {
    const dir = tmpdir('stale-patch-');
    const { ctx, file } = await afterReading(dir, 't.js', `one${NL}two${NL}three${NL}`);
    editedElsewhere(file, `one${NL}two CHANGED BY ANOTHER SESSION${NL}three${NL}`);

    const r = await tools.execute('apply_patch', { path: 't.js', expect: `two${NL}`, replace: `2${NL}` }, ctx);
    assert.ok(r.isError, 'it must refuse');
    assert.match(r.output, /PATCH CONFLICT/, 'and name the conflict, not the symptom');
    assert.match(r.output, /changed after you read it/);
    assert.match(r.output, /NOTHING WAS WRITTEN/);
    assert.ok(!/probably|might be|perhaps/i.test(r.output), 'a mutation system does not speculate');
    assert.strictEqual(fs.readFileSync(file, 'utf8'),
      `one${NL}two CHANGED BY ANOTHER SESSION${NL}three${NL}`,
      "the other session's edit must survive untouched");
  });

  await test('STALE: write_file REFUSES to overwrite a file that changed after the read', async () => {
    // The one that could silently destroy work. Before the guard this wrote the
    // file and reported success.
    const dir = tmpdir('stale-write-');
    const { ctx, file } = await afterReading(dir, 'w.js', `original${NL}`);
    editedElsewhere(file, `edited by somebody else${NL}`);

    const r = await tools.execute('write_file', { path: 'w.js', content: `whole file from a stale read${NL}` }, ctx);
    assert.ok(r.isError, 'it must refuse');
    assert.match(r.output, /WRITE CONFLICT/);
    assert.match(r.output, /NOTHING WAS WRITTEN/);
    assert.match(r.output, /apply_patch/, 'and point at the mutation that cannot lose an edit');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `edited by somebody else${NL}`);
  });

  await test('STALE: a file this session never read is refused as NO_INSPECTION_PROVENANCE', async () => {
    // The complement of every case above: no read, no foreign write, nothing
    // stale — just an existing file and a session about to replace it with
    // bytes composed from nothing it inspected. Creation names a file that
    // does not exist; this names one that does, and the difference is the
    // bytes nobody here has seen.
    const dir = tmpdir('stale-unread-');
    const file = path.join(dir, 'fresh.js');
    fs.writeFileSync(file, `whatever${NL}`, 'utf8');
    const ctx = { cwd: dir, session: new Session({ cwd: dir }) };
    const r = await tools.execute('write_file', { path: 'fresh.js', content: `new${NL}` }, ctx);
    assert.ok(r.isError, 'a whole-file write to a never-read target must refuse');
    assert.match(r.output, /NO_INSPECTION_PROVENANCE/);
    assert.ok(!/WRITE CONFLICT/.test(r.output), 'no read happened, so nothing went stale');
    assert.ok(!/another job/.test(r.output), 'and nobody else wrote it either — it was never read at all');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `whatever${NL}`, 'NOTHING WAS WRITTEN');
  });

  await test('STALE: read, unchanged, then write — the ordinary path proceeds', async () => {
    // The middle case between the two around it: inspection happened, nothing
    // changed since, so the write is exactly as informed as it looks and the
    // guards must be silent.
    const dir = tmpdir('stale-fresh-');
    const { ctx } = await afterReading(dir, 'p.js', `a${NL}`);
    const r = await tools.execute('write_file', { path: 'p.js', content: `b${NL}` }, ctx);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'p.js'), 'utf8'), `b${NL}`);
  });

  await test("STALE: LAIN's OWN write is never reported as somebody else's change", async () => {
    // `observe` clears the ledger entry after every mutation, so a session that
    // reads, writes, and writes again must not accuse itself. A guard that
    // false-positives on its own work is a guard that gets switched off.
    const dir = tmpdir('stale-self-');
    const { ctx } = await afterReading(dir, 's.js', `a${NL}`);
    const first = await tools.execute('write_file', { path: 's.js', content: `b${NL}` }, ctx);
    assert.ok(!first.isError, first.output);
    ctx.session.evidence.observe('write_file', { path: 's.js' }, first);
    const second = await tools.execute('write_file', { path: 's.js', content: `c${NL}` }, ctx);
    assert.ok(!second.isError, second.output);
    assert.strictEqual(fs.readFileSync(path.join(dir, 's.js'), 'utf8'), `c${NL}`);
  });

  // ---- THE OTHER CAUSES, EACH NAMED RATHER THAN GUESSED AT ---------------

  await test('STALE: TABS against spaces is diagnosed as whitespace, and says which', async () => {
    const dir = tmpdir('why-tabs-');
    const file = path.join(dir, 'a.js');
    fs.writeFileSync(file, `head${NL}${TAB}return cache;${NL}foot${NL}`, 'utf8');
    const ctx = { cwd: dir };                       // no ledger: no stale claim
    const r = await tools.execute('apply_patch',
      { path: 'a.js', expect: `    return cache;${NL}`, replace: `    return x;${NL}` }, ctx);
    assert.ok(r.isError);
    assert.match(r.output, /WHITESPACE differs/);
    assert.match(r.output, /file indents with TABS/);
  });

  await test('STALE: an INVISIBLE character is named with its code point', async () => {
    const dir = tmpdir('why-nbsp-');
    const file = path.join(dir, 'b.js');
    fs.writeFileSync(file, `head${NL}const y = 2;${NL}foot${NL}`, 'utf8');
    const ctx = { cwd: dir };
    const r = await tools.execute('apply_patch',
      { path: 'b.js', expect: `const y =${NBSP}2;${NL}`, replace: `const y = 3;${NL}` }, ctx);
    assert.ok(r.isError);
    assert.match(r.output, /invisible character \(U\+00A0\)/);
  });

  await test('STALE: text that is genuinely absent still gets the closest-line report', async () => {
    // The fallback must survive. A diagnosis that fires on everything would be
    // a diagnosis that means nothing.
    const dir = tmpdir('why-absent-');
    fs.writeFileSync(path.join(dir, 'c.js'),
      `alpha${NL}const total = count + 1;${NL}gamma${NL}`, 'utf8');
    const ctx = { cwd: dir };

    // Close enough that `closestLine` can point at it — a majority of the words
    // are shared, which is the threshold it requires before offering one.
    const near = await tools.execute('apply_patch',
      { path: 'c.js', expect: `const total = count + 2;${NL}`, replace: `z${NL}` }, ctx);
    assert.ok(near.isError);
    assert.match(near.output, /the expected text is not in the file/);
    assert.match(near.output, /closest line/, near.output);

    // And nothing like it at all: the honest answer is that there is nothing to
    // point at, which is what it says rather than offering an unrelated line.
    const far = await tools.execute('apply_patch',
      { path: 'c.js', expect: `wholly unrelated content here${NL}`, replace: `z${NL}` }, ctx);
    assert.ok(far.isError);
    assert.match(far.output, /Nothing resembling the first line was found/);
  });

  await test('STALE: none of this blocks an ordinary, correct patch', async () => {
    const dir = tmpdir('why-happy-');
    const { ctx, file } = await afterReading(dir, 'd.js', `keep${NL}change me${NL}keep${NL}`);
    const r = await tools.execute('apply_patch',
      { path: 'd.js', expect: `change me${NL}`, replace: `changed${NL}` }, ctx);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `keep${NL}changed${NL}keep${NL}`);
  });
};
