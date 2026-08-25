'use strict';

/**
 * WHAT THE LOG SAID AGAINST WHAT THE SCREEN SHOWED.
 *
 *: the point is not to collect both. It is to notice when they disagree.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH, in the user's own example: the log reports
 * that the minigame completed, and the final screenshot still shows the
 * minigame. Every individual record is true. The bot really did print
 * ROUND_COMPLETE, and the screen really does show the minigame — and the
 * conclusion "the round completed" is false.
 *
 * That is not a fact anything can supply. It only exists BETWEEN two records
 * from different sources, and it is invisible to anything looking at either one
 * alone. So the sources are kept apart all the way through observe.js and are
 * brought together exactly here, once, deliberately.
 *
 * ------------------------------------------------------------------------
 * THE FOUR VERDICTS, and none of them is "success".
 *
 *   CORROBORATED  both sources, same story. The strongest thing available.
 *   CONTRADICTED  both sources, different stories. Becomes a QUESTION, never a
 *                 conclusion — see below.
 *   UNRESOLVED    the log says something and the screen was never seen. Not a
 *                 failure and not a confirmation: an absence.
 *   UNEXPLAINED   the screen shows something no log line accounts for. The most
 *                 interesting one, and the one a log-only investigation cannot
 *                 have.
 *
 * A CONTRADICTION IS NOT A DIAGNOSIS. LAIN does not get to decide which source
 * is lying — the log could be wrong, the screenshot could be of the wrong
 * moment, the expectation could be mistaken. What it does is state both, name
 * the disagreement, and ask. That is: "Can you tell me whether that screen
 * is expected?"
 *
 * AND `SENT_UNCONFIRMED` NEVER BECOMES `SUCCESS`. An input LAIN injected is a
 * record of an injection, not of a receipt, and the only thing that can promote
 * it is a source that watched the target — which is precisely what this reads.
 */

const { SOURCE } = require('./observe');

const VERDICT = Object.freeze({
  CORROBORATED: 'CORROBORATED',
  CONTRADICTED: 'CONTRADICTED',
  UNRESOLVED: 'UNRESOLVED',
  UNEXPLAINED: 'UNEXPLAINED',
});

/**
 * How close in time two records must be to be about the same moment.
 *
 * A SCREEN IS A LATER STATEMENT THAN THE LOG LINE THAT TRIGGERED IT — the
 * capture is fired by the line and takes as long as a screenshot takes. Too
 * tight and nothing ever pairs; too loose and a capture is matched to a line
 * from a different round. Three seconds is wider than any capture measured here
 * and narrower than the gap between rounds.
 */
const WINDOW_MS = 3000;

/**
 * Does this visual record support, or contradict, what the log claimed?
 *
 * DELIBERATELY SHALLOW, and this is the important design decision in the file.
 * It compares TERMS the user supplied — the words that identify the state — and
 * nothing else. It does not attempt to understand the screen; understanding is
 * the model's job, and a clever heuristic here would be LAIN deciding what the
 * evidence means, which puts firmly on the other side of the line.
 *
 * So: a claim, a capture, and whether the capture's text mentions the terms.
 * Everything subtler is left for the model to read in the packet.
 */
function mentions(text, terms) {
  const hay = String(text || '').toLowerCase();
  return terms.filter((t) => t && hay.includes(String(t).toLowerCase()));
}

/**
 * ONE CLAIM, CHECKED.
 *
 * @param {object} claim  { kind, at, detail } — the LOG event
 * @param {Array}  visuals  VISUAL evidence records with `text` (OCR) if any
 * @param {object} expect  { present: [], absent: [] } — what the screen should
 *                         show if the claim is true, in the user's words
 */
