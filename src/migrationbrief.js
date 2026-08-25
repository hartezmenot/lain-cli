'use strict';

/**
 * WHAT THE EXPENSIVE MODEL IS ACTUALLY GIVEN.
 *
 * Not "migrate the agents to Vue" and forty thousand tokens of repository.
 * A CONTRACT: the intent as confirmed by the user, the exact scope, the file-
 * by-file replacement map, the structure to preserve, what must not be touched,
 * what must not survive, and what will be checked afterwards.
 *
 * ------------------------------------------------------------------------
 * THE DIFFERENCE THIS MAKES IS NOT POLITENESS, IT IS ARITHMETIC.
 *
 *   WITHOUT   the model rediscovers the project, guesses the scope, and holds
 *             every file it read in context while it writes — and its guess
 *             about scope is unrecoverable, because the answer was never in
 *             the repository in the first place
 *
 *   WITH      the model reads a page, and every fact in it was established for
 *             free by a directory walk or settled for four words by a question
 * ------------------------------------------------------------------------
 *
 * IT IS WRITTEN TO BE EXECUTED, NOT INTERPRETED. Every line is either a fact
 * or an instruction with a named subject. There is no "consider whether", no
 * "you may wish to" — an ambiguity in this document is an ambiguity that was
 * supposed to have been resolved before it was written.
 *
 * AND IT NEVER PRESCRIBES A TOOL OR AN ORDER (see prompt.js). It states the
 * required FINAL STATE. How to get there is the model's decision, exactly as
 * it is for every other kind of work in this program.
 */

const M = require('./migration');

const MAX_ROWS = 60;
const MAX_RESPONSIBILITIES = 14;

/** A section, dropped entirely when it has nothing to say. */
function section(title, rows) {
  const kept = (rows || []).filter((r) => r != null && String(r).trim() !== '');
  if (!kept.length) return '';
  return `${title}\n${kept.join('\n')}`;
}

function cap(rows, n = MAX_ROWS) {
  if (rows.length <= n) return rows;
  return [...rows.slice(0, n), `  [${rows.length - n} more — the manifest has the full list]`];
}

/**
 * Render the contract.
 *
 * @param {object} contract
 * @param {object} o
 *   verification  a migrationcheck.verify result, when one has been run — so
 *                 the brief can say what is ALREADY true rather than restating
 *                 the plan at a model that has half-finished it.
 */
