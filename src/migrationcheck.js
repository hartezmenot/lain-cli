'use strict';

/**
 * DID THE ARCHITECTURE ACTUALLY CHANGE?
 *
 * ------------------------------------------------------------------------
 * A NORMAL AGENT VERIFIES ONE THING AND CALLS IT TWO.
 *
 *     scanner.py exists          ✓  proven by the file
 *     scanner.py works           ✓  proven by the tests
 *     scanner.cpp is gone        ?  nothing on earth checked this
 *
 * The third claim is the one the user actually made, and it is the only one
 * with no natural evidence: a leftover implementation breaks nothing, which is
 * precisely why it survives every suite ever written. So it is checked here,
 * explicitly, as a list of things that must NOT be true.
 * ------------------------------------------------------------------------
 *
 * AND THE HYBRID HALF, which is the same discipline pointed the other way.
 * "Change Agent B to Vue" asserts that Agent A and Agent C are STILL REACT
 * afterwards. A migration that helpfully converted all three passes every
 * positive check ever written and has destroyed two thirds of the request, so
 * KEEP is verified as strictly as REPLACE.
 *
 * BACKUP BEFORE DESTRUCTION, and the backup is not a new invention: the
 * project already has checkpoints (backups.js), and this calls them. What it
 * adds is an ARCHIVE — the source implementation moved out of the tree and
 * into the migration's own store, so it is retrievable, is not running, and is
 * not something the residue sweep then reports as unfinished work.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const M = require('./migration');
const tech = require('./tech');
const structure = require('./structure');
const map = require('./migrationmap');

/** A check's verdict. Three values, because UNKNOWN is not PASS. */
const V = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' });

function sha(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16); }
function abs(root, rel) { return path.resolve(root, String(rel).replace(/\\/g, '/')); }
function exists(root, rel) { try { return fs.statSync(abs(root, rel)).isFile(); } catch { return false; } }
function readFile(root, rel) { try { return fs.readFileSync(abs(root, rel), 'utf8'); } catch { return null; } }

/** Where a migration keeps what it took out of the tree. */
function archiveDir(id) { return path.join(M.dir(), String(id), 'archive'); }

// ------------------------------------------------------------ the sweep ----

/**
 * ONE PASS OVER THE TREE, answering every question the checks will ask.
 *
 * Built once and shared, because the alternative is a directory walk per check
 * and a contract has dozens. What it collects is deliberately small: which
 * files of the source technology survive, and which names each of them still
 * declares.
 */
