'use strict';

/**
 * EVERY TOOL IS REAL — advertised, dispatchable, described, and shaped.
 *
 * WHAT THIS GUARDS AGAINST, and V1 shipped all four:
 *
 *   ADVERTISED BUT NOT DISPATCHABLE. V1 sent 68 schemas against 78 dispatch
 *     entries. A model that calls a name it was offered and gets "unknown tool"
 *     has been lied to, and it will keep trying.
 *
 *   DISPATCHABLE BUT NOT ADVERTISED. A capability nothing can reach. It is not
 *     a bug the user ever sees — it is work that was done and then hidden.
 *
 *   A SCHEMA THAT CANNOT BE SATISFIED. A `required` name that is not among the
 *     properties is a call the model cannot construct correctly, and the error
 *     it gets back does not say so.
 *
 *   A DESCRIPTION TOO THIN TO CHOOSE BY. The description is the ONLY thing the
 *     model has when deciding between forty-four tools. "Reads a file" against
 *     four tools that read files is not a choice, it is a coin toss.
 *
 * These are structural checks, not behavioural ones — each tool's own behaviour
 * is tested where it lives. What is checked here is that the VOCABULARY is
 * coherent, because that is the property no single tool's test can see.
 */

const assert = require('assert');
const { test } = require('../helpers');

const reg = require('../../src/tools');

