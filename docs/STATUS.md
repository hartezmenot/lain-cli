# LAIN v2 — verification status

Labels are used exactly as defined; nothing is upgraded because the code looks
correct. A green run of unit/integration/smoke never implies LIVE PROVIDER.

```
UNIT-VERIFIED · INTEGRATION-VERIFIED · LIVE-VERIFIED · LIVE PROVIDER VERIFIED
SIMULATED · TEST-ONLY · PARTIAL · MISSING · NOT VERIFIED
```

Tiers: `unit` → UNIT-VERIFIED · `integration` → INTEGRATION-VERIFIED ·
`smoke` (spawns the real binary) → LIVE-VERIFIED · `live` (contacts a real
provider, self-skipping) → LIVE PROVIDER VERIFIED.

## The CLI finishing pass — activity vocabulary, and a red suite made green (2026-09-08)

The primary surface already had the hierarchy the brief asks for (project ·
model · tokens · one live activity row · one input box); this pass did not
rebuild it. What it found and fixed is narrower and real.

| Capability | Tier | Label |
|---|---|---|
| The four harness tools NAME THEIR SUBJECT (`verify_task`, `service_check`, `observe`) | unit | **UNIT-VERIFIED** |
| The four harness tools get their own VERB — VERIFYING / OBSERVING / STARTING / CHECKING | unit | **UNIT-VERIFIED** |
| The strip word is a pure function of the phase — same state, same word, at any clock | unit | **UNIT-VERIFIED** |
| No timer and no `Math.random` in `ui/status.js` — the UI cannot invent activity | unit | **UNIT-VERIFIED** |
| Project, model, token cost and the input box are on screen together, drawn through the real `Screen` | unit | **UNIT-VERIFIED** |
| Exactly ONE input region, below the conversation | unit | **UNIT-VERIFIED** |
| ONE elapsed-work clock per task, `HH:MM:SS`, which does not restart between a read, a write, a test or a retry | unit | **UNIT-VERIFIED** |
| The clock PAUSES on a rate limit, an interruption or a question, and resumes from the banked figure | unit | **UNIT-VERIFIED** |
| The clock cannot be advanced by drawing, and exactly ONE module advances it | unit | **UNIT-VERIFIED** |
| One elapsed vocabulary — the live row, `/bg` and the background region all spell it `HH:MM:SS` | unit | **UNIT-VERIFIED** |
| A successful routine call (read, search, shell) leaves NO row in the conversation; a failure, a change to the project, a verification, a decision and a service all do | unit | **UNIT-VERIFIED** |
| The turn's STANDING VERDICT — its last clean command — is kept, read off lifecycle.js's own rule rather than guessed from the command text | unit | **UNIT-VERIFIED** |
| The live pass and the recorded pass use ONE rule, so the conversation never rewrites itself at settlement | unit | **UNIT-VERIFIED** |
| Recovery, and a clipboard copy, are TRANSIENT OPERATIONS on the live row — never prose in the conversation | unit | **UNIT-VERIFIED** |
| An operation note can never displace a turn's phase, and can never make the window title claim work | unit | **UNIT-VERIFIED** |
| One invisible content frame — equal gutters, no fixed column cap, conversation and composer starting on the same column | unit + smoke | **LIVE-VERIFIED** |
| Preformatted content (fenced code, diagrams, trees) is never reflowed; a line too wide FOLDS at a cell boundary and loses nothing | unit + smoke | **LIVE-VERIFIED** |
| The composer is a borderless two-row grey region, resize-safe at 40–160 columns | unit + smoke | **LIVE-VERIFIED** |
| A submitted turn gets a scroll anchor on the header's rule when it scrolls out of view; clicking it returns to the exact message | unit | **UNIT-VERIFIED** |
| A second fold MERGES the first rather than quoting it — one summary marker, a true message count, instructions verbatim in order | unit | **UNIT-VERIFIED** |
| `/clean` (screen), `/clear` (model conversation), `/new` (task and plan) and `/compact` (transform) are four distinct operations | unit | **UNIT-VERIFIED** |
| Nothing in the compaction path can delete `.lain` evidence, artifacts or transcripts | unit | **UNIT-VERIFIED** |
| `/compact` answers in two lines; the accounting is `/token` | unit | **UNIT-VERIFIED** |
| ONE token estimator in the tree, and ONE owner of context transitions | unit | **UNIT-VERIFIED** |
| `toolRegistry.execute` has exactly ONE caller, so no convenience surface can bypass the gate; `/bg` delegates to the same executor | unit | **UNIT-VERIFIED** |
| A tool row's outcome and subject are PAINTED — green tick, red cross, cyan path — where the whole row used to be unpainted | unit | **UNIT-VERIFIED** |
| ONE content frame — `ui/frame.js contentBounds` — with EQUAL gutters at every width, odd or even, consumed by the header, conversation, live row, composer and command menu | unit | **UNIT-VERIFIED** |
| No renderer computes its own horizontal margin; no drawn row crosses the frame's right edge | unit | **UNIT-VERIFIED** |
| The gutter scales with the terminal (1 / 2 / 3 / 4), monotonically and boundedly, and is given up on a terminal too narrow to afford it | unit | **UNIT-VERIFIED** |
| PROSE narrows to a readable measure on a very wide terminal; code, diagrams and tables keep the whole frame | unit | **UNIT-VERIFIED** |
| The composer is three rows of grey with the text CENTRED in them, one pad inside the fill, no border at any width | unit + smoke | **LIVE-VERIFIED** |
| The command menu is a LIST — no frame, no rules, no shouted title — as wide as its contents and never the terminal | unit | **UNIT-VERIFIED** |
| The selected command row is CONTAINED within the menu, with the command token accented and its description dim | unit | **UNIT-VERIFIED** |
| Exactly ONE horizontal rule on the surface; the background and pending regions are labels | unit | **UNIT-VERIFIED** |
| A tool row reads `verb · subject` — the verb of a shell command is its program, and `Ran` is gone | unit | **UNIT-VERIFIED** |
| The live row names no actor for LAIN's own work, speaks transient states in sentence case, and shouts only verdicts | unit | **UNIT-VERIFIED** |
| One glyph vocabulary with the window title: spinner / ✓ / ✕ / Ⅱ / › / · , read off the same PAUSED_WORDS list | unit | **UNIT-VERIFIED** |
| The turn anchor is a dim `↑ user` on the header's rule — navigation, not a second header | unit | **UNIT-VERIFIED** |
| The final answer has the highest foreground contrast on the screen; tool rows and activity are dimmer | unit | **UNIT-VERIFIED** |
| A provider retry says NOTHING into the conversation — the live row carries it compactly and replaces it; the raw failure stays on the turn record | unit | **UNIT-VERIFIED** |
| The end of a rate-limit wait is not announced; a recovery the user need not act on leaves no trace | unit | **UNIT-VERIFIED** |
| A rate limit shows the PAUSE mark, never a spinner — the row and the window title read one classification | unit | **UNIT-VERIFIED** |
| A continuation LAIN composes for itself is captioned, never rendered as a user message; an UNDECLARED source is drawn as the user's own words | unit | **UNIT-VERIFIED** |
| Every runtime continuation (`rate-limit-resume`, `provider-failover`, `handover`, `steer`) has a caption; no internal key is printed at the user | unit | **UNIT-VERIFIED** |
| A steer acknowledgement and an interruption are transient; the steer's own words stay durable | unit | **UNIT-VERIFIED** |
| Streamed reasoning never enters the conversation — it is counted as output, kept on the record, and shown only behind `LAIN_SHOW_THINKING=1` or when it is the only thing the turn produced | unit | **UNIT-VERIFIED** |
| The prompt contract explicitly forbids routine narration, tool-call numbering and thinking-out-loud openers | unit | **UNIT-VERIFIED** |
| ONE divider per exchange boundary, inside the frame, dim, never inside code or between paragraphs | unit | **UNIT-VERIFIED** |
| The turn anchor is a one-line preview of the REAL submitted prompt on its own ground, normalised, truncated, paste-marked, inside the frame | unit | **UNIT-VERIFIED** |
| A markdown heading is bold, never upper-cased — one heading weight, not two | unit | **UNIT-VERIFIED** |
| An ordinary turn prints no task id, event count or verification contract | unit | **UNIT-VERIFIED** |
| One projection seam — `dash.js` consumes `harnesssurface`, never `runtime.snapshot()` | unit | **UNIT-VERIFIED** |
| A missing harness projects ABSENT (`null`), never an empty task | unit | **UNIT-VERIFIED** |

**Two real defects, both found by reading what the screen would say:**

1. `describeTarget` had no branch for `verify_task`, `service_check` or
   `observe` — none of them carries a `path`, `command`, `pattern` or
   `question` — so all three drew as subject-less rows. Thirty verifications
   were indistinguishable from each other, in the one place a person most
   wants to know WHAT is being proved. The same fault `computer`,
   `process_run` and `web_fetch` had each been fixed out of before.
2. The status strip mapped all four harness tools to the generic `RUNNING`.
   `RUNNING npm test` and `RUNNING unit tests pass` are not the same event:
   one is a command, the other is LAIN trying to PROVE something, and the
   harness already distinguishes them (`harness/state.js` VERIFYING is a state
   only evidence can leave). The strip was the last surface flattening it.

The vocabulary is NOT new: VERIFYING is what the strip already said for a
pending completion, and OBSERVING is the observation router’s own word. Nothing
here invented a state; two of them were simply unreachable from a tool call.

### The red suite, and what it was hiding

The tree carried **13 permanently failing tests** (6 unit, 7 smoke) — recorded
in the previous pass as “pre-existing, not fixed”. All 13 had ONE cause: they
asserted `/audit` and `/troubleshoot` were registered commands, after this
tree’s own UX-subtraction pass deliberately removed them. A suite with known-red
tests in it stops being read, so they were reconciled rather than left:

- the tests now assert the DECISION (the command is gone) and the survival of
  what it reached — `mode.js` still classifies a vague problem report as
  TROUBLESHOOT, `troubleshoot.js` still renders, `/compare` still exists;
- `src/health.js` was PROBING THE COMMAND REGISTRY for both, and therefore
  reported the workflows as **MISSING**. They are not missing. It now probes the
  module and the mode, and the rows are named for what a person can do
  (`Project reading`, `Troubleshooting`) rather than for a command they can type.

**Unit 2,233 / 0 failed. Smoke 534 / 0 failed. Distribution 40 / 0 failed.**
Integration 169 / 1 — the one failure is `harness-lifecycle.test.js`
(“foreground-owner crash removes foreground tool descendants”), an untracked
Harness-owned file exercising the process manager and the Rust supervisor. It
touches none of the modules changed here and reproduces in isolation.

### A LIMITATION THIS PASS FOUND AND DID NOT REPAIR

**The external-review relay is orphaned.** `investigation.relay` is called from
exactly one place — `troubleshoot.js` `runCommand` — and no registered command
reaches that any more. The machinery is intact and nothing can start it, so the
structured troubleshoot REPORT and the bounded LAIN → EXTERNAL → LAIN review no
longer appear in any turn. The TROUBLESHOOT *workflow* (prompt guidance, trace
before editing) is unaffected and still reached by describing a problem.

This is reported rather than fixed because the repair is a product decision —
give the relay a door (a command, or a model-facing tool) or retire it with its
module — and both are larger than this pass. `tests/smoke/relay-dash-mcp.test.js`
now asserts the REACHABILITY fact, so the day it changes, a test says so.

**Also observed, environmental:** the integration tier ran for four hours
against a stale `rust/lain-supervisor` binary (`tests/run.js` refuses it by
design) with 112 orphaned supervisors and 30 headless Chromes left by earlier
runs holding the machine. Rebuilt and cleaned: the same tier now completes in
**228 seconds**. Nothing in the CLI caused this and nothing in it was changed for it.

---
## Distribution and packaging (2026-09-08)

How `lain` gets onto a machine. Architecture and limitations:
[`DISTRIBUTION.md`](DISTRIBUTION.md).

| Capability | Tier | Label |
|---|---|---|
| One product, one executable — `package.json` declares exactly one `bin`, asserted | distribution | **UNIT-VERIFIED** |
| Package contents — a `files` allowlist; 585 files / 6.9MB → 276 files / 3.4MB, source only | distribution | **UNIT-VERIFIED** |
| A real global install from a packed tarball into an ISOLATED npm prefix | manual, this pass | **LIVE-VERIFIED** |
| `lain --version` on a PATH holding only the sandbox bin, node and system32 | manual, this pass | **LIVE-VERIFIED** |
| `lain --doctor` from that isolated install, in an empty project, exit 0 | manual + distribution tier | **LIVE-VERIFIED** |
| The Harness ships inside the same executable (`lain /harness capabilities`) | manual, this pass | **LIVE-VERIFIED** |
| The no-npm path — extracted tarball, `node distribution/install.js`, launcher run | manual + distribution tier | **LIVE-VERIFIED** |
| Install success contract — the launcher must RUN, not merely exist | distribution | **UNIT-VERIFIED** |
| PATH: append-only, idempotent, case-correct, no duplicates, bin-dir only | distribution | **UNIT-VERIFIED** |
| PATH denied — still installs, states the limitation, prints the manual command, claims nothing | distribution | **UNIT-VERIFIED** |
| Windows: USER scope via PowerShell, never `setx` (silent 1024-char truncation), never machine PATH | distribution | **UNIT-VERIFIED** |
| Windows: three shims (`.cmd`, `.ps1`, POSIX), LF endings on the POSIX one, quoted paths | distribution | **UNIT-VERIFIED** |
| A launcher in a path containing SPACES actually runs | distribution | **UNIT-VERIFIED** |
| Unix: marked block in the file `$SHELL` reads; idempotent; removal restores the file; fish syntax | distribution | **UNIT-VERIFIED** (file I/O exercised on this host; a Unix login shell re-reading it is NOT VERIFIED) |
| Uninstall removes only what it wrote; config, sessions and the checkout are kept | distribution | **UNIT-VERIFIED** |
| Shadowing — a second `lain` earlier on PATH is reported, not hidden | distribution | **UNIT-VERIFIED** |
| Boundary — nothing in `src/` reaches `distribution/`, and no `src/` file mutates PATH | distribution | **UNIT-VERIFIED** |
| Development mode unaffected — `node bin/lain.js` with no install | distribution | **UNIT-VERIFIED** |
| Optional capabilities never block installation; `○` is a fact, `✗` is a fault | distribution | **UNIT-VERIFIED** |

**Distribution suite: 39 tests, 0 failed.** Every PATH case runs against an
INJECTED FAKE adapter — the developer's real PATH is never touched, which is the
same rule `tests/run.js` applies to the config home.

**One defect found and fixed:** `pathenv.remove` hands the adapter what is left
after filtering, which on Unix is the empty string (that adapter holds one
entry). `set('')` wrote `export PATH=":$PATH"` and left the marker block in the
profile, so uninstall reported success over a file that still had LAIN in it. An
empty value now means UNSET.

**Answered explicitly:** a new user can install LAIN Harness and immediately use
`lain` without separately installing a LAIN CLI — verified by the isolated
install above, not inferred from package metadata.

---

## The Harness (2026-09-08)

The task runtime, event vocabulary, process manager, artifact store,
verification engine, observation router, browser harness, recovery engine and
capability registry. Architecture and limitations: [`HARNESS.md`](HARNESS.md).

| Capability | Tier | Label |
|---|---|---|
| Task state machine — `PASSED` unreachable except through `VERIFYING`; terminal states never rewritten | unit | **UNIT-VERIFIED** |
| Task record persisted to `.lain/tasks/<id>/`, reloaded across processes | unit + smoke | **LIVE-VERIFIED** |
| Persistence is ARMED by the first material event — a task that did nothing leaves no directory, and no history is lost when it arms | unit + smoke | **LIVE-VERIFIED** |
| The task drawer is bounded at 200, and only settled tasks are ever pruned | unit | **UNIT-VERIFIED** |
| `lain --doctor` — grouped Core/Optional report, side-effect free, exit 0 with no provider | distribution + smoke | **LIVE-VERIFIED** |
| Event vocabulary — 42 names on ONE bus; a guard proves none is advertised and never emitted | unit | **UNIT-VERIFIED** |
| Flight recorder — every bus event appended to the active task's `events.jsonl` | unit + smoke | **LIVE-VERIFIED** |
| Artifact store — text and BYTES (a screenshot is a real PNG), torn-line tolerant, path-traversal safe, never throws | unit + integration | **INTEGRATION-VERIFIED** |
| Process manager — an unrequested exit is a CRASH; health is UNKNOWN when nothing looked; ownership + `cleanup` | unit + integration | **INTEGRATION-VERIFIED** |
| Verification engine — FAILED outranks INCONCLUSIVE; optional requirements cannot change a verdict; nothing short-circuits | unit + integration | **INTEGRATION-VERIFIED** |
| Checks — a missing runner is INCONCLUSIVE, never a red suite (via `execution.js` + `testing.js`) | unit | **UNIT-VERIFIED** |
| Project profile — `/verify full` derived from what the manifest declares, never guessed | unit | **UNIT-VERIFIED** |
| Observation router — structure before pixels; `screen` deliberately inverted; every source maps onto `observe.js`'s five witness kinds | unit | **UNIT-VERIFIED** |
| Browser harness — real Chrome launched headless, real flow, DOM/console/screenshot, PASS and FAIL both proven on a served page | integration | **INTEGRATION-VERIFIED** |
| Browser unavailability — INCONCLUSIVE with a reason, never a silent pass or a false failure | unit | **UNIT-VERIFIED** |
| Recovery — environmental never retried; a transient failure retried exactly once, then re-classified | unit | **UNIT-VERIFIED** |
| Capability registry + approval policy — DESTRUCTIVE/EXTERNAL require approval; every live tool described | unit | **UNIT-VERIFIED** |
| Approval events from the real permission flow; unattended asks nobody and announces nothing | unit | **UNIT-VERIFIED** |
| CLI — `/harness` `/tasks` `/verify` `/artifacts` `/env`, and `/task` unchanged plus a section | smoke (real binary) | **LIVE-VERIFIED** |
| Model tools — `verify_task` `service_start` `service_check` `observe` | smoke (real binary) | **LIVE-VERIFIED** |
| Dashboard renders a PROJECTION; the payload carries names and counts, never artifact bodies | unit | **UNIT-VERIFIED** |
| Remote surface | — | **PARTIAL** — `harnesssurface.project()`/`line()` exist and the dashboard consumes them; the Rust supervisor side is not wired |
| Execution tiers 3-4 (container/VM, remote runners) | — | **MISSING** — interfaces only, deliberately |
| Skill packages (manifest, loader, trust) | — | **MISSING** — `harness/profile.js` is the manifest-derived stand-in |

**Full tiers after this pass: unit 2,218 / 6 · integration 146 / 1 ·
smoke 528 / 7 · distribution 40 / 0.** Every one of the 14 failures is
accounted for below: 13 are the `/audit` + `/troubleshoot` removal's, and 1 is
the remote-control cluster (149 orphaned `lain-supervisor.exe` processes were
live on the machine at the end of this pass, up from 101 at the start — each
timed-out run leaks more, and they must be cleared before that tier can give a
trustworthy answer).

**Harness suites: 147 tests, 0 failed** (unit 123 across six files · integration 8
scenarios A-E · plus 16 smoke cases against the real binary). Scenario B
launches a real headless Chrome against a real served page and asserts both the
PASS and the FAIL path; it degrades to an asserted INCONCLUSIVE where no browser
exists.

**Three real defects were found by these tests and fixed:**

1. `lain -p` never tore the harness down — it does not go through `repl.start()`,
   so a one-shot that started a managed service HUNG FOREVER (the service held
   the event loop open) and left the process as an orphan. Found by a smoke test
   that stopped finishing. `App.once` now shuts down in a `finally`.
2. `harnesslink.beginTurn` read `runtime.active()`, which is null the instant a
   task settles — so continuing after a verdict opened a fresh task with no
   `causedBy`, silently losing the link between a failure and the work that
   fixed it. It reads `latest()`.
3. A turn that died at the transport, before any tool call, still created
   `<project>/.lain/tasks/<id>/` and left it there — litter in somebody's
   project for a request that never reached the model. Caught by
   `smoke/connection.test.js`, which has guarded "a failure BEFORE any tool
   leaves the working tree untouched" for months. Persistence is now ARMED by
   the first MATERIAL event; earlier events are flushed in order when it fires,
   so no history is lost.

**Two latent defects in pre-existing code, exposed by this work and fixed:**

1. `tests/integration/guardian.test.js` — "Node holds no second copy of the
   decision" strips comments before checking that `inputgate.js` does not read
   the transcript. Its stripper split on LF and used `//.*$`, and **`.` does not
   match a carriage return in JavaScript** — so on a CRLF checkout nothing was
   stripped and the guard failed on a comment that says, correctly, that the
   gate does not read `record.stopReason`. This repository has
   `core.autocrlf=true` and no `.gitattributes`, so *a fresh clone on Windows
   produces exactly that*: the guard was failing for every new contributor on
   this platform and passing only where some tool had rewritten the file as LF.
   Line endings are now normalised before the rule is applied. (Surfaced here
   because a `git stash`/`pop` cycle — used to establish a baseline — rewrote
   working-tree files through git's autocrlf filter.)
2. `tests/integration/continuation.test.js` — the sandbox teardown raced
   `gitsnapshot.prefetch`, which `submit` fires **deliberately unawaited** and
   which spawns `git` with the sandbox as its working directory. On Windows a
   directory cannot be removed while a process has it as a cwd, so the teardown
   got EPERM. Measured, not assumed: three consecutive runs failed immediately
   and all three succeeded 600ms later. The teardown now retries within a bounded
   budget and still throws on a genuine leak. Pre-existing (`src/gitsnapshot.js`
   is untracked working-tree work); this pass shifted timing enough to make it
   deterministic rather than intermittent.

**Pre-existing failures NOT caused by this work, and not fixed by it:** six unit
tests (`audit.test.js` ×4, `health.test.js`, `panes-report.test.js`) assert that
`/audit` and `/troubleshoot` are registered commands. Both were removed from the
command surface by this tree's own uncommitted UX-subtraction pass
(`src/reportcommands.js`, `src/commands.js`) and their tests were not updated.
Proven by restoring `src/reportcommands.js` to HEAD, at which point `/audit`
registers again. Re-adding the commands would reverse a decision this tree
records deliberately, so they are reported rather than "fixed".

---

**Latest pass (Phase-2 removal pass): unit 2,094 / 0 failed** — the Probe
integration removed from the tree and the architecture guards green on the
changed code (first run after the removals: 2,110/1, where the one failure was
the reachability guard catching two unreachable modules — numfmt.js and
tools/browser.js, both deleted; the second run is the recorded pass).
Integration and smoke NOT yet re-run on the changed tree; the figures below
are the prior pass. The benchmark's mock baseline: 8/8 task runs verified,
8/8 instrumentation checks matched (details below and docs/BENCHMARK.md).

**Prior pass (request admission): unit 2,134 / 0 failed · smoke 528 / 0 failed ·
integration 133 / 4 failed** — every failure in the remote/brain and supervisor
cancel timing tests, the same cluster proven environmental in the prior pass.

**The remote-control failures were finally root-caused: not timing, not code —
~90 orphaned supervisor processes.** A full enumeration of live
`lain-supervisor.exe` (a `tasklist` tail shows three; `Get-CimInstance` shows
the truth) found roughly ninety `serve` processes accumulated across days of
test runs, every one from this repo's `target/` directories. Timed-out harness
runs never reach `withRemote`'s `finally` teardown, so each leaked supervisor
kept polling the `LAIN_TELEGRAM_API` port baked in at spawn, forever, at a
backoff that caps at 60s. Windows reuses ephemeral ports, and the fake
Telegram served ANY client that shared the file-wide `FAKE_TOKEN` — so the
moment a new test's fake landed on a port an orphan remembered, the orphan
raced the real supervisor for `getUpdates` and stole or duplicated updates.
That single mechanism explains every observed symptom: "the bot answered"
never arriving (an orphan consumed the update), pairing replies arriving
twice (an orphan also paired), the dedupe test's `2 !== 1` (an orphan's
in-memory `seen` list never held update 4242), and the run-to-run variance
in WHICH tests failed — a different port collision each time. The Rust runtime
was audited sound while diagnosing (cursor-before-answer, generation-guarded
threads, token-never-in-argv transport); no runtime change was made, per §15.

