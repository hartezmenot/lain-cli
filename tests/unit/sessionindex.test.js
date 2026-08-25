'use strict';

/**
 * `/resume` MUST NOT BE A MEMORY TEST.
 *
 * The command took an id and nothing else, and `/sessions` listed the same ids:
 *
 *     20260817-225319-78b1
 *     20260818-042858-06yn
 *
 * That is a filename — a timestamp plus four random characters — and it was the
 * only handle the user had on their own work. Nothing in it says which one was
 * the dashboard bug.
 *
 * What these hold: sessions are described by their CONTENT, sorted by when they
 * were last touched, searchable by what they were about, and the id is never
 * required. And the two rules that must survive the change: nothing resumes
 * itself, and nothing is claimed to have been restored without looking.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const idx = require('../../src/sessionindex');

/** Write a session file the way Session.save() does, with a chosen mtime. */
function write(dir, id, data, agoMs = 0) {
  const f = path.join(dir, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  if (agoMs) {
    const t = new Date(Date.now() - agoMs);
    fs.utimesSync(f, t, t);
  }
  return f;
}

const session = (over = {}) => ({
  id: over.id || 'x', createdAt: '2026-08-18T09:18:00.000Z',
  cwd: over.cwd || 'C:\\work\\scalpbot',
  messages: over.messages || [],
  turns: over.turns || [],
  task: over.task === undefined ? { objective: 'the dashboard stopped updating', steers: [] } : over.task,
  lifecycle: over.lifecycle === undefined
    ? { state: 'VERIFYING', lastCommand: { command: 'pytest', ok: true }, evidence: { filesChanged: ['a.py', 'b.py'] } }
    : over.lifecycle,
  plan: over.plan || null,
  actors: over.actors || [],
});

module.exports = async function () {
  // ------------------------------------------------------------- describing --

  await test('INDEX: a session is described by what it WAS, not by its key', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-091800-abcd', session());
    const [s] = idx.summaries({ dir });
    assert.strictEqual(s.project, 'scalpbot');
    assert.strictEqual(s.objective, 'the dashboard stopped updating');
    assert.strictEqual(s.state, 'VERIFYING');
    assert.strictEqual(s.filesChanged, 2);
    assert.deepStrictEqual(s.lastCommand, { command: 'pytest', ok: true });
    // The id is still there — as metadata, which is all it ever was.
    assert.strictEqual(s.id, '20260818-091800-abcd');
    assert.strictEqual(s.shortId, 'abcd');
  });

  await test('INDEX: the headline is enough to recognise it without the id', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-091800-abcd', session());
    const [s] = idx.summaries({ dir });
    assert.match(idx.headline(s), /dashboard stopped updating/);
    assert.match(idx.statsLine(s), /2 files changed/);
    assert.match(idx.statsLine(s), /VERIFYING/);
  });

  await test('INDEX: nothing is invented for a session that did nothing', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-010101-zzzz', session({ task: null, lifecycle: null }));
    const [s] = idx.summaries({ dir });
    assert.strictEqual(s.objective, null);
    assert.strictEqual(s.state, null);
    assert.strictEqual(s.filesChanged, 0);
    assert.match(idx.headline(s), /no task was ever started/);
  });

  await test('INDEX: a session that will not parse is REPORTED, not skipped', () => {
    // A session that exists and cannot be opened is a fact worth having; a
    // silently shorter list is how a missing file goes unnoticed.
    const dir = tmpdir('sidx-');
    fs.writeFileSync(path.join(dir, '20260818-020202-brok.json'), '{ not json', 'utf8');
    const [s] = idx.summaries({ dir });
    assert.ok(s.unreadable, 'the failure must be carried on the row');
    assert.match(idx.headline(s), /unreadable/);
  });

  // --------------------------------------------------------------- ordering --

  await test('INDEX: sorted by LAST ACTIVITY, newest first', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-old1', session({ cwd: 'C:\\work\\older' }), 3 * 86400000);
    write(dir, '20260818-000002-mid1', session({ cwd: 'C:\\work\\middle' }), 86400000);
    write(dir, '20260818-000003-new1', session({ cwd: 'C:\\work\\newest' }), 0);
    const list = idx.summaries({ dir });
    assert.deepStrictEqual(list.map((s) => s.project), ['newest', 'middle', 'older']);
  });

  await test('INDEX: today and yesterday are named, older ones are dated', () => {
    // ANCHORED TO CALENDAR DAYS, not to a number of hours.
    //
    // This wrote a file 26 hours old and expected YESTERDAY, which is only true
    // when the clock is past 02:00 — run at 01:33 it lands two calendar days
    // back and reads `Aug 17`. The grouping is about which DAY something
    // happened, so the fixture has to be built the same way, or the test fails
    // for an hour every night and tells you nothing when it does.
    const noon = (daysAgo) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - daysAgo);
      return Date.now() - d.getTime();
    };
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000003-new1', session(), 0);
    write(dir, '20260818-000002-mid1', session(), noon(1));
    write(dir, '20260818-000001-old1', session(), noon(6));
    const list = idx.summaries({ dir });
    assert.strictEqual(list[0].when.group, 'TODAY');
    assert.strictEqual(list[1].when.group, 'YESTERDAY');
    assert.match(list[2].when.group, /^[A-Z][a-z]{2} \d+$/, 'older ones carry a date');
  });

  await test('INDEX: the cost is bounded by the limit, not by how many exist', () => {
    const dir = tmpdir('sidx-');
    for (let i = 0; i < 40; i++) write(dir, `20260818-0000${String(i).padStart(2, '0')}-s${i}`, session(), i * 60000);
    assert.strictEqual(idx.summaries({ dir, limit: 5 }).length, 5);
    assert.ok(idx.summaries({ dir, limit: 500 }).length <= idx.MAX_LIMIT, 'and the ceiling really is a ceiling');
  });

  // ---------------------------------------------------------------- search --

  await test('INDEX: search matches what the session was ABOUT', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-aaaa', session({ task: { objective: 'the dashboard stopped updating' } }), 0);
    write(dir, '20260818-000002-bbbb', session({ cwd: 'C:\\work\\lain-v2', task: { objective: 'MCP desktop investigation' } }), 1000);
    const all = idx.summaries({ dir });
    assert.deepStrictEqual(idx.search(all, 'dashboard').map((s) => s.shortId), ['aaaa']);
    assert.deepStrictEqual(idx.search(all, 'mcp').map((s) => s.shortId), ['bbbb']);
    // The PROJECT is searchable too — often the only word a person remembers.
    assert.deepStrictEqual(idx.search(all, 'lain-v2').map((s) => s.shortId), ['bbbb']);
  });

  await test('INDEX: every word must match, so a search really narrows', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-aaaa', session({ task: { objective: 'the dashboard stopped updating' } }), 0);
    write(dir, '20260818-000002-bbbb', session({ task: { objective: 'the dashboard button moved' } }), 1000);
    const all = idx.summaries({ dir });
    assert.strictEqual(idx.search(all, 'dashboard').length, 2);
    assert.deepStrictEqual(idx.search(all, 'dashboard button').map((s) => s.shortId), ['bbbb']);
  });

  await test('INDEX: `today` and `recent` are searches too', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-aaaa', session(), 0);
    write(dir, '20260818-000002-bbbb', session(), 4 * 86400000);
    const all = idx.summaries({ dir });
    assert.deepStrictEqual(idx.search(all, 'today').map((s) => s.shortId), ['aaaa']);
    assert.strictEqual(idx.search(all, 'recent').length, 2);
  });

  // ------------------------------------------------------- what must not move --

  await test('INDEX: it READS — it never resumes, and never writes a session', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sessionindex.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/writeFileSync|renameSync|unlinkSync/.test(code), 'the index must not write anything');
    assert.ok(!/Session\.resume|\.adopt\(/.test(code), 'and it must not resume anything');
  });

  await test('RESUME: an id still resolves, before any search is attempted', () => {
    // Someone holding an id — from a --resume hint, from a script, from notes —
    // must not be told to go and browse for it.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'resume.js'), 'utf8');
    const first = src.indexOf('Session.match(query)');
    const search = src.indexOf('sessionIndex.search');
    assert.ok(first > 0 && first < search, 'an exact id must be tried before the browser');
  });

  await test('RESUME: Session.resume stays the ONE path across a session boundary', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'resume.js'), 'utf8');
    assert.match(src, /Session\.resume\(id\)/);
    // And what came back is still CHECKED rather than claimed.
    assert.match(src, /continuity\.resumeSummary/);
  });

  await test('RESUME: the session store carries the OTHER VOICES, so a review survives', () => {
    // The external review used to live only on the UI object, so a resumed
    // session came back with its transcript, its objective and its changed
    // files while the reviewer that produced half of them was simply gone.
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: process.cwd() });
    s.actors.push({ kind: 'external', text: 'FACT: the writer is stale.', afterTurns: 1 });
    const round = JSON.parse(JSON.stringify(s.toJSON()));
    assert.deepStrictEqual(round.actors, [{ kind: 'external', text: 'FACT: the writer is stale.', afterTurns: 1 }]);
  });

  await test('RESUME: a session saved before this existed simply has no voices', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000009-oldx', session({ actors: undefined }));
    const [s] = idx.summaries({ dir });
    assert.strictEqual(s.externalRounds, 0);
    assert.strictEqual(s.lastExternal, null, 'absent reads as absent, never as restored');
  });

  await test('RESUME: the details view is built from real fields, inventing none', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-aaaa', session({
      turns: [{ userInput: 'fix it', text: 'I found the stale writer.' }],
      actors: [{ kind: 'external', text: 'The writer appears to have stopped.', afterTurns: 1 }],
    }));
    const [s] = idx.summaries({ dir });
    const { sessionDetailsAdapter } = require('../../src/ui/pickers');
    const text = sessionDetailsAdapter({ session: s }).items.map((i) => i.label).join('\n');
    assert.match(text, /ORIGINAL TASK/);
    assert.match(text, /the dashboard stopped updating/);
    assert.match(text, /LAST LAIN MESSAGE/);
    assert.match(text, /stale writer/);
    assert.match(text, /LAST EXTERNAL REVIEW/);
    assert.match(text, /writer appears to have stopped/);
    assert.match(text, /pytest — passed/);
  });

  await test('RESUME: a detail that was never recorded says so', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-000001-aaaa', session({ task: null, lifecycle: null }));
    const [s] = idx.summaries({ dir });
    const { sessionDetailsAdapter } = require('../../src/ui/pickers');
    const text = sessionDetailsAdapter({ session: s }).items.map((i) => i.label).join('\n');
    assert.match(text, /\(none recorded\)/);
    assert.match(text, /nothing was run, so nothing is verified/);
  });

  await test('RESUME: the list shows no session id anywhere on screen', () => {
    const dir = tmpdir('sidx-');
    write(dir, '20260818-091800-abcd', session());
    const list = idx.summaries({ dir });
    const { sessionListAdapter } = require('../../src/ui/pickers');
    const text = sessionListAdapter({ sessions: list }).items.map((i) => i.label).join('\n');
    assert.ok(!text.includes('20260818-091800-abcd'), 'the filename must not be what identifies it');
    assert.ok(!text.includes('abcd'), 'nor the token');
    assert.match(text, /scalpbot/);
    assert.match(text, /dashboard stopped updating/);
  });

  await test('RESUME: D is advertised AND the panel can actually deliver it', () => {
    // The completion overlay once advertised [D] and [R] and could deliver
    // neither, because a printable character emits `edit` and never `key`.
    const dir = tmpdir('sidx-');
    write(dir, '20260818-091800-abcd', session());
    const { sessionListAdapter } = require('../../src/ui/pickers');
    const { InteractionPanel } = require('../../src/ui/panel');
    const adapter = sessionListAdapter({ sessions: idx.summaries({ dir }) });
    assert.match(adapter.footer, /D details/, 'it is advertised');
    const p = new InteractionPanel();
    p.open(adapter);
    assert.strictEqual(p.stack.length, 1);
    assert.strictEqual(p.shortcut('d'), true, 'and the letter is claimed');
    assert.strictEqual(p.stack.length, 2, 'and it really opened the details');
    assert.match(p.frame.title, /SESSION DETAILS/);
    // Esc/← comes back to the list, which is the other half of the promise.
    p.back();
    assert.strictEqual(p.stack.length, 1);
    assert.match(p.frame.title, /RESUME SESSION/);
  });

  await test('RESUME: a letter the panel does NOT claim is left alone to be typed', () => {
    const { InteractionPanel, commandPaletteAdapter } = require('../../src/ui/panel');
    const p = new InteractionPanel();
    p.open(commandPaletteAdapter({ commands: [{ name: '/models', desc: 'x' }], filter: '/' }));
    // A completion menu follows what is being typed and must never have a
    // letter stolen from it — that is what makes the model browser filterable.
    assert.strictEqual(p.shortcut('d'), false);
  });
};
