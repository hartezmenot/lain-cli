'use strict';

/**
 * INTENDED vs OBSERVED — the comparison that makes an architecture survivable.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION IT ANSWERS, and nothing else in the tree can answer it:
 *
 *     Is the project still the shape somebody decided it should be?
 *
 * The file index (projectindex.js) knows what is on disk. The architecture
 * (architecture.js) knows what was meant. Neither alone can tell you that
 * `guardian.rs` is GONE — the index simply stops listing a file it no longer
 * sees, and reports nothing missing, because "missing" is not a property a
 * directory listing has. It is a property of the DIFFERENCE.
 *
 * ------------------------------------------------------------------------
 * THE FOUR OBSERVATIONS, and what each one costs to get wrong.
 *
 *     PRESENT   the location exists. Says nothing about behaviour.
 *
 *     MISSING   nothing is there. If the node was PLANNED this is ordinary and
 *               unremarkable; if it was IMPLEMENTED it is the recovery signal —
 *               the architecture still knows the purpose, the parent, the
 *               dependencies and the last verification of something whose code
 *               no longer exists.
 *
 *     DAMAGED   it is there and it is broken. A zero-byte source file is the
 *               exact incident this system was built from, and a file that no
 *               longer parses is the same class: present, listed by every
 *               directory walk, and worth nothing.
 *
 *     DRIFTED   it is there, it is fine, and it CHANGED SINCE IT WAS VERIFIED.
 *               This is the subtle one, and the definition is deliberately
 *               narrow: drift is not "the file changed" — files change, that is
 *               the job. Drift is a VERIFICATION that no longer describes what
 *               is on disk. A claim that has quietly stopped being true is more
 *               dangerous than an absent claim, because somebody is relying on
 *               it.
 *
 * ------------------------------------------------------------------------
 * IT NEVER EDITS INTENT. `architecture.observe()` is the only thing this module
 * calls that writes, and it can only write the `observed` field. A reconciler
 * that could set `status` would "fix" a MISSING component by declaring it
 * PLANNED again, and the record of what was lost would be gone — which is the
 * failure the whole design exists to prevent.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE GUESSES. A node with no location gets UNKNOWN, not PRESENT and
 * not MISSING: nothing looked, because there was nowhere to look. Zero is not
 * unknown and unknown is not zero, here as everywhere else.
 */

const fs = require('fs');
const path = require('path');

const architecture = require('./architecture');
const lainstore = require('./lainstore');

const { OBSERVED, STATUS } = architecture;

/** Files past this are fingerprinted by stat alone; parsing them is not worth it. */
const MAX_PARSE_BYTES = 2_000_000;

/** Directory fingerprints stop here. A node pointing at `node_modules` is a mistake, not a workload. */
const MAX_DIR_ENTRIES = 400;

const JS = /\.(?:js|jsx|mjs|cjs)$/i;

/**
 * WHAT A LOCATION LOOKS LIKE RIGHT NOW, cheaply and comparably.
 *
 * Size and mtime, which is what `stat` gives for free — the same fingerprint
 * projectindex.js uses, and with the same stated limit: an edit that changes
 * neither is invisible to it. Recorded rather than papered over.
 */
function fingerprint(root, location) {
  if (!location) return { kind: 'none', print: '', bytes: 0 };
  const abs = path.resolve(root, location);
  let st;
  try { st = fs.statSync(abs); } catch { return { kind: 'absent', print: '', bytes: 0 }; }
  if (st.isFile()) {
    return { kind: 'file', print: `f:${st.size}:${Math.floor(st.mtimeMs)}`, bytes: st.size, abs };
  }
  if (!st.isDirectory()) return { kind: 'other', print: `o:${st.size}`, bytes: st.size, abs };
  // A DIRECTORY IS A NODE TOO. `rust/lain-supervisor` is a component; its
  // fingerprint is its shallow contents, which is enough to notice that the
  // whole thing was deleted or that a source file inside it vanished.
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return { kind: 'absent', print: '', bytes: 0 }; }
  const rows = [];
  let bytes = 0;
  for (const e of entries.slice(0, MAX_DIR_ENTRIES)) {
    if (e.isDirectory()) { rows.push(`${e.name}/`); continue; }
    let size = 0;
    try { size = fs.statSync(path.join(abs, e.name)).size; } catch { /* raced */ }
    bytes += size;
    rows.push(`${e.name}:${size}`);
  }
  rows.sort();
  return { kind: 'dir', print: `d:${rows.length}:${bytes}:${rows.join(',').length}`, bytes, abs, count: rows.length };
}

