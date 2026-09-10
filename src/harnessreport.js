'use strict';

/**
 * THE DOCTOR, RENDERED — one report, read by `lain --doctor` and by
 * `/harness doctor` alike.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS ITS OWN FILE.
 *
 * Two callers want the same words: the CLI flag an installer runs before there
 * is a session, and the slash command a person runs mid-task. If each formatted
 * the rows itself they would drift, and the day they disagreed somebody would
 * be looking at two different accounts of the same machine. `harness.doctor()`
 * measures; this arranges; nothing else writes these lines.
 *
 * ------------------------------------------------------------------------
 * THE THREE MARKS, AND WHY AN UNAVAILABLE OPTIONAL IS NOT AN ERROR.
 *
 *     ✓   available
 *     ○   optional, and not here — a fact, not a fault
 *     ✗   MISCONFIGURED — something is set up and set up wrongly
 *
 * The distinction is the whole point of the report. A server with no Chrome is
 * a perfectly healthy LAIN whose browser checks will say INCONCLUSIVE; marking
 * that with the same symbol as a broken task store would train people to ignore
 * both. `✗` is reserved for the thing that actually needs attention.
 *
 * NO COLOUR, NO CURSOR, NO PANEL. This is printed by a CLI flag that may be
 * running inside an installer, a CI log or a pipe. It is plain text.
 */

/** Marks are ASCII-plus-one-symbol so they survive every terminal codepage. */
const MARK = Object.freeze({
  AVAILABLE: '✓',      // ✓
  UNAVAILABLE: '○',    // ○
  MISCONFIGURED: '✗',  // ✗
});

function markFor(row) {
  if (row.state === 'AVAILABLE') return MARK.AVAILABLE;
  // A CORE capability that is not available is broken, whatever its state says.
  if (row.kind === 'core') return MARK.MISCONFIGURED;
  return MARK[row.state] || MARK.UNAVAILABLE;
}

/**
 * @param {Array} rows      from `harness.doctor()`
 * @param {object} summary  from `Harness.summarise(rows)`
 * @returns {string} the whole report, ending in a newline
 */
function render(rows, summary) {
  const lines = ['', 'LAIN Harness', ''];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push(group);
    }
    lines.push(`  ${markFor(r)} ${String(r.name).padEnd(20)}${r.why || ''}`);
  }
  lines.push('');
  if (summary) {
    lines.push(summary.ok ? '  Core is available.' : `  CORE PROBLEM: ${summary.why}`);
    if (summary.unavailable && summary.unavailable.length) {
      // SAID PLAINLY, because the alternative reading — that something is
      // wrong — is the one people reach for when they see a list.
      lines.push(`  Optional and not present: ${summary.unavailable.join(', ')}.`
        + ' These are not errors; the capabilities that need them report INCONCLUSIVE.');
    }
    if (summary.misconfigured && summary.misconfigured.length) {
      lines.push(`  Configured and not working: ${summary.misconfigured.join(', ')}.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { render, MARK, markFor };
