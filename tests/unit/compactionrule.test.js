'use strict';

/**
 * THE COMPACTION CONTRACT, AND THE ONE EXECUTION DOOR.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS AUDITED BEFORE ANY OF IT WAS CHANGED, because three of these
 * commands are destructive and one of them was already correct:
 *
 *   /clean    the SCREEN only. Untouched.
 *   /clear    the model's conversation. The task, the plan, the evidence and the
 *             session file all survive; `/resume` brings it all back.
 *   /new      drops the task and plan as well.
 *   /compact  transforms the active context. Never clears, never deletes.
 *
 * Those four were already separate, and the separation is the thing most worth
 * protecting — so it is pinned here rather than adjusted. What DID change is the
 * one real defect the audit turned up: a second fold quoted the FIRST fold's
 * summary as though it were a user instruction, truncated it at four hundred
 * characters, and under-reported the message count by sixty. A third fold would
 * have nested that again.
 *
 * ------------------------------------------------------------------------
 * AND THE GUARDRAILS, asserted as a COUNT rather than as behaviour: the point is
 * that no convenience surface has grown a second policy of its own.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const { Session } = require('../../src/session');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** A session with `n` user instructions and an answer after each. */
function talkative(n) {
  const s = new Session({ cwd: process.cwd() });
  s.messages = [{ role: 'user', content: 'the objective' }];
  for (let i = 0; i < n; i++) {
    s.messages.push({ role: 'user', content: 'instruction ' + i });
    s.messages.push({ role: 'assistant', content: 'answer ' + i });
  }
  return s;
}

