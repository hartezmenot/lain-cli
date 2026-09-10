'use strict';

/**
 * WHAT PROVES WORK IN *THIS* PROJECT — a contract derived from what the project
 * itself declares.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS.
 *
 * `/verify full` has to mean something concrete, and "run the tests" is a poor
 * approximation of it: a React app with a red typecheck and a green test suite
 * is broken, and a Rust crate that does not compile has no meaningful test
 * result at all. The set of checks that establishes "this work is sound"
 * differs per project, and every project already states it — in `scripts`, in a
 * `Cargo.toml`, in a `pyproject.toml`.
 *
 * So this READS rather than assumes. A requirement appears only when the
 * project declares the thing that would satisfy it. A project with no lint
 * script gets no lint requirement — not a failing one, and not a silently
 * skipped one.
 *
 * ------------------------------------------------------------------------
 * THIS IS THE SMALL, HONEST VERSION OF "SKILLS DEFINE VERIFICATION".
 *
 * The larger idea — a skill package that declares what proves work in its
 * domain — needs a loader, a manifest format and a trust story, and none of
 * those exists yet. What is buildable today without inventing any of it is
 * this: derive the contract from the manifest that is already on disk. When a
 * skill loader arrives it produces a contract in exactly this shape, and this
 * becomes the default it overrides.
 *
 * ------------------------------------------------------------------------
 * WHAT IT WILL NOT DO.
 *
 * It never invents a command. Every `command` below is copied out of the
 * project's own manifest, or is the canonical invocation for a toolchain whose
 * manifest is present (`cargo build` where there is a `Cargo.toml`). A profile
 * that guessed `npm run lint` at a project without one would turn every
 * verification INCONCLUSIVE for a reason that is the profile's fault.
 */

const fs = require('fs');
const path = require('path');
const testing = require('../testing');

/** Read a JSON manifest, or null. A corrupt manifest is an absent one. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/**
 * SCRIPTS THAT MEAN SOMETHING, and the requirement each one establishes.
 *
 * Ordered cheapest-first, which is also most-informative-first: a typecheck
 * failure explains a test failure, and running the suite first only means
 * paying for the slow answer before the useful one.
 *
 * `required` is false for lint on purpose. A lint finding is worth reporting
 * and is not worth failing a bug fix over — and a harness that blocks on style
 * is a harness people turn off.
 */
const SCRIPTS = [
  { names: ['typecheck', 'type-check', 'tsc'], description: 'the project typechecks', required: true, kind: 'build' },
  { names: ['build', 'compile'], description: 'the project builds', required: true, kind: 'build' },
  { names: ['lint'], description: 'the project lints clean', required: false, kind: 'command' },
];

/**
 * DERIVE THE CONTRACT.
 *
 * @param {string} cwd
 * @returns {{name, requirements, found: string[]}} — `found` names what was
 *   detected, so a caller can SAY what it is about to run rather than making a
 *   person guess why a verification took four minutes.
 */
function forProject(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const requirements = [];
  const found = [];

  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = (pkg && pkg.scripts) || {};
  for (const entry of SCRIPTS) {
    const name = entry.names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
    if (!name) continue;
    found.push(`npm run ${name}`);
    requirements.push({
      description: entry.description,
      required: entry.required,
      checks: [{ kind: entry.kind, label: name, command: `npm run ${name}` }],
    });
  }

  // ---- TOOLCHAINS WHOSE MANIFEST IS THEIR DECLARATION --------------------
  //
  // `cargo build` is not a guess at a project with a Cargo.toml — it is the
  // invocation that toolchain defines. The same is true of `go build ./...`.
  // Nothing here is offered for a toolchain whose manifest is absent.
  if (exists(path.join(root, 'Cargo.toml'))) {
    found.push('cargo build');
    requirements.push({
      description: 'the crate compiles',
      required: true,
      checks: [{ kind: 'build', label: 'cargo build', command: 'cargo build' }],
    });
  }
  if (exists(path.join(root, 'go.mod'))) {
    found.push('go build ./...');
    requirements.push({
      description: 'the module compiles',
      required: true,
      checks: [{ kind: 'build', label: 'go build', command: 'go build ./...' }],
    });
  }

  // ---- AND THE TESTS, WHOEVER OWNS THEM ----------------------------------
  //
  // testing.js already knows how to find a suite across every ecosystem this
  // project supports, and its classification is what turns "the runner is not
  // installed" into INCONCLUSIVE rather than a red suite. Re-deriving any of
  // that here would be a second opinion that can disagree with the first.
  const report = testing.discover(root);
  const suite = testing.primary(report);
  if (suite) {
    found.push(suite.command);
    requirements.push({
      description: 'the test suite passes',
      required: true,
      checks: [{ kind: 'tests', label: 'tests', command: suite.command }],
    });
  }

  return {
    name: 'the project is sound',
    requirements,
    found,
    // NOTHING DETECTED IS A FACT, NOT AN ERROR — and it is why an empty
    // contract must never read as a pass. verify.js settles a contract with no
    // required requirements as INCONCLUSIVE, which is the honest answer to
    // "this project declares nothing that could prove anything".
    empty: requirements.length === 0,
  };
}

module.exports = { forProject, SCRIPTS };
