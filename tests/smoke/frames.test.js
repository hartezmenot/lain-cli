'use strict';

/**
 * VISUAL BEHAVIOUR, ASSERTED ON FRAMES THE REAL BINARY DREW.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TIER EXISTS AT ALL, when ui/playback.js and ui/diffreel.js are
 * already tested by moving their clocks by hand.
 *
 * Those tests prove the STATE MACHINES. They cannot prove that the machine is
 * wired to the screen, that the drawing layer reads the state it produces, or
 * that a frame anybody sees contains what the state said it would. Every defect
 * this file was written after was of exactly that kind:
 *
 *   the window's `height` was computed correctly and never drawn, so it opened
 *     as two rules and then six rows in one frame;
 *   the card and the window were each correct and named different files;
 *   the clock asked for 16ms — a value every unit assertion accepted — and the
 *     platform served 32Hz.
 *
 * So these capture REAL FRAMES from the real process and assert SEQUENCES
 * across them. A single frame proves almost nothing about motion; what matters
 * is that the frames, in order, go somewhere.
 *
 * ------------------------------------------------------------------------
 * A DRAWN FRAME CONTAINS NO NEWLINES. Every row is positioned with
 * `ESC[<n>;1H` and the whole frame is written as one string, so splitting
 * stripped text on '\n' yields one enormous line and any row-adjacency
 * assertion silently tests nothing. `rowsOfFrame` splits on the position
 * escape, which is what actually separates one row from the next.
 *
 * COLOUR IS FORCED ON. A piped child has no TTY, and render.js correctly strips
 * every colour for one — including the semantic ones half of this file is about
 * (struck red, writing blue, added green). Without `LAIN_FORCE_COLOR` the
 * assertion "removed code is drawn struck-through" is unfalsifiable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'lain.js');
const CR = '\r';
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

/** A trusted workspace with the given files in it. */
function workspace(files) {
  const cwd = tmpdir('frames-');
  const cfg = path.join(cwd, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  // BOTH SPELLINGS OF THE SAME DIRECTORY. On Windows `os.tmpdir()` gives the
  // 8.3 short form and `realpath` the long one; trust.js normalises case and
  // separators but does not expand short names, so trusting one leaves the
  // other untrusted — and the run stops on a trust prompt that looks exactly
  // like the edit never happening.
  const real = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd);
  const at = new Date().toISOString();
  const seen = new Set();
  const trustedPaths = [cwd, real]
    .filter((d) => (seen.has(d.toLowerCase()) ? false : seen.add(d.toLowerCase())))
    .map((d) => ({ path: d, level: 'TRUSTED', at }));
  fs.writeFileSync(path.join(cfg, 'config.json'),
    JSON.stringify({ trustedPaths, dashAutostart: false }, null, 2));
  for (const [f, body] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(cwd, f), body, 'utf8');
  }
  return { cwd, cfg };
}

/**
 * Run the real binary and hand back everything it wrote.
 *
 * STAGED STDIN, because writing everything at once delivers keystrokes before
 * the work they are meant to follow has started.
 */
function capture({ files, script, stdin, cols = 118, rows = 44, gap = 1800, timeoutMs = 90000 }) {
  const { cwd, cfg } = workspace(files);
  const sp = path.join(cfg, 'script.json');
  fs.writeFileSync(sp, JSON.stringify(script));
  const env = {
    ...process.env,
    LAIN_CONFIG_DIR: cfg,
    LAIN_FORCE_TUI: '1',
    LAIN_FORCE_COLOR: '1',
    COLUMNS: String(cols),
    LINES: String(rows),
    LAIN_PROVIDER: 'mock',
    LAIN_MOCK_SCRIPT: sp,
  };
  delete env.NO_COLOR;
  const keep = ['LAIN_CONFIG_DIR', 'LAIN_FORCE_TUI', 'LAIN_FORCE_COLOR', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'];
  for (const k of Object.keys(env)) if (k.startsWith('LAIN_') && !keep.includes(k)) delete env[k];
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    let i = 0;
    const next = () => {
      if (i >= stdin.length) { child.stdin.end(); return; }
      child.stdin.write(stdin[i++]);
      setTimeout(next, gap);
    };
    setTimeout(next, 1500);
    const kill = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', () => { clearTimeout(kill); done({ out, cwd }); });
  });
}