module.exports = async function () {
  await test('TOOLS: what is advertised is EXACTLY what is dispatchable', () => {
    const advertised = reg.schemas().map((s) => s.name).sort();
    const dispatchable = reg.names().slice().sort();
    assert.deepStrictEqual(advertised, dispatchable,
      'the schema list and the dispatch table have drifted apart');
  });

  await test('TOOLS: no tool is advertised twice under one name', () => {
    const names = reg.schemas().map((s) => s.name);
    assert.strictEqual(new Set(names).size, names.length, `duplicate tool names: ${names.join(', ')}`);
  });

  await test('TOOLS: every schema is a well-formed object schema', () => {
    for (const s of reg.schemas()) {
      assert.ok(s.name, 'a schema with no name');
      assert.ok(s.parameters && s.parameters.type === 'object', `${s.name}: parameters must be an object schema`);
      const props = s.parameters.properties || {};
      for (const [k, v] of Object.entries(props)) {
        assert.ok(v && v.type, `${s.name}.${k} declares no type`);
      }
    }
  });

  await test('TOOLS: EVERY required argument is a declared property', () => {
    // A `required` name with no property is a call the model cannot construct,
    // and the failure it gets back never says which field was wrong.
    for (const s of reg.schemas()) {
      const props = (s.parameters && s.parameters.properties) || {};
      for (const r of (s.parameters && s.parameters.required) || []) {
        assert.ok(Object.prototype.hasOwnProperty.call(props, r),
          `${s.name}: required "${r}" is not a declared property`);
      }
    }
  });

  await test('TOOLS: every description says enough to CHOOSE by', () => {
    // The description is all the model has when picking one of forty-four.
    for (const s of reg.schemas()) {
      assert.ok(typeof s.description === 'string' && s.description.length >= 30,
        `${s.name}: description is ${(s.description || '').length} characters — too thin to choose by`);
    }
  });

  await test('TOOLS: an unknown name is a RECOVERABLE result, not a crash', async () => {
    // The model has to be able to pick again, so this must come back as a
    // result naming what does exist.
    const r = await reg.execute('no_such_tool', {}, { cwd: process.cwd() });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /unknown tool/);
    assert.match(r.output, /read_file/, 'it must say what DOES exist');
  });

  await test('TOOLS: a tool that throws becomes a result, never an exception', async () => {
    // `run` must never throw for an ordinary failure — a failure is something
    // the model should see and act on.
    const r = await reg.execute('read_file', { path: 'definitely-not-here-9f3a.txt' }, { cwd: process.cwd() });
    assert.strictEqual(r.isError, true);
    assert.ok(r.output.length > 0);
  });

  await test('TOOLS: every tool declares whether it MUTATES', () => {
    // The gate reads this to decide whether a path is being written. A tool
    // that omits it is silently treated as read-only.
    for (const name of reg.names()) {
      assert.strictEqual(typeof reg.isMutating(name), 'boolean', `${name} has no mutates flag`);
    }
  });

  await test('TOOLS: the write tools are all marked as mutating', () => {
    // A write tool that reads as read-only skips the write half of the gate.
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file']) {
      assert.ok(reg.has(name), `${name} is missing from the registry`);
      assert.strictEqual(reg.isMutating(name), true, `${name} must be marked mutating`);
    }
  });

  await test('TOOLS: the read tools are NOT marked as mutating', () => {
    for (const name of ['read_file', 'list_dir', 'grep', 'glob', 'discover_tests']) {
      assert.ok(reg.has(name), `${name} is missing from the registry`);
      assert.strictEqual(reg.isMutating(name), false, `${name} must not be marked mutating`);
    }
  });

  await test('TOOLS: the ones a coding task always needs are always offered', () => {
    // Some tools follow a live transport and are correctly absent when it is not
    // configured (computer — the MCP one; the probe and browser transports were
    // removed in 2026-09, and are no longer exceptions to be found). These are
    // not those: a model with no way to read, edit, search or run is not a
    // coding agent.
    for (const name of [
      'read_file', 'write_file', 'edit_file', 'apply_patch',
      'grep', 'glob', 'symbols', 'list_dir',
      'run_powershell', 'run_bash',
      'discover_tests', 'run_tests',
      'plan_write', 'plan_step_done', 'ask_user',
    ]) {
      assert.ok(reg.has(name), `${name} is not available on an ordinary coding task`);
    }
  });

  await test('SKILLS: every task mode the classifier can produce is reachable', () => {
    // LAIN's "skills" are the mode paragraphs appended to the system prompt.
    // A mode the classifier can return with no guidance behind it is a branch
    // that silently does nothing — the markdown-file-that-nothing-reads problem
    // in its LAIN-shaped form.
    const mode = require('../../src/mode');
    const prompt = require('../../src/prompt');
    const missing = Object.values(mode.KIND).filter((k) => !prompt.MODE_GUIDANCE[k]);
    assert.deepStrictEqual(missing, [],
      `modes with no guidance behind them: ${missing.join(', ')}`);
    // And nothing in the table that the classifier can never produce, which is
    // the same defect pointing the other way: a paragraph nothing can select.
    const kinds = new Set(Object.values(mode.KIND));
    const orphans = Object.keys(prompt.MODE_GUIDANCE).filter((k) => !kinds.has(k));
    assert.deepStrictEqual(orphans, [], `guidance nothing can select: ${orphans.join(', ')}`);
  });

  await test('SKILLS: the guidance really reaches the built prompt', () => {
    // Present in a table is not the same as sent to the model.
    const prompt = require('../../src/prompt');
    const mode = require('../../src/mode');
    for (const kind of Object.values(mode.KIND)) {
      const guide = prompt.MODE_GUIDANCE[kind];
      if (!guide) continue;
      const built = prompt.build({ cwd: process.cwd(), platform: process.platform, mode: kind });
      assert.ok(built.includes(guide.split('\n')[0]), `${kind} guidance never reaches the prompt`);
    }
  });

  await test('SKILLS: no mode paragraph is so long it costs a page per step', () => {
    // This text rides on EVERY request of the turn. A page of process here is
    // a page of tokens per step, forever.
    const prompt = require('../../src/prompt');
    for (const [kind, text] of Object.entries(prompt.MODE_GUIDANCE)) {
      assert.ok(text.length < 3000, `${kind} guidance is ${text.length} characters — it is sent on every step`);
    }
  });
};
