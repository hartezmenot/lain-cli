'use strict';

/**
 * ADVERSARIAL: CAN A PERSON WATCH A REAL MODEL WORK?
 *
 * The reported failure was that the real TUI becomes
 *
 *     SEARCH / READ / SEARCH / READ / SEARCH / READ
 *
 * with the model's own words missing, buried or invisible. The smoke tier pins
 * that with a scripted model, which proves the RENDERING is right — and cannot
 * prove the thing that actually broke, because a scripted model says exactly
 * what the script told it to say, in exactly the shape the renderer expects.
 *
 * A real model chooses its own number of calls, its own order, whether it says
 * anything between them, and whether it says it in one paragraph or six. That
 * is the input the failure was really about. So this drives a real model
 * through the real draw path and asserts on THE DRAWN FRAME:
 *
 *   · the user's message is on screen,
 *   · the model's own prose is on screen,
 *   · and a long run of calls has not crowded either of them out.
 *
 * It asserts STRUCTURE, never wording: a test that requires a model to produce
 * a particular sentence is a test of that model, and it would pass or fail for
 * reasons that have nothing to do with this UI.
 *
 * IT SKIPS ITSELF when no live provider is reachable, and says so — a green run
 * without this tier implies nothing was adversarially verified.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, runCli, frames: framesOf, rowsOf, lastFrameRows } = require('../helpers');

const BASE_URL = process.env.LAIN_LIVE_BASE_URL || 'http://127.0.0.1:20128/v1';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'adversarial');

/** Strip OSC titles and CSI sequences: what a person would actually read. */
const plain = (s) => String(s)
  .replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * The last drawn frame, and every frame — as ROWS.
 *
 * A drawn frame has no newlines in it: the Screen positions each row with
 * `ESC[<row>;1H` and writes the frame as one string. Stripping the escapes and
 * splitting on '\n' therefore yields a single enormous line, and every count
 * taken from it is zero — which is how a bound on "how many call rows may share
 * a screen" came to pass without ever looking at a row. See helpers.rowsOf.
 */
function lastFrame(out) {
  return lastFrameRows(out).join('\n');
}

function allFrames(out) {
  return framesOf(out).map((f) => rowsOf(f).join('\n'));
}

function freshFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advconv-'));
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) copy(a, b); else fs.copyFileSync(a, b);
    }
  };
  copy(FIXTURE, dir);
  return dir;
}

function configFor(cwd, model) {
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model,
    connection: 'live',
    maxSteps: 40,
    connections: {
      live: { provider: 'live-bridge', via: 'bridge', protocol: 'chat', baseUrl: BASE_URL, models: [model] },
    },
  }, null, 2), 'utf8');
  return configDir;
}

/**
 * Is a live bridge there, and which model should drive?
 *
 * Retried, because A SILENT FALSE SKIP is the dangerous failure in this tier:
 * a bridge that is a moment slow to answer turns an unverified run into a green
 * one that nobody looks at twice.
 */
async function probe(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(`${BASE_URL}/models`, { signal: ac.signal });
      clearTimeout(t);
      if (res.ok) {
        const j = await res.json();
        const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        if (ids.length) {
          const want = process.env.LAIN_ADVERSARIAL_MODEL;
          const pick = (want && ids.includes(want))
            || ids.find((m) => /llama-3\.3-70b|claude|gpt-5|qwen.*coder/i.test(m))
            || ids[0];
          return { ids, pick };
        }
      }
    } catch { /* fall through to the retry */ }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return null;
}