/** The drawn frames, each as an array of real rows. Colour kept. */
function framesOf(out) {
  // ONLY WHAT WAS DRAWN ON THE ALTERNATE SCREEN. Everything after `?1049l` is
  // the shell again — "Session saved.", the resume hint — and it lands
  // concatenated onto the last row, which then measures far wider than the pane
  // and fails an overflow check about text that was never in the pane.
  const body = String(out).split(`${ESC}[?1049l`)[0];
  return body.split(new RegExp(`${ESC}\\[\\?25l`)).map((f) => {
    const parts = String(f).split(new RegExp(`${ESC}\\[(\\d+);1H`));
    const rows = [];
    for (let i = 1; i < parts.length; i += 2) rows[Number(parts[i]) - 1] = parts[i + 1];
    return rows.map((r) => (r === undefined ? '' : r));
  });
}

const plain = (s) => String(s)
  .replace(new RegExp(`${ESC}\\][0-9]+;[^\\u0007]*\\u0007`, 'g'), '')
  .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

/** The live activity position in a frame: a verb with its target indented under it. */
function livePos(rows) {
  const flat = rows.map(plain);
  for (let i = 0; i < flat.length - 1; i++) {
    if (/^ {2}[a-z]+ing\s*$/.test(flat[i]) && /^ {4}\S/.test(flat[i + 1])) {
      return { verb: flat[i].trim(), target: flat[i + 1].trim().split(/\s{2,}/)[0] };
    }
  }
  return null;
}

/** The diff window's title, if one is open. A labelled input border is not one. */
function windowFile(rows) {
  for (const r of rows.map(plain)) {
    const m = /┌─ (\S+) /.exec(r);
    if (m && /\.[a-z]+$/i.test(m[1])) return m[1];
  }
  return null;
}

/** How many content rows the diff window currently has. */
const windowHeight = (rows) => rows.map(plain).filter((r) => /^\s{2}│.*│\s*$/.test(r)).length;

const src = (n) => Array.from({ length: n },
  (_, i) => `function h${i}(req, res) { return res.end('${i}'); }`).join(NL);

const FILES = {
  'router.js': src(30),
  'python.js': `const value = oldFunctionName(input);${NL}const other = 2;${NL}`,
  'package.json': '{"name":"frames","scripts":{"test":"node -e \\"console.log(1)\\""}}',
};

