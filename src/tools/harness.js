'use strict';

/**
 * THE HARNESS TOOLS — what the model can ask the harness to do.
 *
 * ------------------------------------------------------------------------
 * FOUR TOOLS, AND EACH ONE REPLACES A HABIT.
 *
 *   verify_task    replaces "I've fixed it". The model states what would PROVE
 *                  the work, the harness runs those checks, and the verdict
 *                  comes from exit codes and the DOM rather than from the
 *                  sentence at the end of the turn.
 *
 *   service_start  replaces `run_bash("npm run dev &")`, which on Windows does
 *                  not background, on POSIX detaches from any supervision, and
 *                  in both cases leaves a process nobody owns on a port nobody
 *                  recorded. A managed service has a name, a port, a health
 *                  check and an owner task that takes it down.
 *
 *   service_check  replaces a `sleep 5` followed by hope. It answers whether
 *                  the thing is actually up, and it can WAIT for that, which is
 *                  the single most common reason a frontend task fails for no
 *                  real reason.
 *
 *   observe        replaces "take a screenshot and look at it" for questions
 *                  that structure could answer for nothing. The model states
 *                  what it wants to know; the router picks the cheapest source
 *                  that can answer.
 *
 * ------------------------------------------------------------------------
 * WHY `verify_task` IS NOT A COMPLETION TOOL.
 *
 * It cannot mark anything done. It runs a contract and reports the verdict; the
 * task state that follows is computed from that verdict by the runtime, and
 * PASSED is reachable only when every required piece of evidence passed. A
 * model calling this with an empty contract gets INCONCLUSIVE, which is the
 * honest answer to "I proved nothing".
 */

const { EVENT, busOf } = require('../events');

/** Bounded, because a tool result rides in the context window. */
const MAX_OUTPUT = 6000;

function harnessOf(ctx) {
  const app = ctx && ctx.app;
  if (app) return require('../harnesslink').harnessFor(app);
  // NO APP IS NOT AN ERROR. A forked job and a unit test both call tools with a
  // context that has no App, and every tool in this tree works there. The
  // harness is built for the working directory instead, in memory.
  const { Harness } = require('../harness');
  if (!ctx._harness) ctx._harness = new Harness({ workspace: (ctx && ctx.cwd) || process.cwd(), persist: false });
  return ctx._harness;
}

