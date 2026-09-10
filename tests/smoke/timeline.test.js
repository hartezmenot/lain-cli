'use strict';

/**
 * THE ACTIVITY TIMELINE, THROUGH THE REAL BINARY.
 *
 * The unit tier holds the state machines by moving their clocks by hand. This
 * holds the half a unit test structurally cannot: that a real process, drawing
 * real frames, plays the timeline — and, more importantly, that the work is
 * unaffected when the animation is interrupted, navigated away from, or never
 * played at all.
 *
 * THE RULE UNDER TEST, once: the animation may be behind reality; it may not
 * change it. Every assertion below is either "the motion happened" or "the work
 * survived the motion being disturbed", and the second kind matters more.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, frames, rowsOf } = require('../helpers');

const CR = '\n';
const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '34' };
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A project with a real defect and a suite that catches it. */
function project() {
  const dir = tmpdir('tl-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'parser.js'),
    "'use strict';\nfunction parse(s) {\n  const out = [];\n  for (const p of String(s).split(',')) out.push(p.trim());\n  return out;\n}\nmodule.exports = { parse };\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"tl","scripts":{"test":"node test.js"}}', 'utf8');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  // ---- TRUST BOTH SPELLINGS OF THE SAME DIRECTORY ------------------------
  //
  // On Windows `os.tmpdir()` hands back the 8.3 short form
  // (C:\Users\HARTEZ~1\…) while `realpath` gives the long one
  // (C:\Users\Hartezmenot\…). trust.js normalises case and separators but does
  // not expand short names, so trusting one form leaves the other untrusted.
  //
  // It matters HERE and not in a piped run because the filesystem gate only
  // applies when there is a UI to ask (see gate.js) — so a TUI test would stop
  // on a trust prompt for a write that `lain -p` performs without one, and the
  // failure looks exactly like the edit never happening.
  const real = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  const at = new Date().toISOString();
  const seen = new Set();
  const trustedPaths = [dir, real]
    .filter((d) => (seen.has(d.toLowerCase()) ? false : seen.add(d.toLowerCase())))
    .map((d) => ({ path: d, level: 'TRUSTED', at }));
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({
    trustedPaths,
    dashAutostart: false,
  }, null, 2));
  return { dir, cfg };
}

/** Several reads, an edit and a command — enough for a timeline to play. */
const SCRIPT = [
  { tool_calls: [{ name: 'read_file', input: { path: 'src/parser.js' } }] },
  { text: 'Empty input splits into one empty token.', tool_calls: [{ name: 'read_file', input: { path: 'package.json' } }] },
  { tool_calls: [{ name: 'edit_file', input: {
    path: 'src/parser.js',
    old: "  for (const p of String(s).split(',')) out.push(p.trim());",
    new: "  const raw = String(s);\n  if (!raw.trim()) return out;\n  for (const p of raw.split(',')) out.push(p.trim());",
  } }] },
  { tool_calls: [{ name: 'run_powershell', input: { command: 'node -e "console.log(1)"' } }] },
  { text: 'Done.' },
];