function sweep(root, contract) {
  const source = contract.source ? tech.resolve(contract.source.id || contract.source.label) : null;
  const scope = contract.scope || {};
  const survivors = [];
  const declared = new Map();          // name -> [rel]
  const targets = new Map();           // rel -> structure, for the target files

  const wantedTargets = new Set();
  for (const op of contract.operations || []) {
    if (op.type === M.OP.KEEP) continue;
    for (const t of (op.targets && op.targets.length ? op.targets : [op.target])) {
      if (t && !/^\(/.test(t)) wantedTargets.add(String(t).replace(/\\/g, '/'));
    }
  }

  // ---- SOME MIGRATIONS DO NOT NAME THEIR TARGETS, AND CANNOT ------------
  //
  // "Split this agent into three" and "merge these three into one" name a
  // SHAPE, not a set of file paths — deciding those is the work being asked
  // for. So for those operations the responsibility checks look at every file
  // in scope that is not one of the files being retired.
  //
  // That is a weaker check than "scanner.py declares scan", and deliberately
  // the right one here: it still catches the failure that matters — a
  // responsibility DROPPED on the floor during a division or a merge — while
  // staying silent about which part each one landed in, because nobody said.
  const distributed = (contract.operations || []).some((op) => (
    op.type === M.OP.SPLIT || op.type === M.OP.EXTRACT || op.type === M.OP.MERGE || op.type === M.OP.CONSOLIDATE
  ));
  const retiring = new Set((contract.resources || [])
    .filter((r) => r.disposition === M.DISPOSITION.ARCHIVE || r.disposition === M.DISPOSITION.REMOVE)
    .map((r) => r.path));

  for (const f of map.files(root)) {
    if (wantedTargets.has(f.rel)) targets.set(f.rel, structure.extractFile(f.abs, f.rel));
    else if (distributed && !retiring.has(f.rel) && !structure.isData(f.rel)) {
      // NOT LIMITED TO THE SCOPE, deliberately. The parts of a split land in
      // NEW places — `agents/mono` divided into `agents/ui`, `agents/api` and
      // `agents/test` puts every one of them outside the scope that was
      // divided. Looking only inside it found nothing at all, so every
      // responsibility came back UNKNOWN and a split that had dropped a whole
      // job read as complete.
      targets.set(f.rel, structure.extractFile(f.abs, f.rel));
    }
    if (!source || !map.ownedBy(source, f)) continue;
    const within = map.inScope(scope, f.rel);
    if (within) survivors.push(f.rel);
    const s = structure.extractFile(f.abs, f.rel);
    for (const u of s.units) {
      if (!declared.has(u.name)) declared.set(u.name, []);
      declared.get(u.name).push({ rel: f.rel, inScope: within });
    }
  }
  return { source, survivors, declared, targets, wantedTargets };
}

/** Who still imports the paths this migration was meant to retire. */
function importersOf(root, paths) {
  const residue = require('./residue');
  const out = new Map();
  for (const p of paths.slice(0, 40)) {
    let r;
    try { r = residue.forPath(root, p); } catch { continue; }
    out.set(p, r.importers.map((i) => ({ where: i.where, line: i.line, spec: i.spec, test: i.test })));
  }
  return out;
}

// ------------------------------------------------------------- the checks --

/**
 * Run the contract's own verification lists against the tree as it is now.
 *
 * Returns both halves separately and never merges them, because they mean
 * different things at different moments: before activation the positive half
 * SHOULD pass and the negative half SHOULD NOT, and reporting one number would
 * make that indistinguishable from a broken migration.
 */
function verify(root, contract) {
  const c = contract || {};
  const state = sweep(root, c);
  const retiring = (c.verification.negative || [])
    .filter((n) => n.kind === 'file_inactive' || n.kind === 'no_importers')
    .map((n) => n.value);
  const importers = importersOf(root, [...new Set(retiring)]);

  const positive = (c.verification.required || []).map((r) => checkPositive(root, c, state, r));
  const negative = (c.verification.negative || []).map((n) => checkNegative(root, c, state, importers, n));

  const failed = (rows) => rows.filter((r) => r.verdict === V.FAIL);
  // ---- UNKNOWN IS NOT PASS, AND THIS IS WHERE THAT HAS TEETH ------------
  //
  // A required check that could not be EVALUATED has not been satisfied. It
  // read as satisfied, and the hole was exactly where it does most damage: a
  // split names no target files, so before any part is written there is
  // nothing to look in, every responsibility comes back UNKNOWN, and
  // `positiveOk` said the target was ready to activate over an empty tree.
  //
  // Only the POSITIVE half is held to this. An unevaluable NEGATIVE check is
  // the opposite situation — "I could not confirm the old thing is still
  // there" must not block a migration — and those are reported and counted
  // rather than being allowed to fail it.
  const unresolved = positive.filter((r) => r.verdict === V.UNKNOWN);
  const positiveOk = !failed(positive).length && !unresolved.length;
  const negativeOk = !failed(negative).length;
  return {
    id: c.id,
    stage: c.stage,
    positive,
    negative,
    positiveOk,
    negativeOk,
    ok: positiveOk && negativeOk,
    failures: [...failed(positive), ...failed(negative)],
    unresolved,
    survivors: state.survivors,
  };
}

function checkPositive(root, c, state, r) {
  const row = { ...r, half: 'required' };
  if (r.kind === 'file_exists') {
    row.verdict = exists(root, r.value) ? V.PASS : V.FAIL;
    row.detail = row.verdict === V.PASS ? 'present' : 'not on disk';
    return row;
  }
  if (r.kind === 'unchanged') {
    const text = readFile(root, r.value);
    if (text == null) { row.verdict = V.FAIL; row.detail = 'a PRESERVED resource has been deleted'; return row; }
    if (!r.hash) { row.verdict = V.UNKNOWN; row.detail = 'no hash was recorded when the contract was written'; return row; }
    const now = sha(text);
    row.verdict = now === r.hash ? V.PASS : V.FAIL;
    row.detail = row.verdict === V.PASS ? 'byte-for-byte identical' : `content changed (${r.hash} -> ${now})`;
    return row;
  }
  if (r.kind === 'responsibility') {
    // A RESPONSIBILITY IS SATISFIED BY A NAME IN A TARGET FILE, not by a name
    // anywhere. `Scanner.scan` surviving in the C++ it was migrated FROM is
    // the failure, not the proof.
    const wanted = String(r.value).split('.');
    const leaf = wanted[wanted.length - 1];
    if (!state.targets.size) { row.verdict = V.UNKNOWN; row.detail = 'no target file exists yet to look in'; return row; }
    let found = '';
    for (const [rel, s] of state.targets) {
      for (const u of s.units) {
        if (u.name === leaf || `${u.container}.${u.name}` === r.value) { found = rel; break; }
      }
      if (found) break;
    }
    if (found) { row.verdict = V.PASS; row.detail = `carried by ${found}`; return row; }

    // ---- A WEAKER PASS, ON PURPOSE, AND ONLY IN THIS DIRECTION -----------
    //
    // A declaration is the good evidence, and across a LANGUAGE migration it is
    // what happens: `void Scanner::scan()` becomes `def scan(self)`. Across a
    // PARADIGM change it is not — a React `export function Card()` becomes a
    // Vue single-file component whose only trace of the name is
    // `name: 'Card'`, which no declaration pattern will ever find.
    //
    // What this check exists to catch is a responsibility that was DROPPED, and
    // a name that appears nowhere in the target has been dropped. So a bare
    // mention passes, and SAYS it is only a mention. The asymmetry is
    // deliberate: a false pass here costs one weak line in a report, while a
    // false failure blocks the activation of a correct migration and sends the
    // model rewriting working code to satisfy a pattern.
    const word = new RegExp(`(?:^|[^\\w$])${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w$]|$)`);
    for (const rel of state.targets.keys()) {
      const text = readFile(root, rel);
      if (text && word.test(text)) {
        row.verdict = V.PASS;
        row.detail = `named in ${rel}, though not as a declaration this can see`;
        return row;
      }
    }
    row.verdict = V.FAIL;
    row.detail = 'no target file declares or even mentions it';
    return row;
  }
  row.verdict = V.UNKNOWN;
  row.detail = `no check knows how to verify "${r.kind}"`;
  return row;
}

function checkNegative(root, c, state, importers, n) {
  const row = { ...n, half: 'negative' };
  if (n.kind === 'file_inactive') {
    const still = exists(root, n.value);
    row.verdict = still ? V.FAIL : V.PASS;
    row.detail = still
      ? 'STILL ON DISK — the source implementation is active'
      : (c.archived || []).some((a) => a.from === n.value) ? 'archived out of the tree' : 'gone';
    return row;
  }
  if (n.kind === 'no_importers') {
    const rows = importers.get(n.value) || [];
    row.verdict = rows.length ? V.FAIL : V.PASS;
    row.detail = rows.length
      ? `${rows.length} file(s) still import it: ${rows.slice(0, 4).map((i) => `${i.where}:${i.line}`).join(', ')}`
      : 'nothing imports it';
    return row;
  }
  if (n.kind === 'symbol_gone') {
    const hits = (state.declared.get(n.value) || []).filter((h) => h.inScope);
    row.verdict = hits.length ? V.FAIL : V.PASS;
    row.detail = hits.length
      ? `still declared by ${hits.slice(0, 3).map((h) => h.rel).join(', ')}`
      : 'no source-technology file in scope declares it';
    return row;
  }
  if (n.kind === 'no_source_tech_in_scope') {
    row.verdict = state.survivors.length ? V.FAIL : V.PASS;
    row.detail = state.survivors.length
      ? `${state.survivors.length} file(s) remain: ${state.survivors.slice(0, 5).join(', ')}`
      : 'none remain in scope';
    return row;
  }
  if (n.kind === 'caller_updated') {
    let stale = [];
    for (const [src, rows] of importers) {
      for (const i of rows) if (i.where === n.value) stale.push(src);
    }
    stale = [...new Set(stale)];
    row.verdict = stale.length ? V.FAIL : V.PASS;
    row.detail = stale.length ? `still imports ${stale.join(', ')}` : 'no longer points at the old module';
    return row;
  }
  row.verdict = V.UNKNOWN;
  row.detail = `no check knows how to verify "${n.kind}"`;
  return row;
}

// ------------------------------------------------- backup, then destruction --

/**
 * TAKE THE OLD IMPLEMENTATION OUT OF THE TREE — but only once the new one has
 * been shown to work, and never without a way back.
 *
 * The order is the whole safety argument and it is not negotiable:
 *
 *     verify the target -> checkpoint the tree -> archive the source
 *     -> verify the FINAL state -> and if that fails, put it all back
 *
 * A migration that archives first and verifies afterwards has a window in
 * which neither implementation is known to work, and the user's project is in
 * it.
 */
function activate(root, contract, { backups = null, tests = null, force = false } = {}) {
  const c = contract;
  const before = verify(root, c);
  if (!before.positiveOk && !force) {
    return {
      ok: false,
      why: 'the target is not verified yet, so nothing was archived. '
        + `${before.positive.filter((r) => r.verdict === V.FAIL).length} required check(s) fail.`,
      verification: before,
    };
  }

  // ---- THE CHECKPOINT, from the system that already owns checkpoints -----
  const bk = backups || require('./backups');
  let checkpoint = null;
  try {
    const r = bk.create(root, {
      label: `before migration ${c.id}`,
      reason: c.intent || `migration ${c.id}`,
      tests,
    });
    checkpoint = r.ok ? r.row : null;
    if (!r.ok && !force) {
      return { ok: false, why: `no checkpoint could be taken (${r.why}) — nothing was archived`, verification: before };
    }
  } catch (e) {
    if (!force) return { ok: false, why: `no checkpoint could be taken (${(e && e.message) || e}) — nothing was archived`, verification: before };
  }
  c.backup = checkpoint ? { kind: 'checkpoint', id: checkpoint.id, at: checkpoint.at } : null;

  // ---- ARCHIVE, which is a MOVE and never a delete ----------------------
  const moved = [];
  const removed = [];
  for (const r of c.resources || []) {
    if (r.disposition !== M.DISPOSITION.ARCHIVE && r.disposition !== M.DISPOSITION.REMOVE) continue;
    const from = abs(root, r.path);
    if (!fs.existsSync(from)) continue;
    const to = path.join(archiveDir(c.id), r.path);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      moved.push({ from: r.path, to, disposition: r.disposition });
      if (r.disposition === M.DISPOSITION.REMOVE) removed.push(r.path);
    } catch (e) {
      // A PARTIAL ARCHIVE IS THE WORST STATE OF ALL, so it is undone at once
      // rather than reported and left.
      restoreArchived(root, moved);
      return { ok: false, why: `archiving ${r.path} failed (${(e && e.message) || e}); everything moved so far was put back`, verification: before };
    }
  }
  c.archived = moved.map((m) => ({ from: m.from, to: m.to, disposition: m.disposition }));
  M.note(c, M.STAGE.ACTIVATED, `archived ${moved.length} file(s); checkpoint ${checkpoint ? checkpoint.id : 'none'}`);

  // ---- AND NOW THE QUESTION THAT DECIDES WHETHER THIS WORKED ------------
  const after = verify(root, c);
  if (!after.ok) {
    const back = rollback(root, c, { backups: bk });
    return {
      ok: false,
      rolledBack: true,
      why: 'the final state did not verify after activation, so the old implementation was restored',
      verification: after,
      rollback: back,
    };
  }
  M.note(c, M.STAGE.COMPLETE, 'final state verified: target active, source archived, preserved resources intact');
  try { M.save(c); } catch { /* the manifest is a record, not the work */ }
  return { ok: true, archived: moved, checkpoint, verification: after };
}

