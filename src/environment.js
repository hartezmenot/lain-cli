'use strict';

// ---------------------------------------------------------------------------
// THE MACHINE-DETECTION SURFACE, re-exported.
//
// `environment.js` used to be TWO modules in one file: the machine (what OS,
// shell, package manager, venv and test runner the machine and project have)
// and the workspace (which execution environment — CLI or Probe — owned the
// current task). The Probe half was removed from LAIN CLI in 2026-09, along
// with the Probe integration it enforced. This file is now what it started as:
// a thin re-export of envdetect.js, kept so every consumer imports
// `./environment` under the names it always called.
//
// Consumers: the prompt's stable prefix (prompt.js), the execution contract
// (contracts.js), the survey (survey.js), clifacts.js, briefcommand.js,
// externalrequest.js, ui/contextview.js, tools/tests.js.
// ---------------------------------------------------------------------------

const envdetect = require('./envdetect');

module.exports = {
  osName: envdetect.osName,
  detectShell: envdetect.detectShell,
  detectPackageManager: envdetect.detectPackageManager,
  detectVenv: envdetect.detectVenv,
  detectTestRunner: envdetect.detectTestRunner,
  detectRuntimes: envdetect.detectRuntimes,
  detect: envdetect.detect,
  summary: envdetect.summary,
  reset: envdetect.reset,
};