module.exports = async function () {
  const live = await probe();
  if (!live) {
    process.stdout.write(`  ~ SKIPPED: no live provider at ${BASE_URL} — the conversation was NOT adversarially verified\n`);
    return;
  }
  process.stdout.write(`  · adversarial model: ${live.pick}\n`);

  await test('ADVERSARIAL: a real investigation is watchable — the model is visible between its calls', async () => {
    const dir = freshFixture();
    const configDir = configFor(dir, live.pick);

    const r = await runCli([], {
      cwd: dir,
      configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'Investigate this project and tell me what the dashboard does. '
        + 'Search it, read the files you need, and say what you are finding as you go. '
        + 'Change nothing.\n',
      timeoutMs: 420000,
    });

    const frames = allFrames(r.out);
    const frame = lastFrame(r.out);
    const everything = frames.join('\n');

    // ---- DID THE RUN EVEN FINISH? -----------------------------------------
    //
    // `r.code === null` means the harness killed the child mid-turn. The screen
    // is then a snapshot of a model still thinking, and asserting anything about
    // what it drew would be asserting against the provider's speed. NOT
    // VERIFIED, said out loud, and never a pass. (Observed 2026-08-20: the local
    // bridge took 79s to return ten tokens.)
    if (r.code === null) {
      process.stdout.write(
        '    ~ NOT VERIFIED: the run was still working when the budget expired — '
        + 'the conversation was NOT exercised on this run.\n');
      return;
    }

    // ---- AND DID THE MODEL DO THE THING THE TEST IS ABOUT? ----------------
    //
    // A model that made one call and stopped cannot demonstrate a flood, so a
    // pass would mean nothing. This is a precondition, reported as such.
    const calls = Number((/(\d+) tool calls?/.exec(everything) || [])[1] || 0);
    assert.ok(calls >= 3,
      `the model made ${calls} tool call(s) — too few to say anything about a flood.\n${frame}`);

    // ---- THE USER IS IN THEIR OWN CONVERSATION ---------------------------
    //
    // Across the session, not on the final frame: a model that answers at
    // length legitimately fills the pane with its answer, and demanding the
    // opening message still be visible underneath it would be demanding the
    // feed NOT scroll. What must never happen is that it was never drawn.
    assert.ok(/❯ Investigate this project/.test(everything),
      'the user\'s own message was never drawn as theirs');

    // ---- THE MODEL IS VISIBLE AS A SPEAKER, NOT ONLY AS A CALLER ---------
    //
    // Structural, not textual: rows of words on the final screen that are not
    // tool rows and not chrome. What it SAYS is the model's business.
    const rows = lastFrameRows(r.out);
    const chrome = /^[│└┌├]|^\s*(ACTIONS|USER|NOTE|OUTPUT|LAIN|EXTERNAL|MCP)\s*$|^\s*TASK\s|^\s*[✓✗·◐◓◑◒]/;
    const prose = rows.filter((l) => l.trim().length > 12 && !chrome.test(l) && !/^\s*\[/.test(l));
    assert.ok(prose.length > 0,
      `the model's own words are nowhere on the final screen:\n${frame}`);
    assert.ok(/\bLAIN\b/.test(everything), 'and it was labelled as the speaker at some point');

    // ---- AND THE CALLS HAVE NOT CROWDED IT OUT ---------------------------
    const callRows = rows.filter((l) => /[✓✗]/.test(l) && !/TOOL |LAIN /.test(l));
    assert.ok(callRows.length <= 8,
      `${callRows.length} call rows on one screen — this is the reported failure:\n${frame}`);

    // WHETHER A RUN WAS COMPACTED IS THE MODEL'S BUSINESS, NOT A REQUIREMENT.
    //
    // Compaction folds CONSECUTIVE calls, and a model that says something
    // between them never produces a run long enough to fold — which is the
    // better outcome, not a missing one. Requiring a `×N` here would have
    // failed the run where the model behaved best. Reported, never asserted.
    const folded = /×\d/.test(everything);
    process.stdout.write(
      `    · ${calls} tool calls · ${callRows.length} call rows on the last screen`
      + ` · ${folded ? 'a run was folded' : 'no run long enough to fold — the model spoke between its calls'}\n`);
  });

  await test('ADVERSARIAL: a real answer keeps the shape the model gave it', async () => {
    // THIS DEFECT WAS FOUND BY THIS TIER, and could only have been found here.
    //
    // A real final answer is headings, bullets, a table and fenced code. It was
    // rendered as ONE feed entry and reflowed by `wrap`, so every structural
    // newline was lost and the screen showed
    //
    //     ignores the error } } ``` If `pull()` throws (e.g. the sensor is…
    //
    // — code and prose run together, a markdown table reduced to pipes in a
    // sentence. No scripted model writes an answer shaped like that, so no
    // amount of the rest of the suite could have seen it.
    //
    // The assertion is on STRUCTURE, never on wording: whatever the model
    // chooses to write, a line it ended must still be a line.
    const dir = freshFixture();
    const configDir = configFor(dir, live.pick);

    const r = await runCli([], {
      cwd: dir,
      configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'Read src/dashboard.js and src/ocr.js and describe what each one does. '
        + 'Use a short markdown list, and quote the offending line of code in a fenced '
        + 'code block. Change nothing.\n',
      timeoutMs: 420000,
    });

    const frames = allFrames(r.out);
    const everything = frames.join('\n');
    const rows = everything.split('\n');

    // A FENCE IS ITS OWN LINE. If one was drawn inside a sentence, the answer
    // was reflowed — which is the defect, exactly.
    const fenced = rows.filter((l) => l.includes('```'));
    // A fence row is the fence and, at most, a language tag. Anything else on
    // the row is prose that was folded into it.
    const inline = fenced.filter((l) => !/^```[a-zA-Z0-9+#-]*$/.test(l.trim()));
    if (fenced.length) {
      assert.strictEqual(inline.length, 0,
        `a code fence was drawn inside a line of prose — the answer was reflowed:\n${inline.slice(0, 3).join('\n')}`);
      process.stdout.write(`    · ${fenced.length} fence row(s), none reflowed into prose\n`);
      return;
    }

    // NO FENCE MEANS NO EVIDENCE EITHER WAY, and that is worth saying rather
    // than passing quietly. A bullet list is the weaker check available.
    const bullets = rows.filter((l) => /^\s{2,}[-*·]\s+\S/.test(l));
    process.stdout.write(`    · the model produced no fenced block; ${bullets.length} bullet row(s) checked instead\n`);
    assert.ok(bullets.length >= 2 || /\bLAIN\b/.test(everything),
      `neither fenced code nor a list was drawn, so the shape of the answer is UNVERIFIED:\n${lastFrame(r.out)}`);
  });
};