/** Put the archived files back where they came from. The precise inverse. */
function restoreArchived(root, moved) {
  const back = [];
  for (const m of moved) {
    try {
      const to = abs(root, m.from);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(m.to, to);
      back.push(m.from);
    } catch { /* report what came back, not what did not */ }
  }
  return back;
}

/**
 * PUT IT BACK.
 *
 * The archive is restored first, because that alone makes the old
 * implementation active again and it cannot lose anything: every file it
 * writes is one this migration moved out itself. The whole-tree checkpoint is
 * the heavier instrument and is used only when asked for, since it also
 * reverses edits that had nothing to do with the migration.
 */
function rollback(root, contract, { backups = null, full = false } = {}) {
  const c = contract;
  const restored = restoreArchived(root, c.archived || []);
  let checkpoint = null;
  if (full && c.backup && c.backup.id) {
    const bk = backups || require('./backups');
    try { checkpoint = bk.restore(root, c.backup.id); } catch (e) { checkpoint = { ok: false, why: (e && e.message) || String(e) }; }
  }
  c.archived = [];
  M.note(c, M.STAGE.ROLLED_BACK, `restored ${restored.length} archived file(s)${full ? ', plus the checkpoint' : ''}`);
  try { M.save(c); } catch { /* a record, not the work */ }
  return { ok: true, restored, checkpoint, targetsLeftInPlace: targetPaths(c) };
}

