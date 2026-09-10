# The LAIN Harness

What changed, why, and where the seams are. Written for somebody who has to
work on this next.

---

## 1. The one-sentence version

LAIN used to end a task when the model stopped talking. It now ends a task when
**evidence** says so, and keeps the receipts.

```
BEFORE                          AFTER
USER                            USER
 ↓                               ↓
MODEL                           TASK        (a record, on disk, with a state)
 ↓                               ↓
TOOLS                          EXECUTE      (tools, and now managed services)
 ↓                               ↓
MODEL                          OBSERVE      (routed: structure before pixels)
 ↓                               ↓
"Done"                         VERIFY       (a contract of falsifiable checks)
                                ├── FAIL → RECOVER (classified) → EXECUTE
                                └── PASS
                                      ↓
                                  ARTIFACTS  (.lain/tasks/<id>/)
                                      ↓
                                  CLI · DASHBOARD · REMOTE  (one projection)
```

The defining property: **there is no method anywhere that marks a task done.**
`TaskRuntime` has no `complete()`, no `succeed()`, no `markDone()`. The only
route to `PASSED` is `settle()`, and `settle()` takes a verification result.

---

## 2. What was already here, and was kept

The harness is built *on* LAIN's existing intelligence, not beside it. Nothing
below was re-implemented:

| Existing | Still owns | How the harness uses it |
|---|---|---|
| `task.js` | task IDENTITY — is this the same task? | `harnesslink` consumes `verdict.sameTask`; there is still exactly one continuation classifier |
| `lifecycle.js` | conversation liveness — done, blocked, needs the person | `state.fromLifecycle()` maps its verdict; `claimsSuccess` decides when a claim triggers verification |
| `events.js` | the named-fact channel | the harness vocabulary was ADDED to the same bus — there is no second emitter |
| `testing.js` | classifying a test run (`TESTS_BLOCKED` etc.) | `checks.tests` is a thin mapping onto it; BLOCKED becomes INCONCLUSIVE |
| `execution.js` | classifying a failed command | `checks` and `recovery` both read `CLASS`; nothing re-derives it |
| `lainstore.js` | every path inside `.lain/` | task directories are `lainstore.taskDir()`; the artifact store joins nothing |
| `gate.js` / `trust.js` / `permissions.js` | enforcement | the capability registry DESCRIBES and advises; it does not enforce |
| `jobs.js` | a command that ENDS and yields a result | untouched; services are a different vocabulary (below) |
| `observe.js` | watching a long RUN, five witness kinds | `observation.COARSE_OF` maps every fine source onto one of its five |
| `dash.js` | the web surface | it now renders a projection instead of assembling its own view |
| `/steer`, `/task`, `/plan` | unchanged | `/task` gained a section; nothing it printed was removed |

---

## 3. The new modules

```
src/harness/
  state.js          the eight-state machine and its legal moves
  record.js         what a task IS: workspace, processes, verifications, artifacts
  runtime.js        the only writer of task state; subscribes to the bus
  artifacts.js      durable evidence under .lain/tasks/<id>/
  hooks.js          eight lifecycle points; every run lands on the timeline
  processes.js      managed services: start/stop/restart/health/logs/cleanup
  verify.js         verification contracts and the verdict arithmetic
  checks.js         the check runners — tests, build, command, http, file, process, browser, observation
  profile.js        a contract derived from what THIS project declares
  observation.js    the observation plane and the router
  browser.js        one browser session: DOM, a11y, console, network, screenshot
  browserharness.js sessions, flows, artifacts, ownership
  cdp.js            the DevTools wire, over Node's built-in WebSocket
  recovery.js       transient / environmental / permission / logical
  registry.js       the normalised capability registry and the approval policy
  timeline.js       a projection of the flight recorder
  index.js          the facade that wires them together

src/harnesslink.js      the seam with the REPL (three functions)
src/harnesssurface.js   the projection every window reads
src/harnesscommands.js  /harness /tasks /verify /artifacts /env
src/tools/harness.js    verify_task, service_start, service_check, observe
src/appprompt.js        systemPrompt, moved out of app.js at the size guard
```