/**
 * IS THIS BROKEN? Only for things cheap and certain enough to be sure about.
 *
 * An empty source file is the incident. A JavaScript file that does not parse
 * is the same shape. Everything else is left alone: reporting DAMAGED because a
 * checker was unavailable would be the "clean because the linter is missing"
 * error with the sign flipped, and it is worse — it condemns working code.
 */
function damage(fp) {
  if (fp.kind === 'file') {
    if (fp.bytes === 0) return 'the file is there and it is empty';
    if (JS.test(fp.abs) && fp.bytes <= MAX_PARSE_BYTES) {
      let r;
      try { r = require('./diagnostics').checkJs(fs.readFileSync(fp.abs, 'utf8'), fp.abs); } catch { return ''; }
      if (r && r.ok === false && !r.inconclusive) {
        return `it does not parse${r.line ? ` (line ${r.line})` : ''}: ${r.message || 'syntax error'}`;
      }
    }
    return '';
  }
  if (fp.kind === 'dir' && fp.count === 0) return 'the directory is there and it is empty';
  return '';
}

/**
 * COMPARE THE WHOLE ARCHITECTURE AGAINST THE DISK.
 *
 * Mutates `model` in place — only the `observed` field of each node — and
 * returns what it found. The caller saves; this does not, because a
 * reconciliation run against a read-only checkout is still worth reading.
 */
function reconcile(root, model, { at = Date.now() } = {}) {
  const report = {
    at,
    checked: 0,
    present: 0,
    missing: 0,
    damaged: 0,
    drifted: 0,
    unknown: 0,
    alarms: [],
    prints: {},
  };

  for (const node of Object.values(model.nodes)) {
    report.checked += 1;
    if (!node.location) {
      // NOTHING TO LOOK AT is not the same as NOTHING THERE. A design-only node
      // is a legitimate, complete state.
      architecture.observe(model, node.id, { status: OBSERVED.UNKNOWN, note: 'no location recorded', at });
      report.unknown += 1;
      continue;
    }
    const fp = fingerprint(root, node.location);
    report.prints[node.id] = fp.print;

    if (fp.kind === 'absent' || fp.kind === 'none') {
      architecture.observe(model, node.id, {
        status: OBSERVED.MISSING,
        note: `nothing at ${node.location}`,
        at,
      });
      report.missing += 1;
      if (node.status !== STATUS.PLANNED) {
        // THE RECOVERY SIGNAL. A planned thing that does not exist yet is
        // normal; a built thing that does not exist any more is not.
        report.alarms.push({
          id: node.id,
          name: node.name,
          kind: 'MISSING',
          say: `${node.name} was ${node.status} at ${node.location} and there is nothing there now`,
        });
      }
      continue;
    }

    const broken = damage(fp);
    if (broken) {
      architecture.observe(model, node.id, { status: OBSERVED.DAMAGED, note: broken, fingerprint: fp.print, at });
      report.damaged += 1;
      report.alarms.push({ id: node.id, name: node.name, kind: 'DAMAGED', say: `${node.name}: ${broken}` });
      continue;
    }

    // ---- DRIFT: A VERIFICATION THAT STOPPED BEING TRUE -------------------
    //
    // Only ever computed against the print captured AT VERIFICATION TIME. With
    // no such print there is no drift to detect and the honest answer is
    // PRESENT — an unverified file that changed is a file that changed.
    const was = String((node.verification && node.verification.fingerprint) || '');
    if (was && was !== fp.print) {
      architecture.observe(model, node.id, {
        status: OBSERVED.DRIFTED,
        note: `changed since it was verified by ${node.verification.how || 'something'}`,
        fingerprint: fp.print,
        at,
      });
      report.drifted += 1;
      report.alarms.push({
        id: node.id,
        name: node.name,
        kind: 'DRIFTED',
        say: `${node.name} changed since the verification that made it VERIFIED — re-check it`,
      });
      continue;
    }

    architecture.observe(model, node.id, { status: OBSERVED.PRESENT, fingerprint: fp.print, at });
    report.present += 1;
  }

  return report;
}

