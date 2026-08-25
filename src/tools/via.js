'use strict';

/**
 * WHICH MECHANISM RAN IT — one stamp, one vocabulary.
 *
 * A shell, a direct spawn, Python and a background job are
 * four different ways to run something, they fail differently, they are fixed
 * differently, and the model cannot route around a failure it cannot tell
 * apart. `it exited 1` is at least two distinct problems wearing one number —
 * PowerShell flattens every non-zero exit to 1, and only a shell expands a glob
 * or a pipe.
 *
 * IT LIVES HERE RATHER THAN IN EACH TOOL because the stamp had already been
 * written twice, in two spellings, and the third caller (background jobs) had
 * simply been forgotten — which is what a scattered vocabulary always costs.
 * One vocabulary is the rule; this is that rule applied to execution.
 */

/** The four mechanisms LAIN can run something with. Nothing else is a KIND. */
const KIND = Object.freeze({
  SHELL: 'shell',
  PROCESS: 'process',
  PYTHON: 'python',
  JOB: 'background job',
});

/** `[via shell: powershell]` — the detail is optional and free-form. */
function via(kind, detail = '') {
  return `[via ${kind}${detail ? `: ${detail}` : ''}]`;
}

module.exports = { via, KIND };