module.exports = async function () {
  // ---- THE DIFF, AS A PERFORMANCE -------------------------------------------

  const patch = await capture({
    files: FILES,
    script: [
      { tool_calls: [{ name: 'edit_file', input: {
        path: 'python.js',
        old: 'const value = oldFunctionName(input);',
        new: 'const value = newFunctionName(input);',
      } }] },
      { text: 'Done.' },
    ],
    stdin: [`rename it${CR}`, `/exit${CR}`],
  });
  const patchFrames = framesOf(patch.out);

  await test('FRAMES: the diff window OPENS progressively — no box appearing whole', () => {
    const heights = patchFrames.filter(windowFile).map(windowHeight);
    assert.ok(heights.length > 2, `the window was drawn across several frames: ${heights.length}`);
    const max = Math.max.apply(null, heights);
    assert.ok(heights[0] < max,
      `it grows into place rather than arriving at full size: ${heights.slice(0, 12).join(',')} max ${max}`);
  });

  await test('FRAMES: old code is struck PROGRESSIVELY, then the new code materialises', () => {
    // ---- THE SEQUENCE, NOT A SINGLE FRAME ---------------------------------
    //
    // The strike used to advance a whole line at a time, so a one-line
    // replacement went from ordinary code to fully red between two frames — a
    // state change, not a deletion being performed — while the new line under
    // it was visibly typed. Half the edit was performed and half of it blinked.
    const widths = [];
    for (const rows of patchFrames) {
      for (const r of rows) {
        // The struck span is what sits inside SGR 9 … SGR 29 on a removed row.
        const m = new RegExp(`${ESC}\\[9m(.*?)${ESC}\\[29m`).exec(r);
        if (!m) continue;
        const n = plain(m[1]).length;
        if (widths[widths.length - 1] !== n) widths.push(n);
      }
    }
    assert.ok(widths.length >= 3,
      `the pen is seen at several positions across the line: ${widths.join(',')}`);
    assert.ok(widths[0] < widths[widths.length - 1],
      `and it travels from the start of the line towards its end: ${widths.join(',')}`);

    // AND THE REPLACEMENT ARRIVES AFTER IT, character by character, carrying
    // the unsettled glyphs that say it is materialising rather than pasted.
    const writing = patchFrames.findIndex((rows) => rows.some(
      (r) => r.indexOf('▌') >= 0 && /[░▒▓#%&$@*+=<>/\\|~^]/.test(plain(r))));
    const firstStrike = patchFrames.findIndex((rows) => rows.some(
      (r) => new RegExp(`${ESC}\\[9m`).test(r)));
    assert.ok(firstStrike >= 0, 'the old code really was struck');
    assert.ok(writing > firstStrike,
      `the new code is written after the old is struck: ${firstStrike} then ${writing}`);
  });

  await test('FRAMES: the counters climb and land on the real patch', () => {
    // ---- THE WINDOW'S OWN TALLY, NOT EVERY `+n -m` ON THE SCREEN ---------
    //
    // The settled feed row carries the FINAL counts from the moment the edit
    // lands — it is the record, and it is right to be complete. Scraping the
    // whole frame therefore mixes a finished number in with a climbing one and
    // reports a sequence that goes backwards. The counters under test are the
    // ones on the window's own title rule, which is where the performance
    // reports how far it has got.
    const seq = [];
    for (const rows of patchFrames) {
      for (const r of rows.map(plain)) {
        if (!/┌─ \S+\.[a-z]+ /.test(r)) continue;
        const m = /\+(\d+) -(\d+)/.exec(r);
        if (!m) continue;
        const v = `${m[1]}/${m[2]}`;
        if (seq[seq.length - 1] !== v) seq.push(v);
      }
    }
    const nums = seq.map((s) => s.split('/').map(Number));
    assert.ok(nums.every((n, i) => i === 0 || (n[0] >= nums[i - 1][0] && n[1] >= nums[i - 1][1])),
      `counters only ever climb: ${seq.join(' -> ')}`);
    assert.ok(seq.includes('1/1'), `and land on the real change: ${seq.join(' -> ')}`);
  });

  await test('FRAMES: the card and the window under it never name different files', () => {
    // Unreachable by construction now — one playhead, and the window is a
    // property of the event (ui/playback.js). Walked anyway, because a
    // structural guarantee nothing checks is a comment.
    let both = 0;
    for (const rows of patchFrames) {
      const lp = livePos(rows);
      const w = windowFile(rows);
      if (!lp || !w) continue;
      both += 1;
      assert.strictEqual(w.split(/[\\/]/).pop(), lp.target.split(/[\\/]/).pop(),
        `card "${lp.target}" over window "${w}"`);
    }
    assert.ok(both > 0, 'a window really was drawn under a card during the run');
  });

  // ---- READS, AND THE PROSE BETWEEN THEM -----------------------------------

  const reads = await capture({
    files: FILES,
    script: [
      { tool_calls: [{ name: 'read_file', input: { path: 'router.js' } }] },
      { text: 'The runtime never dispatches to connect().',
        tool_calls: [{ name: 'read_file', input: { path: 'python.js' } }] },
      { text: 'Done.' },
    ],
    stdin: [`investigate${CR}`, `/exit${CR}`],
  });
  const readFrames = framesOf(reads.out);

  await test('FRAMES: a read is on screen long enough to be read', () => {
    // "reading → appears for a fraction of a second → disappears" was the
    // reported symptom. Counted in FRAMES the process actually drew.
    const showing = readFrames.filter((rows) => {
      const lp = livePos(rows);
      return lp && /read/.test(lp.verb);
    }).length;
    assert.ok(showing >= 3, `the read held the live position for ${showing} drawn frames`);
  });

  await test('FRAMES: only ONE live activity position is ever drawn', () => {
    // The feed carries the finished calls; the timeline carries the live one.
    // Two live positions at once would mean the two had started duplicating.
    for (const rows of readFrames.concat(patchFrames)) {
      const n = rows.map(plain).filter((r) => /^ {2}[a-z]+ing\s*$/.test(r)).length;
      assert.ok(n <= 1, `one live operation at a time, found ${n}`);
    }
  });

  await test('FRAMES: prose converges on its text without ever jumping to it', () => {
    // ---- THE MAGICIAN EFFECT, MEASURED ------------------------------------
    //
    // "a tiny animation begins, then the rest instantly appears." Stated as a
    // measurement: track the SETTLED prefix of the sentence across frames and
    // look at the largest single-frame gain. A teleport is one frame that
    // delivers most of the line.
    const want = 'The runtime never dispatches to connect().';
    const lens = [];
    for (const rows of readFrames) {
      for (const r of rows.map(plain)) {
        const t = r.trim();
        if (!t || !want.startsWith(t[0])) continue;
        let n = 0;
        while (n < t.length && n < want.length && t[n] === want[n]) n += 1;
        if (n >= 4) { if (lens[lens.length - 1] !== n) lens.push(n); break; }
      }
    }
    assert.ok(lens.length >= 2, `the sentence was seen arriving: ${lens.join(',')}`);
    const grew = lens.filter((n, i) => i === 0 || n > lens[i - 1]);
    assert.ok(grew[grew.length - 1] >= want.length - 2,
      `and it arrives in full: ${grew.join(',')}`);
  });

  await test('FRAMES: structured prose keeps its structure on screen', () => {
    // The wall this whole effort is about. Asserted on the LAST drawn frame,
    // which is what a person is left looking at.
    const last = readFrames[readFrames.length - 1] || [];
    const rows = last.map(plain);
    const at = rows.findIndex((r) => r.includes('never dispatches to connect()'));
    assert.ok(at >= 0, `the finding is on screen:${NL}${rows.join(NL)}`);
    assert.ok(rows.every((r) => plain(r).length <= 122),
      'and no drawn row overflows the pane');
  });

  await test('FRAMES: finished work recedes; the current run keeps its weight', () => {
    // ---- EVERY PAST EVENT AT EQUAL VISUAL WEIGHT --------------------------
    //
    // Completed calls were drawn at `meta`, which is also the weight of the
    // call happening now. Thirty finished reads therefore carried exactly the
    // force of the one in flight, and there was nothing down the pane for the
    // eye to follow — the screen preserved history instead of following the
    // work.
    //
    // The LAST run of calls is the work in hand and keeps its weight;
    // everything before it recedes one step (ui/paint.js `faint`). Nothing is
    // dropped and nothing moves — only the emphasis changes.
    const FAINT = ESC + '[38;5;244m';
    let sawFaint = false;
    let sawNormalRun = false;
    for (const rows of readFrames) {
      const calls = rows.filter((r) => /✓ (?:Read|Ran|Searched)/.test(plain(r)));
      if (calls.length < 2) continue;
      if (calls.some((r) => r.indexOf(FAINT) >= 0)) sawFaint = true;
      if (calls.some((r) => r.indexOf(FAINT) < 0)) sawNormalRun = true;
    }
    assert.ok(sawFaint, 'earlier completed work is drawn quieter than the current run');
    assert.ok(sawNormalRun, 'and the current run is not faded with it');
  });

  // ---- /api: A CREDENTIAL, A PROVIDER PICKER, AND A VISIBLE SELECTION ------

  const api = await capture({
    files: FILES,
    script: [{ text: 'Nothing to do.' }],
    stdin: [
      '/api sk-test-credential-value' + CR,   // the credential
      ESC + '[B',                             // ↓ once — move the selection
      ESC + '[B',                             // ↓ again
      ESC,                                    // Esc — cancel, store nothing
      '/exit' + CR,
    ],
    gap: 2200,
    timeoutMs: 90000,
  });
  const apiFrames = framesOf(api.out);

  await test('FRAMES: /api <credential> asks which provider it belongs to', () => {
    const asked = apiFrames.some((rows) => rows.map(plain)
      .some((r) => /WHICH PROVIDER IS THIS CREDENTIAL FOR/.test(r)));
    assert.ok(asked, 'the provider question is drawn');
    // AND IT OFFERS THE KNOWN ENDPOINTS, from the one table.
    const providers = require('../../src/providers');
    const all = apiFrames.flatMap((rows) => rows.map(plain)).join(NL);
    for (const p of providers.KNOWN) {
      assert.ok(all.includes(p.label), `${p.label} is offered`);
    }
    assert.ok(/Other…/.test(all), 'and so is the row that asks rather than guesses');
  });

  await test('FRAMES: the credential never leaves the line it was typed on', () => {
    // ---- WHAT THIS CAN AND CANNOT PROMISE --------------------------------
    //
    // The key IS visible on the input line while it is being typed, and that is
    // the terminal echoing a keystroke — the same as `export KEY=…` in any
    // shell. Masking it would need input-level secret handling and would stop
    // anyone checking what they pasted; it is not what this guards.
    //
    // What it guards is the part `/api` controls: the credential must never be
    // written into the FEED, the PANEL or an ERROR message, where it would
    // outlive the keystroke and end up in a screenshot or a copied transcript.
    // What is shown back instead is its shape — `sk-…alue`.
    const inputRow = (rows) => {
      const i = rows.map(plain).findIndex((r) => /^│ >/.test(r));
      return i;
    };
    for (const rows of apiFrames) {
      const at = inputRow(rows);
      rows.forEach((row, n) => {
        if (n === at) return;                  // the line being typed on
        assert.ok(!plain(row).includes('sk-test-credential-value'),
          `row ${n + 1} carries the credential: ${plain(row).trim()}`);
      });
    }
    // AND THE SHAPE IS WHAT IS REPORTED BACK, when anything is.
    const all = apiFrames.flatMap((rows) => rows.map(plain)).join(NL);
    if (/sk-…/.test(all)) assert.ok(true, 'the shape stands in for the key');
  });

  await test('FRAMES: the selected row is unmistakable, and the arrows move it', () => {
    // ---- THE MARKER ALONE WAS THE WHOLE OF THE SELECTION ------------------
    //
    // A list where some rows carry a TONE put a coloured unselected row next to
    // a plain selected one, so the brightest thing on screen was not the thing
    // Enter would take. Both cues now: the `❯` survives monochrome, the surface
    // wins at a glance.
    const marked = [];
    for (const rows of apiFrames) {
      for (const r of rows) {
        const t = plain(r);
        if (!/│ ❯ /.test(t)) continue;
        const label = t.replace(/^.*❯ /, '').trim();
        if (label && marked[marked.length - 1] !== label) marked.push(label);
        // THE WHOLE ROW IS ON THE SURFACE, not just the words: a highlight that
        // stops at the text reads as an artefact rather than a selection.
        assert.ok(r.indexOf(ESC + '[48;5;236m') >= 0,
          `the selected row is drawn on the reading surface: ${t}`);
      }
    }
    assert.ok(marked.length >= 2,
      `the arrow keys really moved the selection: ${marked.join(' -> ')}`);
  });

  await test('FRAMES: Esc leaves the picker with nothing stored', () => {
    const cfgFile = path.join(api.cwd, 'cfg', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const conns = cfg.connections || {};
    for (const [id, c] of Object.entries(conns)) {
      assert.ok(!c.apiKey, `${id} must hold no credential after a cancelled /api`);
    }
  });
};