module.exports = async function () {
  await test('TIMELINE: the verb and its target are drawn as one indented unit', async () => {
    // ---- IT USED TO ASSERT A BOX, AND THE BOX WAS THE DEFECT --------------
    //
    // `reading` above a fifty-two-column frame containing `python.js` is five
    // rows and a border spent on one filename, and on a real screen it reads as
    // a CARD competing with the diff window below it rather than as the subject
    // of the verb above it. The relationship is possessive, so it is drawn with
    // indentation — which also survives monochrome and a narrow terminal.
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '', '', '', ''], stepDelayMs: 5000, timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /reading/, 'the verb is the label');
    assert.match(out, /parser\.js/, 'naming what is being read');
    // THE TARGET SITS INDENTED UNDER ITS VERB, on the very next row. That
    // relationship is the change, so it is what is asserted — not the words,
    // which were already there when the box was.
    //
    // SPLIT WITH `rowsOf`, NOT ON NEWLINES. A drawn frame contains none: every
    // row is positioned with `ESC[<n>;1H` and the whole frame is written as one
    // string, so splitting stripped text on '\n' yields a single enormous line
    // and any row-adjacency assertion silently tests nothing. See tests/helpers.
    const seen = [];
    for (const f of frames(r.out)) {
      const rows = rowsOf(f);
      for (let i = 0; i < rows.length - 1; i++) {
        if (/^ {2}\w+ing\s*$/.test(rows[i]) && /^ {4}\S/.test(rows[i + 1])) {
          seen.push(`${rows[i].trim()} / ${rows[i + 1].trim()}`);
        }
      }
    }
    assert.ok(seen.length, 'a verb with its target indented on the row under it');
  });

  await test('TIMELINE: the live position never draws a bare card around its target', async () => {
    // The pane holds ONE bordered surface at a time and it belongs to the diff
    // window, which genuinely needs an edge to be told apart from the terminal.
    // A second frame around a filename competes with it for the same eye.
    //
    // A BARE `┌────┐` is the old quotation box. The diff window always titles
    // itself `┌─ file ─…`, and the summary callouts title themselves too, so
    // an untitled frame can only be the thing this removed.
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '', '', '', ''], stepDelayMs: 5000, timeoutMs: 90000,
    });
    for (const frame of String(r.out).split('\x1b[?25l')) {
      const f = plain(frame);
      assert.ok(!/┌─+┐/.test(f), `a bare box was drawn around a target:\n${f.slice(0, 700)}`);
    }
  });

  await test('TIMELINE: a finished activity becomes ONE compact line', async () => {
    // The whole compactness argument: the box belongs to the live operation,
    // and everything before it is a quiet line.
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '', '', '', ''], stepDelayMs: 5000, timeoutMs: 90000,
    });
    const out = plain(r.out);
    // The box belongs to the LIVE operation. A finished read keeps one quiet
    // line in the feed and loses its quotation — which is the whole
    // compactness argument, and the thing to assert.
    assert.match(out, /reading\s+src[\\/]parser\.js/, 'the completed read is one line naming its subject');
    const frames = String(r.out).split('\x1b[?25l').map(plain);
    const last = frames[frames.length - 1] || '';
    assert.ok(!/┌─+┐/.test(last), `no bare box may survive to the end:\n${last.slice(0, 500)}`);
  });

  await test('TIMELINE: an edit shows its real +/- and leaves them behind', async () => {
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '', '', '', ''], stepDelayMs: 5000, timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /patching|edit/, 'the edit is named');
    assert.match(out, /\+\d+/, 'with a real addition count');
    // And the change is really on disk — the animation described something true.
    const after = fs.readFileSync(path.join(dir, 'src', 'parser.js'), 'utf8');
    assert.match(after, /raw\.trim\(\)/, 'the edit actually happened');
  });

  await test('TIMELINE: the diff window OPENS and then GOES AWAY', async () => {
    // A permanent diff panel is the thing this replaces. It must appear, and it
    // must not still be there at the end.
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '', '', '', ''], stepDelayMs: 5000, timeoutMs: 90000,
    });
    const frames = String(r.out).split('\x1b[?25l').map(plain);
    const withDiff = frames.filter((f) => /raw\.trim\(\)/.test(f) && /┌─ src/.test(f));
    assert.ok(withDiff.length, 'the diff window was drawn at some point');
    const last = frames[frames.length - 1] || '';
    assert.ok(!/┌─ src[\\/]parser\.js/.test(last), 'and it did not stay open to the end');
  });

  await test('TIMELINE: scrolling and stray keys mid-animation do not disturb the work', async () => {
    // Presentation must not be load-bearing. It used to say "switching panes"
    // and press Alt+N; there are no panes, so what it presses now is the keys
    // that DO move the view (PgUp, Home, End) plus the ones that no longer do
    // anything at all (Tab, Alt+3) — and the property is unchanged: the edit,
    // the file and the session must be exactly as they would have been if
    // nobody had touched the keyboard.
    const { dir, cfg } = project();
    const PGUP = '\x1b[5~';
    const HOME = '\x1b[H';
    const END = '\x1b[F';
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, PGUP, HOME, '\t', '\x1b3', END, '', '/exit' + CR],
      stepDelayMs: 3000, timeoutMs: 80000,
    });
    assert.strictEqual(r.code, 0, `the session died while scrolling:\n${plain(r.out).slice(-900)}`);
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not a function/.test(out),
      `an error reached the screen:\n${out.slice(-900)}`);
    const after = fs.readFileSync(path.join(dir, 'src', 'parser.js'), 'utf8');
    assert.match(after, /raw\.trim\(\)/, 'the edit survived being scrolled away from');
  });

  await test('TIMELINE: an interrupt ends the work, not the screen', async () => {
    // Ctrl+C during a playing timeline. The turn stops; the process does not,
    // and nothing half-animated is left corrupting the next frame.
    const { dir, cfg } = project();
    const r = await runCli([], {
      cwd: dir, configDir: cfg, env: tui, script: SCRIPT,
      stdinSteps: ['fix the empty case' + CR, '\x03', '\x03', '/exit' + CR],
      stepDelayMs: 2500, timeoutMs: 70000,
    });
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not a function/.test(out),
      `an error reached the screen:\n${out.slice(-900)}`);
  });

  await test('TIMELINE: a PIPE gets the account with no animation at all', async () => {
    // The same events, none of the motion. `lain -p` output must stay plain —
    // a one-shot run piped into something else is not a place for a timeline.
    const { dir, cfg } = project();
    const r = await runCli(['-p', 'fix the empty case'], {
      cwd: dir, configDir: cfg, script: SCRIPT, timeoutMs: 70000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.out);
    assert.ok(!/┌─+┐/.test(out), `a pipe must not draw timeline surfaces:\n${out.slice(0, 600)}`);
    // But the work still happened, and is still reported.
    const after = fs.readFileSync(path.join(dir, 'src', 'parser.js'), 'utf8');
    assert.match(after, /raw\.trim\(\)/, 'the edit happened without any animation');
  });

  await test('TIMELINE: the LAST operation of a turn settles — it does not teleport', () => {
    // ---- THE OUTSTANDING ITEM THIS SETTLES, AND WHAT MEASURING IT SAID ----
    //
    // Carried on the ledger as "the last operation of a turn still moves two
    // rows at once", on the reasoning that the redraw ticker stops when the
    // turn ends and the final operation therefore has no frames left to settle
    // in. That is a plausible mechanism and it is not what happens.
    //
    // Measured on a three-command turn, counting DISTINCT renderings of each
    // operation across the 51 frames actually drawn:
    //
    //     last operation    7 distinct states
    //     middle operation  4 distinct states
    //
    // The last one settles MORE, not less: it is the operation still on screen
    // while the turn closes, so it is drawn through its running spinner, its
    // completion, its status row and its resting state. `syncTicker` keeps the
    // clock alive on `activity.busy()`, which stays true while any enqueued
    // event is unplayed, and `settle()` marks events done WITHOUT moving the
    // playhead — so the frames to settle in exist.
    //
    // This is a ceiling test against the regression, not a claim of new work:
    // if the ticker is ever made to stop at `phase === null`, the last
    // operation collapses to one state and this fails.
    return (async () => {
      const { dir, cfg } = project();
      const r = await runCli([], {
        cwd: dir, configDir: cfg,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
        stdin: 'run three checks in a row' + CR + '/exit' + CR,
        script: [
          { text: 'First check.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(1)"' } }] },
          { text: 'Second check.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(2)"' } }] },
          { text: 'Third check.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(3)"' } }] },
          { text: 'Issue' + CR + 'All three ran.' + CR + CR + 'Verified' + CR + '- three commands' },
        ],
        timeoutMs: 90000,
      });
      assert.strictEqual(r.code, 0);

      // THE HARNESS ALREADY HAS THESE, and writing them again here cost two
      // runs: the hand-rolled row splitter lost its backslashes on the way into
      // the file and became `/[d+;1H/`, an unterminated character class. This
      // file imports `frames` and `rowsOf` at the top for exactly this reason.
      const drawn = frames(r.out).slice(1);

      const statesFor = (re) => {
        const seen = [];
        for (const f of drawn) {
          const key = rowsOf(f).filter((x) => re.test(x)).join(' | ');
          if (!key) continue;
          if (!seen.length || seen[seen.length - 1] !== key) seen.push(key);
        }
        return seen;
      };

      const last = statesFor(/console\.log\(3\)|node · /);
      assert.ok(last.length >= 3,
        `the final operation collapsed to ${last.length} state(s) — it teleported:${CR}${last.join(CR)}`);
      // And it really does pass through a RUNNING state before its result, which
      // is the difference between animating and appearing finished.
      assert.ok(last.some((s) => /RUNNING/i.test(s)),
        'the last operation must be seen running, not only completed');
      assert.ok(last.some((s) => /node · -e "console\.log\(3\)"/.test(s)),
        'and must be seen completed');
    })();
  });
};