**The fix is in the test rig, not the runtime: per-test tokens, and a fake that
authenticates like the real thing.** `fakeTelegram` now mints a fresh, well-
formed bot credential per test (`mintToken`) and answers any OTHER token with
the 404 the real Telegram gives a credential it does not know — on every
method, before any queue is served. An orphaned supervisor that wanders onto
the new fake's port can neither steal updates nor inject replies; its
remembered token belongs to a fake that is already gone. The two tests whose
assertions are specifically about a visible constant token (connect, badtoken)
opt in via `{ token: FAKE_TOKEN }`, and the degrade test's leak assertion
follows the minted token. Clearing the accumulated orphans is a one-time
cleanup (`taskkill /IM lain-supervisor.exe /F`), after which the rig's own
teardown plus the token refusal keeps the tree clean.

*(Weighed and rejected: making the supervisor exit when its home directory
vanishes. Outliving a client is the supervisor's stated job — "the part of LAIN
that is still running when LAIN is not" — and a real home never vanishes. A
runtime behavior change to solve what is now a contained test-hygiene problem
fails §20's "do not rewrite working systems". The one-time kill plus the
per-test token refusal are the whole remedy.)*

**Second mechanism found after the token fix — the forensics held, the first
explanation did not.** With per-test tokens in place the interference class of
failures was gone (18/25 passing with the full orphan population still live),
but seven tests kept failing at run-to-run-varying sites: the pairing gates
themselves. Forensics on the leftover mkdtemp homes identified the shape. The
`Authorized…` text every failing assertion mistook for its answer is sent
ONLY on a successful `/pair` (telegram.rs:337), and notify's
`events.jsonl` shows `REMOTE_CONNECTED` → `TURN_STARTED` exactly 15.0s
apart — the full `until` budget consumed waiting for a pairing reply that
had not arrived, after which the late reply poisoned every subsequent
assertion in the test. The homes' `telegram.json` offsets (1–2) prove the
updates were eventually consumed; the runtime moved its cursor and answered
correctly, just late.