module.exports = async function () {
  // -------------------------------------------------- folding, and merging --

  await test('FOLD: a second fold MERGES the first, it does not quote it', () => {
    const s = talkative(40);
    s.compact({ maxMessages: 20, force: true });
    for (let i = 0; i < 30; i++) s.messages.push({ role: 'user', content: 'later ' + i });
    s.compact({ maxMessages: 20, force: true });
    const text = String(s.messages[1].content);
    const markers = (text.match(/earlier messages folded/g) || []).length;
    assert.strictEqual(markers, 1, 'one summary, superseding the old marker, not nested inside it');
    assert.ok(!/What you asked for, in order:[\s\S]*What you asked for, in order:/.test(text),
      'and the previous summary is not a bullet of this one');
  });

  await test('FOLD: a third fold does not nest either', () => {
    const s = talkative(40);
    for (let round = 0; round < 3; round++) {
      s.compact({ maxMessages: 20, force: true });
      for (let i = 0; i < 30; i++) s.messages.push({ role: 'user', content: 'round' + round + '-' + i });
    }
    s.compact({ maxMessages: 20, force: true });
    const text = String(s.messages[1].content);
    assert.strictEqual((text.match(/earlier messages folded/g) || []).length, 1);
  });

  await test('FOLD: the count is the real number of messages, not the array slots', () => {
    // THE OLD DEFECT: a prior summary occupied ONE slot while standing for
    // sixty-one real messages, so every later header under-reported by sixty.
    const s = talkative(40);
    s.compact({ maxMessages: 20, force: true });
    const first = s.messages[1].foldedCount;
    for (let i = 0; i < 30; i++) s.messages.push({ role: 'user', content: 'later ' + i });
    s.compact({ maxMessages: 20, force: true });
    const second = s.messages[1].foldedCount;
    assert.ok(first > 1, 'the first fold stood for many messages: ' + first);
    assert.ok(second > first, 'and the second stands for more, not fewer: ' + second);
    assert.match(String(s.messages[1].content), new RegExp('\\[' + second + ' earlier messages'),
      'and the header says the same number');
  });

  await test('FOLD: the user instructions survive, in order, verbatim', () => {
    const s = talkative(20);
    s.compact({ maxMessages: 8, force: true });
    for (let i = 0; i < 20; i++) s.messages.push({ role: 'user', content: 'later ' + i });
    s.compact({ maxMessages: 8, force: true });
    const text = String(s.messages[1].content);
    // Instructions are the thread; losing them is losing it.
    const at = (needle) => text.indexOf(needle);
    assert.ok(at('instruction 0') >= 0, 'the earliest instruction survives two folds');
    assert.ok(at('instruction 19') > at('instruction 0'), 'and the order is kept');
  });

  await test('FOLD: the objective is never folded away', () => {
    const s = talkative(60);
    for (let i = 0; i < 3; i++) s.compact({ maxMessages: 10, force: true });
    assert.strictEqual(s.messages[0].content, 'the objective',
      'a session that forgets what it was asked is worse than one that is refused');
  });

  await test('FOLD: a very long session states what it stopped listing', () => {
    // Bounded so a summary cannot become the thing needing compaction — and
    // honest about it, because one that quietly forgot half a conversation while
    // claiming to hold it is worse than one that says so.
    const s = talkative(200);
    s.compact({ maxMessages: 20, force: true });
    const text = String(s.messages[1].content);
    if (/no longer listed here/.test(text)) {
      assert.match(text, /the \d+ oldest are no longer listed here/);
    }
    assert.ok(text.length < 60000, 'the summary is bounded: ' + text.length);
  });

  await test('FOLD: the merge survives persistence, so a RESUMED session does not nest', () => {
    // The parts a fold carries (`said`, `calls`, `foldedCount`) are what the NEXT
    // fold merges from. They live on the message, so they go through
    // `session.toJSON()` with everything else — but a field that silently failed
    // to persist would reintroduce the nesting bug across a restart only, which
    // is the hardest version of it to notice.
    const s = talkative(40);
    s.compact({ maxMessages: 20, force: true });
    const persisted = JSON.parse(JSON.stringify(s.toJSON()));
    const fold = persisted.messages[1];
    assert.strictEqual(fold.elided, 'folded', 'the marker survives');
    assert.ok(fold.foldedCount > 1, 'and the count it stands for');
    assert.ok(Array.isArray(fold.said) && fold.said.length, 'and the instructions');
    assert.ok(fold.calls && typeof fold.calls === 'object', 'and the call tallies');

    // AND A SECOND FOLD AFTER THE ROUND TRIP STILL MERGES.
    const resumed = new Session({ cwd: process.cwd() });
    resumed.messages = persisted.messages.slice();
    for (let i = 0; i < 30; i++) resumed.messages.push({ role: 'user', content: 'later ' + i });
    resumed.compact({ maxMessages: 20, force: true });
    const text = String(resumed.messages[1].content);
    assert.strictEqual((text.match(/earlier messages folded/g) || []).length, 1,
      'a resumed session must not nest its summaries');
    assert.ok(resumed.messages[1].foldedCount > fold.foldedCount,
      'and the count still grows rather than resetting to the array length');
  });

  await test('FOLD: no tool result is ever left without its call', () => {
    // Every OpenAI-shaped API rejects the whole request for one orphan, which is
    // why folding takes a contiguous run from the front and snaps to a boundary.
    const s = new Session({ cwd: process.cwd() });
    s.messages = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 30; i++) {
      s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, name: 'read_file' }] });
      s.messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'data' });
    }
    s.compact({ maxMessages: 12, force: true });
    const ids = new Set();
    for (const m of s.messages) for (const tc of m.tool_calls || []) ids.add(tc.id);
    for (const m of s.messages) {
      if (m.role !== 'tool') continue;
      assert.ok(ids.has(m.tool_call_id), 'orphaned tool result ' + m.tool_call_id);
    }
  });

  // ------------------------------------------------- compaction is not clear --

  await test('CLEAR: the four commands are four different operations', () => {
    // Audited before anything was touched, and pinned rather than changed.
    const sessioncmds = read('sessioncommands.js');
    assert.match(sessioncmds, /define\('\/clean'/, '/clean exists');
    assert.match(sessioncmds, /define\('\/clear'/, '/clear exists');
    assert.match(sessioncmds, /define\('\/new'/, '/new exists');
    assert.match(read('compactcommand.js'), /define\('\/compact'/, '/compact exists');
    // /clear CLEARS THE CONVERSATION and says the task survives.
    assert.match(sessioncmds, /clearContext\(\)/, '/clear clears the model conversation');
    assert.match(sessioncmds, /Nothing on disk changed/, 'and says nothing on disk changed');
  });

  await test('CLEAR: clearing the context touches nothing on disk', () => {
    const s = talkative(5);
    s.task = { objective: 'fix the parser', toJSON: () => ({ objective: 'fix the parser' }) };
    const before = s.messages.length;
    const r = s.clearContext();
    assert.ok(r.removed > 0, 'it removed messages: ' + JSON.stringify(r));
    assert.ok(s.messages.length < before);
    assert.ok(s.task, 'the task survives a context clear');
  });

  await test('CLEAR: compaction and clear never call each other', () => {
    // Two operations, two meanings. Compaction transforms; clear drops.
    const authority = read('contextauthority.js');
    assert.match(authority, /COMPACTION IS NOT CLEAR/, 'the boundary is stated');
    const session = read('session.js');
    const clearBody = session.slice(session.indexOf('clearContext()'));
    assert.ok(!/this\.compact\(/.test(clearBody.slice(0, 400)), 'clear does not compact');
  });

  await test('CLEAR: nothing in the compaction path can delete evidence', () => {
    // `.lain` holds the architecture record, the facts and the findings of
    // unfinished turns. Context compaction is an in-memory transformation of one
    // array and must not be able to reach any of it.
    for (const f of ['session.js', 'contextauthority.js', 'contextfit.js', 'compactcommand.js']) {
      const src = read(f);
      assert.ok(!/rmSync|unlinkSync|rmdirSync/.test(src),
        f + ' must not be able to delete anything');
      assert.ok(!/lainstore/.test(src), f + ' must not reach the evidence store');
    }
  });

  // ------------------------------------------------------- the auto threshold --

  await test('AUTO: compaction runs against the BUDGET, not the provider ceiling', () => {
    // Compacting against what the provider will ACCEPT meant it never ran until
    // the window was nearly full — and by then the cost had been paid on every
    // request carrying the transcript up there.
    const src = read('contextfit.js');
    assert.match(src, /preflight-context-pressure/, 'there is a pre-flight pass');
    assert.match(src, /THE BUDGET, NOT THE CEILING/, 'and it is the budget it measures against');
    assert.match(src, /contextbudget/, 'from the one budget authority');
  });

  await test('AUTO: there is ONE thing that may compact, and ONE token estimator', () => {
    // No duplicate estimator: the header's live figure, compaction and `/token`
    // all divide by the same constant, which is why they cannot disagree.
    const { CHARS_PER_TOKEN } = require('../../src/session');
    assert.ok(CHARS_PER_TOKEN > 0);
    let owners = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (/CHARS_PER_TOKEN\s*=\s*[0-9]/.test(fs.readFileSync(p, 'utf8'))) owners += 1;
      }
    };
    walk(SRC);
    assert.strictEqual(owners, 1, 'exactly one module may define the estimator');
  });

  await test('AUTO: the notice is one transient line, not a compression report', () => {
    const src = read('contextfit.js');
    assert.match(src, /Context compacted ·/, 'one concise line');
    assert.ok(!/kept: \$\{summary\.kept/.test(src), 'the kept list is no longer printed over the work');
    assert.match(src, /surface,/, 'and it goes to the transient surface, never the conversation');
    // THE DETAIL MOVED TO `/token` RATHER THAN BEING DROPPED.
    assert.match(read('tokencommand.js'), /kept through compaction/, '/token carries it on demand');
  });

  await test('COMPACT: the manual command answers in one line', () => {
    const reg = {};
    const { C } = require('../../src/render');
    require('../../src/compactcommand').register({
      define: (n, d) => { reg[n] = d; }, DURING_TURN: { BLOCKED: 'b' }, C,
    });
    const out = [];
    const app = {
      render: { write: (s) => out.push(s) },
      cfg: {},
      session: {
        messages: new Array(300),
        contextChars: () => 291000,
        contextAuthority: {
          compact: () => ({ result: {
            compacted: true, before: 291000, after: 84000, folded: 207,
            beforeMessages: 291, afterMessages: 84,
          } }),
        },
      },
    };
    reg['/compact'].run(app);
    const text = out.join('').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    const rows = text.split(String.fromCharCode(10)).filter((l) => l.trim());
    assert.strictEqual(rows.length, 2, 'the verdict and the one fact not in the numbers');
    assert.match(rows[0], /Compacted · 291k → 84k/);
    assert.match(rows[1], /Nothing was deleted/);
    // IT IS MACHINERY, so it goes to the command surface and not the conversation.
    assert.strictEqual(reg['/compact'].surface, true);
  });

  // ------------------------------------------------------ one execution door --

  await test('GUARD: every tool call goes through ONE gate, and there is one caller', () => {
    // The gate is at the single door `tools/index.js:execute`, and that door has
    // exactly one caller — the turn loop. A convenience command cannot bypass the
    // policy because there is no second way in.
    assert.match(read('tools', 'index.js'), /require\('\.\.\/gate'\)\.check\(/, 'the door checks');
    let callers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (/toolRegistry\.execute\(|require\('\.\/tools'\)\.execute\(/.test(text)) {
          callers.push(path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    callers = callers.filter((f) => f !== path.join('tools', 'index.js'));
    assert.deepStrictEqual(callers, ['turn.js'],
      'one executor, so one policy: ' + callers.join(', '));
  });

  await test('GUARD: /bg runs a turn, so it inherits the same gate', () => {
    // `/bg` starts background work through `app.startBackground`, which drives
    // `runTurn` — the same loop, the same tool door, the same policy. It does not
    // execute anything itself.
    const jobcommands = read('jobcommands.js');
    for (const bad of ['spawn(', 'execFile(', 'child_process', 'new Worker']) {
      assert.ok(!jobcommands.includes(bad), '/bg must not execute anything itself: ' + bad);
    }
    assert.match(jobcommands, /app\.startBackground\(/, 'it delegates');
    assert.match(read('jobrunner.js'), /runTurn/, 'and the background path is the same executor');
  });

  await test('GUARD: no surface has grown a second policy authority', () => {
    // gate.js, trust.js and permissions.js remain the only ones. A convenience
    // command that reimplemented any of their decisions would be a second answer
    // to a question that must have one.
    for (const f of ['jobcommands.js', 'pscommand.js', 'compactcommand.js', 'tokencommand.js']) {
      const src = read(f);
      assert.ok(!/trustedPaths|NEVER_AUTO|CAPABILITY\s*=/.test(src),
        f + ' must not hold policy of its own');
    }
    // AND THE UI ONLY PROJECTS THE DECISION.
    assert.ok(!/trust\.check\(|permissions\./.test(read('ui', 'status.js')),
      'the live row reports a decision; it does not make one');
  });
};
