'use strict';

/**
 * THE VERIFICATION ENGINE — the only thing in LAIN that may say a task passed.
 *
 * ------------------------------------------------------------------------
 * THE SENTENCE THIS FILE EXISTS TO MAKE FALSE:
 *
 *     "I've fixed the authentication redirect."
 *
 * That is a CLAIM. It has never been evidence, and every harness that treats it
 * as evidence produces the same failure — work reported as finished that was
 * never checked, discovered by the person, hours later, in production.
 *
 * A VERIFICATION CONTRACT is the claim rewritten as something falsifiable:
 *
 *     REQUIREMENT   the authentication redirect works
 *     EVIDENCE      the build passes
 *                   the auth tests pass
 *                   POST /login answers 302
 *                   the browser flow reaches /dashboard
 *                   the browser console has no errors from that flow
 *
 * Each line is run. Each produces PASSED, FAILED or INCONCLUSIVE. The task's
 * verdict is arithmetic over those, and arithmetic has no opinions.
 *
 * ------------------------------------------------------------------------
 * THE ARITHMETIC, AND WHY IT IS IN THIS ORDER.
 *
 *     any REQUIRED requirement FAILED           -> FAILED
 *     every REQUIRED requirement PASSED         -> PASSED
 *     otherwise (something required is MISSING) -> INCONCLUSIVE
 *
 * FAILED is checked FIRST and that ordering is load-bearing. A contract with
 * one red test and one browser check that never ran is FAILED, not
 * INCONCLUSIVE: something was proved wrong, and the missing evidence does not
 * soften it. The reverse ordering would let any task hide a real failure behind
 * an unrunnable check.
 *
 * OPTIONAL REQUIREMENTS ARE RUN AND REPORTED AND CANNOT CHANGE THE VERDICT.
 * They exist because "the lint is clean" is worth knowing and is not worth
 * failing a bug fix over. A contract with no required requirements at all is
 * INCONCLUSIVE by construction — nothing was required, so nothing was proved.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS ENGINE IS NOT ALLOWED TO DO.
 *
 * It does not read the transcript. It does not ask a model. It does not weigh
 * "the model sounded confident" against a red check. It does not retry a failed
 * check hoping for a different answer — a flaky check is a fact about the
 * project, and hiding it here is how a harness stops being trustworthy. Recovery
 * is a decision made ABOVE this file, by recovery.js, with this file's report in
 * hand.
 */

const checks = require('./checks');
const { VERDICT } = checks;

/** A contract with more than this is a task that should have been two tasks. */
const MAX_REQUIREMENTS = 24;
const MAX_CHECKS_PER_REQUIREMENT = 12;

/**
 * Normalise whatever the caller wrote into a contract.
 *
 * DELIBERATELY FORGIVING ABOUT SHAPE AND STRICT ABOUT MEANING. A requirement
 * may be written as a string ("the tests pass") with its checks inline, or as a
 * full object. What is never inferred is whether it is REQUIRED: the default is
 * true, because a contract whose requirements quietly default to optional is a
 * contract that always passes.
 */
function contract(spec = {}) {
  const raw = Array.isArray(spec) ? spec : (spec.requirements || []);
  const requirements = [];
  for (const r of raw.slice(0, MAX_REQUIREMENTS)) {
    if (!r) continue;
    const checkList = (Array.isArray(r.checks) ? r.checks : (r.check ? [r.check] : []))
      .slice(0, MAX_CHECKS_PER_REQUIREMENT)
      .filter(Boolean);
    requirements.push({
      id: String(r.id || `r${requirements.length + 1}`),
      description: String(r.description || r.requirement || r.id || 'requirement').slice(0, 300),
      required: r.required !== false,
      checks: checkList,
    });
  }
  return {
    name: String(spec.name || 'verification').slice(0, 120),
    taskId: spec.taskId ? String(spec.taskId) : null,
    requirements,
  };
}

/**
 * ROLL UP THE CHECKS OF ONE REQUIREMENT.
 *
 * EVERY check of a requirement must pass for the requirement to pass. There is
 * no "two out of three" — a requirement whose evidence is partly missing has
 * not been established, and the alternative is a threshold, which is an opinion
 * with a number in front of it.
 */