**Why the reply was late — first theory, now corrected.** The real API holds
`getUpdates` open; that hold paces the adapter's poll loop, and the rig's
instant-empty answer was a genuine fidelity defect (a curl-spawn storm
limited only by process creation). The fix is correct regardless: the fake
now HOLDS an empty getUpdates (250ms window) and releases it the instant a
message is spoken, which is Telegram's actual delivery semantics; loop rate
drops from spawn-limited to ~4 polls/sec; the `fail` check stays before the
hold (degrade's fast-500 path is unchanged); teardown drains held requests.
But the hold alone did NOT green the file — 16/9 with the orphan population
still live, 14/11 later the same day as the population crept to 96 — so the
storm was one contributor, not the cause.

**The wire trace closed it.** An env-gated tracer (`LAIN_RC_TRACE`) in the
fake now stamps every wire event with epoch milliseconds: SAY (test queued a
message), POLL-SERVED (a getUpdates arrived and was answered), SENT (a
sendMessage landed). The traced run's timeline is unambiguous: SAY →
POLL-SERVED gaps of 11.5s, 17.1s and 38.2s — the message waits in queue
long before the supervisor's poll ever arrives — while POLL-SERVED → SENT
is ~400ms. Once a poll lands, the runtime answers promptly; what is starved
is the poll itself. Between visible polls the fake receives nothing for
5–50s stretches that match the backoff ladder exactly (2+4+8+16s of
in-transit getUpdates deaths, each failure doubling the sleep, telegram.rs
:205-206) — requests dying before they reach the fake, which is why the
fake's trace shows only the retries that finally got through. Under it all:
96 orphaned supervisors at census time, grown from ~90 across the day as
the score decayed 18/7 → 16/9 → 14/11 in lockstep. The leak path is in the
rig's own teardown: `supervisor.shutdown()` is a graceful request with a 5s
budget, and the child is spawned detached and unref'd with its PID
discarded (src/supervisor.js:182) — a shutdown that misses its window under
load leaves an orphan the rig can no longer reach. Each failed test can leak
one more; the failures and the leaks feed each other in a loop.

**Verdict: the runtime is sound; the machine was drowning.** The backoff
behavior is correct (a request that dies in transit SHOULD back off); the
sends are one-shot but fast when unpolluted. The defect is environmental —
the accumulated orphan population — and the remedy is the one-time kill,
with the traced clean-machine run as the confirming A/B. §15 untouched,
§20 untouched: no runtime change was made or is proposed on this evidence.

Confirmed directly per tier from the runs of this pass: **unit 2,133 ·
integration 129–132 · smoke 528**.

**The integration failures are a pre-existing timing sensitivity, not a
regression of this pass — proved, not assumed.** The same file was green twice
in the morning runs of this machine. A canary run of `remote.test.js` with this
pass's new code instrumented recorded **0 executions of `runTurn` and 0 of
`handover.build`** — the tests failed with none of the changed code paths ever
having run. The remote/brain/supervisor tests drive a real supervisor process,
a real HTTP "brain" and Telegram-shaped polling against 15–20s windows; under
load they fail at varying rates. Not chased further this pass; the failure
modes ("the bot never answered", one supervisor cancel timeout) are all
deadline expiries.

**The live provider tier was NOT exercised in this pass.** The bridge answered
`429 — Individual quota reached` for all three completion tests, and a retry after
the stated reset window was refused the same way. The four `wininput` live tests
passed against real OS input. Nothing here is upgraded on the strength of a green
unit run: the completion path is **LIVE-VERIFIED** from an earlier pass and
**NOT VERIFIED in this one**.

## The benchmark baseline of this pass

**This pass added `bench/` — a representative, deterministic benchmark whose
mock mode is REQUIRED and validates the measurement itself, plus a live mode
that is explicit opt-in.** All 8 task runs verified against behavioural ground
truth and all 8 instrumentation checks matched their planted numbers. The
findings it measured (the ~16.4k-est-token fixed floor every request carries,
the ledger's 250-line coverage gap, the measured cost of planted waste) and the
two env-gated runtime seams it needed are recorded in **docs/BENCHMARK.md**;
`tests/unit/bench-evidence.test.js` (16 cases) pins the evidence classifier in
both directions, and `tests/smoke/bench.test.js` pins mock reproducibility.

**Bench environment, weighed and decided: the fixture stays git-less.** The
fixture is copied without any `.git` (bench/fixture holds README/package.json/
src/test.js/tests only), nothing in bench/ references git — task trust is
injected via `trustedPaths`, the reset guarantee is proven by a sha256
byte-walk, and drift by protected hashes, so no benchmark mechanism depends on
git. The CLI degrades by design without it: `gitsense.review` answers "not a
git repository, so there is nothing to compare against" and the briefing
renders "Not available." — one clean refusal, no failure path. Adding a
`.git` now would also invalidate the before/after comparison: the recorded
baseline was measured git-less, and a `.git` would add a per-request
`git status` spawn and change briefing content on every run — a different
measured environment, not a code improvement. (Weighed per the standing
instruction that fixture-environment changes be recorded honestly.)

## GAP-MATRIX pass — the two implemented fixes, and what is verified

The competitive audit (docs/GAP-MATRIX.md, 28 rows) selected two changes as the
highest-confidence code candidates. Both are implemented. **Both are NOT
VERIFIED at any tier as of this writing** — the execution environment refused
every command of this pass ("claude-opus-5 temporarily unavailable, so auto
mode cannot determine the safety of Bash"), so no syntax check, no test tier,
and no benchmark re-run has happened on the changed tree. This section records
exactly what exists, and the two false starts caught by writing the tests
first, so the moment a run is possible the results have a place to land.

### Row 24 — git state reaches the model, per turn (src/gitsnapshot.js, new)

`gitsense.js` has measured the working tree since it was written but only two
consumers ever saw it (`survey.js` for the briefing, `review_changes`). The
model received nothing unless it called a tool. GAP-MATRIX row 24 called this
the smallest confirmed gap with daily frequency.

The fix is one module wired at three seams, all in the established shapes:

- `app.submit()` → `gitsnapshot.prefetch(this, this.gitTouched())` — fire-and-
  forget, the same shape `refreshSupervisedJobs` uses; the measurement overlaps
  request assembly and a turn that outruns it simply renders no section.
- `app.adopt()` → `gitsnapshot.reset(this)` — a new session is a new tree.
- `promptparts.of()` renders `say(app._gitSnapshot)` into the **volatile half
  only**, after the split, beside the plan digest. Tree state is the
  definition of volatile; putting it in the stable prefix would re-price every
  conversation on every file write — the token incident recreated by the
  feature meant to add information.

`say()` renders numbers, not content (per-file +added/-removed, grouped
untracked/deleted, ≤12 rows, ≤4 shape observations), and is a PURE renderer of
`gitsense.review`'s judgements. It is silent for a clean tree, no `.git`, a
failed measurement, or a measurement that has not landed — each of those is the
correct answer.

**Two defects were found and fixed while writing the unit tests, before any
tier ran** — which is the §23 UNIT step doing its job:

1. The first version re-derived "unexpected" inside `say()` from a second copy
   of the expected list, comparing absolute ledger paths against repo-relative
   git names. It never matched, so with a non-empty ledger EVERY modified file
   would have been flagged "this session never wrote". The fix removes the
   second idea: `f.unexpected` comes from `gitsense.review`, which owns the one
   path-normalization rule; `prefetch` is the only place the ledger list is
   passed, untransformed.
2. The rewrite-note guard suppressed the whole-file-rewrite observation
   whenever the huge-set note fired. They advise different responses (scope
   vs edit method) and both must be able to appear.
3. (Found 2026-09-07 while statically verifying the tests against the code
   before the first run.) The unexpected-file case asserted
   `!text.includes('mine.js')` — impossible: every modified file renders as an
   ordinary row, so `mine.js` is in the listing by design. The assertion is now
   scoped to the notes section (`Worth knowing:`), which is where findings
   live, plus a positive assertion that the file IS present as an ordinary
   row. A defect in the test, not the implementation.

### Row 24's wiring exposed a pre-existing gitsense defect: the path BASE

Found 2026-09-07 while tracing what the per-turn wiring would render. It is a
**gitsense.js defect that predates this mission** — review_changes and survey
were broken by it all along — but row 24 would have turned it into per-turn
corruption, so it was fixed as part of the row-24 work.

The facts (verified against the shipped git docs on this machine,
git-status(1) and git-diff(1), not against remembered behavior):

- `--porcelain=v1` ALWAYS reports repo-root-relative paths — "the user's
  `status.relativePaths` configuration is not respected" is deliberate. So from
  a subdirectory cwd, git's names are `pkg/mine.js`-shaped.
- `git diff --numstat` from a subdirectory defaults to root-relative names over
  the WHOLE tree; `--relative` opts into subtree scoping, and a user's
  `diff.relative` config silently sets that flag.
- Both expected-list sources (the checkpoint ledger, lifecycle evidence) hold
  ABSOLUTE paths, which review() normalizes against cwd — the session's own
  frame.

So from any subdirectory cwd the two frames diverged on every file: every
modified file was flagged `unexpected` (the cwd-relative expected name could
never equal git's root-relative one), `countLines` probed paths that do not
exist — so `lines` came back null and every size judgement built on it (the
rewrite detector's `lines > 30` gate) silently stopped working — and every
expected file was reported `missing`.

The fix, all inside gitsense.js:

- both calls scoped to the session's subtree (`-- .`) — a monorepo-subdir
  session is not briefed on other directories' changes, and a whole-monorepo
  numstat is no longer paid for;
- numstat's frame pinned with `--no-relative` against a `diff.relative` config;
- the join happens in git's root frame (both sides as git reported them), then
  a single `rev-parse --show-prefix` — fused into the repo probe review()
  already ran, so no extra spawn — converts names into the cwd frame for the
  expected-list match, countLines, and every rendered name. At the repo root
  the conversion is the identity, so root-level sessions' answers are
  byte-for-byte what they always were;
- `describe()`'s "WRITTEN BUT NOT DIFFERENT" note no longer asserts the false
  inference ("the write produced the same bytes that were already there") for
  ignored or out-of-subtree writes — it states both readings, because "git
  reports no change" is two observations, not one. (`say()`, the per-turn
  section, never rendered `missing`; briefing.js's phrasing was already
  literally true.)

Regression test: `tests/unit/semantic.test.js` gains a real-repo subdirectory
case — repo with `pkg/` and a top-level file, changes in BOTH places,
`review(pkg, {expected: [pkg/mine.js]})` asserts mine.js is not `unexpected`,
numstat landed on it (1/1), `lines === 3` (countLines read the real file),
theirs.js still is a surprise, `missing` is empty, and root.js — differing
from the last commit — is absent entirely (subtree scoping). **NOT VERIFIED —
written, not run.**

Unit tests: `tests/unit/gitsnapshot.test.js` (14 cases — say() rendering and
silence, prefetch storage and silence-on-failure, reset, the ledger read, and
two seam tests asserting the section lands in `live` and NEVER in `stable`).
**NOT VERIFIED — written, not run.** app.js sits at 699 lines against its
`< 700` architecture guard (the delegate method `gitTouched()` is one line
because the body lives in gitsnapshot.touched).

**Update 2026-09-07: the unit tier RAN.** 2,175 passed, 1 failed — the one
failure being the app.js god-object guard itself ("app.js is 700 lines —
split it before it becomes repl.js"): the gitsnapshot reset in `adopt()` was
+3 lines and crossed the boundary, split-count being 700 against 699 physical
lines. Every new case passed — including the gitsense subdirectory
regression. Fixed by condensing the gitsnapshot reset comment to one line
(app.js:150-151, now 699 split-count); the guard itself was NOT touched.
**Re-run pending the classifier's next window** (the outage that has run
through this session also blocked the confirmation).

### Phase 1 baseline — the browser ownership surface + the /external audit

**Label: read-and-traced, NOT a removal.** Task #34, §16 and §0-C of the new
brief. Same rule as the Probe map: the complete file-level inventory lands
first; Phase 2 removes per §19.

**The browser surface, in full:**

- **src/browser.js** — the BrowserRuntime: `live()`, `runtimeFor(app,
  provider)` with the `app._browsers` Map (one runtime per provider profile;
  `app._browser` is the `'profile'` default), `start()` spawns a separate
  Chromium under `~/.lain-v2/browser/profile` (never the user's browser,
  never their profile — the file's header rules). This is browser
  infrastructure by any reading: it owns Chromium process lifecycle and the
  CDP wire.
- **src/browsercdp.js** — the CDP client the runtime speaks (loopback debug
  port only). Browser infrastructure; dies with browser.js.
- **src/tools/browser.js** — the `browser` tool (open/info/screenshot/
  inspect/click/type/key/wait/measure/console). Gated by
  `browserLive` at tools/index.js:133-134 — "IT ONLY EXISTS WHILE THE
  BROWSER IS RUNNING, which the user starts with `/external browser`". Dies.
- **src/research.js `search()`** — web_search drives LAIN's Chromium
  (Bing results; headless gets a degraded page, which is why the runtime is
  headed). Dies with the browser. **web_fetch is a plain HTTP GET**
  (research.js:19 "no browser, no JavaScript, no profile") — GENERIC, and it
  survives: §16's "generic HTTP/network mechanisms needed for legitimate
  coding workflows" is exactly this tool.
- **src/tools/web.js** — the schemas. `fetchTools` (web_fetch) survives;
  `searchTools` (web_search, tools/index.js:147's `if (browserLive)` gate)
  dies.
- **src/actors.js BrowserActor** (:278-484) + `KIND.BROWSER` (:75) + the
  registry entry (:572) — the chat-page external-review relay (drives a
  ChatGPT-style page, watches the reply settle, attributes it to "the page"
  never a model). This is browser automation in service of /external —
  the §0-C audit's one genuine coupling point: it dies, and with it
  `/external browser` / `/external chatgpt` (routecommands.js:160-164), the
  KIND.BROWSER row in the `/external` status view, and modelroutes.js's
  browser rows.
- **src/imageview.js:123** — `browser.live()` used as the preferred viewer
  for the human-inspection HTML page, with `start <file>` as the fallback.
  The LIVE branch dies; the default-viewer fallback (cmd `start` / `open` /
  `xdg-open`) survives untouched — the human visual-inspection workflow
  keeps its viewer.
- **src/survey.js:210-215** — the `browser` row in the machine survey
  ("The user starts one with /external browser"). Dies with the runtime.
- **src/tools/semantic.js:631** — `{ _browser: ctx.app && ctx.app._browser }`
  in a tool context — dies with `app._browser`.
- **src/routecommands.js:77-80, 154-164** — the `/external browser` /
  chatgpt branches. `routecommands.js:80`'s comment notes the actor replaced
  a curl+grep flow "that required the user's own browser". Dies.
- **Tests:** tests/smoke/browser.test.js (the live browser test — requires
  `src/browser` + `BrowserActor`; dies), tests/unit/imageview.test.js (the
  lain-chromium branch case; the default-viewer cases survive),
  tests/unit/research.test.js (search cases; fetch cases survive),
  tests/unit/actors.test.js (BrowserActor cases), tests/unit/relay.test.js /
  modelroutes.test.js / external.test.js / externalrequest.test.js /
  observe.test.js / toolaudit.test.js / dashgate.test.js /
  external-resume.test.js / relay-dash-mcp.test.js (browser rows and
  `/external browser` paths inside otherwise-generic tests — restructure),
  tests/unit/sessionindex.test.js (the `delivered: 'browser'` field at
  actors.js:426 — a generic session-index field whose value is the label;
  the field survives, that value stops being produced), tests/live/
  mcp-input.test.js (browser mentions in the live tier),
  tests/integration/supervisor.test.js (browser references in supervisor
  jobs), tests/unit/backups-mcp.test.js (browser mentions in mcp config
  examples).
- **Docs:** README/STATUS probe-era browser sections annotated as historical
  at Phase 2; docs/ui-prototype/workspace.js untouched prototype scenery.

**The §0-C /external audit, answered:**

- external.js is **not a second provider stack**: it resolves through
  `provider.resolve` and speaks through `provider.chat` (external.js:6-12,
  97-100) — the same catalog and connection machinery a turn uses, only the
  WHICH model/connection changed. There is no second routing implementation
  that could disagree about endpoints.
- The reviewer **has no tools, no filesystem, no shell** (SYSTEM prompt at
  external.js:43-68): claims to have acted are flagged, not passed through.
- **NOT CONFIGURED is a real state** — plainly reported, never falling back
  to LAIN's own model and calling it an external review.
- The actor family (actors.js) delivers packets: HumanActor (paste relay),
  ApiActor, ReverseActor (declared-not-built seam that says so), BrowserActor
  (the one browser-coupled actor, dies per the map above). /external stays
  isolated from the core coding-agent lifecycle: troubleshoot's local loop
  is unaffected, and the request verbs (`send`/`show`/`cancel`) act on the
  pending draft only.
- **Verdict: /external survives Phase 2** minus its browser actor, exactly
  as §0-C requires ("keep it temporarily… do not expand it, do not redesign
  unless required to prevent coupling"). The only removal needed to prevent
  coupling is the browser actor itself, already in the map.

### Row 25 — the elision note's recovery route (src/tools/tests.js, one block)

The quietPass elision note advised: "re-run `<command>` with run_bash and grep
it" — teaching the model to spend a second full suite run (minutes, plus
another request to read) to recover one line the first run already established
as passing. The note now names the runner's own filter (`-t`/`--filter`/`-k`)
as the recovery route. The compaction stub's "Re-run the call if you need the
rest" was audited and deliberately left: it already carries name + args + a
semantic residue outline, so re-running there is recovery of elided EVIDENCE,
not re-derivation of a settled verdict. A retrieve-by-id tool was rejected as
tool-count expansion.

Unit tests: `tests/unit/testing.test.js` gains one case pinning the note's
direction on the OLD advice's signature (`run_bash`, `grep`) — not on any
mention of re-running, which the new note legitimately contains as the advice
against the waste. **NOT VERIFIED — written, not run.**

### What the fresh benchmark must answer (pending #30)

The 2026-09-05T20-18-39 mock run (8/8 verified, all instrumentation matched) is
the "before". The fresh run on the changed tree answers: does the git section
appear in mock turns against git fixtures without breaking any instrumentation
check, and does tool-selection stay within the detectors' expectations. Mock
token figures validate ACCOUNTING ONLY.

**A bench-environment decision to record before that run.** `bench/out/` is
inside the lain-v2 repo and gitignored. With the new `-- .` subtree scoping,
a fixture cwd under `bench/out/` sits on an ignored path: the per-turn section
is silently clean in every bench run. That is the correct behavior for the
host repo (the host tree's ~90 dirty files must NOT render into a fixture
session's prompt — that would be per-turn corruption, silent for every bench
turn since none of the fixtures have their own git), but it means **the bench
does not measure the section at all**. Options weighed for #30:

1. Leave the bench silent (the default). The section is measured elsewhere —
   by the gitsnapshot unit tests' seam cases and the real-repo case in
   semantic.test.js — while the bench measures the rows 24/25 candidates'
   request cost (no section rendered = no tokens spent) and everything else
   unchanged.
2. Give fixtures their own `git init` + a baseline commit. This would measure
   the section rendering inside real bench turns, but it changes the fixture
   ENVIRONMENT mid-mission — a truth-machinery-adjacent change ("do not
   modify benchmark truth machinery"), and one that invalidates the mock
   "before" comparison (the "before" tree ran with no fixture git, so the two
   runs would no longer differ by "the row-24 candidates" alone; §17's
   one-meaningful-difference rule would be violated).
3. Force dirty-tree content under `bench/out/`? No — bench/out is the run
   output directory; making it "dirty" from the host repo's perspective would
   require removing the gitignore, which would couple the host repo to the
   bench fixtures.

Decision: option 1 for this mission's #30 run. The unit-tier real-repo case
(semantic.test.js) is the section's correctness measurement, and the bench
still answers the request-cost question (no tokens spent on the section in
either tier). Option 2 is the right follow-up AFTER the mission, run as its
own A/B (its own before run, its own tree state), not as a mid-mission
confounder baked into the #30 comparison.

### Phase 1 baseline — the Lain Probe integration surface, fully mapped

**Label: read-and-traced, NOT a removal.** Task #33, the new brief's §1 rule
(baseline before refactor). Every file the word "probe" touches was read and
sorted into one of four buckets. This section is the Phase-2 removal plan's
input; nothing has been deleted yet (§19's order is map → remove → guard).

**The four buckets, and what each one means for removal:**

1. **GENERIC STATE READS named `probe` — SURVIVE UNTOUCHED.**
   `supervisor.probe()` reads the supervisor binary's file+pid and answers
   `available/why` — a liveness check with no Probe-client logic
   (providerhealth.js, runtimefacts.js, guardian.js all read it;
   tests/smoke/rc.test.js:80 pins it). rust/lain-supervisor jobs.rs's
   "probe" is likewise the supervisor's own cheap liveness check ("the slow
   probe meant the feature silently broken" — line 176/756/771). Neither is
   Lain Probe integration; deleting either would damage the supervisor's
   health surface.

2. **The `computer` DUAL-TRANSPORT FAMILY — SURVIVES VIA THE DESKTOP BRIDGE,
   with one honest degradation already written in code.** tools/index.js:128
   gates `computer` on `probeLive || mcpConfigured`, so with the Probe gone
   the tool remains reachable through the desktop bridge alone. The
   FOCUS/keyboard path already refuses the desktop transport with the
   measured reason (computer.js:420-427: "the desktop bridge cannot verify
   the foreground before each keystroke, and an unverified keystroke goes
   wherever the user is looking") and the channels ledger's fallback ("ask
   the user to press it"). **No new code is needed for the keyboard
   question — the existing refusal IS the post-removal answer.** Files:
   computer.js, keyboarddelivery.js, heldkeys.js, channels.js,
   capability.js (its STAGE vocabulary and desktop-dialect rows — the
   probe-dialect rows 131-156 die), tools/computer.js, uxphases.js,
   tools/visual.js (uses computer's channels/visualReadiness; probes the
   transports generically), ui/panes.js:593 visual readiness rows,
   ui/status.js. The `.FIFTEEN` naming layers its name onto all three
   vocabularies.

3. **PURE PROBE INTEGRATION — DIES (the §0-B removal).** probe.js (the
   connection class: config discovery, python discovery via the reused
   `probe.python` config key, `-m probe` spawn, hello handshake, `_live`,
   mirrorTurn, companion attach), tools/probe.js (the `probe` tool:
   DIALECT.probe operations), probeskill.js (the system-prompt contract
   paragraphs), probefacts.js (`.lain-probe/` survey facts; also the only
   writer to `.lain-probe/`), probecommand.js (`/mcp probe` routing, probe
   revoke), probetask.js (PROBE_TASK_RE), companion.js (the probe-window
   event relay — its only attach site is probecommand.js:208), the
   environment.js PROBE-window state machine (lines 1-268: ENVIRONMENTS,
   PROBE_TOOL_GROUPS, ALWAYS_ALLOWED, BRIDGE_TOOL, enterProbe/enterCli,
   checkToolAllowed, describe, note, _reset — all probe-specific; envdetect.js
   is a separate module re-exported at :284, and the 7 generic consumers
   — contracts.js, survey.js, clifacts.js, prompt.js, briefcommand.js,
   externalrequest.js, ui/contextview.js, tools/tests.js — call only
   detect/summary and are untouched), identify.js:63-75 (the CLI→PROBE
   handoff), mode.js:218 (KIND.PROBE detection), permissions.js:73-285 (the
   probe-scope grants), prompt.js:159-160 (the Probe contract paragraphs),
   promptparts.js:104-106 (probeskill.decorate call), app.js:228 (the
   decorate seam) and app.js:369 (`probe.mirrorTurn`), tools/index.js:119-122
   (the `probeLive || envIsProbe` gate), tools/exec.js:49-56
   (`findPython`'s reuse of `probe.python` — see the decision below),
   survey.js:422 (probefacts gather), turnevents.js:178-230 (the probe actor
   labeling), describe.js:31-71 (probe phrasing), ui/phrasing.js:62-83
   (probe labels), ui/memoryview.js:52 (the `/note fact lain-probe takes
   decimal PIDs` example string — the view is generic; only the example
   string is stale), src/tests/helpers context. The `/mcp` command's probe
   routing (commands.js:278, :298-303) dies with probecommand.

4. **UI PHRASING LABELS — die with their facts.** describe.js:31-71 and
   turnevents.js:178-240's probe rows describe states only the probe
   integration produced; when the states can no longer exist, the rows go
   with them.

**Decisions recorded before Phase 2:**

> **Update 2026-09-07 (Phase 2 COMPLETE — the Probe removal, verified):** the
> bucket-3 files are deleted, every src seam is cut, and the **unit tier ran
> green on the changed tree: 2,094 passed, 0 failed** — including the
> architecture guard ("every source file is reachable from the entry point"),
> which is the §19 closedown check and which **caught two real residues the
> textual sweep had missed**: `numfmt.js` (the probe tool's dual-base number
> rendering — its only consumer was the deleted tool; no live consumer means
> it is Probe-payload presentation, not generic infrastructure, and it is
> deleted) and `tools/browser.js` (a dead file whose registration had already
> gone; pre-deleted by the browser phase that was to come, and counted here).
> What survived per the rulings below: `computer` (bridge-gated now), the
> keyboard family with its refusal, the events bus, `probe.python`,
> `capability.js`'s dialect tables, and the caller-less-but-tested
> keyboarddelivery/capability.preflight contracts. Test restructures:
> inputdelivery.test.js reduced to its transport-agnostic vocabulary core;
> onecomputer.test.js keeps the consolidation assertions and ADDS a negative
> (`probe` is not a tool name, not dispatchable, not on disk) while the four
> redirect/schema tests died with the tool they grepped; observe.test.js's
> `_probe` doubles moved to bridge doubles (the regionOf/NO_TARGET matching
> rules — LAIN-owned, transport-agnostic — are re-pinned; the `vision.ocr`
> region-capture test died as probe-dialect-only, its intent already covered
> by regionOf + the REGIONS-gate refusal test); uxphases PHASE M rewritten
> onto the bridge; capability.test.js's retired-name assertions converted to
> negatives (`describeTarget('probe', …) === ''` — retired names must not be
> special-cased back into existence). Two live UI breakages found and fixed on
> the way: status.js's VERB table and actor gate both tested the retired
> `probe`/`desktop` names and missed `computer`, so every bridge action in
> flight would have drawn as plain RUNNING/TOOL instead of RUNNING MCP/MCP.
> Eleven present-tense Probe misstatements in src comments were reworded;
> historical traces (lifecycle.js, markdown.js, events.js) were kept as
> history. mcp-input.test.js is deleted (its cross-references in
> keyboarddelivery.js/wininput/keyboarddelivery headers now record that the
> transport-path live test died with the transport).

- **`computer` survives** via the desktop bridge, not deleted. §0-B says
  separate generic mechanisms from Probe-specific code; tools/index.js's own
  comment documents that screen/input operations were consolidated across
  three vocabularies (desktop/probe/computer) and that memory/breakpoints/
  findings "genuinely are the Probe's domain". The consolidation survives;
  only the probe transport dies.
- **The keyboard FOCUS path keeps its existing refusal** — no capability is
  invented to replace the Probe's verified-focus sequence. The refusal
  text and the channels fallback ("ask the user to press it") are already
  the correct post-removal behavior, written in the code today.
- **The events bus survives.** companion.js is the only subscriber in src,
  but the bus and every emitter (turnevents.js, tools/jobs.js, tools/visual.js,
  ui/index.js:439) are the named-facts contract — exactly what the future
  Harness (§2 of the brief) will subscribe to. app.js:117's comment already
  names the dashboard as a second subscriber-to-be. Deleting the bus would
  be deleting the mechanism the brief's target architecture needs.
- **`probe.python` config key**: tools/exec.js reads `cfg.probe.python` as
  one of three python-discovery sources. This is a REUSE of a Probe-era key
  as generic python discovery, not Probe integration — the consumer is the
  generic `python_run` tool, and the key keeps working for anyone who
  configured a python for the old Probe. KEPT, with a comment noting the
  history, in line with "do not delete reusable generic infrastructure
  merely because Probe used it".
- **`.lain-probe/` (`.gitignore:6`)**: probefacts.js is the only writer
  (`.lain-probe/` holds the probe's local survey facts). It dies with
  probefacts.js; the gitignore entry goes stale and is removed in Phase 2.
- **Test files (Phase 2 restructure, not blind delete):**
  tests/unit/probeskill.test.js, environment.test.js (the PROBE ROUTING
  cases — note the file also pins envdetect via `require('../../src/
  environment')`; the re-exports keep the file loadable, so the probe cases
  must be cut while the machine-detection cases stay), inputdelivery.test.js,
  keyboarddelivery.test.js (unit tier drives the sequence through a double —
  the keyboard family survives, so the test survives, driving the desktop
  refusal), onecomputer.test.js (half its cases are structural source-grep
  tests of tools/probe.js:52-88 — those die with the probe tool), facts.test.js
  (the `/mcp probe` / probe-live seam cases), companion.test.js (dies with
  companion.js), desktop.test.js (desktop bridge — SURVIVES), tests/live/
  mcp-input.test.js + wininput.test.js (live-tier probe-transport tests —
  die; the live tier already skips when no probe is configured),
  e2e-probe-environment.js (dies), tests/unit/architecture.test.js:343/385 —
  companion.js entries removed from HELPERS/EXTRACTED lists when the file
  goes (the :341 HELPERS list has NO existsSync guard and will throw on a
  missing file, so the entry must be removed, not left).
- **Docs:** README / STATUS.md / docs/ probe references are historical
  records, annotated not rewritten. docs/ui-prototype/workspace.js's probe
  mentions are UI prototype scenery, untouched.

**What this map does NOT yet cover** (recorded as gaps, not silently
skipped): the Rust supervisor's probe side (rust/lain-supervisor/src/remote.rs
is the Telegram bot — separate mission; the supervisor's own liveness probe
is bucket 1 and survives); the `.FIFTEEN` capability naming audit promised by
§14's tool-surface classification; the exact import lines that die with each
bucket-3 file (listed at file level here; Phase 2 lands them per §19's order:
locate registrations → imports → tests → docs → architecture guards).

## The cache forensics pass — the corpus contradicts the standing claim

**Label: corpus-derived, NOT VERIFIED live.** Everything in this section was
extracted from the recorded session JSON (`sessions/20260905-112051-o2pn.json`)
— 765 requests, turn-level usage and per-request audits, every number read
directly, and the seven turns that read cache summed to exactly the session's
total cacheReadTokens (7,538,787). No live experiment has been run; the
correction is to the *diagnosis*, not to any code. Full evidence in
CONTROL-LOOP §2a; the one-line version:

**"Every resumed turn reads cacheReadTokens = 0" is false.** Five of the
seven caching turns WERE resumed turns (t3 78,912; t12 767,936 after a
2h13m gap; t13 628,800; t14 733,184; t19 3,228,643). Dead cache is a
late-session phase change (Sep 5 evening onward, turns 20+), not a resume
property and not a TTL property. Two LAIN-side causes are confirmed from the
corpus: (1) the stable head drifts across turn boundaries (the project
brief's tree listing reacts to the target tree's own mutations, plus
conditional tool availability changing the schemas block); (2) the fold
regime — `_foldOldest` splices at messages[1], so at the message cap every
append re-prices the conversation from index 1, bounding cache at the ~18k
head (t25's only read is exactly head-sized). The fold mechanism is also
**pinned as three WRITTEN unit cases** in `tests/unit/session.test.js` (a fold
replaces the bytes at messages[1]; consecutive folds at the cap keep changing
it; the snap-to-unit-boundary never leaves a dangling tool half — the pair
planted exactly at the computed cut, with `KEEP_RECENT=10` giving
floor=cut=14, the tool answer's index, so the backward snap is genuinely
exercised). NOT RUN — written, not executed; the corpus-derived observation
becomes UNIT-VERIFIED behavior only when the tier runs.
The literal-0 on turns
t23/t24/t26 — ideal stablePrefix shape, constant head, still zero — remains
UNEXPLAINED by anything the session JSON records; per-request model/connection
(reqtrace, sink was off in that run) is the instrument that would catch
route failover, which t24's own transcript (mid-turn omniroute 401/429s)
makes the leading suspect. Also measured: this gateway never reports
cacheCreationTokens on ANY of the 765 requests, including turn 1 —
creation-0 is evidence of nothing.

No code was changed for this. The §5 experiment protocol (live run with
`LAIN_REQTRACE` on + promptCache A/B) needs zero code changes; it is blocked
on the provider bridge (429), reset ~2026-09-12.



## The truncation guard, and the model boundary

### A whole-file write must not be how a file is lost

A 900-line source file in this repository went to 0 bytes. A script opened it
for writing — which truncates — and failed before writing anything. It was
untracked, so there was nothing to restore it from.

The shape is not specific to that script. `write_file` can do it in one call:
replace a substantial file with a fraction of itself, from a reconstruction that
was not complete. `apply_patch` and `edit_file` cannot, because they verify the
exact text they replace.

So `write_file` now **refuses** a write that would collapse a file:

```
TRUNCATION REFUSED - src/main.rs
It is 30000 bytes; this write is 0 (empty).
To change part of it:  apply_patch, or edit_file - both verify the exact text
they replace, so they cannot destroy what they did not see.
If you really do mean to replace it:  write_file with truncate: true.
NOTHING WAS WRITTEN.
```

A refusal, not a warning: a warning arrives after the data is gone. Emptying a
file deliberately is still one call away, and the escape is **advertised in the
schema** — a guard whose way out is undocumented is a guard people work around.

The thresholds are chosen so ordinary work is untouched: a file under 2 KB is
rewritten freely, and so is any write keeping half the file or more. An empty
write over a non-empty file always counts, whatever the size.

### The model boundary: what is real, and what is not

**Real, AND WIRED INTO THE TURN LOOP since the request-admission pass.** The
runtime admits, identifies and closes every model request, and can refuse one:

```
turn.js  → request_begin → allow | refuse (TURN_LOST / ROUTE_SHUT)
         → provider.chat      (never called on refusal)
         → request_end        carrying that attempt's own usage receipt
```

Every retry is its own request lifecycle with its own runtime-issued id, and
the turn does not restart between them. Proved against the real supervisor by
`tests/integration/requestadmission.test.js`: an instrumented provider call
finds the runtime's open request id already landing before the wire; a seeded
ROUTE_SHUT denial records zero wire calls and zero billed requests; and the
parked-question regression that delayed this wiring for a pass is guarded by
its fourth test.

**The parked regression, root-caused — twice, both product fixes.** (1) The
first wiring waited out the supervisor BOOT WINDOW inside admission
(`reachable()`), stalling a turn's first request for up to seconds; a booting
runtime is not a request authority, and `requestBegin` now degrades instantly
when no supervisor is up. (2) The admission await also exposed that a
CANCELLED turn, suspended before the wire, would proceed to call the provider
anyway once cancelled mid-window — it consumed a later test's mock step and
was observed as a job that "asked" and ran to completion. The boundary now
rechecks the abort signal before the wire: a cancelled turn issues nothing
further. The same investigation found the harness defect that made this
intermittent for a whole pass: the mock provider's cursor was per-PROCESS, so
any leaked turn in the in-process tier could steal another conversation's
scripted steps. The cursor is now per-CONVERSATION (keyed by the first user
sentence), which removes the entire class.

Two refusals remain, both things only the runtime knows: a turn whose **owning
process is gone** — which a newly started CLI cannot know from its own memory —
and a route recorded as **shut with a reset still in the future**, which
`availability.js` holds in memory and loses on restart. A limit with **no stated
reset does not refuse**: null is not a clock.

The session carries the open request id, so a stale close cannot clear a live
request, and an open request survives a supervisor restart.

**Not real: the turn loop does not call it.** Wiring `request_begin` into
turn.js reproducibly fails one test — a background job that must park on a
question stays unparked and runs to completion. The investigation is recorded
here rather than lost, because the next attempt should start from it rather than
from the beginning.

### What was ruled out, by measurement

| hypothesis | probe | result |
|---|---|---|
| admission is refusing | logged every refusal through a full suite run | **no refusals** |
| the mock delivers the wrong script step | logged the cursor and step | correct: step 0 is `ask_user`, step 1 follows |
| `ctx.ask` is missing | logged `typeof ctx.ask` at the tool | **it is a function** |
| `AgentJob.askUser` returns early | read it | it always returns a pending promise |
| a leaked turn from an earlier test eats a step | added a settle between tests | **did not fix it** |
| the admission wait costs the turn latency | bounded it at 150ms | did not fix it |
| a close fired for a request that was never issued | `end()` now returns early without an id | did not fix it |

### The decisive asymmetry

A standalone reproduction — same `App({interactive:false})`, same isolated
config and supervisor home, same script, same question text — **parks correctly
at 50ms and stays parked**:

```
ADMIT -> {"allow":true,"requestId":"","reason":"","available":false}
t=50ms   state=RUNNING needsInput=true phase=WAITING_FOR_INPUT
t=800ms  state=RUNNING needsInput=true phase=WAITING_FOR_INPUT
```

The same code inside the suite does not. So the cause is **cross-test state in
the in-process tier**, not the boundary itself: something an earlier test leaves
behind makes the ask tool return without calling `ctx.ask`. The remaining
suspect is the clarification budget in `clarify.js` (`mayAsk` can refuse and
return before `ctx.ask` is reached), but that is per-App and a fresh App is
built per test, so it was not confirmed.

### What was done about it

*(Historical record of the first, failed attempt — kept because the next
failure should start from it.)* The wiring was removed rather than shipped, and
the Node client deleted rather than left unreachable — the architecture guard
for unreachable modules catches that and is right to. The Rust side and its
tests remained, and the boundary is now wired for real (see above), with both
root causes fixed in the product rather than the tests.

### The TURN lifecycle, by contrast, IS now driven by the loop

The coarser half of runtime visibility does not touch the request boundary and
is wired for real: `turn.js` announces every turn to the Guardian with the pid
that owns it (`guardian.turn_begin` — the only evidence `effective` in
guardian.rs accepts that a dead process can never finish the turn), and
`turnclose.close` — the one accounting point every ending already passes
through — reports the ending (`guardian_turn_end`) plus the turn's final usage
receipt, the only note that carries output tokens. Without the ending call the
runtime's handover boundary could never close: guardian.rs holds a session in
needs-handover until it sees a `turn_end` that nothing used to send.

The stop reason crosses as a WORD MAP, not a judgement: turnrecord says `end`
and `rate-limited`, the runtime's contract says `completed` and `rate_limited`,
and every other stop reason is already the runtime's word and passes through
unread. Passing `end` through unread would have filed every finished turn as
PROVIDER_FAILED — caught by reading guardian.rs's `turn_end` match before the
first run, and proved against the real supervisor by
`GUARDIAN: a REAL turn announces itself and its ending` in
tests/integration/guardian.test.js.

## `.lain/` — the project is remembered between sessions

### The objection this had to answer first

`codemodel.js` refuses to keep a store, and says why:

> NO STORE. V1's `.lain/index.json` was rebuilt at startup and then aged with
> every edit LAIN made, so it answered confidently from stale data for the rest
> of the session.

That is worse than having no index, because a confident wrong answer costs more
than no answer. So the rule here is not "cache harder":

> **The index is never read without checking the disk first.**

Every query goes through `fresh()`, which stats the tree and re-scans anything
whose size or mtime moved. There is **no accessor that returns what was written
last time**, so answering from a stale entry is not unlikely — it is unreachable.
The test that would catch that regressing edits a file behind LAIN's back and
asserts the old symbol is gone.

### Measured on this repository

```
cold build     510ms   525 files indexed, 22,791 declarations
warm pass       27ms   525 reused, 0 re-read
after 1 edit    46ms   524 reused, 1 re-read
index on disk  1.5 MB
```

**19× faster warm than cold**, and the file that changed is the file that is
re-read.

### What it holds, and what it must not

Per file: size, mtime, language, declared symbols, import specifiers. Enough for
"where is X", "what does this file define", "who imports this".

**Not** file contents, not the conversation, not anything a model said. It is
machine state about the project, and it is **never sent to a model wholesale** —
a caller asks it a question. Shipping the 1.5 MB index into a prompt would
recreate the cost it exists to remove.

### `understand` — orientation for 173 tokens

A model opening an unfamiliar tree reads the README, lists directories, greps for
an entry point and opens files: four or more requests at ~65,000 input tokens
each. `understand` returns a **623-character projection** — counts, the modules
with the most declarations, what changed since last time — for one stat pass.

It is a summary, not the store, and a test asserts it stays under 4,000
characters and never leaks raw index fields.

### Degradation, stated rather than hidden

* A **corrupt** or **older-version** index is rebuilt, never half-trusted.
* A **read-only** project still answers — it pays the scan each time and the
  reply says the index could not be kept.
* The fingerprint is **size + mtime**. A same-length rewrite inside one clock
  tick, or a deliberate timestamp forgery, is invisible to it. That is what
  `stat` gives cheaply, and it is written down rather than glossed.
* Symbols come from `codemodel`, so coverage is what `jsscan` supports.
  Other languages are recorded by identity alone.

`.lain/` is in `.gitignore`: a committed index would be a merge conflict on every
commit.

### Two state domains, and Rust owns the synchronisation

The index alone can say "nothing moved since the last stat". It cannot say
"unchanged since you last opened this project" — that is a fact about history,
and the process holding it has to outlive the CLI that computed it. So the split
is:

```
~/.lain-v2/supervisor/projects/    identity, and when the runtime last
                                   synchronised a tree. Counts and a digest.
<project>/.lain/                   the materialised index: symbols, imports,
                                   fingerprints, per file.
```

**Neither is a copy of the other.** The runtime holds no symbol table; the
project holds no record of which machines have opened it. A test reads the
runtime's record back and asserts that the words `alpha`, `beta`, `mtime`,
`imports` and `src/a.js` appear nowhere in it — a symbol table there would be a
second authority for the same truth.

The flow, with the decision in the runtime:

```
worker stats the tree      -> digest
     |
Rust project_open(digest)  -> NEW | UNCHANGED | MODIFIED | RESHAPED
     |
worker updates .lain incrementally
     |
Rust project_synced(digest, counts)
```

`projects.rs` **never reads the project** — not one file, not one `stat`. It is
told what a worker found and it remembers. Deciding what changed belongs to the
worker, because the worker is the thing holding the tree open.

**Nothing is called UNCHANGED without evidence.** A caller that passes no digest
gets `MODIFIED`, never `UNCHANGED` — the same refusal `reset_at: null` makes in
providers.rs.

Verified against a real supervisor: a project is NEW once, then UNCHANGED, then
MODIFIED after one edit; the verdict survives a **supervisor restart**; two
projects keep independent state; deleting `.lain` rebuilds the index while the
runtime still recognises the tree; and with no supervisor running it still
indexes and reports `UNKNOWN` rather than inventing a history.

### It made `locate` cheaper too

`locate` used to walk the tree twice — once for references, once for importers.
Importers now come from the index, so it walks once. When there is no index, or
it holds nothing for that path, the walk still happens: the helper returns
**null** rather than an empty list, because an empty list is the claim "nothing
imports this" and a missing index is not that claim.

### The layer rides the handover packet

A handover built from the session alone carries one process's memory. Since the
durable layer landed, `handover.build` also carries the project's: the
reconciler's alarms (intent vs disk, re-measured at the moment of the packet),
the architecture branch the changed files sit inside — each as a named
component with its purpose, not as bytes — the vocabulary those components were
defined with, their recorded wiring, the dead turn's scratch findings, and the
promoted facts with the evidence that established them. Every section is
optional and skipped silently when its slot is empty, so a project with no
`.lain/` produces exactly the packet it produced before. Proved by the three
`.lain` tests in tests/unit/handover.test.js, including §24's recovery case:
delete the implementation, and the packet says MISSING in the reconciler's
words while guaranteeing the intent survived in `.lain/`.

## The model stops being the project explorer

The token incident had a second half. The first was composition — 14,778 fixed
tokens plus a 50,000-token conversation on every request. The second is **how
many requests one question costs**.

### Four hops for four facts

Asked to change one function, the model could only do this, and every arrow is a
full request:

```
symbols("saveSettings")        where is it?
      |
read_symbol("saveSettings")    what does it do?
      |
dependents("src/settings.js")  what breaks if I change it?
      |
read_file(...)                 ...and what did that caller look like?
```

The model was not being wasteful. Nothing composed those, so it had to chain
them, and each hop re-sends the whole context.

### `locate` — one call, one walk

`src/locate.js` answers all four together. It is not a new index and not a new
subsystem: it uses the same `search.walk` traversal, the same definition
classification `symbols` uses, the same import matching `dependents` uses, and
`codemodel` for the body. It also costs **one** tree traversal where asking
`symbols` and `dependents` separately costs two.

Measured on this repository, for "where is buildWire and what breaks if I change
it":

| | old chain | `locate` | change |
|---|---|---|---|
| model round trips | 3 | 1 | **-67%** |
| tool result tokens | 538 | 438 | -19% |
| tree traversals | 2 | 1 | |
| input tokens spent | 44,872 | 15,216 | **-66%** |

The input figure counts only the 14,778-token floor each request carries. A real
request also carries the conversation, so at the observed ~65,000 per request the
same lookup goes from ~195,000 tokens to ~65,000.

References are **counted per file**, not listed line by line — "3 uses in
settingspane.js" is what a decision is made with, and the forty individual lines
behind it are what made the old answer expensive without making it better.

**It is a cheapest-sufficient-evidence step, not a wall.** Every cap is reported
when it bites (`[N more]`, `read_symbol X for the whole definition`) and the
ordinary tools remain. And it says on every answer that it is lexical: it cannot
tell two things with the same name apart, follow an alias or a re-export, and it
counts a mention in a comment as a use.

## Diagnostics before the suite, not after it

A suite run is minutes. A typo is microseconds. The order was the wrong way
round: edit, run the suite, wait, read a stack trace, and discover

```
NameError: name 'pirnt' is not defined
```

which a linter names in eight milliseconds. The cost is not only the minutes —
it is the model request that reads the failure, at ~65,000 input tokens, to learn
something already knowable.

`src/pretest.js` runs in front of `run_tests`, over **only the files this session
changed** (from the checkpoint ledger `/changes` and `/undo` already read), using
the same ladder the edit path uses:

```
rung 1  does it parse            no tooling required, works everywhere
rung 3  the project's own linter ruff / pyflakes / eslint, if installed
```

Rung 1 matters more than it looks: this machine has neither `ruff` nor
`pyflakes`, so a gate built only on rung 3 would have been **silently inert
exactly where it was most needed**.

**A clean check is never treated as proof the code works.** When nothing is
found the suite runs exactly as before; the gate returns no `passed`, no `ok`,
nothing a caller could mistake for a test result. A linter can prove a file is
broken and cannot prove it works, and the asymmetry is the whole design.

**It is a gate that opens.** `force: true` runs the suite anyway and the refusal
names it. A pre-existing error in a file touched for an unrelated reason would
otherwise make the tests unreachable, and a guard that can trap you is one people
learn to route around.

## The token incident — why 66,000 tokens bought a 36-token decision

Reported: **815 requests, 59,243,462 input, 202,310 output, 24.5% cached**, with
individual requests of ~66,000 input against 36 output. Output was **0.34%** of
everything spent.

### What a request was made of, measured on this repository

```
system prompt (prompt.build)      12,614 chars   ~3,504 tokens
project brief                      3,402 chars     ~945 tokens
tool schemas (45 tools)           37,186 chars  ~10,329 tokens
──────────────────────────────────────────────────────────────
fixed, on every request                         ~14,778 tokens
conversation budget                              50,000 tokens
                                                ──────────────
predicted steady state                          ~64,778 tokens
```

Observed band: **62,716 – 66,481**. The prediction lands inside it, so the
composition is not in doubt.

**22.8% of every request was spent before one word of conversation**, and
**15.9% was tool schemas** — 45 of them, most irrelevant to any given turn.

### The mechanism: it is the ramp, not one big request

A 40-step tool loop, measured through the real `contextfit` path:

```
step  5   21,664 tokens
step 10   30,233
step 20   47,374
step 30   64,516     <- then compaction fires, once
step 31   32,793
```

Every step re-sends the whole accumulated transcript. The reported 62–66K
requests are the top of that ramp. One 30-step turn costs ~1.19M input tokens,
and no single request in it is unreasonable.

### Two hypotheses that measurement killed

**"Compaction is thrashing the cache."** It fires **once in 40 requests**, not
every step. Wrong.

**"Lower the 50,000-token budget."** Swept it, and the result reverses the
intuition — because a shared prefix is cheap and compaction rewrites it:

| budget | total input | peak | **billed (uncached)** | shared prefix |
|---|---|---|---|---|
| 50,000 | 1,530,740 | 64,411 | **494,473** | 64.1% |
| 24,000 | 1,201,580 | 38,792 | **508,328** | 56.3% |
| 14,000 | 1,037,001 | 29,340 | **570,289** | 44.8% |
| 8,000 | 877,166 | 23,324 | **639,929** | 27.6% |

Lowering the budget cuts total tokens by 43% and **raises the bill by 29%**. The
existing 50,000 is close to optimal for the number actually paid. It was left
alone.

### The defect that was real: volatile state in front of the cache

`app.systemPrompt()` returned one string, and that string was `messages[0]`:

```
BASE instructions           identical for the life of the install
working directory, OS       identical for the life of the session
mode guidance               CHANGES EVERY TURN
working context / handover  CHANGES EVERY TURN
project brief               identical for the life of the session
plan digest                 CHANGES AS STEPS COMPLETE
```

A prefix cache keeps the longest identical **head**. Volatile text at position
three means the entire conversation behind it — up to 50,000 tokens that did not
change at all — sits behind a byte that did. Every turn boundary re-priced the
whole request, which is what a 24.5% cache rate looks like from the outside.

### The fix

`prompt.build({ separate: true })` returns the two halves; `promptparts.js`
assembles them; `contextfit.buildWire` puts the changing half at the **tail** of
the wire, after the conversation, where a change costs only itself.

Measured on a five-turn, eight-step workload:

```
                   TODAY        FIXED      change
total input      1,273,765   1,273,981      0.0%
BILLED uncached    519,633     461,245    -11.2%
cache hit rate       59.2%       63.8%
```

**Total input is unchanged to within rounding — it is the same information, in
the same words.** Rejoining the halves reproduces the original prompt byte for
byte, and a test asserts exactly that. This is an ordering change and nothing
else, which is why it carries no risk of making LAIN dumber.

Proven on the real path, two real turns through the real App:

```
#1  msgs 3  ~3,693 tok   messages[0] ~3,578 tok   tail _live=true
#2  msgs 5  ~4,037 tok   head shared 89.3%        tail _live=true
messages[0] identical across all requests: true
```

The volatile block is a **user** turn, never `system`: `provider.js` hoists every
system message into Anthropic's cached block, which would put the changing text
straight back into the prefix this exists to protect. `toAnthropic` now merges it
into a preceding tool-result turn so two user turns never arrive in a row.

### The token pane, and the two tabs that were not removed

`9 tokens` is a new pane, reached by Alt+9 or Tab. Every figure on it carries
where it came from, because the four are not interchangeable:

```
MEASURED    a provider said so, in a usage block on the wire
ESTIMATED   LAIN counted characters in the array it transmitted
PENDING     a request is open and this figure exists only when it closes
UNKNOWN     this route has never reported this quantity at all
```

Output reads **PENDING** during every request on every provider LAIN speaks to —
Anthropic states it in `message_delta` at the end, the OpenAI shape in the final
chunk — so a rising output count would be a drawn guess. A cache nobody reported
reads **unknown**, never `0`. Nothing on the pane animates: two renders of the
same state are byte-identical, and a test asserts it.

Fed the reported incident, the pane says:

```
input : output    293 : 1
average input     72.7K
cache hit rate    24.5%
```

That ratio is the fact nobody could see while it was happening.

**MEMORY and DETAIL were inspected and kept.** The instruction was to remove them
*if* they were redundant. They are not: MEMORY is the only view of what `/note`
recorded — decisions, source-of-truth, limitations — which survives compaction
and restart and is the only place that reasoning lives; DETAIL carries the rows
behind CONTEXT's counts, and `contextview.js` is explicit that only DETAIL
carries them. Deleting either would have destroyed the sole copy of something.
So the pane count went from eight to nine.

### `/mouse` — the terminal gets its selection back

LAIN turns on `?1002h` so the prompt has a caret you can click and tabs you can
press. That takes the terminal's own drag-selection, and the standing advice —
hold Shift — is true in Windows Terminal, iTerm2 and GNOME Terminal and **false**
in the legacy Windows console and several multiplexer setups. For anyone on
those, `/help` described something that does not happen and there was no way to
turn it off.

It is a preference now. `/mouse off` restores native selection and copy exactly
as they behave without LAIN; the clickable caret and the feed's click targets go
with it, and the trade is stated on screen rather than hidden. `/mouse` toggles, `/mouse on`
restores. `/copy` is unaffected and still copies what LAIN knows rather than
what happens to be on screen.

### What is NOT fixed

* **Rust does not own the LLM request path.** `provider.js` builds the payload
  and calls `fetch` directly; the runtime receives observations only. This is a
  real ownership gap and it is stated rather than papered over.
* **Tool schemas are still 10,329 tokens on every request.** Gating them by
  relevance risks removing a capability the model needed, and that trade was not
  made blind.
* **No live-provider before/after.** Every figure above is measured through the
  real code path with a deterministic workload; none of it is a provider bill.

## Remote control — Telegram carries, a local model speaks, the runtime decides

> **Update 2026-09-07 (Phase 2):** the CLI-side surface of this — the `/rc`
> command (rccommand.js, the Telegram setup flow, the token/brain adapters) and
> the 2-second watcher (remotewatch.js, which polled queued intents and applied
> stops/model switches) — was **removed from LAIN CLI** per the stabilization
> brief. What survived, unchanged: the supervisor binary and its capability
> wire (remotecontrol.js), `/session` as the terminal window onto it, the held
> queue + `inputgate.drainQueued` door (a queued continuation still runs through
> the SAME recovery — the test that proves it now drives `drainQueued`
> directly), and `guardian.stopClear` (the runtime-side API the Harness that
> inherits remote control will call). The sections below describe the
> architecture as built, which is the architecture the supervisor still
> implements; only the CLI's own presentation/control surface is gone.

The third boundary of the migration, and the first to put a surface OUTSIDE this
machine in front of the runtime. It is deliberately not "LAIN on your phone":
there is one runtime, and this is a window onto it.

```
        TELEGRAM              transport. Bytes in, bytes out. Owns no state.
            |
            v
        LOCAL MODEL           the voice. English -> a capability NAME.
            |                 Facts -> English. Runs on this machine.
            v
        CAPABILITY            the authority. A closed list of 13, validated,
            |                 executed against the stores.
            v
        GUARDIAN / JOBS / PROVIDERS
```

### What each layer may do, and what it cannot

| | may | may not |
|---|---|---|
| Telegram | carry text | know what a session is |
| local model | name one capability, phrase one answer | call anything, invent a number |
| capability | read the stores, record an intention | run a turn, touch a file, spawn a process |
| Guardian | everything it already owned | be overruled by either of the above |

**The local model is not trusted, and the design says so twice.** It sits between
an untrusted message and the runtime, so it inherits the untrust. It cannot call
a function — it names one, and `capability::run` looks the name up in a closed
list. And it cannot make up a figure: `brain::unsupported_numbers` checks every
number in its answer against the facts the runtime produced, and an answer
carrying a percentage the runtime never stated is **discarded** in favour of the
authoritative text, with the reason shown. A prompt that says "do not invent" is
a hope; this is a check, and it is tested with a model that invents `61%` and
`2629 tests`.

### The capability vocabulary

Nine reads and four controls. There is no passthrough, no eval, and no name in
the list whose verb is `exec`, `run`, `read`, `write` or `delete` — a test
asserts that by splitting each name and checking both halves.

```
runtime.status      session.list        session.get         provider.list
provider.get        job.list            job.get             token.current
diagnostic.list
session.continue    session.stop        session.model_switch    job.stop
```

The four controls **record an intention and act on nothing**. Running a model
turn needs the transcript, the tools, the credentials and the abort controller,
and all four live in the CLI — so the runtime writes down what was asked and
the CLI-side door honours it when nothing is in flight (`inputgate.drainQueued`,
since the /rc-era watcher was removed in 2026-09; see the note above).
Reporting "stopped" for a
turn this process cannot reach would be inventing a success.

### One continuation, two doors

A `/continue` from a phone does **not** get a second implementation. It lands in
the same `held` queue a locally refused sentence lands in, and the CLI drains it
through the same `inputgate.recover` — same refresh of what the runtime
observed, same take, same packet. Proved end to end: the queued intent runs as
`sameTask` with a `RATE_LIMITED` briefing attached, and a second tick runs
nothing.

That test found a real inconsistency: `turn_end` wrote a bare reason
(`the route was limited`) while `offer` wrote `RATE_LIMITED: the route was
limited`, and the recovery reached through the remote door read the field with
no kind on it and fell back to "the runtime is recovering". Both producers now
write the same shape.

### Progress, and the refusal to invent it

`Progress` in guardian.rs **cannot be constructed without a `source`** — a row
that loses its provenance is discarded rather than shown. The only counter LAIN
actually has is the plan: steps a model wrote down and then marked done. A turn
with no plan reports the activity and an **empty source**, which clears any
stale figure rather than leaving yesterday's 80% on somebody's phone.

```
Counted        60% (3 of 5 steps, counted by plan)
Uncounted      not counted — no plan, test run or worker has reported one
```

`Verified` is the only thing in the runtime that means "done" the way a person
means it, and it comes from one place: `testing.counts()` parsing a runner's own
summary in the shell tool. `seen` is the guard — a build log with the word
"passed" in it reports nothing.

### Session, turn, worker, process — four things

`Status` (session) is a separate vocabulary from `TurnState` (turn), because a
session whose last turn COMPLETED is not a finished project and a session whose
owner pid is gone is not merely idle.

```
RUNNING  RATE_LIMITED  FAILED  BLOCKED  WAITING  INTERRUPTED  COMPLETED  IDLE  UNKNOWN
```

`COMPLETED` is the weakest claim in the list on purpose: it means the last turn
finished. Anything stronger lives in `verified`.

### Where the credential lives, and where it cannot appear

`~/.lain-v2/supervisor/remote/telegram.json`, owner-only where the platform has
a concept of it. `Remote::snapshot` is the only projection and **cannot** carry
it — no flag, no debug mode. It is absent from: session files, the transcript,
prompts, handover packets, the evidence ledger, `config.json`, the event log
(which records the bot's public username), curl's argv (the request is written to
`curl --config -` on **stdin**, so the command line is `curl --config -` on every
call), and every error message (`http::scrub` runs on all returned text).

The local model's endpoint and model name **are** shown — a person must be able
to see which model is answering for them — and its key is held to the same rule
as the bot token.

### Honest limitations

* **TLS is borrowed from `curl`.** This crate has no dependencies and writing a
  TLS client by hand would be the worst decision in the repository. `curl`
  missing is a reported `UNAVAILABLE` state, never a silent failure.
* **The CLI polls for remote intentions** every 2s while a bot is configured, and
  not at all otherwise — *(the /rc-era watcher that did this polling was removed
  from LAIN CLI in 2026-09 along with /rc; the runtime side still records the
  intentions and the drain door still honours them, so the limitation describes
  the architecture as built.)* A push would need the runtime to hold a connection to
  every attached CLI and know when one died — the problem owner-pid exists to
  avoid.
* **The remote voice must be local.** A hosted endpoint is refused, because a
  chat message is untrusted text and forwarding it to a third party is not
  something a user could notice.
* **No live provider tier was run.** Nothing here is LIVE PROVIDER VERIFIED.
* **`/rc` used to mean readiness.** That report is now `/ready`, same engine,
  same output.

## The Guardian — runtime authority leaves the Node process

The second boundary of the migration to change **ownership** rather than add a
layer, and the first to take something away from the process that dies.

### The measurement

A turn dies — the provider 502s, a limit lands, the socket goes away, or the
Node process is killed. The person watching types `continue`. Node had nothing
to consult, so it sent the literal word `continue`, and the model that answered
next received one word with no antecedent. It did the only sane thing: re-read
the README, re-listed the tree, re-opened the files the dead model had already
read, and rebuilt by hand a picture that was on disk the whole time.

`continue` is INTENT. It is not context. Nothing in Node was in a position to
know the difference, because the thing that knew the turn had died was the turn,
and the turn was gone.

### A. Authority map, before → after

| Subsystem | Old authority | New authority | Why it moved | Compatibility seam |
| --- | --- | --- | --- | --- |
| may this input be sent | nothing asked | **Rust** `guardian.rs::offer` | only a process outside the turn can know the turn died | `src/inputgate.js`; with no supervisor it delivers, exactly as before |
| turn state | `app.abort`, a boolean on an object that dies with the process | **Rust** `TurnState` | a killed process writes no ending, so the session file describes a turn still in flight | `turnauthority.js` translates `record.stopReason`; nothing else changed |
| undelivered user input | `app.steerQueue`, an array in memory | **Rust**, on disk before the caller is answered | the process that lost the turn lost the sentence | `steerQueue` untouched, and still owns *in-turn* steers |
| model-boundary detection | inferred from `session.turns` | **Rust** `turn_begin`, by comparison | a failover inside `provider.js` is a model change nobody types | `handover.build` gained one optional `runtime` argument |
| when a boundary is CLOSED | Node read the record it had just produced | **Rust** `turn_end` | a completed turn is the evidence, and Node was a second party owning a flag it did not hold | none needed — the call disappeared |
| token accounting | `session.usage`, per process | **Rust** mirror + `session.usage` | a client that is not this terminal needs the same figure | `turnclose.js` unchanged; the Rust copy is additive |
| runtime event stream | job events only | **Rust** `guardian/events.jsonl`, beside `events.jsonl` | "what happened while nobody was reasoning" was answerable for jobs and nothing else | `runtimefeed.js` merges both behind one cursor |
| background workers | already Rust | unchanged | — | — |
| provider health | already Rust | unchanged | — | — |
| process liveness | `tasklist`, **≈3,000 ms/call** | **kernel32 `OpenProcess`**, **≈0.06 ms** | it sits on the input gateway, which answers a keystroke | same `alive(pid)` signature |
| rendering | Node | **Node — deliberately unchanged** | state authority and rendering adapter are different jobs | the strip reads a projection, as it always did |

**If Node dies now, what truth is lost?** The transcript, and in-turn steers.
Everything else — which turn was running and under which pid, what was typed and
not delivered, that a model changed, what it has all cost, which routes are shut,
which workers are alive — is in a process that is still running.

### B. Input lifecycle: the model dies and the user types `continue`

```
"continue"
   │
   ▼  repl.js — turnActive? no. queued.
app.handle
   │  answerPending? no.   looksLikeCommand? no.
   ▼
inputgate.admit ──► guardian.offer ──► [socket] ──► guardian.rs::offer
                                                        │
                                    effective state: PROVIDER_FAILED
                                    (or TURN_LOST — the recorded pid is gone)
                                                        │
                                     the text is WRITTEN TO DISK, then
                                    ◄─── { deliver: false, reason }
   │
   ├─ 1. SAYS SO   "held — the last turn did not finish. Recovering with what
   │                LAIN observed rather than sending that on its own."
   ├─ 2. LOOKS     runtimefacts.refresh — supervised jobs, closed routes.
   │               The only awaited refresh in LAIN; bounded at 2s.
   ├─ 3. TAKES     guardian.deliver — every held sentence, oldest first,
   │               keepHandover: true (the packet does not exist yet)
   └─ 4. SENDS     app.submit(intent, { sameTask: true, from: 'handover' })
                     └─ systemPrompt → prompt.build({ runtime }) → handover.build
```

The replacement model receives the person's own word as the message, and a
packet as its system prompt. Measured on a realistic session it is **1,311
characters — about 330 tokens** — and it opens

> LAIN's runtime stopped this message reaching the model directly: the previous
> turn did not finish — the provider stopped answering. The work up to this
> point was done by claude-opus-5.

and closes

> The user typed this while the runtime could not deliver it:
> - "continue"
>
> This is the INTENT of the request you are answering — it is not the context
> for it. The context is everything above.

Between them: the objective, the user's later corrections, what is on disk **now**
measured against the checkpoints, what the previous model only *claimed*, which
files have already been read, which workers are alive, and which routes are shut
and until when.

**Not held:** commands (`/models` must answer while a route is shut, `/resume` is
how a person recovers by hand), an answer to an open question, and a turn the
user cancelled themselves — `TurnState::needs_handover` excludes `Cancelled` on
purpose, because briefing somebody on their own Ctrl+C spends a request telling
them what they already know.

### C. Output lifecycle

`turn.js` already computed a phase before every provider call and every tool, and
threw it away. It now also reaches the Guardian — no request, no token, one more
listener on a callback that already existed:

```
provider stream ─► turn.js ─► app.notePhase ─┬─► ui.setPhase        the screen
                                             ├─► jobs.primary       /jobs
                                             └─► guardian.turnPhase survives the process

turn ends ──────► turnauthority.end ─────────► guardian.turnEnd
                    stopReason, passed through unread:
                      end → completed · rate-limited → rate_limited
                      aborted / provider / max-steps / no-credential → as-is

usage ──────────► provider.js  `usage`      ─► record.usage   accumulated
                               `usage_live` ─► ui.liveUsage + guardian  replaced
```

The Guardian does not read prose, classify text, or decide what a turn meant. It
validates transport and lifetime; the model still owns every conclusion.

### D. Diagnostics — the backends actually connected

Three rungs, each cheaper than the next, all on the edit path:

| Rung | Backend | Answers | Status |
| --- | --- | --- | --- |
| 1 | `vm.Script` / `node --check` / `python ast.parse` / JSON | does it parse | already existed |
| 2 | `codemodel.js` + `typos.js` | does every name resolve — **JavaScript only** | already existed |
| 3 | **`ruff check --output-format=json`**, else **`python -m pyflakes`**; **`eslint --format json`** when the project has a config *and* a local binary | the project's own rules, one file | **new** |

Rung 3 closes exactly the gap in §7's example. `pirnt("hello")` in Python
**parses**, and rung 2 does not read Python, so it used to reach the model as a
clean write and be discovered by running the program — a suite, a stack trace, a
NameError, and a turn spent working backwards to a typo. Verified directly:

```
$ printf 'pirnt("hello")\n' > t.py
{"tool":"pyflakes","rows":[{"line":1,"column":1,"message":"undefined name 'pirnt'"}]}
PYFLAKES — the file was written; pyflakes reports:
  t.py:1:1  undefined name 'pirnt'
```

and a correct file returns `""`.

**Deliberately NOT connected:** `tsc --noEmit`, `cargo check`, `go vet`. All three
are stronger and all three are whole-project; hanging them off every write would
make editing a large repository unusable. They stay in `toolchain.js`, where a
person asks for them. **This is not VS Code-level analysis** — there is no type
checking on the edit path, and saying otherwise would be the false confidence
`diagnostics.js` was built to avoid.

Refusals that make it usable: a language with no fast tool is `inconclusive`,
never clean; an absent linter module is not a finding; a timeout is not a pass;
warnings are dropped, only errors reported.

### E. Token telemetry — live, completion-only, estimated, unavailable

| Figure | Availability | Drawn as |
| --- | --- | --- |
| input tokens, open request | **LIVE** on Anthropic — `message_start`, before any output exists | `+18K` |
| input tokens, open request | **completion-only** on OpenAI-compatible routes, where most gateways state usage in the final chunk | `+…` |
| output tokens | **completion-only, every provider LAIN speaks to** | `↓1.2K`, always a total |
| cache reads / creation | with the input side, same rules | `⚡31K` |
| session totals | after each request | `↑42K ⚡31K ↓1.2K` |
| **estimated** | *nothing* | — |

Nothing is interpolated. The wire carries `output_is_live: false` so no renderer
can infer otherwise, and `+…` means "a request is open and its cost is not known
yet", which is a different fact from `+0`.

### F. UI — what replaced the duplicate progress

There were **two progress bars for one measurement**: the task banner drew
`STEP 3/5 ████░░ 60%` at the top, and the status strip drew the same thing in
its right-hand column, one row above the caret.

- the **banner keeps it** — progress belongs beside the objective it measures,
  and it moves on the scale of minutes;
- the **strip** carries the telemetry in E — the thing that moves every second,
  and the question the banner cannot answer;
- below 56 columns the strip **sheds** the accounting rather than abbreviating
  it, because the live row's job is to prove LAIN is alive.

Guarded both ways in `tests/unit/uxphases.test.js`: the strip must **not** contain
`STEP n/m` or a bar, and the banner must.

### G. Telegram readiness — the boundary, and nothing else

`src/runtimefeed.js` is the client boundary. `state()` is what a surface renders
when it opens; `since(seq)` is the whole resume protocol (one cursor, merged
across both event logs); `headline(event)` is one line a person can read;
`needsAttention(state)` is the single question a notifier asks.

It is **read-only, and that is asserted** — a test fails if `send`, `cancel`,
`continue`, `run` or `write` ever appear on it. A surface reachable from outside
the machine should be able to say what is happening before it can make anything
happen.

**No Telegram adapter exists, none is configured, and no token has been asked
for.** The first client of this boundary is `/runtime`, in this terminal, because
a boundary with no caller is a boundary that is wrong in ways nobody has noticed.

### H. Long-running workers

`jobs.rs` is unchanged: start time, deadline, pid, log location, exit status and
the event stream, with `JOB_DEADLINE_REACHED` saying the *window* ended and never
that the *work* did — asserted separately in `tests/unit/runtimefeed.test.js`.

What is new is that the same is now true of the **conversation** beside them. A
model failing, Node dying, or a model switching no longer loses the fact that
work was in flight, or the sentence the person typed at it — proved against a
really killed process in `tests/integration/guardian.test.js`.

### I. Tests

| Tier | Result |
| --- | --- |
| Rust (`cargo test`) | **55 passed / 0 failed** — 17 of them in `guardian.rs`, 2 new in `jobs.rs` |
| unit | **2,041 passed / 0 failed** (49.5s) |
| integration | **91 passed / 0 failed** (56.5s) — 14 new, against a real supervisor and a really killed process |
| smoke (spawns the real binary) | **523 passed / 0 failed** (2,183s) — 4 new, including `continue` after a dead turn driven through the real CLI |
| live provider | **NOT EXERCISED in this pass** |

New files: `rust/.../guardian.rs`, `src/guardian.js`, `src/inputgate.js`,
`src/turnauthority.js`, `src/runtimefacts.js`, `src/runtimefeed.js`,
`src/runtimecommand.js`, `src/filecheck.js`, `src/projectcache.js`.

### Three defects found by building this, not by reading it

1. **Requests over separate sockets are not ordered.** `turn_end` then
   `turn_begin` arrived reversed about one run in three, recording a failure on
   top of a turn that had just started. A session's calls are now one ordered
   stream — `ordered()` in `src/guardian.js`.
2. **`tasklist` costs ~3 seconds.** Every gateway question timed out, and a
   timed-out gateway *delivers* — so the feature silently did not work while its
   own tests were green. Raising the timeout would have hidden it; `alive()` is
   now one `OpenProcess` call.
3. **End of input was treated as an event, not a state.** `repl.js` cancelled a
   question that was already open when stdin closed, and could not cancel one
   asked a moment later. Adding an await in front of `submit` moved every piped
   run into that window and LAIN hung on an open panel. `UI.askUser` now checks
   the state.

And one about this suite: a failing test left its detached supervisor running.
One afternoon of iterating produced **354 orphaned processes**, which between
them held the debug binary open and made `cargo build` fail with "Access is
denied" — a build failure with no visible connection to its cause. The shutdown
moved into a `finally`.

### J. Known limitations

1. **No Telegram, no WhatsApp, no dashboard rewrite.** The boundary exists and
   has one caller; no adapter has been written or tested.
2. **No type checking on the edit path**, by choice — see D.
3. **Rung 3 needs a linter the project already has.** With neither `ruff` nor
   `pyflakes` present, Python gets the parse check and nothing more, and the test
   covering it declares a skip rather than passing quietly.
4. **The first turn of a session on a machine with no running supervisor is
   partially unprotected.** `wake()` starts one when a turn begins and it takes
   about a second; observations made inside that window now wait for it
   (`reachable()`, 3s), but a failure *and* a `continue` both landing inside it
   can still slip through. Every later turn is covered.
5. **`session.messages` is still Node's.** The transcript dies with the process.
   The packet is built from records that do not, which is the design — but a
   transcript is genuinely lost.
6. **In-turn steers still live in `app.steerQueue`.** Only input the runtime
   *refused to deliver* is durable; a steer queued against a healthy running turn
   is still in memory.
7. **The saving is argued, not measured.** §24 asks for before/after token counts
   on representative workflows. What is measured is the recovery's COST (≈330
   tokens) and the runtime's own cost (0.75 ms per call). What a bare `continue`
   would have cost in rediscovery needs a live provider and was not run.
8. **The live tier was not exercised.** Nothing here is LIVE PROVIDER VERIFIED.


## Provider health moves behind the Rust runtime

The first boundary of the runtime migration to actually change ownership rather
than add a layer. Nothing was translated from JavaScript to Rust; one class of
fact was moved to the process that is still running when LAIN is not.

### The measurement

`availability.js` kept everything it knew in a `Map` on the App object, under a
comment stating this was by design because "a restart legitimately knows
nothing". That is correct about a circuit breaker and wrong about the thing that
costs a user their afternoon. Measured live against a real router: `retry in 4
hours`. Restart LAIN five minutes later and the number is gone —

- the next turn calls the closed route and is refused, buying the same fact
  twice;
- the model picker, the one screen where "which of these can I use right now" is
  asked, shows the shut door as **not tried yet**;
- and nothing in a handover can tell a replacement model which road not to take,
  which matters most because a rate limit is one of the commonest *causes* of a
  handover.

### What moved, and what deliberately did not

The two halves of provider health have different lifetimes and had been sharing
one because they share a record.

| Fact | Lifetime | Owner now | Adopted after a restart |
| --- | --- | --- | --- |
| rate limit, reset stated | hours, stated by the provider | Rust | **yes** — the door is still shut |
| rate limit, no reset stated | unknowable | Rust records, Node refuses | **no** — see below |
| circuit breaker | this process's guess | Node | no — a fresh process re-guesses |
| disabled / maintenance | a decision | Rust | **yes** — a decision is not an observation |
| `last_success` / `last_failure` | audit | Rust | reported, never acted on |

The refusal in row two is the part with teeth. Inside the process that watched
the refusal happen, a limit with no stated reset means "shut until something says
otherwise". Across a restart it means nothing usable: a limit with no clock could
be twenty seconds or three days old and there is no evidence to tell them apart.
Adopting it would wedge a working route shut with **nothing able to discover it
had cleared** — a permanent outage manufactured out of a missing field. So the
reason text is kept as context, the door is left openable, and the next request
settles it.

### No invented countdown, at any layer

`reset_at: null` survives Rust, the wire, Node, the model picker, `/provider
status` and the handover packet without becoming a zero anywhere — a zero renders
as *clears now*, on a door that is shut. Where the provider did not say, LAIN
says `UNKNOWN RESET`. This is asserted separately on each side of the socket
because either side could be the one that fabricates it.

### Only an observation clears a limit

Time passing is a prediction; a request that went through is an observation. A
stated reset in the past stops *blocking* (the provider's own number says it is
over), but the flag is dropped only by a successful request or by a person. The
supervisor keeps the same refusal it already had about jobs: it records what it
saw, or it records that it does not know.

### It is still optional, and still starts nothing on its own

The hard rule from `supervisor.js` is unchanged: LAIN is a zero-dependency Node
program and behaves identically where no Rust toolchain exists. Every call
answers with a state instead of throwing, `availability.js` stays synchronous
(it is consulted immediately before a socket opens and may never await), and the
sink is fire-and-forget — a sink that throws or rejects cannot add a second
failure to a turn that is already failing.

One judgement lives in `providerhealth.js`: **when a fact is worth starting a
process for.** Exactly one is — a rate limit with a stated reset, because it is
true for hours and is the whole point of the store. Everything else is recorded
only when a supervisor is already listening.

A user's decision (`/provider disable`, `/provider maintenance`) is deliberately
*not* on that list, which is the non-obvious call. Persisting it is genuinely
better and it does persist when a supervisor is up — but starting one for it
would exceed what was asked (a disable has always been session state, and
`availability.js` describes it as such) and would spawn a background process
from a UI command. The first draft did start one; a smoke test now asserts it
does not.

### Where it shows up

- `/models` — the route rows read `app.availability` directly, so a hydrated
  limit appears with its real clock and needed no change at the call site. That
  the picker required no edit is the evidence the migration went in *behind* the
  existing API rather than beside it.
- `/provider status` — a rate-limited route now prints its clock, or
  `UNKNOWN RESET`, and says when the fact came from an earlier session.
- the handover packet — a new section names every closed route and marks it
  `LAIN observed these`, distinct from the previous model's report.

### Verified

Full suite after this pass: **2,629 passed / 0 failed** (1,629s), confirmed per
tier — unit 2,025 · integration 77 · smoke 519 · live 8. The live tier ran
against a real provider (576 models advertised) rather than self-skipping.

- **UNIT-VERIFIED** — `rust/lain-supervisor` 37 tests (16 new: 10 in
  `providers.rs`, 6 protocol-level in `main.rs`), and
  `tests/unit/providerhealth.test.js` 18 tests covering the adoption rules, the
  duration→absolute conversion, decision-vs-observation, and sink failure modes.
- **INTEGRATION-VERIFIED** — `tests/integration/provider-health.test.js`, 10
  tests against a **real supervisor process**, including a four-hour limit
  surviving LAIN's death and surviving the supervisor's own restart. Self-skips
  when the binary is not built.
- **LIVE-VERIFIED** — `tests/smoke/provider-health.test.js` drives the real
  binary to prove no supervisor is spawned by opening a session, by reading
  provider health, or by `/provider retry`.
- **NOT VERIFIED** — a real provider rate limit against the durable store end to
  end. Every test above supplies the 429 and its reset time; none has waited for
  a real router to issue one. The parsing of a real refusal into
  `retryAfterMs` is unchanged from the code that was already live-verified, but
  the durable path itself has not met a real limit.

### A gap this pass opened in test isolation, and what the evidence actually said

Mirroring provider health to the supervisor made every path that records a route
reach a directory the suite had never isolated. `supervisor.js` does not read
`LAIN_CONFIG_DIR` — it has its own home (`LAIN_HOME`, else `~/.lain-v2`),
because the process it manages outlives any one session — and `runCli` scrubs
every `LAIN_*` variable then rebuilds only the ones it knows about. So a spawned
child fell through to the user's real home, and the in-process tiers construct
real Apps that would have done the same.

Closed in two places:

- `runCli` gives every spawned child an isolated `LAIN_HOME`;
- `tests/run.js` does the same for the in-process tiers and **refuses to start**
  if `LAIN_HOME` points at the real home — the same refusal it already makes
  about the config home, and for the same reason: by the time a test could
  report this, the damage is on disk.

**TWO WRITERS, AND ONLY ONE OF THEM WAS THE SUITE.** A full run was followed by
three rows in `~/.lain-v2/supervisor/providers/`, and they were recorded here as
all being the suite's. Bisecting by tier did not reproduce it: unit, integration
and live were clean, and smoke reproduced only intermittently. A tripwire on
`ensure()` — log a stack whenever the resolved home is the real one — named the
writer on its only hit:

```
argv=[".../npm/node_modules/lain/bin/lain.js","--resume"]   LAIN_HOME=undefined
  at Availability.noteFailure (src/availability.js)
  at runTurn (src/turn.js:333)
```

Not a test. The developer's **own globally installed LAIN**, in a real `--resume`
session, recording a real omniroute 429 into the real supervisor home — the
feature working exactly as designed, on a machine where the suite happened to be
running at the same time. The suite produced zero spawns into the real home,
which is the evidence the isolation fix works.

The other two rows (`ninerouter`, `mock`) *were* the suite's: `ninerouter` is not
a configured connection on that machine, so nothing but a fixture could have
written it. So the leak was real and so was the legitimate write, which is
precisely why attribution mattered.

**It mattered for more than bookkeeping.** The hygiene guard written alongside
the fix asserted *the real supervisor home is empty* — and that fails whenever
the developer is using LAIN, for the best possible reason. A guard that fails
when the product works is worse than no guard, because it teaches people to
ignore it. It now asserts the property it can actually attribute — **this
process's `LAIN_HOME` is isolated, and `runCli` passes an isolated one to every
child** — since nothing can attribute a file in a directory shared with the user
to a particular writer. Verified in both directions.

### What this did NOT migrate

One boundary of the runtime migration is done. The rest is mapped, not built,
and this section exists so the next pass starts from the real state rather than
from the plan.

| Subsystem | Authority today | Should be | Note |
| --- | --- | --- | --- |
| background jobs, deadlines, cancellation | **Rust** | Rust | done in an earlier pass |
| provider health, rate-limit state | **Rust** | Rust | **this pass** |
| model transport (send/receive, stream, reconnect) | Node | Rust | the largest remaining boundary, and the riskiest — a zero-dependency Rust crate would have to reimplement HTTP/SSE for every provider LAIN speaks to. Not a one-turn change, and not worth risking a working provider stack to start badly |
| runtime event bus / UX event stream | Node | Rust | `src/events.js` already has the right shape (named facts, subscribers). Migrating the *bus* is cheap; migrating every *producer* is not |
| terminal state machine / rendering | Node | Rust | `src/ui/*` is large and heavily tested. Nothing here should move before the event stream does, or there would be two writers |
| tool dispatch, capability gate | Node | Rust | `src/permissions.js` + `src/capability.js` already centralise the decision; the gate is the natural next migration after transport |
| diagnostics, project inventory, AST/FGM/locator | Node + workers | Rust orchestration, workers keep the computation | §18/§22 — these are not to be rewritten, only re-parented |
| session persistence | Node | Rust eventually | adapter first; identify authoritative vs derived vs cache before moving anything |
| Python workers | Python, spawned by Node | Python, spawned by Rust | keep the workers, move the supervision |

The pattern this pass establishes and the next should copy: **the durable store
becomes the authority, the existing Node module keeps its exact synchronous API
and becomes a hot mirror in front of it, and the adoption rules — which facts are
still true after a restart — live next to the state they describe.** The model
picker needed no edit to show a persisted rate limit, and that is the test of
whether a migration went in behind an API or beside it.

## The presentation pass

The engineering behind this was already green. This pass changes what a person
SEES while it works, and it changes no execution path: every module named below
is a pure function of (real events, clock), nothing in it is awaited by the turn
loop, and `instant` — a pipe, a test, no TTY — collapses all of it to identical
content.

### The animation may be behind reality; it may not change it

- **UNIT-VERIFIED** — the state machines are driven by an injected clock:
  `playback`, `diffreel`, `diffscript`, `reveal`, `condense`, `anchors`,
  `feedcache`, `framebudget`, `activitysurface`.
- **LIVE-VERIFIED** — `tests/smoke/timeline.test.js` drives the real binary.
- **LIVE PROVIDER VERIFIED** — two real sessions against the bridge, captured
  off the terminal with per-chunk timestamps and read back frame by frame.

### The diff window PERFORMS the edit

It was a scrolling reveal — the window opened and the diff arrived a line at a
time from the top, which reads as a file being printed. It is now driven by a
real line-level edit script (`ui/diffscript.js`) and plays each hunk:

```
SCROLL to the change → STOP → STRIKE the old lines red →
WRITE the replacement, character by character, in blue →
SETTLE it green → SCROLL to the next change
```

`ui/panes.js unified()` could not drive that and still cannot: it takes the
common prefix and the common suffix and calls everything between them one
block, so there is nothing to stop AT. That is exactly right for the DIFF pane,
which is READ; it is useless for a window, which is WATCHED. The two coexist.

### Two defects the live run found that no test had

Both were invisible to the unit tier, because both are about elapsed time and
the unit tier drives the clock by hand.

**A patch card never showed its own counters.** The ACTIVE phase was capped at
four times its floor, measured from when playback started showing the card — so
any operation slower than that (which is every edit sitting behind a model
response) had already exhausted ACTIVE, SETTLE and EXIT by the time its result
arrived, and jumped straight to the next card. The counters land in SETTLE. In
a recorded session, not one patch card ever showed `+n -m`. The ACTIVE phase now
ends when the operation did.

**The card and the window under it named different files.** The card read
`patching src/parser.js` while the window below was still rewriting
`src/serializer.js` — two halves of one surface disagreeing about what was being
changed. An edit's card now holds for exactly as long as its own window needs,
and the counters are only ever taken from a window showing the SAME file.

### The frame budget, measured rather than asserted

The redraw clock moved from 60ms (≈17Hz) to 16ms (60Hz). That is only
affordable because the conversation is no longer rebuilt between two frames on
which it did not change. Measured on this machine, whole composed frame:

| session | before | after |
|---|---|---|
| 5 turns × 4 calls | 0.32 ms | 0.20 ms |
| 80 turns × 12 calls | 2.18 ms | 0.19 ms |
| 400 turns × 20 calls | **13.01 ms** | **0.23 ms** |

Over a 600-frame animation on the 80-turn session: mean 0.37ms, worst 4.61ms,
**zero frames over the 16ms budget**, heap 89.5 MB → 25.9 MB. The cache key is
derived from the CONTENT rather than from a "something changed" flag, because a
flag is a correctness bug waiting for the next mutator somebody forgets — and
the symptom, a feed that silently stops updating, is the worst defect this
interface could have.

### Narration the screen already shows

`src/prompt.js` has always asked the model to work quietly. Measured against
real models it says "Let me read the runner log" anyway, so `ui/condense.js` is
the half that makes it true — at DRAW time only. The model's text is unchanged
in the session, on the wire and in the turn record; `/copy last` and
`/copy context` still hand back exactly what it wrote.

The unit of narration is the SENTENCE, not the line, and that was learned by
measuring: a line-based filter removed **0 of 40** prose lines on a real
session, because a model writes a paragraph on one line with the announcement as
one sentence inside it. Counted in sentences, the same session gives 2 of 80.

**What it will not do** is the design: a closed set of openers and verbs, only
sentences under 110 characters, never inside a code fence, never a sentence
naming a file/number/reason, and never the whole message.

## The operational-contract pass

### The facts a session should never have to rediscover

A person with an IDE never establishes that `--pid` wants `16296` rather than
`0x3FA8`. The debugger shows addresses in hex because it knows they are
addresses; the editor and the language server agree what line 183 counts from;
the terminal is the shell the project uses. None of that is intelligence — it is
CONTEXT, supplied by tooling — and its absence is why an agent burns requests
proving things the repository already knows.

`/brief` now opens with a `PROJECT FACTS / OPERATIONAL CONTRACT` section:

```
--- SOURCE_LOCATION ---
  Line numbers:               1-based
  Byte offsets:               0-based
  Range end:                  exclusive   e.g. "const" spans [0, 5)
  Columns:                    not produced by LAIN; supplied by external analysers only

--- SHELL ---
  Command separator:          ; (semicolon)
                              NOT: && — Windows PowerShell 5.1 has no such
                              operator; it arrived in PowerShell 7 (pwsh)
```

**A FACT IS NOT A FINDING**, and they are kept apart end to end:

| | |
|---|---|
| FACT | "The PID argument is decimal." |
| FINDING | "Something passed hexadecimal to `--pid`." |
| CONTRADICTION | "The documentation says hex; the parser converts decimal." |

The third is the most valuable, because it is the case where reading the
documentation makes things *worse*. Contradictions are emitted as findings;
facts never are.

### Facts are MEASURED, not read

The obvious way to establish "line numbers are 1-based" is to open `lineAt`, see
`return lo + 1`, and write it down. That is a reading, and readings go stale —
the same silent drift `probeskill.js` already refuses to accept for the Probe's
contract.

So the discoverers RUN the code. `lineAt` is called on a two-line string;
`tokenize` is run over a known source and the first token's `start` is read off
it; a range end is proven exclusive by checking `end - start` equals the token's
own length. Evidence recorded as `executed against this build`, which cannot
disagree with the build it came from.

### The Probe: what is provable, and what is honestly UNKNOWN

The Probe is an **external companion** whose source is not in this tree, so
restating its parameter list here would be exactly the drift `probeskill.js`
forbids. What *is* provable is provable by grammar:

- `{ "pid": 1234 }` is a JSON **number**, and the JSON grammar has no
  hexadecimal literal — `0x3FA8` is a syntax error, not a number. A PID sent as
  a number is therefore **necessarily decimal**.
- `{ "address": "0x1abc" }` is a quoted **string** with an `0x` prefix.

Different representation *and* different JSON type, so the two can never be
interchangeable — and that follows from the declared examples plus the grammar
rather than from anybody's recollection.

Everything the Probe genuinely owns — offsets, scan ranges, byte representation,
target authorization, exit codes — is recorded as **UNKNOWN**, with the exact
call that answers it (`probe(op:"capabilities", params:{of:"<operation>"})`) and
an explicit warning that the PID and address facts **do not generalise** to it.
That is the difference between one question and four experiments.

### Two detectors, calibrated in both directions

A detector only ever run on a broken fixture has been shown to fire; silence on
working code is the harder half. Both were checked both ways:

- **Documented-but-unimplemented**: a tool parameter or command flag that
  appears in the schema and nowhere in the module behind it. Its first run
  produced a **false accusation** — that `/brief` documents `--gone`, `--removed`
  and `--present` while nothing reads them. All three are parsed, in
  `briefcommand.js`, which *registers* the command from its own file, so
  following `require()` out of the run body found nothing. The resolver now
  finds the file that calls `define()`, and the tree is clean.
- **Two sources of truth**: an embedded dataset beside a JSON file with a
  matching name. Its first version counted *lines*, so a compact one-line table
  — the exact shape it exists to catch — scored one entry and was missed.
  Members are now counted from the token stream, so formatting is irrelevant and
  a comma inside a string is not a member.

## The engineering briefing pass

### It is `/brief`, not `/steer`, and that is not a naming preference

`/steer` already exists and means something else: it is how the user corrects
work that is **already running**. The word is load-bearing across
`app.steerQueue`, `task.steers`, `plan.steer()`, the prompt's "the user has
since said" block, and a smoke test of its own. `define()` throws on a duplicate
name, so a second `/steer` would not shadow the first — **it would take the
binary down at startup**. Beyond that, a user typing `/steer` to redirect a task
and receiving a four-hundred-line project audit is exactly the one-word-two-
meanings defect the architecture guard exists to prevent. The capability keeps
the request's own word for the artifact: an engineering **briefing**.

### Five axes, and a build pass cannot make the others pass

The distinction is enforced in `survey.grade()` rather than merely believed:

```
BUILD        PASS
TESTS        UNVERIFIED
RUNTIME      UNVERIFIED
FRONTEND     UNVERIFIED
ENGINEERING  DEGRADED
```

`UNVERIFIED` is tested **first** on every axis, so an axis nobody measured can
never fall through into `PASS`. And when a build passes while engineering does
not, the report says so in words, because the reflex to read the first line and
stop is strong enough to be worth interrupting.

### A finding that vanished is not the same as a finding that was fixed

The lifecycle has two exits, and the difference is the whole point. On a re-run:

- the analyser that found it **ran again and no longer reports it** → `FIXED`
- the analyser **did not run** → `UNVERIFIED`, and the report says
  *"these are NOT fixed"*

Measured directly: run the briefing with `--gone=ENEMIES`, then re-run it
without that flag, and the residue finding comes back as
`unobserved: RESIDUE #001 -> UNVERIFIED`, with `fixed: none`. An analyser that
was skipped produces exactly as many findings as a clean one, and calling that
a fix would be the report lying about the one thing it exists to get right.

### Ids survive being regenerated

`ERROR #014` has to still be `ERROR #014` after an edit, or an instruction
naming it rots immediately. So the id is keyed on a fingerprint that
**excludes the line number** — inserting a function above a defect must not
renumber it — and normalises digits inside the message, so "expected 3, got 4"
and "expected 3, got 5" are one recurring defect rather than two.

### The native toolchain, asked its own questions

`toolchain.js` analyses nothing itself. Each analyser answers three separate
questions — *applies*, *available*, *run* — and a language that **applies while
its tool is missing** becomes an `UNVERIFIED` finding naming what is absent,
never silence. Silence is indistinguishable from a clean result.

Exercised for real on this machine: `go vet` found
`main.go:7:14 fmt.Printf format %d has arg name of wrong type string` — the
wrong-type class, from the tool that actually knows — and Python compiled in
**one process** rather than one per file, reporting only the broken file.

### What it found on a fixture built to break it

A tree with a parse error, a `getUser`/`getUsers` typo, a `warth`/`width` typo,
a half-done JSON migration, an unrelated git edit, and one command failed under
three shells produced `BUILD FAILED · ENGINEERING FAILED` and named every one —
including `ENEMIES was supposed to be gone and is still defined` with the
importer nobody had looked at, and:

```
Every attempt produced COMMAND_NOT_FOUND under 3 different shells, which
eliminates the shell as the cause. Another shell will produce the same result.
```

Two defects in the collector were found by running it and fixing what it got
wrong: the enclosing symbol was reported as `rows` (the one-line `const` the
defect sat on) instead of `activeUsers` (the function a reader has to open), and
a location row was printed twice.

## Drag to select in the conversation, release to copy

Reported by a user, immediately after the scrollback fix: there was still no way
to get a sentence *out* of the conversation.

The terminal's own selection copies out of the SCROLLBACK, and the workspace is
not in the scrollback — it is a region LAIN repaints in place. Dragging across it
natively copies whatever happened to be on the glass when the button went down,
a redraw mid-drag ruins it, and the text somebody wants is usually scrolled out
of view and was never on the glass at all.

So the region that owns the pixels now owns the selection over them. Press,
drag, release: the selection highlights as you go and is on the clipboard when
you let go.

The design decisions that make it behave:

- **Offsets index the whole feed, not the visible rows**, so a selection
  survives scrolling instead of silently reselecting different text.
- **What reaches the clipboard is plain** — colour is a rendering concern, and
  trailing padding from row-clipping is stripped.
- **Reverse video is reapplied after any colour reset inside the span**, or a
  full SGR reset halfway through a word would leave the rest looking unselected.
- **A plain click selects nothing**, so clicking to dismiss a highlight still
  works and an accidental click cannot clobber a clipboard.
- **Blank padding rows hold no text.** The feed pads *above* short content, so
  the row-to-line map is not `scroll + offset`; getting that wrong selects text a
  few lines off and reads as "the selection is janky" rather than as an off-by-N.

Verified in the real binary by sending SGR mouse reports and finding reverse
video painted over real conversation rows. **No test ever touches the real
clipboard**: the copy path is exercised with it stubbed, and the smoke test
sends a press and a drag and deliberately never a release.

## Scrollback reached six turns, and the fix is not the one it looked like

Reported by a user: scrolling up stopped well short of the beginning of their
own conversation, which was sitting complete in the saved session file.

The visible cap was `compactRuns(said).slice(-60)`, carrying a comment saying
"the workspace scrolls for the rest". It does not and cannot: `scrollWorkspace`
bounds scrolling to the number of lines the renderer **returns**, so anything
trimmed there is unreachable rather than off-screen.

Raising that was necessary and not sufficient. The real ceiling was one line
further up — the feed was **constructed** from `turns.slice(-6)`. Not trimmed
for display: built from the last six turns, so every mechanism downstream was
operating on a conversation that had already been discarded.

| | turns in the buffer | reachable by scrolling |
|---|---|---|
| before | 6 | 6 |
| after | 400 | **all of them** |

Measured, because the cap presumably existed for a reason: a full render of the
longest sessions on this machine costs **2.8ms and 4.4ms**, and a redraw happens
on a keystroke rather than on a frame clock. Proved by driving the real binary
with 80 PageUp keypresses against a 120-turn session and finding
`MARKERQ0` — where the old code stopped at turn 114.

Caps that remain now **say so** (`⋮ N earlier turn(s) not shown — the full
transcript is in the saved session`), because a silent cap is how somebody
concludes their history is gone.

Also removed while in that file: `sameText` was **defined twice**, twenty lines
apart, the second silently shadowing the first — the duplicate-implementation
defect the architecture guard catches in `src/`, sitting in the UI where the
guard does not look.

## The engineering environment pass

Four things moved out of the model's context window and into the machine:
which shell a command ran in and what kind of failure came back; what a file's
symbols are and exactly where they live; whether an old implementation actually
went away; and what shape the working tree is really in.

### A failed command used to cost four requests to identify

The measured loop, on this machine, before this pass:

```
powershell   echo a && echo b   →  exit 1
cmd          echo a && echo b   →  exit 1
bash         echo a && echo b   →  bash not on PATH
powershell   echo a ; echo b    →  works
```

Four tool results, four full round trips, and PowerShell had printed the answer
in the first one: *The token '&&' is not a valid statement separator in this
version.* Nothing in that sequence needed a model. Which shell ran the command
is known before it is spawned, which directory it ran in is known, and whether
stderr says `not recognized as the name of a cmdlet` or `syntax error near
unexpected token` is a string comparison.

So `src/execution.js` classifies the failure and states the deterministic fact
about that shell which explains it:

```
[via shell: powershell · cwd=C:\Users\…\lain-v2]
The token '&&' is not a valid statement separator in this version.
[exit 1]
[CLASSIFICATION: SHELL_SYNTAX (exit 1)
 Windows PowerShell 5.1 has no && or || operator; they were added in
 PowerShell 7 (pwsh). In 5.1, `;` runs the next statement unconditionally…
 SHELL MISMATCH: `&&` in a PowerShell command.]
```

`src/attempts.js` keeps the rest of the loop from happening at all. It records
every command with the shell, the directory and the classification, and when one
comes round again the result carries what already happened:

```
[ATTEMPT 3 of this command. Previously:
  1. COMMAND_NOT_FOUND (exit 1) — shell=powershell, 0s ago
  2. COMMAND_NOT_FOUND (exit 1) — shell=powershell, 0s ago
 All 3 failed the same way (COMMAND_NOT_FOUND) under 2 different shells,
 so the shell is not the difference.]
```

That last line is a measurement, not a hint: three identical classifications
across two shells eliminates the shell as the cause. It never refuses a call —
re-running a command after an install is often exactly right — and the wording
is deliberately evidence rather than instruction, on the same terms as the
evidence ledger.

**CWD stopped being something to arrange with `cd`.** Every execution tool takes
a `cwd`, resolved and checked before anything is spawned, and a bad one is
refused with `no such directory for cwd: …` instead of arriving later as a shell
error that reads like the command being wrong. The session's own directory is
never mutated.

### Symbols, with exact ranges — the seam search.js said would need a parser

`search.js` documents what a lexical index cannot do, and the fifth item is the
one that matters: *give the exact BYTE RANGE of a definition, which is what an
edit needs.* `src/jsscan.js` is a tokeniser, so a name in a string, a comment or
a regular expression is not a name; `src/codemodel.js` turns that stream into
declarations with byte-exact ranges and their containers.

Calibrated against this repository, which is the only corpus that means
anything: **309 files round-trip through the tokeniser with every byte
accounted for, 13,201 symbols found, and every one of 911 extracted top-level
declarations compiles standalone.** That last property is what makes
`replace_symbol` safe — if the extracted bytes are a complete declaration, then
splicing over exactly that span cannot take a neighbour with it.

### The typo class a parser cannot see

`getUser` where `getUsers` was meant is valid syntax. `src/typos.js` finds it
because the name resolves to nothing while something very close to it does.

The rule that makes it worth reading is that **both gates must open**: the name
must be unresolvable, AND a near miss must exist. An unresolved name with
nothing close to it is not reported at all, because a project can reach a name
in ways a scanner cannot see, and one false alarm is enough to make the channel
worthless.

Calibration is empirical, and it changed the design. At the first thresholds the
sweep flagged exactly one line in the tree — an object-literal shorthand method
the scanner was misreading — which was a scanner defect, fixed. At relaxed
thresholds it flagged `event` against `onEvent`, which is not a typo but a
deliberate prefix. That produced the rule that separates them: **a typo replaces
characters, a prefix or suffix adds them**, so one name containing the other is
never a near miss. With that rule the distance-2 bound came down from eight
characters to five, which is what makes `warth` for `width` reachable at all.

Final calibration: **63,228 references across 310 working files, zero
reports.** The check runs automatically after every write, alongside the parse
check, on the same terms — silence unless it can prove a defect and name what
was meant.

### "Replace X with Y" is two claims and the tests only check one

Y exists is proven, because the new path works. X is gone is unproven, because a
leftover definition breaks nothing — which is exactly why it survives, and why
the next person edits the wrong copy. `src/residue.js` checks the second claim,
classifying every occurrence on tokens so that a name in a changelog is a
different finding from a name in a `require`:

```
MIGRATION INCOMPLETE.

SHOULD BE GONE
  ENEMIES — STILL DEFINED. The migration is not finished.
      DEFINED  src/data.js:2   variable
      USED     src/legacy.js:3 (shorthand)

FILES THAT SHOULD BE GONE
  src/data.js — STILL ON DISK. 1 file(s) still import it.
```

`src/legacy.js` is the file nobody looked at, and no test in the project would
have failed because of it.

### The diff, as a shape rather than as content

`src/gitsense.js` reads `--numstat`, not the diff itself, so it costs almost
nothing. What it can then say is the part that is hard to see from inside the
work: a file where nearly every line is on both sides of the diff is a
whole-file rewrite or a reformat, not an edit; a `dist/` directory in the change
set was produced rather than written; and files differing from the last commit
that LAIN did not write are called out separately from the ones it did — which
it knows, because the lifecycle ledger was already tracking them.

### Frontend measurement

`browser inspect` already returned a rectangle. `measure` adds the delta against
an expected rectangle plus the computed styles that produced it — the rectangle
says what is wrong and the styles say why. `console` reads what the page itself
reported: `Runtime.enable` was already being sent at attach, so console messages
and uncaught exceptions had been landing in the CDP event buffer since the page
opened and were being discarded. A `TypeError` with a file and a line was one
call away from every "the button does nothing" diagnosis.

## Screen layout, input viewport, and durable context

### Progress was nine rows; the work got five

Measured, not estimated. `taskBanner` returned `TASK` / objective / blank /
`STEP 2 / 5` / a 40-cell bar / `20% complete` / blank / `STATUS` / the live row —
**nine rows of chrome for three facts**. On an 80×24 terminal, after the header,
the input and the workspace border, fourteen rows remain:

| | progress rows | rows left for the feed |
|---|---|---|
| before | 9 | **5** of 14 |
| after | 2 | **12** of 14 |

The three questions are still answered separately — where in the plan (STEP), how
much is *finished* (the bar and the percentage), what is happening this second
(the live row) — laid out across the width the terminal already has instead of
down the height it does not. On a narrow terminal the live row takes a third row
rather than being truncated.

### Model prose and tool activity were one stream

What the screen showed:

```
Let's begin with Phase 1 — a full audit of the project…
✓ Ran sleep 4
Now reading the settings owner.
✓ Listed .
```

Two completely different kinds of fact, rendered identically. The feed was a flat
array of strings, so nothing downstream *could* tell them apart. Entries now
carry `kind`, and runs of the same kind are grouped under one label:

```
  MODEL
    Looking at the settings owner and the API between them.

  ACTIONS
    ✓ Listed src
    ✓ Read web/settings.js
```

One label per run, not per line, so a five-call investigation costs one heading
and five rows. Below 52 columns the labels are the decoration that goes;
indentation and the `✓` still separate the two. **LIVE-VERIFIED** at 120×40,
100×30, 80×24, 60×15 and 40×9 — task identity, progress, activity, input and a
visible caret survive at every one, with no row exceeding its width.

### Long input scrolled off the screen

The input row drew `clip('> ' + text, width)` — always the **start** of the line.
Type past the right edge and the caret, and everything after it, was simply not
drawn: you were editing blind, and a long prompt could not be reviewed or
corrected without deleting it.

There was no caret to follow, either: `←`, `→`, `Home` and `End` were decoded as
key names and then fell through to nothing, so a typo halfway through a prompt
could only be fixed by deleting everything after it.

The editor now has a caret — insert, backspace, `←/→`, `Home/End`, and `↑/↓`
walking the lines of a pasted block (history recall when there is no block) — and
`ui/viewport.js` scrolls the window to follow it, marking `…` where text
continues. One column is reserved so a caret at end-of-line has somewhere to be
drawn.

**LIVE-VERIFIED** through the real TUI: typing a 130-character prompt shows its
tail; `Home` jumps to `fix the telegram signal toggle so that…`; `End` returns;
sixty `←` presses scroll the window back one character at a time to the start.

`Home`/`End` had to stop being workspace-scroll keys while text is being edited —
they now scroll the workspace only when the input line is empty, the same rule
`Tab` and `Enter` already followed.

### Context — audited against the real payload

Run on the real binary with a 20k budget and two 1,200-line file reads:

```
request 1   2 messages    3,904 chars
request 2   4 messages    3,983 chars
request 3   6 messages   23,586 chars   <- the big read
request 4   8 messages    4,419 chars   <- compacted
request 5  10 messages    4,670 chars
```

**The rendered feed is not model context.** Verified by inspection and by test:
the only things pushed into `session.messages` are the user's input, assistant
text and tool calls, tool results, and liveness nudges. `ACTIONS`, `MODEL`,
`ACTIVITY` and `✓ Listed` appear nowhere in the persisted conversation — the UI
record (`turns`) is kept beside it, not inside it.

**The latest user message and the user's corrections always survive.**
Compaction elides *tool results* and *old assistant prose*; a `role: 'user'`
message is never touched, and the objective at index 0 is never touched at all.
Asserted on a real session where a 1,200-line file was read twice under a 15k
budget: both `fix the telegram signal toggle` and `Actually make it disabled by
default.` came through intact, and neither carried an `elided` mark.

**What was missing was the conclusions.** `session.evidence.digest()` existed and
was never used; the lifecycle's files-changed and last-check never reached the
model at all. So `--resume` restored the conversation but not what had been
worked out from it. `prompt.workingContext()` now adds a capped block:

```
# Already established
The user has since said (these override the original request):
- Actually make it disabled by default.

Files changed so far: settings.js

Last check: npm test — FAILED (exit 1)

Already inspected this session (unchanged since):
  - settings.js (420 lines)
```

Conclusions only, never the evidence behind them — a file can be re-read, a
decision cannot be re-derived. Capped under 1,800 chars because it rides on every
request of the turn; measured cost on a real resume: **+266 chars**. A fresh
session adds nothing rather than an empty heading.

## Model picker — search, exit, and false choices

Reproduced on the real binary first, fixed, then re-driven on the real binary.

### Search only matched adjacent words

Measured against the live 975-model catalog **before** the fix:

| query | results | in the catalog |
|---|---|---|
| `qwen free` | **0** | `qwen3.8 27b Free` |
| `qwen 3.7` | **0** | `qwen3.7 Flash`, `qwen3.7 Max`, … |
| `QWEN FREE` | **0** | — |
| `qwen3.7` | 9 | — |

The search tested ONE contiguous substring, so a query matched only when its
words happened to be adjacent, in that order, with that spacing. Nobody
remembers a provider's punctuation.

`src/modelsearch.js` now normalises into two forms — **squashed** (every
non-alphanumeric removed, so `qwen3.7-27b-free` and `Qwen 3.7 27B Free` are the
same string) and **tokens** (split on punctuation *and* letter↔digit boundaries,
so `qwen3.8` yields `qwen · 3 · 8`). A multi-word query is an **AND**: `qwen
free` returns the free Qwen rather than degenerating into `qwen`. Ranking is
seven explicit tiers, exact first, so any result can be explained without
trusting a score. Local, deterministic, zero tokens, no dependency.

**After**, on the same live catalog:

| query | results | first |
|---|---|---|
| `qwen free` | 1 | `qwen3.8 27b Free` |
| `qwen 3.7` | 9 | `qwen3.7 Max` |
| `qwen 3 7` | 9 | identical to `qwen 3.7` |
| `QWEN FREE` | 1 | `qwen3.8 27b Free` |
| `sonnet` | 52 | — |
| `claude sonnet` | 47 | — |

Writing the tests caught a real over-match: token matching was a substring test,
so the `7` in `qwen 3.7` matched the `7` inside `27b` and dragged `qwen3.8 27b
Free` into a 3.7 query. Tightened to **token prefixes** — `son` still reaches
`sonnet`, `7` no longer reaches `27`.

The picker had its **own** filter, stricter than the command's, so
`/models qwen free` found a model and typing the same words into the picker
found nothing. Both now call one function.

### Ctrl+C was held by the panel

With the picker open, Ctrl+C Ctrl+C did nothing; Escape was required first. The
policy was right and the exit flag was being set — but the REPL loop was parked
inside `await ui.ask(...)`, and nothing resolved that promise, so the flag was
set where nobody could read it. The EOF path already closed the panel and
resolved the pending ask; the exit path had been missed. Ctrl+C is global; a
panel does not get to hold it.

**LIVE-VERIFIED** at human pace from the root list, a filtered search and a
route screen: first press arms `Press Ctrl+C again to exit`, second press exits
`code 0` with `Session saved`, **no Escape**. Interrupting real work still
cancels the work and does *not* arm an exit.

(The confirmation window is 1500 ms. Presses spaced exactly 1500 ms apart land
on the boundary and re-arm instead — which is correct, and is what made an early
test run look like a hang.)

### A false choice, shown as a route screen

`/models qwen free` selected the right model and then reported **"2 routes serve
this model"** listing `omniroute:orca` twice, both marked current. The router
advertises 8 of 975 models twice under upstream namespaces that reduce to the
same route. Selection persists `connectionId`, so both rows stored the same
thing: two rows, one outcome, and a drill-down screen the user was forced
through to choose between two identical lines. `build()` now collapses
connections that share a `connectionId`, keeping the richer entry. **8 → 0
duplicate routes**; models with a genuine provider choice: 85 of 975. The exact
upstream id still travels on the wire — this changes what is displayed, never
what is sent.

### Smaller things the real screen showed

- The filter text stayed on the input line after the picker closed, so the next
  keystrokes appended to a dead search and submitted `qwen free/status` as a
  task. The query belongs to the picker and now leaves with it.
- Selecting printed one dim line. It now prints a confirmation naming the model,
  its provider and the effort — the receipt for the action just taken.
- Cancelling printed nothing at all; it says `Unchanged.`
- Rows said `1 route`, which is not something a person can act on. A count
  appears only where there is a choice in it; otherwise the row names the
  provider. The linear listing and the picker use the same format.
- A filter can hide the row carrying the `●` mark, leaving no current state on
  screen; the title now carries it when the list cannot.

**Real-binary verification**: `/models` → typed `qwen free` → one Enter →
`✓ Model selected / qwen3.8 27B Free / omniroute / effort auto`, header changed
immediately, `/status` confirmed `orca/qwen/qwen3.8-27b-free`. Reopening
`/models` showed `❯ ● qwen3.8 27b Free`. Rendered without overflow at 120×40,
80×24, 60×15 and 40×9. A pasted `/models qwen free` stayed literal in the input
box.

## Model picker + paste — two defects found by driving the real TUI

Both were reproduced on screen before anything changed, and verified on screen
afterwards.

### Enter did not select a model

`/models sonnet` → ↓↓ → Enter left the active model untouched. Enter was bound
to "show me this model's routes", so choosing a model meant Enter (routes),
Enter (route detail), Enter ("use this route") — three keypresses through two
screens that, for most models, offer no choice at all. **Measured on the live
catalog: 882 of 975 models have exactly ONE route** (50 of the 52 Sonnets). Enter
did something; it never did the thing it was pressed for.

Enter now means USE THIS and commits as soon as nothing is left to decide: one
route and no effort levels → selected outright; one route with levels → straight
to the levels, skipping the empty route screen; several routes → the route list,
because there a decision genuinely exists. `→` opens the routes for anyone who
wants to look first, `←` goes back, `Esc` leaves the active model alone.

The same rule applies outside the panel, so the two cannot disagree:
`/models sonnet` (52 matches) opens the picker already filtered, while
`/models claude-opus-5` (one match) simply selects it — which is also the only
way to choose a model with no terminal attached. `/model` is now a pure alias:
one implementation, one state machine, one meaning for Enter.

**LIVE-VERIFIED through the real TUI**: `/models sonnet` → ↓↓ → **one** Enter →
the header reads `claude-4.5-sonnet-thinking omniroute effort auto` and `/status`
confirms `cu/claude-4.5-sonnet-thinking`. The alias path was driven separately
and selected `tllm/claude_sonnet_4`.

### A paste ran itself

Pasting this — the payload from the brief — started a task with no Enter pressed:

```
Continue from step 4.

Then run /models.

Finally say done.

/exit
```

`input.js` called `_emitInput` the instant the closing bracketed-paste marker
arrived, so a paste was wired as a SUBMISSION rather than as characters arriving
in the box. You could not read what you had pasted, edit it, or change your mind.

A paste now appends to the edit buffer and emits `edit`; Enter submits. The
newlines inside it are content, not Enters — both arrive down the same pipe, and
only the bracketed markers can tell a keystroke from content, which is exactly
what the markers are for. The menus follow TYPING: an `edit` that came from a
paste offers nothing, and a multi-line buffer is content by construction — the
same rule `looksLikeCommand` already applied at submit time, stated once so the
two cannot drift apart. For display only, newlines fold to ` ⏎ ` with a
`[7 lines]` tag; writing a real newline into a drawn frame tears the box open.

**LIVE-VERIFIED**: after the paste the input box reads
`> Continue from step 4. ⏎ Then run /models. ⏎ Finally say done. ⏎ /exit  [7 lines]`,
the workspace still says "Ready to work", and no task exists. One Enter then
submits all of it as exactly one task. A pasted `/models` does not open the
picker, a pasted `/exit` does not leave, a pasted `@src/` does not open the file
menu — and a TYPED `/` still opens the palette, mid-task and otherwise.

Writing the tests found a third defect: history recall (↑) left the paste flag
set, so a recalled `/exit` counted as pasted — and pasted input is never treated
as a command, so it was sent to the model instead of leaving. `setLine` clears
the flag with the characters it replaces.

Three existing tests encoded the old behaviour and were updated, each carrying
its reason: two drove Enter expecting a drill-down (now `→`), and one asserted a
paste never appears in the input box — which was a usable stand-in for "↑ must
not recall a paste" only while a paste could not be shown at all.

## `/compare` — the audit, as a command

The capability audit below was a one-off report. It is now a **first-class
command**, so the question "what could the old version do that this one can't?"
can be asked of any tree at any time, including trees this project has never
seen.

`/compare <folder | github-url | dump.txt>` runs **one symmetric probe set** over
both trees — the same probes, both sides, so neither is privileged — and prints a
grid plus a plain-language summary. A capability is detected from evidence in the
tree (file names, exported symbols, command strings), never from a hand-written
list of "what V1 had", because a hand-written list is a claim about a codebase
rather than a reading of one.

Statuses: `✓` implemented · `≈` partial · `→` replaced · `—` missing ·
`✕` regressed · `⊘` intentionally excluded · `?` needs review.

`/compare add <capability>` does **not copy code**. It hands the capability to
the ordinary task loop as a request — naming the old implementation as reading
material and stating the constraints (extend the existing owner, no parallel
system, no new dependency, its own test) — because deciding how something should
look in *this* architecture is work, and work belongs to the model with real
tools rather than to a report generator.

Deliberate exclusions (orchestra, `lain-model`, the web dashboard, cross-model
handoff, permission gates) are marked `⊘` and **never offered for migration**. A
comparison that keeps suggesting you re-adopt what you deliberately dropped is
one nobody reads twice.

Sources: a local folder (everything read locally, nothing leaves the machine), a
public GitHub repository (**one** listing request for the whole file tree, then
content only for files a probe asks about — no clone, no archive, no dependency),
or a flattened-repository text dump. An unrecognised source yields **zero files
and an error**, never an empty comparison that reads like a verdict.

Run against the real V1 tree: 253 files vs 88, **25 implemented · 3 replaced ·
8 missing · 4 intentionally excluded**. LIVE-VERIFIED. (The count moved from 24/9
during this pass: `/compare` detected the catalog refresh the moment it existed,
which is the tool reading the tree rather than repeating its own report.)

## Catalog refresh — `/api refresh`, `/model refresh`, `/models refresh`

One implementation behind three names, because there is no way to guess which a
person reaches for and a second registry is how two lists start disagreeing. It
is a **catalog** request — the `/models` endpoint — never a completion, asserted
by a test that checks the request counter does not move.

It reports the **difference**, not a total: you refreshed because you added
something, so "967 models" does not answer your question. Measured live against
the real bridge:

```
✓ omniroute  2978 model(s) from http://127.0.0.1:20128/v1/models
✓ 967 model(s)  (was 934)
✓ 33 new: cmd/claude-haiku-4-5-20251001, cmd/claude-opus-4-7, …
  Current model kept: gh/gpt-4o-2024-11-20
```

and on the second run, `Already up to date — 967 model(s), nothing added or
removed.` The one consequence that changes what happens next — **the model you
are using no longer exists** — is a warning, and nothing is silently chosen for
you. LIVE PROVIDER VERIFIED.

## Liveness audit — all fifteen cases, driven against a real socket

Every case below was run through `bin/lain.js` against a **real HTTP provider
that misbehaves on purpose** (not the mock — the mock replaces the network call,
which is the thing under test). The screen was sampled continuously and the
distinct states recorded.

| Case | What the screen did | |
|---|---|---|
| A immediate | READY → THINKING → Writing → READY | ✓ |
| B 5s wait | THINKING, **4 distinct elapsed readings**, 4/4 spinner phases | ✓ |
| C **30s wait** | THINKING, **29 distinct elapsed readings**, then the answer | **✕ → fixed** |
| D slow stream | Writing, **11 distinct elapsed readings** over 12s | ✓ |
| E tool calls | RUNNING, naming the tool and its subject | ✓ |
| F provider fails | ERROR + reason + "session is intact" | ✓ |
| G dies mid-stream | ERROR at 0.9s, never a silent return to READY | ✓ |
| H 500 | WAITING `retry 1/2 in 1s` | ✓ |
| I retry then ok | THINKING → WAITING ×2 → Writing → READY | ✓ |
| J 30s tool | RUNNING, **29 distinct elapsed readings**, then continues | ✓ |
| K prose then stop | ends on READY in 0.7s — the turn is genuinely over | ✓ |
| L no tool call | same; not misreported as a stall | ✓ |
| M needs a decision | **NEEDS USER**, with the wait ticking | ✓ |
| N Ctrl+C while waiting | INTERRUPTING → INTERRUPTED, immediately | ✓ |
| O **Ctrl+C during a tool** | INTERRUPTING → INTERRUPTED at 6.0s | **✕ → fixed** |

**Two real defects, both found by running rather than reading:**

1. **A provider taking 30 seconds to first byte was killed.** `TTFB_TIMEOUT_MS`
   was 30s — and a reasoning model thinking for a minute before its first token
   is ordinary, not broken. LAIN reported "provider is not answering" one instant
   before the answer arrived. Now 120s (`LAIN_TTFB_TIMEOUT_MS` overrides). What
   makes a long bound safe is that the wait is **visible**: the header says
   THINKING, the counter ticks every second, and Ctrl+C lands immediately — so
   LAIN does not have to guess on the user's behalf. The bound still exists,
   because a wedged local router accepts the connection and then says nothing
   forever.
2. **Ctrl+C during a running command did not stop the command.** Measured: the
   header went to INTERRUPTING at 6.0s and **stayed there until 30.2s**, when
   `sleep 30` finished on its own. `child.kill()` ends the shell; what the shell
   started is a grandchild that inherits the pipes, so `close` never fired. Now
   the process **tree** is ended (`taskkill /T` on Windows, a process-group
   signal elsewhere) **and** the result settles the moment the user says stop —
   either alone leaves a hole. Verified: INTERRUPTED at 6.0s, and a probe
   confirms **0 surviving processes**.

Writing those tests found a third: an **already-aborted** signal never fires
`addEventListener('abort')`, so an interrupt arriving between the model's tool
call and the spawn started a process nobody was waiting for. Checked up front now.

## Terminal title — LIVE-VERIFIED at last

Previously NOT VERIFIED across three passes, because a test process has no TTY
and `termtitle` correctly refuses to write OSC to a pipe.

Verified this pass by launching LAIN in a **real Windows Terminal window** and
then asking the **operating system** what that window is called — a reading taken
from outside LAIN entirely, not from LAIN's own belief:

```
project C:\Users\...\lain-v2      → window title: [lain-v2]
project ...\scratchpad\titleproj  → window title: [titleproj]
```

The project folder name leads and there is no hardcoded product prefix, as
designed. The busy form (`● project — topic`) remains UNIT-VERIFIED through
`compose()`; it travels the same write path that is now proven to reach a real
terminal.

## `/models <name>` is a SEARCH again

Found by running `/models sonnet` against the real 967-model catalog: it printed
**one** arbitrary Sonnet and hid the other fifty-one. `find()` answers "which
model did they mean" and returns one — right for `/model <name>`, which selects,
and wrong for `/models <name>`, which searches. A search that silently discards
its results is worse than no search, because you cannot tell it happened.
`catalog.search()` now returns every match, ranked by how the match was made
(exact id → exact name → prefix → substring → upstream id). Verified live: **52
found**. The TTY panel already filtered correctly; this was the linear path.

## V1 → V2 capability audit

The whole V1 tree (107 source modules, ~46,000 lines) was inventoried against
V2 (36 modules, ~9,000) and each capability classified. The full matrix is
below; these are the findings that changed the code.

**The one severe regression: V2 had NO context management of any kind.**
`session.messages` grew for the life of a task and `turn.js` re-sent all of it
on every step, so a long task grew its own payload until the provider refused
it — with the whole turn's work inside the rejected request. Measured on the
real binary, same task, same script, 7 requests:

| | peak request | total sent | persisted |
|---|---|---|---|
| before | 717k chars | 2,525k chars | 713k |
| after | 34k chars | 205k chars | 29k |

`Session.compact()` is deterministic and costs **zero tokens** — V1's `/compact`
asked a model to summarise, which spends tokens exactly when tokens are scarce
and lets a generation decide what to forget. This elides the bulk and keeps the
shape: old tool results become a stub naming the call that produced them (so the
model can re-run it), long assistant prose keeps its opening, and **nothing is
deleted or reordered** — every `tool_call_id` keeps its partner, so a compacted
conversation is still valid for every provider protocol. The objective and the
recent working set are never touched. A single result larger than the whole
window is truncated head-first rather than stubbed, because the head is usually
the answer. **LIVE PROVIDER VERIFIED**: a 480s task, 30 tool calls, compaction
firing repeatedly, every compacted request accepted, 0 orphaned tool results.

| Capability | V1 | V2 | Status | Evidence |
|---|---|---|---|---|
| Context management | `/compact` (model summary) | `Session.compact` + `/compact` | **NEWLY IMPLEMENTED** (was MISSING) | measured above; `tests/unit/context.test.js`, `tests/smoke/context.test.js` |
| Feature graph (FGM) | `fgm.js` + `.lain/fgm.json` store | `dependents` tool | **REPLACED** — query kept, store dropped | `tests/unit/dependents.test.js` |
| AST / structural | `tools/index.py` → `.lain/index.json` | `symbols` (regex, live) | **REPLACED** — weaker parse, cannot go stale, no Python needed | `tests/unit/search.test.js` |
| Diagnostics | `/doctor` | `/doctor` + `diagnose.js` | **NEWLY IMPLEMENTED** (was MISSING) | `tests/smoke/doctor.test.js` |
| Completion gate | `goalcheck` · `review` · `verification` | `lifecycle.complete()` + `contradiction()` | **IMPLEMENTED**, extended this pass | `tests/unit/claims.test.js` |
| File fingerprinting | `drafts` sha256 · discovery fingerprint | evidence ledger `{size,mtime}` · checkpoint sha256 | IMPLEMENTED | `tests/unit/core.test.js`, `tests/integration/recovery.test.js` |
| Liveness / no-progress | `liveness.js` + 3 more | `lifecycle.js` (one) | REPLACED — one owner, interleaving-safe | `tests/unit/liveness.test.js` |
| Task state | `taskstate` (14) + `tasklifecycle` (6) | `lifecycle` (6) | REPLACED — pipeline dropped deliberately | `tests/unit/lifecycle.test.js` |
| Evidence | claim classification (FACT/HYPOTHESIS/…) | read-cache ledger | **PARTIAL** — same name, different capability; see limitations | — |
| Checkpoint · undo | project-scoped history | project-scoped + stale guard | IMPLEMENTED (stronger) | `tests/integration/recovery.test.js` |
| Project scan | 4 subsystems + coordinator | `project.brief` (bounded, once) | REPLACED | `tests/unit/project-shell.test.js` |
| Context selection | `handoff.selectContext` 5 levels | model chooses via search tools | REPLACED | — |
| Cross-LLM handoff | `handoff.build` | — | **MISSING** (P4 — no orchestra to hand off to) | — |
| Cross-run learning | `recipeledger` · `fixledger` · `memory` · `knowledge` · `skills` | — | **MISSING** (P1 — see limitations) | — |
| Project notes (`/init`) | `.lain/*.md` + `project-context.js` | — | **MISSING** (P2) | — |
| Routing / orchestra | `relay` · `agents` · `/council` | — | OBSOLETE — extracted to `lain-model` 2026-08-09 | — |
| Static site check | `staticcheck.js` | — | MISSING (P3) | — |
| Code hygiene | `codehygiene.js` | prompt ground rule | REPLACED (prompt, not tool) | live run, previous pass |
| Permissions | `core/permissions.js` | none, by decision | OBSOLETE — documented in README | `src/tools/shell.js` header |
| Spend/cost ledger | `track.js` · `/cost` · `/usage` | `/status` tokens only | PARTIAL | — |

## Product completion pass — what changed and how it was found

Every item below was found by **launching the binary and doing a real coding
task**, not by reading code. Each was invisible to a green suite.

| Was | Now | Status |
|---|---|---|
| A configured, reachable, authenticated bridge advertising 2,760 models produced `No models` — no model selectable, so `provider.resolve` fell through and **LAIN could not make a single request**. Model lists could only be transcribed into config by hand. | Connections are asked what they serve; the answer is cached on disk for a day. 2,760 ids → 934 canonical models. | LIVE PROVIDER VERIFIED |
| The model had **no way to write a plan**. `maybeComplete()` requires a finished plan, so the completion screen, the progress bar and the plan view were **dead on every real task**. | `plan_write` / `plan_step_done` drive the existing `plan.js`. No new plan rules. | LIVE PROVIDER VERIFIED |
| **No search tool at all** — finding code meant reading files, or a shell `grep` that does not exist on stock Windows. | `grep` (contents, `file:line`) and `glob` (names), bounded, generated trees and binaries skipped, truncation announced. | LIVE-VERIFIED + UNIT |
| A finished plan over a **failing** test suite completed: evidence counted the changed file and never consulted the red run. | Completion consults the last command. A red check refuses, names the command, and is reported to the model in-band. `userConfirmed` still overrides. | LIVE-VERIFIED + UNIT |
| Checkpoints were **written to disk and never read back**: `/undo` and `/changes` after `/resume` reported nothing while the bytes sat in the config home. | A resumed session loads its own snapshots. Numeric ordering; a spent snapshot is removed. | LIVE-VERIFIED + INTEGRATION |
| `run_bash` spawned whatever `bash.exe` PATH offered — on Windows the **WSL launcher**, which fails every call with `execvpe(/bin/bash) failed` when no distribution is installed. (Former limitation #7.) | A real POSIX shell is preferred and the `System32` shim is skipped. The command string is still never rewritten. | UNIT-VERIFIED + LIVE-VERIFIED |
| The project brief stopped at the top level; a measured real run spent its first three calls on `list_dir src`, `list_dir test`, `read_file package.json`. | The brief names the files inside source directories — one `readdir` each, capped, still under budget on a 96-module tree. | UNIT-VERIFIED |
| `No provider configured. Set ANTHROPIC_API_KEY…` was shown even with a working bridge and thousands of models — the user had merely not picked one. | Three distinct messages for three distinct situations. | LIVE-VERIFIED |

**Undo gained a guarantee it did not have.** It now refuses when a file no longer
holds what LAIN left there, so a concurrent change by *any* writer — another
session, an editor, a `git checkout` — cannot be silently discarded. The
pre-existing cross-session test was updated to assert this stronger reason; its
substantive assertion (the other session's bytes survive) is unchanged and still
passes.

**Model ranking is deliberately NOT implemented.** LAIN selects a default only
from a connection's declared `"default"`, or when the catalog holds exactly one
model. An earlier attempt at `models[0]` selected an alphabetically-first
synthetic video detector as the coding model; guessing was removed rather than
tuned.

## Core

| Capability | Status |
|---|---|
| REPL, streaming, prompt returns, clean exit | LIVE-VERIFIED |
| Tool loop; tool call → result → turn end | LIVE PROVIDER VERIFIED |
| Tool protocol persisted in the conversation | INTEGRATION-VERIFIED |
| Turn-wide tool counting | LIVE PROVIDER VERIFIED |
| `run_bash` incl. pipes, redirects, chaining | LIVE-VERIFIED |
| `run_cmd` / `run_powershell` | LIVE-VERIFIED |
| File read / write / edit / list | LIVE PROVIDER VERIFIED |
| `grep` returns `file:line`; generated trees and binaries skipped | LIVE-VERIFIED + UNIT-VERIFIED |
| `glob` matches names; `**` crosses directories and `*` does not | UNIT-VERIFIED |
| A truncated search SAYS it was truncated | UNIT-VERIFIED |
| A search that finds nothing is a result, not an error | UNIT-VERIFIED |
| An invalid regex reports what the engine objected to | UNIT-VERIFIED |
| `run_bash` resolves a real shell, never the WSL shim | UNIT-VERIFIED |
| Unknown tool name recovers | INTEGRATION-VERIFIED |
| No credential costs zero requests | LIVE-VERIFIED |
| Clean process exit after a real network request | LIVE PROVIDER VERIFIED |

## Session · task · paste

| Capability | Status |
|---|---|
| New session starts EMPTY (no plan/task/objective inherited) | LIVE-VERIFIED |
| `/resume` restores task, plan, completed steps, evidence | LIVE-VERIFIED |
| Unknown id refuses and invents nothing | LIVE-VERIFIED |
| `/resume` and `/new` rebind checkpoints (no cross-session undo) | LIVE-VERIFIED |
| One task-identity classifier | UNIT-VERIFIED + architecture test |
| Lifecycle fed by the real turn loop | INTEGRATION-VERIFIED |
| Productive turn ending in narration ≠ no-progress | LIVE PROVIDER VERIFIED |
| Completion requires evidence | UNIT-VERIFIED |
| The MODEL can write a plan and finish its steps | LIVE PROVIDER VERIFIED |
| A model revision keeps completed steps and replaces only open ones | UNIT-VERIFIED |
| A finished plan over a FAILING check does not complete, and names the command | LIVE-VERIFIED + UNIT-VERIFIED |
| The model is told in-band that its check is red | LIVE-VERIFIED |
| Fail → fix → pass completes; it is the end state that counts | UNIT-VERIFIED |
| A red check survives `/resume` and still blocks completion | UNIT-VERIFIED |
| Liveness detects alternating repeats (A B A B A) | LIVE-VERIFIED |
| Liveness never blocks the model's next tool | LIVE-VERIFIED |
| 40-line and 100-line paste stay ONE input | LIVE-VERIFIED |
| Paste starting with continue/resume/keep/fix/done/step/plan stays content | LIVE-VERIFIED |
| Evidence: whole-file re-read served; targeted read always executes | LIVE-VERIFIED |
| A paste during an active task mutates neither plan nor objective | LIVE-VERIFIED |
| Content preceding a paste marker is not lost (piped input) | LIVE-VERIFIED |
| Model identity from provider metadata (`root`/`parent`/`owned_by`) | LIVE PROVIDER VERIFIED |

## Models · effort · providers · outage

| Capability | Status |
|---|---|
| Canonical model list, effort + alias collapsed | LIVE PROVIDER VERIFIED (2,760 → 934) |
| A connection is ASKED what it serves; the answer is cached on disk | LIVE PROVIDER VERIFIED |
| Provider equivalence metadata survives discovery (identity not flattened) | INTEGRATION-VERIFIED |
| A declared `models` list is never overruled by discovery | INTEGRATION-VERIFIED |
| Discovery is at most once per connection per launch; a fresh cache costs nothing | INTEGRATION-VERIFIED |
| A dead / silent / erroring catalog endpoint is an answer, never a hang or a throw | INTEGRATION-VERIFIED |
| `/provider refresh [id]` re-reads a catalog and requests no completion | LIVE-VERIFIED |
| LAIN refuses to GUESS a model out of a large catalog | INTEGRATION-VERIFIED |
| A connection-declared `default` is honoured; a bad one is reported | INTEGRATION-VERIFIED |
| "no provider" / "no model selected" / "model not served" are distinct messages | LIVE-VERIFIED |
| Routes grouped under one model identity | LIVE-VERIFIED |
| Only routes that actually serve a model are shown | LIVE-VERIFIED |
| Generic across vendors (no hardcoded provider) | LIVE PROVIDER VERIFIED |
| `gpt-5.5-extra-high` splits correctly; no phantom base | LIVE PROVIDER VERIFIED |
| `-fast`/`-flash`/`-pro` stay identity, not effort | UNIT-VERIFIED |
| One `/effort` incl. `auto`; `/efforts` absent | LIVE-VERIFIED |
| Provider ≠ connection ≠ credential ≠ readiness | LIVE-VERIFIED |
| `REQUEST_READY` earned by a real successful request | LIVE PROVIDER VERIFIED |
| disable / enable / maintenance / retry with provider dead | LIVE-VERIFIED |
| Every command surface usable while a provider is in maintenance | LIVE-VERIFIED |
| Outage does not kill the REPL | LIVE-VERIFIED |
| A socket that accepts and never replies does not hang the prompt | LIVE-VERIFIED |
| No retry storm (breaker holds, zero requests) | LIVE-VERIFIED |
| No background health polling | UNIT-VERIFIED (structural: no timer exists) |
| No fake OAuth; keyless route offered before any API key | LIVE-VERIFIED |

## Consolidation pass — driven against a REAL misbehaving provider

A local HTTP server that stalls, dies mid-stream, 500s and streams slowly — so
the real network path is exercised, not a stubbed one. Each row is a timeline of
what the screen actually said.

| Scenario | What the screen did | Status |
|---|---|---|
| Long prose → tool → second model call → tool | THINKING → Writing → RUNNING → THINKING → Writing → RUNNING, no gap over 3s | LIVE-VERIFIED |
| 8s wait for the first byte | `Thinking…` with the counter ticking, then the answer | LIVE-VERIFIED |
| Stream that stalls 30s and never answers | 13 distinct elapsed values shown (2s…14s), then ERROR | LIVE-VERIFIED |
| Connection destroyed mid-stream | **was: silently READY** → now ERROR + reason + "session is intact" | LIVE-VERIFIED |
| 500, 500, then success | THINKING → WAITING `retry 1/2 in 1s` → WAITING `retry 2/2` → Writing | LIVE-VERIFIED |
| Slow stream, one token per 1.5s | `Writing…` throughout | LIVE-VERIFIED |

**ERROR is a new state.** The header reported `READY` the moment a provider
died: the failure was in the activity feed, but the single word summarising the
session contradicted it. A silent return to READY after a failure is
indistinguishable from success.

## Copy / paste — LIVE-VERIFIED through the real binary

| Capability | Status |
|---|---|
| A multi-line paste is ONE input, byte-for-byte | LIVE-VERIFIED |
| `/models`, `/exit` inside a paste are content and never execute | LIVE-VERIFIED |
| `continue` / `resume` / `done` / `step 4` / `plan` inside a paste stay content | LIVE-VERIFIED |
| A paste mutates neither the plan nor the objective | LIVE-VERIFIED |
| Text typed BEFORE a paste is not lost | LIVE-VERIFIED |
| A 300-line paste is one input and is not truncated | LIVE-VERIFIED |
| A pasted `@` does not open file completion | LIVE-VERIFIED |
| A single-line paste of a command name is text, not a command | LIVE-VERIFIED |
| Pasting during an active task adds content without disturbing it | LIVE-VERIFIED |

## Acceptance tasks — real binary, live provider

| Test | Result | Status |
|---|---|---|
| **A — IMPLEMENT** "Add a Telegram signal on/off button." | Reused the existing `notifications` section, API route and service; changed state → service → surface → tests (4 files); **no new directories, no second settings system** | LIVE PROVIDER VERIFIED |
| **B — BUGFIX** UI posts the wrong field | Traced to `web/settings.js`, fixed the exact planted line, **1 file changed**, tests green | LIVE PROVIDER VERIFIED |
| **D — AUDIT** "Audit this project." | Tree **byte-identical** before and after (md5 of every file) | LIVE PROVIDER VERIFIED |
| **C — TROUBLESHOOT** | Classification LIVE-VERIFIED; full live run NOT VERIFIED |
| **E — NEW PROJECT** | Guidance only; staged build NOT VERIFIED live |

Two real defects were found by running these, not by reading code:

1. **A green test suite was treated as disproving the bug report.** In test B the
   tests only exercised the API route directly, never through the UI's `toggle()`
   — so they passed and LAIN concluded "no apparent issue". The guidance now
   states that a passing suite means the tests do not cover the path the user
   described, which narrows the search rather than ending it. Re-run: it read
   that path and found the line.
2. **A new feature's assertions were folded into an existing unrelated test**
   (`+6 -3` rewriting the email test). That test then failed for two reasons and
   described neither. The guidance now requires the new behaviour to get its own
   named test covering the round trip. Re-run: `+10 -0`, purely additive.

## Workflow — how a request becomes work

| Capability | Status |
|---|---|
| Request mode inferred LOCALLY (implement/bugfix/troubleshoot/audit/explain/new-project/resume/chat) | LIVE-VERIFIED (all of the brief's examples, through the real CLI) |
| Zero model calls and zero tokens to classify | UNIT-VERIFIED (pure function, deterministic, no I/O) |
| A PASTE never re-classifies the work | UNIT-VERIFIED |
| A continuation KEEPS the mode it is continuing | UNIT-VERIFIED |
| "build X" is a new project only where there is no project | UNIT-VERIFIED |
| A specific symptom is BUGFIX; a vague one is TROUBLESHOOT | UNIT-VERIFIED |
| The mode selects guidance and NOTHING else — it cannot block a task | structural (advisory prompt text only) |
| Mode survives `/resume` | UNIT-VERIFIED (session field) |
| IMPLEMENT fits the EXISTING architecture instead of inventing one | LIVE PROVIDER VERIFIED |
| IMPLEMENT finishes the visible surface, not just the backend | LIVE PROVIDER VERIFIED (regression: it stopped at the backend until the guidance said otherwise) |
| BUGFIX traces the path and changes only the broken link | LIVE PROVIDER VERIFIED (1 file, 12 calls) |
| Diagnostic scaffolding is removed before reporting | LIVE PROVIDER VERIFIED (regression: a `console.log` was left in a handler under a green suite) |
| AUDIT modifies nothing | LIVE PROVIDER VERIFIED (byte-identical tree after the run) |
| `symbols` sorts a name into definitions / imports / uses in one call | LIVE-VERIFIED |

## Terminal tab title

| Capability | Status |
|---|---|
| The tab is named after the PROJECT, not the product | UNIT-VERIFIED |
| The task and a running-turn marker are appended | UNIT-VERIFIED |
| Control characters in user text can never reach the terminal | UNIT-VERIFIED |
| OSC 0 and OSC 2, BEL-terminated | UNIT-VERIFIED |
| Nothing written to a pipe or a dumb terminal; `LAIN_NO_TITLE` disables | UNIT-VERIFIED |
| Driven from the same snapshot the screen draws; restored on exit | UNIT-VERIFIED (structural) |
| Verified in a real PowerShell window | NOT VERIFIED — needs a TTY a test process does not have |

## Liveness — "is LAIN still working?"

The defect: `turn.js` computed the current phase before every provider call and
every tool, and **nothing ever passed an `onStatus` to receive it**. Every
liveness function was correct and none of it reached a terminal.

| Capability | Status |
|---|---|
| `THINKING` while waiting on the provider, in the header AND in words | LIVE-VERIFIED |
| `RUNNING` naming the tool and its subject | LIVE-VERIFIED |
| `WORKING` while the model is streaming | LIVE-VERIFIED |
| `NEEDS USER` while `ask_user` is open | LIVE-VERIFIED |
| `WAITING` counting down a real retry | UNIT-VERIFIED |
| The screen keeps redrawing through a long wait (≥6 frames / 3s, spinner advances) | LIVE-VERIFIED |
| Elapsed time shown once a wait is worth naming | LIVE-VERIFIED |
| The spinner is a function of the CLOCK — it cannot animate while idle | UNIT-VERIFIED |
| The live row DISAPPEARS when nothing is running | UNIT-VERIFIED |
| Calls of the turn IN FLIGHT are visible, not only at turn end | LIVE-VERIFIED |
| A failed call is reported ONCE (no duplicate trailing error block) | UNIT-VERIFIED |
| Provider failures still surface — they have no call of their own | UNIT-VERIFIED |
| `grep` reads as `Searched for "X"`, not `grep /X/` | UNIT-VERIFIED |
| Zero model calls and zero tokens for any of it | structural (one `provider.chat` call site; the only timer redraws state) |

## Input while the model is working

| Capability | Status |
|---|---|
| `/` opens the palette during an active turn | LIVE-VERIFIED |
| It filters as typed, and the work carries on underneath | LIVE-VERIFIED |
| A chosen command runs IMMEDIATELY, not after the turn | LIVE-VERIFIED |
| A command that would rewrite session/plan/tree says so instead | LIVE-VERIFIED |
| `/exit` waits for the turn rather than racing it | LIVE-VERIFIED |
| Queue ORDER is preserved when nothing is running | LIVE-VERIFIED (regression: bypassing unconditionally ran a trailing `/exit` before the task above it) |

## Ctrl+C

| Capability | Status |
|---|---|
| Read by the input reader — no panel can swallow it | structural + LIVE-VERIFIED |
| While working: `INTERRUPTING` shown BEFORE the unwind, then `INTERRUPTED` | LIVE-VERIFIED |
| No `READY` frame flashes between them | LIVE-VERIFIED |
| Works with the command palette open | LIVE-VERIFIED |
| An open panel/question is cancelled with the turn | LIVE-VERIFIED |
| Idle: first press arms the hint on the input frame, second exits cleanly | LIVE-VERIFIED |
| No Escape required first; any other key disarms | LIVE-VERIFIED |

## Model browser

| Capability | Status |
|---|---|
| Three levels: MODEL → PROVIDER/CONNECTION → ROUTE DETAIL + EFFORT | LIVE PROVIDER VERIFIED |
| Typing filters the browser (934 → 50 for "sonnet") | LIVE PROVIDER VERIFIED |
| Opens on the current model; filtering lands at the top of the results | LIVE-VERIFIED |
| A route is ONE row plus its effort summary, not eight fields inline | UNIT + LIVE-VERIFIED |
| Choosing an effort settles model + connection + level in one act | UNIT-VERIFIED |
| identity/provider/connection/credential/readiness/availability stay separate | UNIT-VERIFIED |
| `←` back, `Esc` close; Enter belongs to the panel while it is open | LIVE-VERIFIED |
| Entirely local — no request, no token | structural |

## Terminal UI

| Capability | Status |
|---|---|
| Four FRAMED regions drawn by the real binary (header/workspace/input/panel) | LIVE-VERIFIED |
| Each region names itself on its own top edge; INPUT renames to COMMANDS/FILES | LIVE-VERIFIED |
| Alternate screen entered and restored on exit | LIVE-VERIFIED |
| Progress = completed work (step 1 started = 0%) | LIVE-VERIFIED |
| Header shows model / connection / effort separately | LIVE-VERIFIED |
| Workspace views activity, plan, diff, files, output | LIVE-VERIFIED |
| ONE interaction panel for /models, /provider, /config, /effort | LIVE-VERIFIED |
| /models is model-centric; effort variants stay collapsed | LIVE-VERIFIED |
| Panel shrinks the workspace, never the input | LIVE-VERIFIED |
| Panel windows long lists (2,000 rows to the allotted height) | UNIT-VERIFIED |
| Plan expansion is display-only (never mutates plan state) | UNIT-VERIFIED |
| Renders correctly at 120x40, 80x24, 60x15, 40x9 (COLUMNS/LINES honoured) | LIVE-VERIFIED |
| At every one of those sizes the live status and the input survive | LIVE-VERIFIED |
| Nothing drawn exceeds the terminal width; screen+cursor restored each time | LIVE-VERIFIED |
| EOF with a panel open still exits cleanly and saves | LIVE-VERIFIED |
| Paste stays ONE input with the TUI active | LIVE-VERIFIED |
| Exit prints the REAL persisted session id, which resumes | LIVE-VERIFIED |
| Non-TTY falls back to the linear renderer | LIVE-VERIFIED |
| UI costs zero model calls (pure state to lines) | UNIT-VERIFIED (structural) |
| Mouse support | NOT IMPLEMENTED (deliberate — the UI is keyboard-only) |
| Start screen: centred wordmark, project, route, "Type a task below" | LIVE-VERIFIED |
| Start screen drops its lowest-ranked rows to fit rather than overflowing | LIVE-VERIFIED (60x15, 40x9) |
| Activity interleaves the model's prose with the calls that followed it | LIVE-VERIFIED |
| Activity phrases calls as `✓ Read src/auth/token.js`, no timings or token counts | LIVE-VERIFIED |
| Header carries no diagnostics — state, route and progress only | LIVE-VERIFIED |
| Plan is one line per step; Enter expands to Why / Files / Status | UNIT + LIVE-VERIFIED |
| Plan expansion shows no timestamps or lifecycle internals | UNIT-VERIFIED |
| Diff: CHANGES list with `●` and `+N -M`; Enter opens a line-numbered diff | LIVE-VERIFIED |
| Files: real tree connectors (├─ └─ │) with changed files marked | LIVE-VERIFIED |
| Output: command, stdout, exit code only when non-zero | LIVE-VERIFIED |
| Completion palettes size to their contents, never take the screen | LIVE-VERIFIED |
| Panel opens with the cursor on the first CHOOSABLE row | LIVE-VERIFIED |
| Scroll indicator on the header's rule when content overflows | LIVE-VERIFIED (the tab strip it used to ride on is gone; see the one-surface rewrite) |
| Shift+Tab cycles views backwards | REMOVED with the panes — Tab now only accepts a completion |
| Exit prints a SHORT resume token that resolves to the real session | LIVE-VERIFIED |
| `--resume <token>` restores the session in a fresh process | LIVE-VERIFIED |
| Splash (wordmark, project, Ready) before the alternate screen opens | IMPLEMENTED (TTY-only path; not exercised over a pipe) |
| Launch screen states project, route, readiness and what to type | LIVE-VERIFIED |
| Activity shows the request, the model's prose and each call with its subject | LIVE-VERIFIED |
| Live "running" row while a call is in flight | IMPLEMENTED (drawn from tool_start; not isolated in a test) |
| Header carries tool/file/elapsed facts when there is no plan | LIVE-VERIFIED |
| TTY stdout belongs to the Screen — nothing paints over the regions | LIVE-VERIFIED |
| Command output is captured and rendered inside the workspace | LIVE-VERIFIED |
| Tool results shown only when they are messages, not file contents | UNIT-VERIFIED (length rule) |
| `/changes` lists changed files with real +N -M counts | LIVE-VERIFIED (was the DIFF pane) |
| `/changes` prints the diff itself, line-numbered, with no picker to go through | LIVE-VERIFIED |
| `/changes files` shows a bounded project tree with changed files marked | LIVE-VERIFIED (was the FILES pane) |
| The conversation carries real shell results and exit codes, in order | LIVE-VERIFIED (was the OUTPUT pane) |
| Tab cycles views; Alt+1..5 jump to one | REMOVED — ONE surface, and every pane's content is a command. tests/unit/onesurface.test.js and tests/smoke/onesurface.test.js assert the machinery is gone and unreachable |
| `Ctrl+1..5` view switching | REMOVED with Tab / Alt+N; there is nothing to switch to |
| `/plan`: progress bar, active step marked, note and files shown where there are any | LIVE-VERIFIED (was the PLAN pane; `detail` replaced the expansion keystroke) |
| Enter opens a plan step picker | REMOVED — `/plan` prints every step's detail, so nothing is asked which |
| `/models` filters by name and opens on the current model | LIVE PROVIDER VERIFIED (2,760 ids → 1,151 models; `/models opus` → 120) |
| `/config` Enter CHANGES a value and persists it | LIVE-VERIFIED |
| A modal panel reports NEEDS USER, not WORKING | LIVE-VERIFIED |
| Project scan and tree cached per session; change count memoised per checkpoint | IMPLEMENTED (structural: no per-keystroke rescan) |
| Turn record persists narration + per-call actions, each bounded | LIVE-VERIFIED |
| Panel `kind` decides key routing (COMMAND_PALETTE … ASK_USER, IDLE) | UNIT-VERIFIED |
| Typing does not disturb a modal panel; only completion menus follow the line | LIVE-VERIFIED |
| ↑/↓ recall prompt history when no menu is open | LIVE-VERIFIED |
| ↑/↓ drive the menu when one IS open (history cursor untouched) | LIVE-VERIFIED |
| History bounded (200), blanks excluded, consecutive repeats collapsed | UNIT-VERIFIED |
| Editing a recalled prompt does not rewrite the stored entry | UNIT-VERIFIED |
| A paste never enters history | LIVE-VERIFIED |
| History is memory-only — never written to disk | UNIT-VERIFIED (structural: no writer exists) |
| Typing `/` opens the command palette | LIVE-VERIFIED |
| `/mo` filters; the list IS the command registry, not a copy | LIVE-VERIFIED |
| `/eff` offers `/effort` exactly once; `/efforts` absent | LIVE-VERIFIED |
| Tab completes the highlighted command into the line | LIVE-VERIFIED |
| Enter runs the highlighted command (never sent to the model) | LIVE-VERIFIED |
| Esc closes the palette and keeps what was typed | LIVE-VERIFIED |
| A bare `/` is never spent on a model request | LIVE-VERIFIED |
| A slash mid-sentence stays prose | LIVE-VERIFIED |
| Typing `@` opens project-relative path completion | LIVE-VERIFIED |
| `@src/in` filters; Tab/Enter INSERT the path and never submit | LIVE-VERIFIED |
| Completing a directory re-lists one level deeper | LIVE-VERIFIED |
| Generated dirs excluded; completion cannot escape the project; list capped | UNIT-VERIFIED |
| Completion reads names only — nothing is read into the prompt | UNIT-VERIFIED (structural) |
| Normal input still submits after every kind of menu interaction | LIVE-VERIFIED |
| Header, view tabs and input row survive menu use | LIVE-VERIFIED |
| Route view shows identity/provider/connection/credential/readiness/availability/effort | LIVE PROVIDER VERIFIED |
| ask_user / MCQ tool — registered, panel-rendered, answer returns as evidence | LIVE-VERIFIED |
| ask_user cannot start a task, wipe the plan or reset steps | LIVE-VERIFIED |
| ask_user without an interactive UI reports it instead of hanging | LIVE-VERIFIED |
| Completion screen wired to real lifecycle completion | LIVE-VERIFIED |
| Completion NOT shown without evidence, or on a mere claim of success | LIVE-VERIFIED |

## Reversibility · token economy

| Capability | Status |
|---|---|
| Snapshot before a mutating call | INTEGRATION-VERIFIED |
| `/changes`, `/undo` (incl. undoing a creation) | LIVE-VERIFIED |
| `/undo` and `/changes` work after `/resume` (snapshots reloaded) | LIVE-VERIFIED + INTEGRATION-VERIFIED |
| Undo REFUSES when the file changed after LAIN wrote it | INTEGRATION-VERIFIED |
| Undo still cannot cross a session boundary | LIVE-VERIFIED |
| Snapshots load in numeric order, so undo pops the latest past `c10` | INTEGRATION-VERIFIED |
| A spent snapshot does not return on the next resume | INTEGRATION-VERIFIED |
| Recovery without git | LIVE-VERIFIED |
| Git-aware recovery | MISSING (deliberate) |
| One model request per model step; no hidden round-trips | LIVE-VERIFIED (single `provider.chat` call site) |
| Fixed prefix ≈ 771 est. tokens; 554 measured by a real provider | LIVE PROVIDER VERIFIED |

## Deliberately not implemented

External planner · a persistent feature graph or AST database (the *queries*
are implemented, by `dependents` and `symbols`; the *stores* are refused
because V1's went stale after every edit) · OAuth implementations · git-aware
recovery · permission modes. These are excluded by decision, not oversight.

~~context compaction~~ — **implemented this pass**; see the capability audit.

## Remaining limitations

1. **Four display-name collisions remain**, out of 934 canonical models:
   `claude_sonnet_4`/`claude-sonnet-4`, `GPT_5`/`gpt-5`,
   `gemini-3-flash`/`gemini_3_flash`, `Step-3.7-Flash`/`step-3.7-flash`. These
   are the same model spelled two ways by the provider, but the catalog supplies
   **no `root` or `parent` linking them**, so there is no authoritative evidence
   of equivalence and they are deliberately kept distinct.
   **Status: PARTIAL — known, bounded, evidenced.**
2. **A paste during an active task is content for that task** — it never becomes
   a control command, a task transition or a plan mutation. Starting a different
   task is an explicit act (`/new`). **LIVE-VERIFIED as deliberate behaviour.**
3. ~~Automatic catalog discovery is not implemented.~~ **RESOLVED this pass.**
   A connection with a `baseUrl` is asked what it serves and the answer is cached
   for a day; `/provider refresh` re-reads it. **LIVE PROVIDER VERIFIED**
   (2,760 ids → 934 models from a real bridge). Discovery contacts only the
   catalog endpoint, at most once per connection per launch.
4. **56 of 99 exports have no production caller** — almost all constants and
   helpers exported for tests. No dead *subsystem*; surface-area bloat only.
5. **Live tier depends on a reachable bridge.** It self-skips otherwise, and now
   prints the probe failure reason so a skip can never be mistaken for a pass.
6. `run_powershell` is exercised on win32 only.
7. ~~`run_bash` depends on which `bash` is first on PATH.~~ **RESOLVED this
   pass.** `run_bash` now resolves a real POSIX shell (an explicit `LAIN_BASH`,
   Git Bash, MSYS, Cygwin, or the first non-shim `bash.exe` on PATH) and skips
   the `System32` WSL launcher, which is not a shell. Choosing the *interpreter*
   is not rewriting the *command*: the command string still reaches the shell
   verbatim, pipes and redirects included. If no POSIX shell exists at all, the
   failure names the executable and points at `run_powershell` / `run_cmd`.
   **UNIT-VERIFIED** (shim detection, resolution, pipeline integrity, exit
   codes) **+ LIVE-VERIFIED**.
8. **`←` does nothing inside a completion menu.** It is `back` only in a
   drill-down (model → routes); `→` accepts a completion. Deliberate.
9. **Interactive plan-step expansion**, `LIVE-VERIFIED` 2026-08-16: Alt+2 to the
   plan view, Enter on an empty input line opens the PLAN STEPS panel
   (`workspaceSelect` → `planStepsAdapter`), selecting a step calls
   `screen.toggleStep(n)` and the step expands in place in the real workspace.
   Driven through the real binary with `LAIN_FORCE_TUI=1` and a scripted
   provider; expansion remains display-only, as designed — it cannot mutate
   plan state.
10. **Cross-run learning is MISSING.** V1 carried five stores — `recipeledger`
    (how to build a kind of thing), `fixledger` (which fix cleared which error),
    `memory`, `knowledge`, `skills` — so a second, similar task started warm.
    V2 has none, and every task starts cold. This is the largest *remaining*
    V1 capability gap and it is P1, not P4: it is the difference between LAIN
    getting better with use and LAIN being the same on day 200 as on day 1.
    Not attempted this pass because a wrong recipe injected into a prompt is
    worse than no recipe, and there is no measurement in place yet to tell the
    two apart. **Status: MISSING — acknowledged, not obsolete.**
11. **`evidence.js` is not V1's evidence system.** V1's classified *claims*
    (FACT · OBSERVATION · HYPOTHESIS · USER_CLAIM · MODEL_CLAIM) so a model's
    assertion could never be recorded as a fact. V2's is a read-cache keyed on
    `{size, mtime}`. The `lifecycle` evidence counters and the new
    `contradiction()` check cover the part that mattered most — a claim is
    checked against what actually ran — but the general claim taxonomy is gone.
    **Status: PARTIAL.**
12. **A success claim is contradicted, not prevented.** `contradiction()` fires
    when the model's closing text claims success and the task's last command
    failed. It is a warning printed under the turn; it does not edit the
    model's words, and it cannot detect a false claim about something no
    command checked. **UNIT- and LIVE-VERIFIED via the real binary; the live
    provider run that motivated it did not re-issue the claim on re-run, so the
    live path fired the plan-level gate instead ("Plan finished, but not
    complete — the last command failed (exit 1): npm run test").**
13. **`dependents` resolves imports lexically.** It reads the tree as it is at
    that instant, so it cannot be stale — but it is not a module resolver: it
    does not read `tsconfig` path aliases, webpack aliases or package
    `exports` maps. A project built on aliases will under-report. It never
    claims otherwise: "no dependents" is always phrased as a finding, with the
    dynamic-loading caveat attached when the project loads code by name.
    **Status: PARTIAL — bounded and disclosed in the tool's own output.**
14. **The context budget is estimated in characters, not tokens.**
    `CHARS_PER_TOKEN = 3.6` is deliberately pessimistic, so LAIN compacts
    slightly early rather than one step late. A real tokenizer is a per-model
    dependency; `LAIN_CONTEXT_CHARS` overrides the estimate when a provider's
    advertised context length is wrong (common for local models served behind
    an OpenAI-shaped API). **Status: PARTIAL by design.**
15. **`/compare` detects capabilities by evidence, not by understanding.** A
    probe is a file-name pattern plus, where the capability lives inside a shared
    file, a content pattern. It cannot recognise a capability implemented under
    an unfamiliar name in an unfamiliar layout, and it will call a stub present
    if the stub is named convincingly. The probe set is a table
    (`src/capabilities.js`) precisely so a wrong or missing row is a one-line fix
    rather than an engine change. **Status: PARTIAL by design — useful, not
    omniscient.**
16. **`/compare` against a GitHub URL contacts GitHub.** One request lists the
    file tree and a handful more read files a probe asks about. It is the only
    part of LAIN that talks to anything other than your configured provider, it
    happens only when you pass an `https://` source, and a local folder — the
    recommended form — reads everything on this machine. **LIVE-VERIFIED against
    a stubbed transport; not exercised against github.com in this pass.**
17. **`/compare add` prepares work; it does not perform a migration.** It
    composes the request and submits it as an ordinary turn. What actually gets
    built is whatever the model builds, subject to the same completion evidence
    as any other task. **Deliberate** — a report generator that writes subsystems
    is how V1's architecture got copied into places it did not fit.
18. **The busy terminal title is not independently verified.** The idle title is
    LIVE-VERIFIED from the OS (see above). Driving a task inside a detached
    console window and sampling the title mid-turn needs focus-stealing input
    injection, which is not worth the flakiness. **UNIT-VERIFIED via `compose()`,
    on the write path proven live.**
19. **`taskkill /T` is best-effort, as any process kill is.** A child that
    ignores termination, or one that re-parents itself, can survive. The reason
    the interface no longer waits on it is exactly this: the result settles when
    the user says stop, so an unkillable grandchild can no longer hold the
    session hostage even in the case where the kill fails.
20. **The symbol tools are JavaScript only, and say so.** `jsscan.js` reads
    `.js`, `.cjs` and `.mjs`. Not JSX, not TypeScript, not Python, not Go — a
    TypeScript type annotation would confuse declaration detection, and half a
    parser is worse than none. Every symbol tool answers a file it cannot read
    with a declared no and a pointer to `apply_patch`, which works on every file
    in every language. **Status: PARTIAL by design, and disclosed in the tool's
    own output.**
21. **`jsscan.js` is a TOKENISER, not a parser.** It has no syntax tree and no
    scope analysis: it can say a name is an identifier, and it cannot say which
    binding that identifier resolves to. Two `send` methods on two classes are
    told apart by their container and by nothing else. The `/` disambiguation
    uses the standard preceding-token rule with an unterminated-regex fallback;
    `(a) /re/.test(b)` on one line is the shape it can get wrong, and the
    fallback then reads it as division rather than desynchronising.
    **UNIT-VERIFIED by a byte-exact round trip over all 309 JavaScript files in
    this repository.**
22. **The unresolved-name check reports LESS than it could, deliberately.** Both
    gates must open: unresolvable AND a near miss. A genuine typo whose intended
    name is not similar enough — or is not in the file — is missed, and that is
    the correct direction to fail: a missed typo costs one bug the tests were
    going to find, and one false report costs the channel. Bindings are
    over-collected for the same reason. **Status: PARTIAL by design. Calibrated
    at zero reports over 63,228 references in working code.**
23. **`rename_symbol` does not resolve member accesses, and does not pretend
    to.** `x.send` may be the method being renamed or a different `send` on a
    different object; nothing short of type inference can say. Member accesses
    are counted, reported with their locations, and left alone unless
    `include_members` is passed. Occurrences inside strings, comments and
    non-JavaScript files are never rewritten and are always reported, because a
    string holding the old name is frequently a real reference. **Status:
    PARTIAL and fully disclosed in every result.**
24. **`find_residue` proves absence of TEXTUAL reference, not absence of
    dependency.** A project that reaches code by a computed name, a plugin
    registry or reflection can depend on something this reports as gone. It also
    cannot decide whether a surviving leftover is deliberate — a compatibility
    shim is a judgement about intent — so it reports and never deletes.
25. **`review_changes` measures the SHAPE of a diff and makes no judgement about
    correctness.** A 4,000-line diff can be exactly right and a whole-file
    rewrite can be what was asked for. Every observation is phrased as something
    worth a second look, with the reasoning attached, precisely so the section
    stays readable rather than something to scroll past. The rewrite threshold
    (80% of a file's lines on both sides of the diff) is a heuristic.
26. **The attempt ledger lives for one session and is bounded.** Sixty commands,
    eight attempts each; older entries fall off. It never blocks a call and is
    phrased as evidence throughout — asserted structurally, because a ledger
    that starts refusing things is a ledger that has become a policy.
27. **`browser console` reads a bounded ring of CDP events.** The buffer holds
    200 events, so a page that logs in a loop will have pushed earlier messages
    out. It reports what it has, with the total, and never implies it saw
    everything from page load.
28. **The briefing's type findings depend on a toolchain being installed.**
    `tsc`, `eslint`, `cargo check` and `go vet` are run when present and
    reported as `UNVERIFIED` findings when absent. **`go vet` and the Python
    parser were exercised for real on this machine; `tsc`, `eslint` and
    `cargo check` were NOT — no TypeScript or ESLint install exists here, so
    only their absent-tool path is verified.** Their output parsers are written
    against each tool's documented format and are unexercised against real
    output. **Status: PARTIAL — the architecture is proven, two of five
    analysers are proven end to end.**
29. **A misspelled PROPERTY is not detectable without types.** `el.warth` for
    `el.width` is a member access on a value whose type nothing here knows.
    The unresolved-name check sees BARE identifiers, so it catches
    `warth` used as a variable and misses `el.warth`. That gap is stated in the
    briefing's own limitations section, and it is what `tsc` exists for.
30. **Root-cause grouping is mechanical and can be wrong.** Findings group when
    they share a file or a symbol; the hypothesis attached is INFERRED and
    labelled as such. A group is evidence of shared surface, never proof of
    shared cause, and unrelated findings that happen to touch one file will be
    grouped.
31. **The briefing does not run the test suite unless asked.** `--tests` runs
    the project's own command; without it, TEST health is `UNVERIFIED` rather
    than assumed. The dead-code sweep is opt-in for the same reason — it is a
    tree scan per exported name and would make every briefing feel slow.
32. **Scrollback is bounded at 400 turns.** Beyond that the oldest turns are not
    in the scroll buffer and the screen says so, naming the saved session as
    where the rest lives. The bound exists to stop a pathological session making
    redraws sluggish; it is not reached by any session on this machine.
33. **The Probe's per-operation contract is UNKNOWN without a live Probe, by
    design.** PID (decimal) and address (hex string) are proved from the
    advertised schema plus the JSON grammar. Everything else the Probe owns —
    offsets, scan ranges, byte representation, target authorization, exit codes
    — is reported as UNKNOWN with the discovery call named. Restating it here
    would be the silent drift `probeskill.js` refuses. **Verified only against a
    SIMULATED connection; no live Probe ran in this pass.**
34. **The contradiction detectors under-report on purpose.** A documented
    parameter is looked for anywhere in the module that defines the tool, not
    just in the function that reads it, so a name appearing only in a comment
    counts as present. A false accusation sends somebody to read code that was
    fine; that is the worse failure.
35. **The two-sources-of-truth check keys on NAME similarity.** An embedded
    dataset whose symbol is not named like its JSON file is missed, and two
    unrelated things that happen to share a name would be reported. It is
    graded INFERRED for exactly that reason, and it never deletes anything.
36. **Text selection covers the workspace feed only.** The input box has its own
    selection (they share one model); panels, the header and the status strip do
    not select. Selection is by character cell, so a double-width glyph selects
    as one cell — no CJK-aware column mapping is claimed.
37. **Copy-on-release writes the system clipboard.** A deliberate drag across
    text overwrites whatever was on it. A plain click does not, and neither does
    a drag that selects nothing.