function clip(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n… (truncated; the whole thing is kept as an artifact)` : t;
}

const tools = {};

tools.verify_task = {
  // IT RUNS THINGS — test suites, builds, browsers — so it is marked mutating
  // and goes through the same gate every other executing tool does.
  mutates: true,
  schema: {
    name: 'verify_task',
    description:
      'PROVE the work instead of claiming it. Give the requirements and, for each, the evidence that '
      + 'would establish it: a test suite, a build command, an HTTP endpoint, a file, a managed '
      + 'process, or a browser flow. Each check returns PASSED, FAILED or INCONCLUSIVE (it could not '
      + 'run — a missing runner is never a red suite), and the task is settled from the result. '
      + 'Required evidence that is missing gives INCONCLUSIVE, not success. Call this when you '
      + 'believe the work is done.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'what this contract is about, in a few words' },
        requirements: {
          type: 'array',
          description: 'one entry per thing that must be true; each names its own evidence',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'the requirement, in plain words' },
              required: { type: 'boolean', description: 'default true; an optional requirement is reported and cannot fail the task' },
              checks: {
                type: 'array',
                description: 'the evidence. kind is one of: tests, build, command, http, file, process, browser, observation',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', description: 'tests | build | command | http | file | process | browser | observation' },
                    label: { type: 'string', description: 'a short name for this check, shown in the report' },
                    command: { type: 'string', description: 'for tests/build/command — the command line; omit for tests to use the project suite' },
                    url: { type: 'string', description: 'for http/browser' },
                    path: { type: 'string', description: 'for file' },
                    contains: { type: 'string', description: 'for file — text the file must contain' },
                    must_exist: { type: 'boolean', description: 'for file — false asserts the path is GONE' },
                    expect_status: { type: 'number', description: 'for http' },
                    expect_exit: { type: 'number', description: 'for command — default 0' },
                    name: { type: 'string', description: 'for process — the managed service name' },
                    goal: { type: 'string', description: 'for observation — file, code, changes, process, logs, endpoint, element, page, errors, requests, screen, system' },
                    selector: { type: 'string', description: 'for browser/observation — a CSS selector' },
                    expect: { type: 'string', description: 'for observation — text the answer must contain' },
                    actions: { type: 'array', description: 'for browser — [{type:navigate|click|type|wait|evaluate|screenshot, ...}]', items: { type: 'object' } },
                    assert: { type: 'array', description: 'for browser — [{selector, visible?, disabled?, text?, exists?}]', items: { type: 'object' } },
                    expect_url: { type: 'string', description: 'for browser — the URL must contain this after the flow' },
                    no_console_errors: { type: 'boolean', description: 'for browser — fail if the page logged errors' },
                  },
                  required: ['kind'],
                },
              },
            },
            required: ['description'],
          },
        },
      },
      required: ['requirements'],
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const requirements = Array.isArray(input.requirements) ? input.requirements : [];
    if (!requirements.length) {
      return {
        output: 'verify_task needs at least one requirement with its evidence. A contract that '
          + 'requires nothing proves nothing, and would settle the task INCONCLUSIVE.',
        isError: true,
      };
    }
    const report = await h.verify({ name: input.name || 'verification', requirements });
    const rendered = require('../harness/verify').render(report);
    return {
      output: clip(rendered),
      isError: report.verdict === 'FAILED',
      meta: {
        verdict: report.verdict, passed: report.passed, failed: report.failed,
        inconclusive: report.inconclusive, taskId: report.taskId,
      },
    };
  },
};

tools.service_start = {
  mutates: true,
  schema: {
    name: 'service_start',
    description:
      'Start a long-running service — a dev server, an API, a worker — that STAYS UP and is owned by '
      + 'this task. Unlike run_bash it does not wait for the command to finish (a server never '
      + 'finishes) and unlike run_background it is not a job with a result: it has a port, a health '
      + 'check, restartable state, and it is stopped automatically when the session ends. Use this '
      + 'for anything you then want to point a browser or an HTTP check at.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'a short name you will refer to it by, e.g. "frontend"' },
        command: { type: 'string', description: 'the command line, e.g. "npm run dev"' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        port: { type: 'number', description: 'the port it will listen on — this is how health is checked' },
        wait_ms: { type: 'number', description: 'wait up to this long for it to become healthy before returning; default 15000, 0 to return at once' },
      },
      required: ['name', 'command'],
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const name = String(input.name || '').trim();
    const command = String(input.command || '').trim();
    if (!name || !command) return { output: 'service_start needs a name and a command', isError: true };
    const taskId = h.runtime.activeId;
    const already = h.processes.named(taskId, name);
    if (already && already.alive) {
      return { output: `a service called "${name}" is already running (pid ${already.pid}${already.port ? `, port ${already.port}` : ''}). Use service_check, or stop it first.`, isError: true };
    }
    const p = h.processes.start({
      taskId, name, command, cwd: input.cwd || ctx.cwd, port: input.port == null ? null : Number(input.port),
    });
    busOf(ctx.app).emit(EVENT.PROCESS_STARTED, { processId: p.processId, name, port: p.port == null ? -1 : p.port });
    const waitMs = input.wait_ms == null ? 15000 : Number(input.wait_ms);
    if (waitMs > 0) {
      const health = await h.processes.waitUntilHealthy(p.processId, waitMs);
      const tail = p.tail(12);
      return {
        output: `${name} (${p.processId}) — ${p.status}, ${health.health}: ${health.why}`
          + (tail ? `\n--- last output ---\n${clip(tail)}` : ''),
        isError: health.health === 'UNHEALTHY',
        meta: { processId: p.processId, pid: p.pid, port: p.port, status: p.status, health: health.health },
      };
    }
    return {
      output: `${name} (${p.processId}) started, pid ${p.pid}. Nothing has checked whether it is up yet — call service_check.`,
      meta: { processId: p.processId, pid: p.pid, port: p.port, status: p.status },
    };
  },
};

tools.service_check = {
  mutates: false,
  schema: {
    name: 'service_check',
    description:
      'Is a managed service actually up, and what has it printed? Probes its port or URL now, and can '
      + 'WAIT until it answers rather than guessing with a sleep. With no name it lists every service '
      + 'this task owns. A service with no health check configured reports UNKNOWN — never HEALTHY, '
      + 'because nothing looked.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the service name given to service_start; omit to list all' },
        wait_ms: { type: 'number', description: 'wait up to this long for it to become healthy; default 0 (one probe, now)' },
        lines: { type: 'number', description: 'how many lines of its output to include; default 20' },
      },
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const taskId = h.runtime.activeId;
    if (!input.name) {
      const all = h.processes.list(taskId);
      if (!all.length) return { output: 'no managed services are running for this task' };
      return { output: all.map((p) => { const j = p.toJSON(); return `${j.name}  ${j.status}  ${j.health}  ${j.port ? `port ${j.port}` : ''}  ${j.healthWhy}`; }).join('\n') };
    }
    const p = h.processes.named(taskId, String(input.name));
    if (!p) return { output: `no managed service called "${input.name}" — service_check with no name lists them`, isError: true };
    const waitMs = Number(input.wait_ms) || 0;
    const r = waitMs > 0 ? await h.processes.waitUntilHealthy(p.processId, waitMs) : await h.processes.check(p.processId);
    const tail = p.tail(Number(input.lines) || 20);
    return {
      output: `${p.name} — ${p.status}, ${r.health}: ${r.why}` + (tail ? `\n--- last output ---\n${clip(tail)}` : ''),
      isError: r.health === 'UNHEALTHY',
      meta: { processId: p.processId, status: p.status, health: r.health, port: p.port },
    };
  },
};

tools.observe = {
  mutates: false,
  schema: {
    name: 'observe',
    description:
      'Find out what is actually true, without deciding HOW to look. State the goal — element, page, '
      + 'errors, requests, screen, file, code, changes, process, logs, endpoint, system — and the '
      + 'router picks the cheapest source that can answer it, structured before visual: the DOM '
      + 'before a screenshot, git before reading files. It reports which source answered, and says '
      + 'plainly when nothing could. Prefer this over taking a screenshot to read something a page '
      + 'already knows.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'element | page | errors | requests | screen | file | code | changes | process | logs | endpoint | system' },
        selector: { type: 'string', description: 'for element/page — a CSS selector' },
        url: { type: 'string', description: 'for element/page/endpoint — where to look' },
        path: { type: 'string', description: 'for file/code — which file' },
        name: { type: 'string', description: 'for process/logs — the managed service name' },
        lines: { type: 'number', description: 'for logs — how many lines' },
      },
      required: ['goal'],
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const goal = String(input.goal || '').toLowerCase();
    const r = await h.observe(goal, input, h.runtime.activeId);
    if (!r.ok) {
      return {
        output: `nothing could answer "${goal}": ${r.why}`
          + (r.tried && r.tried.length ? `\ntried: ${r.tried.map((t) => t.source).join(', ')}` : ''),
        isError: true,
        meta: { goal, ok: false },
      };
    }
    return {
      output: `[${r.source}] ${r.summary}\n${clip(r.value)}`,
      meta: { goal, source: r.source, coarse: r.coarse },
    };
  },
};

module.exports = { tools, MAX_OUTPUT };