---

## 4. The five decisions worth knowing

### 4.1 Eight states, and INCONCLUSIVE is the point

`PLANNED · RUNNING · BLOCKED · VERIFYING · PASSED · FAILED · INCONCLUSIVE ·
CANCELLED`

`INCONCLUSIVE` means *nothing was checked*. Collapsed into `PASSED` it is a
false pass; collapsed into `FAILED` it is a false alarm that teaches people to
ignore the harness. "The browser never started, so the flow was never checked"
is neither, and it is the most common real outcome.

**`VERIFYING` is only reachable from `RUNNING`, and `PASSED` only from
`VERIFYING`.** So no task is verified without having executed, and none is
passed without having been verified. `state.transition()` refuses everything
else and says why in a sentence a person reads.

A terminal state is **never rewritten**. A failure that gets fixed produces a
new *repair* task naming the old one, so "it took two attempts" survives.

### 4.2 A model saying "done" moves the task to VERIFYING

`lifecycle.complete()` only accepts DONE with real evidence — right for the
conversation, and it leaves a task whose model just announced success sitting in
`RUNNING` where nothing ever asks about it. So `harnesslink.endTurn` consumes
`lifecycle.claimsSuccess()` and moves the task to `VERIFYING`: *stop executing
and go and prove it*. The claim is never treated as evidence and cannot reach
`PASSED`.

### 4.3 Jobs and services are two vocabularies with one seam

A **job** (`jobs.js`) is a command that ENDS and yields a RESULT: `QUEUED →
RUNNING → {SUCCEEDED, FAILED, …}`, a timeout, a captured result. Right for a
test suite.

A **service** (`harness/processes.js`) STAYS UP and has a HEALTH. An exit is a
**crash**, not a result. It has a port, a health check, restarts, and an owner
task. Right for a dev server.

Merging them would have made every field optional and `RUNNING` ambiguous.
Nothing in `processes.js` waits for an exit as though it were the point, and
nothing in `jobs.js` grows a port.

Ownership is the answer to the orphaned-process failure this repository already
paid for once: `harness.shutdown()` is called from the REPL teardown and takes
every service and browser down with the session.

### 4.4 Structure before pixels, except when the UI is pixels

The observation router maps a GOAL to an ordered list of SOURCES. For
`element`: DOM → accessibility tree → screenshot → vision. For `screen`:
screenshot first — a canvas or a game has an empty DOM, and insisting on
structure there produces a confident "not present" about something plainly
visible.

A source that cannot answer returns `ok:false` **with a reason**, which is both
how the router knows to try the next one and what makes a verification
INCONCLUSIVE rather than FAILED.

### 4.5 The browser is an instrument, not a browsing tool

LAIN's browsing capability was removed in 2026-09 and stays removed. What is
here navigates only where a contract sends it, uses a throwaway profile, runs
headless, and has no `search` anything — the guarantee is the shape of the API,
not a policy on top of it (there is a test asserting exactly that).

It needs Node 22+ for `globalThis.WebSocket` (no dependency is added) and a
Chrome/Edge binary or an open debug port. When either is missing, `available()`
says which, every browser check is INCONCLUSIVE with that sentence, and nothing
pretends the flow passed.

---

## 5. Using it

### At the prompt

```
/harness                 state, processes, what is proved, evidence counts
/harness doctor          what works on this machine, and why anything does not
/harness capabilities    every capability by side effect, and what needs approval
/harness surfaces        which windows are attached
/harness timeline        the flight recorder
/tasks                   every task this project has a record of
lain --version           does it run at all
lain --doctor            what works on this machine and why anything does not —
                         Core / Execution / Observation / Verification / Optional.
                         A flag, not a slash command: MSYS and Git Bash rewrite a
                         leading `/` into a Windows path before node sees it.

/verify full             the contract this project declares — typecheck, build,
                         lint (optional), suite. Only what its own manifest names.
/verify tests [cmd] · build <cmd> · api <url> · browser <url>
/artifacts [<task>]      the receipts;  /artifacts open <id>  to read one
/env [processes|browser|health]
/task                    unchanged, plus the harness record underneath
```