function render(contract, { verification = null } = {}) {
  const c = contract || {};
  const final = M.finalState(c);
  const src = c.source ? c.source.label : null;
  const tgt = c.target ? c.target.label : 'the target';
  const parts = [];

  parts.push('TASK TYPE: STRUCTURAL MIGRATION');
  parts.push('');
  parts.push(section('USER INTENT:', [`  ${c.intent || '(not recorded)'}`]));

  if (Object.keys(c.answers || {}).length) {
    parts.push('');
    parts.push(section('CONFIRMED BY THE USER (do not re-ask, do not second-guess):',
      Object.values(c.answers).map((a) => `  ${a.question} -> ${a.answer}`)));
  }

  parts.push('');
  parts.push(section('SCOPE:', [
    `  ${c.scope && c.scope.label ? c.scope.label : '(unresolved)'}`,
    c.scope && c.scope.kind === M.SCOPE_KIND.PROJECT
      ? '  This is a PROJECT-WIDE migration; it was stated as one.'
      : '  Nothing outside this scope is part of this migration. Do not widen it.',
  ]));

  // ---- THE MAP ----------------------------------------------------------
  parts.push('');
  parts.push(M.describeMap(c));

  // ---- THE STRUCTURE TO PRESERVE ---------------------------------------
  const shape = (c.shape || []).filter((s) => s.responsibilities && s.responsibilities.length);
  if (shape.length) {
    const rows = [];
    for (const s of shape.slice(0, 12)) {
      rows.push(`  ${s.from}  ->  ${s.to || '(name the target file deliberately)'}`);
      for (const r of s.responsibilities.slice(0, MAX_RESPONSIBILITIES)) rows.push(`      ${r}`);
      if (s.responsibilities.length > MAX_RESPONSIBILITIES) {
        rows.push(`      [${s.responsibilities.length - MAX_RESPONSIBILITIES} more]`);
      }
    }
    parts.push('');
    parts.push(section('STRUCTURE TO PRESERVE — these are RESPONSIBILITIES, not syntax:', rows));
    parts.push('  Build the target structure first and fill it in second. The names above are what the');
    parts.push(`  software does; ${src ? `how ${src} spelled them` : 'how the source spelled them'} is not part of what carries across.`);
  }

  // ---- MERGES, which carry responsibilities rather than files -----------
  for (const op of c.operations || []) {
    if (op.type !== M.OP.MERGE && op.type !== M.OP.CONSOLIDATE) continue;
    const rows = [];
    for (const g of (op.structure && op.structure.responsibilities) || []) {
      rows.push(`  ${g.from} contributes:`);
      for (const r of (g.responsibilities || []).slice(0, MAX_RESPONSIBILITIES)) rows.push(`      ${r}`);
    }
    parts.push('');
    parts.push(section(`${op.type} INTO ${op.target}:`, rows));
    parts.push('  Every responsibility above must exist in the result. Deleting the sources and writing');
    parts.push('  something new that resembles them is not a merge — it is a rewrite that loses behaviour.');
  }

  // ---- PRESERVED AND ADAPTED -------------------------------------------
  const preserved = (c.resources || []).filter((r) => r.disposition === M.DISPOSITION.PRESERVE);
  if (preserved.length) {
    parts.push('');
    parts.push(section('PRESERVE — do not translate, rewrite, move or reformat these:',
      cap(preserved.map((r) => `  ${r.path}${r.why ? `   (${r.why})` : ''}`))));
    parts.push('  These are read by whichever implementation is running and do not care which one it is.');
    parts.push('  Their bytes are checked afterwards; an incidental reformat is a verification failure.');
  }
  const adapt = (c.resources || []).filter((r) => r.disposition === M.DISPOSITION.ADAPT);
  if (adapt.length) {
    parts.push('');
    parts.push(section('ADAPT — keep these, but edit them to fit the target:',
      cap(adapt.map((r) => `  ${r.path}${r.why ? `   (${r.why})` : ''}`))));
  }

  // ---- KEEP, the hybrid half -------------------------------------------
  const keeps = (c.operations || []).filter((o) => o.type === M.OP.KEEP);
  if (keeps.length) {
    parts.push('');
    parts.push(section(`KEEP — ${src ? `${src} ` : ''}code that is NOT part of this migration and must still be there afterwards:`,
      cap(keeps.map((o) => `  ${o.source}`))));
    parts.push('  This project is deliberately not homogeneous. Migrating these as well would be a');
    parts.push('  verification failure, not thoroughness.');
  }

  // ---- DEPENDENCIES -----------------------------------------------------
  const affected = (c.dependencies && c.dependencies.affected) || [];
  if (affected.length) {
    parts.push('');
    parts.push(section('CALLERS THAT BREAK WHEN THE SOURCE GOES:',
      cap(affected.map((a) => `  ${a.path}   imports ${a.imports.join(', ')}`))));
  }

  // ---- WHAT WILL BE CHECKED --------------------------------------------
  parts.push('');
  parts.push(section('REQUIRED VERIFICATION — these are checked mechanically, not taken on trust:',
    cap(summarise(c.verification.required, verification && verification.positive))));
  parts.push('');
  parts.push(section('NEGATIVE VERIFICATION — a migration is NOT finished when the target merely exists:',
    cap(summarise(c.verification.negative, verification && verification.negative))));

  // ---- BACKUP AND ORDER ------------------------------------------------
  parts.push('');
  parts.push('BACKUP AND ORDER OF WORK:');
  parts.push('  Build the target, verify it, and only then retire the source. Do NOT delete anything');
  parts.push('  by hand: migration_activate takes a project checkpoint, moves the retired files out of');
  parts.push('  the tree into this migration\'s archive, re-verifies the final state, and puts');
  parts.push('  everything back if that fails. Deleting a file yourself skips all four of those.');

  parts.push('');
  parts.push('FINAL INVARIANT — the migration is complete when, and only when, all of this holds:');
  for (const a of cap(final.active.slice(0, 30), 30)) parts.push(`  ACTIVE     ${a}`);
  for (const i of cap(final.inactive.slice(0, 30), 30)) parts.push(`  INACTIVE   ${i}`);
  for (const p of cap(final.preserved.slice(0, 20), 20)) parts.push(`  PRESERVED  ${p}`);
  parts.push('');
  parts.push('The final state is what was asked for. The existence of the new code is not.');

  return parts.filter((p) => p !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A verification list, annotated with what is already true when that is known. */
function summarise(rows, results) {
  return (rows || []).map((r, i) => {
    const got = results && results[i];
    const state = got ? `  [${got.verdict}${got.detail ? `: ${got.detail}` : ''}]` : '';
    return `  ${describeCheck(r)}${state}`;
  });
}

function describeCheck(r) {
  switch (r.kind) {
    case 'file_exists': return `${r.value} exists${r.why ? ` — ${r.why}` : ''}`;
    case 'unchanged': return `${r.value} is byte-for-byte unchanged`;
    case 'responsibility': return `${r.value} is implemented in the target`;
    case 'file_inactive': return `${r.value} is no longer in the tree`;
    case 'no_importers': return `nothing imports ${r.value} any more`;
    case 'symbol_gone': return `${r.value} is not still declared by a source-technology file in scope`;
    case 'no_source_tech_in_scope': return `no ${r.value} file remains anywhere in the scope`;
    case 'caller_updated': return `${r.value} calls the target, not the old path`;
    default: return `${r.kind}: ${r.value}`;
  }
}

/** The short form, for a status line or a command panel. */
function oneLine(contract) {
  const c = contract || {};
  const from = c.source ? c.source.label : '?';
  const to = c.target ? c.target.label : '?';
  const n = (c.operations || []).filter((o) => o.type !== M.OP.KEEP).length;
  const keep = (c.operations || []).filter((o) => o.type === M.OP.KEEP).length;
  return `${from} -> ${to} in ${c.scope && c.scope.label ? c.scope.label : 'an unresolved scope'} `
    + `— ${n} operation(s), ${keep} kept, stage ${c.stage}`;
}

module.exports = { render, oneLine, describeCheck, section };
