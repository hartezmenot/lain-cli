'use strict';

/**
 * WHY SOMETHING DID NOT HAPPEN — named, so "Smoke failed." can stop being the
 * whole answer.
 *
 * ------------------------------------------------------------------------
 * A FLATTENED FAILURE COSTS THE NEXT HOUR.
 *
 * "Smoke failed" is compatible with: VMware is not installed, the guest is
 * powering on, the guest answered but the runner is not up, the app never
 * started, Chromium never started, the page loaded and a check genuinely
 * failed, and the test passed but the screenshot could not be copied back.
 * Those have SIX different next actions and one of them — the sixth — means the
 * code under test was fine. Collapsing them makes a person re-run the whole
 * thing to learn which one it was.
 *
 * ------------------------------------------------------------------------
 * TWO AUDIENCES, ONE RECORD.
 *
 * Each failure carries a `code` (for the machine and for tests), a short
 * `summary` (what a person reads) and `detail` (the raw text — a vmrun stderr
 * dump, a stack, a CDP error). The summary NEVER swallows the detail: the
 * detail goes to diagnostics and evidence, and stays out of the one-line
 * result. That is the split §23 asks for, made structural so a caller cannot
 * accidentally print a 4KB stderr into a status line.
 *
 * ------------------------------------------------------------------------
 * `BROWSER_VERIFICATION_FAILED` IS THE ONLY ONE THAT MEANS "THE CODE IS WRONG".
 *
 * Every other code here is an INFRASTRUCTURE fault: the test never ran. That
 * distinction is what `isInfrastructure` exists for, and it matters because an
 * infrastructure fault must never be reported as a failing verification — a
 * red verdict that actually means "VMware is missing" is worse than no verdict,
 * because someone will go looking for a bug that is not there.
 */

/** The taxonomy. Add here, never inline a new string at a call site. */
const CODE = {
  VM_UNAVAILABLE: 'VM_UNAVAILABLE',
  VM_START_FAILED: 'VM_START_FAILED',
  VM_NOT_READY: 'VM_NOT_READY',
  GUEST_EXEC_FAILED: 'GUEST_EXEC_FAILED',
  CHROMIUM_FAILED: 'CHROMIUM_FAILED',
  APP_START_FAILED: 'APP_START_FAILED',
  BROWSER_VERIFICATION_FAILED: 'BROWSER_VERIFICATION_FAILED',
  ARTIFACT_TRANSFER_FAILED: 'ARTIFACT_TRANSFER_FAILED',
};

/**
 * Everything except a real verification verdict is infrastructure. Stated as
 * one exclusion rather than a list of seven, so a code added above is treated
 * as infrastructure by DEFAULT — the safe direction. A new code that genuinely
 * means "the code under test is wrong" has to say so here, deliberately.
 */
const VERDICT_CODES = new Set([CODE.BROWSER_VERIFICATION_FAILED]);

function isInfrastructure(code) {
  return Boolean(code) && !VERDICT_CODES.has(String(code));
}

/** What a person is told first, per code. Short, and never a stack trace. */
const SUMMARY = {
  [CODE.VM_UNAVAILABLE]: 'no VM environment is available',
  [CODE.VM_START_FAILED]: 'the VM would not start',
  [CODE.VM_NOT_READY]: 'the VM is running but not ready to take work',
  [CODE.GUEST_EXEC_FAILED]: 'a command inside the guest failed to run',
  [CODE.CHROMIUM_FAILED]: 'the Harness browser would not start',
  [CODE.APP_START_FAILED]: 'the application under test would not start',
  [CODE.BROWSER_VERIFICATION_FAILED]: 'the page did not pass its checks',
  [CODE.ARTIFACT_TRANSFER_FAILED]: 'evidence could not be brought back',
};

/**
 * BUILD ONE. `why` overrides the stock summary when a call site knows
 * something better; `detail` is unbounded here and bounded at the edges that
 * display it, because truncating at construction destroys the diagnostic
 * before anyone has read it.
 */
function fail(code, why = '', detail = '', extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(SUMMARY, code);
  return {
    ok: false,
    code: known ? code : 'UNKNOWN',
    // A caller that passes an unknown code has a bug; saying so beats
    // silently inventing a category that tests will then assert against.
    why: String(why || SUMMARY[code] || `unrecognised failure code: ${code}`),
    detail: String(detail || ''),
    infrastructure: isInfrastructure(known ? code : null),
    at: Date.now(),
    ...extra,
  };
}

/**
 * ONE LINE FOR A STATUS SURFACE. The detail is deliberately NOT here — this is
 * the half that goes on screen next to a spinner.
 */
function line(f) {
  if (!f || f.ok) return '';
  return `${f.code}: ${f.why}`;
}

module.exports = { CODE, SUMMARY, fail, line, isInfrastructure, VERDICT_CODES };