### From the model

`verify_task` · `service_start` · `service_check` · `observe`

Each replaces a habit: a claim with nothing run, `npm run dev &` on a port
nobody recorded, a `sleep 5` standing in for a health check, and a screenshot
taken to read a value the DOM already knows.

### On disk

**A task that never did anything leaves no trace.** Persistence is *armed*, not
automatic: the record lives in memory until something MATERIAL happens — a tool
ran, a service started, a browser looked, a contract was checked, an artifact
was kept. Creating and starting a task are LAIN's own bookkeeping about an
intention, not work. When arming happens the earlier events are flushed in
order, so the durable log still starts at `task.created`.

That rule exists because a smoke test caught the alternative: a turn that died
at the transport — a 502, before a single tool call — was creating
`.lain/tasks/<id>/` and leaving it in the project. What it costs, stated
plainly: a turn that fails before any tool leaves no task record on disk. The
session transcript still has the attempt; the flight recorder is for what the
work did.

The drawer is bounded: the newest 200 task directories are kept, and beyond that
the oldest are pruned — but **only ones that reached a verdict**. Anything still
RUNNING, BLOCKED or VERIFYING is left alone however old it looks.

```
<project>/.lain/tasks/<task-id>/
    task.json         the record — state, history, processes, verifications
    events.jsonl      the flight recorder, one JSON line per event
    artifacts.json    the index
    verification/     rendered contract reports
    tests/ logs/      per-check output
    screenshots/      real PNGs
```

---

## 6. Limitations, stated plainly

- **Remote surfaces are projection-ready, not wired.** `harnesssurface.project()`
  is consumed by the dashboard. Telegram/remote lives in the Rust supervisor
  (`rust/lain-supervisor/src/remote.rs`) and answers from its own process, so a
  full remote view of harness state needs a Rust-side capability. The seam is
  `harnesssurface.line()`; the work is not done.
- **Execution tiers 3 and 4 (container/VM, remote runners) are interfaces only.**
  `ProcessManager` and the check context are shaped so a different executor can
  be substituted; none is implemented, and nothing pretends otherwise.
- **Skill-defined verification is half-built.** `harness/profile.js` derives a
  contract from what a project's own manifest declares — the small, honest
  version of "a skill says what proves work in this domain". A skill PACKAGE
  (manifest, loader, trust story) does not exist; when one arrives it produces a
  contract in exactly this shape and this becomes the default it overrides.
- **The dashboard gained a harness SECTION, not a workspace.** The existing
  `/dash` page is deliberately a conversation on a phone — dashpage.js argues
  that at length, and replacing it with a task-centric console would reverse a
  decision this project made on purpose. So the harness facts (task state, what
  is proved, services, evidence counts, the last timeline lines) are rendered
  from `harnesssurface.project()` in the details drawer, and every one of them
  is a projection the page computes nothing of. A full workspace — task graph,
  live run, per-agent views — is a separate UI project, not a half-built second
  view bolted onto this one.
- **`recovery.js` classifies but is not injected into tool results.** The model
  already receives a structured failure annotation on every failed command
  (`execution.js`: CLASSIFICATION plus the attempt history), and adding a second
  annotation would be duplication. The harness-level ACTION recommendation is
  available through `harness.recover()` and is used by the scenarios; wiring it
  into `tools/index.js` would need the two vocabularies reconciled first.
- **The browser harness has no video, no trace file and no visual diffing.**
  Screenshots, DOM, accessibility, console and network only.
- **Verification checks run sequentially** and deliberately: two suites racing
  over one build directory manufacture failures.