/** Every path the migration created. Left alone by a rollback, and named. */
function targetPaths(contract) {
  const out = [];
  for (const op of contract.operations || []) {
    if (op.type === M.OP.KEEP) continue;
    for (const t of (op.targets && op.targets.length ? op.targets : [op.target])) {
      if (t && !/^\(/.test(t)) out.push(t);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- report ----

/** The verdict, in the order it is asked about. */
function describe(result) {
  const lines = [];
  const r = result;
  lines.push(r.ok
    ? 'MIGRATION VERIFIED — the target is active, the source is not, and everything preserved is intact.'
    : r.positiveOk
      ? 'TARGET READY, MIGRATION NOT FINISHED — everything required exists, but the old implementation is still active.'
      : 'NOT VERIFIED.');

  lines.push('', 'MUST EXIST');
  for (const row of r.positive) lines.push(`  ${mark(row.verdict)} ${label(row)}${row.detail ? ` — ${row.detail}` : ''}`);
  if (!r.positive.length) lines.push('  (nothing required — the contract lists no positive checks)');

  lines.push('', 'MUST NOT REMAIN ACTIVE');
  for (const row of r.negative) lines.push(`  ${mark(row.verdict, true)} ${label(row)}${row.detail ? ` — ${row.detail}` : ''}`);
  if (!r.negative.length) {
    lines.push('  (nothing — this contract disposes of nothing, which for a migration is itself the defect)');
  }

  if (r.failures.length) {
    lines.push('', `${r.failures.length} check(s) fail. The migration is not complete until every one of them passes: `
      + 'a target that exists is only half of what was asked for.');
  }
  if (r.unresolved && r.unresolved.length) {
    lines.push('', `${r.unresolved.length} required check(s) could not be evaluated yet — marked ?. `
      + 'Unevaluated is not passed: the migration is not finished while any of them stands.');
  }
  return lines.join('\n');
}

function mark(verdict, negative = false) {
  if (verdict === V.PASS) return negative ? 'x' : 'v';
  if (verdict === V.FAIL) return '!';
  return '?';
}

function label(row) {
  if (row.kind === 'file_exists') return `${row.value} exists`;
  if (row.kind === 'unchanged') return `${row.value} unchanged`;
  if (row.kind === 'responsibility') return `${row.value} is implemented`;
  if (row.kind === 'file_inactive') return `${row.value} is no longer in the tree`;
  if (row.kind === 'no_importers') return `nothing imports ${row.value}`;
  if (row.kind === 'symbol_gone') return `${row.value} is not still declared in scope`;
  if (row.kind === 'no_source_tech_in_scope') return `no ${row.value} file remains in scope`;
  if (row.kind === 'caller_updated') return `${row.value} no longer calls the old path`;
  return `${row.kind} ${row.value}`;
}

module.exports = { verify, activate, rollback, describe, sweep, archiveDir, targetPaths, restoreArchived, V };
