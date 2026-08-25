'use strict';

/**
 * OCR acceptance. One deliberate defect; see the fixture README.
 */

const THRESHOLD = 0.8;

/**
 * Is this detection good enough to act on?
 *
 * DEFECT 3: the comparison is `>`, so a detection at exactly the threshold is
 * rejected. The threshold is documented as the minimum ACCEPTABLE confidence,
 * which makes 0.8 acceptable.
 */
function accepted(confidence) {
  return confidence > THRESHOLD;
}

module.exports = { accepted, THRESHOLD };