/**
 * RECONCILE AND PERSIST, including the run itself.
 *
 * The run record lives in its own slot so that "when did anything last look at
 * this project" is answerable without parsing the architecture — and so that a
 * report can say `nothing has looked since` rather than inventing a number.
 */
function run(root, { model = null, save = true } = {}) {
  const m = model || architecture.load(root);
  const report = reconcile(root, m);
  if (save) {
    architecture.save(root, m);
    lainstore.write(root, 'observed', {
      at: report.at,
      checked: report.checked,
      present: report.present,
      missing: report.missing,
      damaged: report.damaged,
      drifted: report.drifted,
      unknown: report.unknown,
      prints: report.prints,
    });
  }
  return { model: m, report };
}

/**
 * VERIFY A NODE AND CAPTURE WHAT WAS VERIFIED.
 *
 * The pair matters: a verification with no fingerprint can never be detected as
 * stale, so `VERIFIED` would be a word that only ever accumulates. Recording
 * the print at the moment of the check is what makes DRIFTED possible at all.
 */
function record(root, model, id, { how, result, by = 'lain', at = Date.now() } = {}) {
  // THE NODE BEFORE THE ATTEMPT, because a REFUSED verification must not
  // change it. `architecture.verify` sets VERIFIED the moment its own checks
  // pass, and the absence check below can only run after — so without this
  // snapshot, a node recorded IMPLEMENTED and verified against a file that
  // has vanished would end the refusal as VERIFIED / MISSING: the strongest
  // word in the vocabulary, granted by the very call that rejected it. A
  // PREVIOUS verification is restored with it, not wiped: its fingerprint is
  // what makes DRIFTED detectable at all.
  const node0 = model.nodes[id];
  const was = node0 ? { status: node0.status, verification: { ...node0.verification } } : null;
  const r = architecture.verify(model, id, { how, result, by, at });
  if (!r.ok) return r;
  const node = model.nodes[id];
  if (node.location) {
    const fp = fingerprint(root, node.location);
    node.verification.fingerprint = fp.print;
    if (fp.kind === 'absent') {
      // A VERIFICATION OF SOMETHING THAT IS NOT THERE is refused, and this is
      // the last place it can be caught. Nothing ran against that file — so
      // the node goes back to what it was, and only the OBSERVATION of the
      // absence is recorded: the disk's word, which the reconciler alone may
      // write.
      if (was) {
        node.status = was.status;
        node.verification = was.verification;
      }
      architecture.observe(model, id, { status: OBSERVED.MISSING, note: `nothing at ${node.location}`, at });
      return { ok: false, error: `nothing exists at ${node.location} — a verification cannot be recorded against it` };
    }
    architecture.observe(model, id, { status: OBSERVED.PRESENT, fingerprint: fp.print, at });
  }
  return { ok: true, node };
}

/**
 * THE REPORT, in the words a person or a model acts on.
 *
 * ALARMS FIRST AND COUNTS AFTER, because a reader scanning this wants to know
 * whether anything is wrong before they want to know how much was checked.
 */
function say(model, report) {
  const out = [];
  if (report.alarms.length) {
    out.push(`ARCHITECTURE vs DISK — ${report.alarms.length} discrepanc${report.alarms.length === 1 ? 'y' : 'ies'}:`);
    for (const a of report.alarms) out.push(`  ${a.kind.padEnd(8)} ${a.say}`);
    out.push('');
    out.push('The architecture still describes these components — their purpose, their place '
      + 'and their last verification are in .lain/ and did not go anywhere. What is gone is the '
      + 'implementation.');
  } else if (report.checked) {
    out.push(`ARCHITECTURE vs DISK — nothing is missing, damaged or drifted (${report.checked} node(s) checked).`);
  } else {
    out.push('No architecture has been recorded for this project yet, so there is nothing to compare.');
  }
  if (report.checked) {
    out.push('');
    out.push(`  present ${report.present}   missing ${report.missing}   damaged ${report.damaged}`
      + `   drifted ${report.drifted}   design-only ${report.unknown}`);
    const t = architecture.tally(model);
    out.push(`  intent:  planned ${t.planned}   partial ${t.partial}   implemented ${t.implemented}   verified ${t.verified}`);
  }
  return out.join('\n');
}

module.exports = { fingerprint, damage, reconcile, run, record, say, MAX_DIR_ENTRIES };