function checkClaim(claim, visuals, expect = {}) {
  const present = Array.isArray(expect.present) ? expect.present : [];
  const absent = Array.isArray(expect.absent) ? expect.absent : [];

  const near = visuals.filter((v) => Math.abs(v.at - claim.at) <= WINDOW_MS);
  if (!near.length) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: null,
      why: 'nothing looked at the screen near this moment, so the claim is neither confirmed nor denied',
    };
  }
  // The one with text is worth more than the one without: a screenshot nobody
  // read says only that a picture exists.
  const seen = near.find((v) => v.ok && v.text) || near.find((v) => v.ok) || near[0];
  if (!seen.ok) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: seen,
      why: `the screen could not be captured here — ${seen.why || 'no reason recorded'}`,
    };
  }
  if (!seen.text) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: seen,
      why: 'a screenshot exists but nothing has read it — NOT SEEN until something does',
    };
  }

  const found = mentions(seen.text, present);
  const shouldBeGone = mentions(seen.text, absent);

  if (shouldBeGone.length) {
    return {
      verdict: VERDICT.CONTRADICTED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind}, and the screen still shows ${shouldBeGone.join(', ')}`,
    };
  }
  if (present.length && !found.length) {
    return {
      verdict: VERDICT.CONTRADICTED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind}, and the screen does not show ${present.join(' or ')}`,
    };
  }
  if (found.length) {
    return {
      verdict: VERDICT.CORROBORATED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind} and the screen shows ${found.join(', ')}`,
    };
  }
  return {
    verdict: VERDICT.UNRESOLVED,
    claim,
    visual: seen,
    why: 'the screen was read and says nothing either way about this claim',
  };
}

/**
 * VISUAL EVIDENCE THAT NO LOG LINE ACCOUNTS FOR.
 *
 * The direction a log-only investigation structurally cannot look. A dialog, a
 * crash box, an indicator that appeared while the program said nothing at all
 * — the absence of a log line is exactly what makes it worth reporting.
 */
function unexplained(visuals, logs, watchFor = []) {
  const out = [];
  for (const v of visuals) {
    if (!v.ok || !v.text) continue;
    const hits = mentions(v.text, watchFor);
    if (!hits.length) continue;
    const near = logs.filter((l) => Math.abs(l.at - v.at) <= WINDOW_MS);
    if (near.length) continue;
    out.push({
      verdict: VERDICT.UNEXPLAINED,
      claim: null,
      visual: v,
      why: `the screen showed ${hits.join(', ')} and no log line was written near that moment`,
    });
  }
  return out;
}

/**
 * THE WHOLE COMPARISON, for one finished observation.
 *
 * @param {Observation} obs
 * @param {object} o
 *   claims    log event kinds that ASSERT something about the screen
 *   expect    { <kind>: { present: [], absent: [] } }
 *   watchFor  terms whose appearance on screen is notable in itself
 */
function compare(obs, { claims = [], expect = {}, watchFor = [] } = {}) {
  const logs = obs.from(SOURCE.LOG);
  const visuals = obs.captures.slice();
  const wanted = new Set(claims);

  const findings = [];
  for (const l of logs) {
    if (wanted.size && !wanted.has(l.kind)) continue;
    findings.push(checkClaim(l, visuals, expect[l.kind] || {}));
  }
  findings.push(...unexplained(visuals, logs, watchFor));

  const count = (v) => findings.filter((f) => f.verdict === v).length;
  return {
    findings,
    counts: {
      CORROBORATED: count(VERDICT.CORROBORATED),
      CONTRADICTED: count(VERDICT.CONTRADICTED),
      UNRESOLVED: count(VERDICT.UNRESOLVED),
      UNEXPLAINED: count(VERDICT.UNEXPLAINED),
    },
    /**
     * WHAT TO DO NEXT — a question when the evidence disagrees with itself.
     *
     * Not an answer. A contradiction means two trustworthy records cannot both
     * be right about the same moment, and which one to believe is a matter of
     * fact about the target that the user knows and LAIN does not.
     */
    question: findings.find((f) => f.verdict === VERDICT.CONTRADICTED) || null,
  };
}

/** The comparison as lines a person reads, sources kept apart. */
function lines(result) {
  const out = [];
  for (const f of result.findings) {
    out.push(`${f.verdict}  ${f.why}`);
    if (f.claim) out.push(`    LOG    ${f.claim.detail || f.claim.kind}`);
    if (f.visual && f.visual.ok) {
      out.push(`    SCREEN ${f.visual.path || 'captured'}${f.visual.text ? ` — ${f.visual.text.slice(0, 120)}` : ' — NOT SEEN (nothing read it)'}`);
    } else if (f.visual) {
      out.push(`    SCREEN NOT CAPTURED — ${f.visual.why}`);
    } else {
      out.push('    SCREEN NOT SEEN');
    }
  }
  return out;
}

module.exports = { compare, checkClaim, unexplained, lines, VERDICT, WINDOW_MS };