function rollUpRequirement(results) {
  if (!results.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'no evidence was named for this requirement' };
  }
  const failed = results.filter((r) => r.verdict === VERDICT.FAILED);
  if (failed.length) {
    return { verdict: VERDICT.FAILED, why: failed.map((r) => `${r.label}: ${r.why}`).join('; ') };
  }
  const missing = results.filter((r) => r.verdict !== VERDICT.PASSED);
  if (missing.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: missing.map((r) => `${r.label}: ${r.why}`).join('; ') };
  }
  return { verdict: VERDICT.PASSED, why: results.map((r) => r.label).join(', ') };
}

/** The contract verdict. See the header — the order of these three tests is the design. */
function rollUpContract(requirements) {
  const required = requirements.filter((r) => r.required);
  const failed = required.filter((r) => r.verdict === VERDICT.FAILED);
  if (failed.length) {
    return {
      verdict: VERDICT.FAILED,
      why: `${failed.length} required requirement${failed.length === 1 ? '' : 's'} failed: ${failed.map((r) => r.description).join('; ')}`,
    };
  }
  if (!required.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'the contract required nothing, so nothing was proved' };
  }
  const missing = required.filter((r) => r.verdict !== VERDICT.PASSED);
  if (missing.length) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      why: `required evidence is missing for: ${missing.map((r) => r.description).join('; ')}`,
    };
  }
  return { verdict: VERDICT.PASSED, why: `all ${required.length} required requirements passed` };
}

/**
 * RUN A CONTRACT.
 *
 * @param {object} spec     the contract, in any of the shapes `contract()` takes
 * @param {object} ctx      {cwd, taskId, processes, browser, observer, signal, runtime}
 * @returns {Promise<object>} the report — verdict, counts, per-requirement detail
 *
 * CHECKS RUN IN ORDER AND NOTHING SHORT-CIRCUITS. A contract that stopped at
 * the first red check would produce a report saying one thing was wrong when
 * four were, and the second run — after the first was fixed — would then
 * "discover" the next one. The whole report, every time, is what makes a
 * recovery loop converge instead of crawling.
 */
const reports = new WeakSet();
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function isResult(value, taskId) {
  return reports.has(value) && value.taskId === taskId;
}

async function run(spec, ctx = {}) {
  const c = contract(spec);
  const began = Date.now();
  const out = [];
  for (const req of c.requirements) {
    const results = [];
    for (const check of req.checks) {
      // eslint-disable-next-line no-await-in-loop -- checks are deliberately
      // sequential: two test suites running at once contend for the same ports
      // and the same build directory, which manufactures failures.
      results.push(await checks.run(check, { ...ctx, taskId: ctx.taskId || c.taskId }));
    }
    const rolled = rollUpRequirement(results);
    out.push({ ...req, ...rolled, checks: results });
  }
  const rolled = rollUpContract(out);
  const count = (v) => out.filter((r) => r.verdict === v).length;
  const report = {
    name: c.name,
    contract: c.name,
    taskId: ctx.taskId || c.taskId,
    verdict: rolled.verdict,
    why: rolled.why,
    passed: count(VERDICT.PASSED),
    failed: count(VERDICT.FAILED),
    inconclusive: count(VERDICT.INCONCLUSIVE),
    requirements: out,
    at: began,
    ms: Date.now() - began,
  };
  reports.add(report);
  return freeze(report);
}

/**
 * THE REPORT A PERSON READS, and the one kept as an artifact.
 *
 * Plain text on purpose. It is written into `.lain/tasks/<id>/verification/`,
 * shown by `/verify`, and pasted into issues by people. Every one of those
 * wants something greppable rather than a colour.
 */
function render(report) {
  const mark = (v) => (v === VERDICT.PASSED ? 'PASS' : v === VERDICT.FAILED ? 'FAIL' : 'INCONCLUSIVE');
  const lines = [];
  lines.push(`VERIFICATION ${report.verdict} — ${report.name}`);
  lines.push(report.why);
  lines.push('');
  for (const r of report.requirements) {
    lines.push(`[${mark(r.verdict)}] ${r.description}${r.required ? '' : '  (optional)'}`);
    for (const c of r.checks) {
      lines.push(`    ${mark(c.verdict).padEnd(12)} ${c.label} — ${c.why}`);
    }
  }
  lines.push('');
  lines.push(`${report.passed} passed · ${report.failed} failed · ${report.inconclusive} inconclusive · ${report.ms}ms`);
  return lines.join('\n');
}

module.exports = {
  run, contract, render, rollUpRequirement, rollUpContract, isResult,
  VERDICT, MAX_REQUIREMENTS, MAX_CHECKS_PER_REQUIREMENT,
};
