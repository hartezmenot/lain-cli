# V1 AUDIT — learn, don't migrate

Traced from entry points through real call paths in the V1 tree captured by the
backup archive. Nothing here is taken from V1's README, comments, or test names.
This exists so V2 can be built deliberately; it is **not** a migration plan.

V1 scale: 56,473 LOC in `src/`. `repl.js` alone is 17,511 lines (31%) and holds
~380 methods on one `App` class. 68 model-facing tools. 77 slash commands.

---

## A. What worked

| Thing | Why it worked |
|---|---|
| **`core/turn.js` — tool protocol kept in `messages`** | The assistant turn is persisted *carrying* its `tool_calls`, and each result is a `role:'tool'` message matched by id. Before this, tool history was thrown away at every turn boundary and the model re-derived the same conclusions forever. This is the single most valuable idea in V1. |
| **Provider failures never escape the turn generator** | Outage/429/402/timeout/401 are all yielded as events; `usage` is always emitted. The REPL always gets control back. |
| **`core/reads.js` — ReadGuard + EvidenceLedger** | Content-keyed on `{size, mtime}`; any mutator invalidates; targeted/ranged reads are never guarded. Task-scoped guard + session-scoped ledger is the right pair of lifetimes. The only V1 system that provably *reduced* tokens. |
| **`availability.js`** | Circuit breaker learned lazily from requests that were happening anyway. No ping loop. User-set MAINTENANCE/DISABLED never auto-cleared. |
| **`providerstate.js` / `connections.js`** | PROVIDER ≠ CONNECTION modelled correctly, including bridge-owned credentials. `REQUEST_READY` requires a *successful request*, never a token on disk. |
| **`modelidentity.js`** | Effort vocabulary *measured* from a live catalog, not guessed. `-fast/-flash/-pro/-lite` correctly classified as identity, not effort. Lazy regex fixes the `extra-high` split. Conservative ≥2-sibling rule. |
| **`plan.js` session ownership** | One stamp comparison. No similarity heuristic, no session enumeration. `retire()` instead of delete. |
| **Turn-wide tool counting** | Counting tools across the *whole* turn instead of the final step fixed real "productive turn scored as no-progress" failures. |
| **Zero runtime dependencies** | Kept the whole thing auditable. |
| **`tools/check.js`** | A static detector for *guards disabled by a constant and left in place* — V1's actual signature failure mode. |

## B. What failed

1. **`repl.js` as a god object.** Turn loop, plan runner, permission gates, model picker, OAuth, dashboard, viewport, and 77 commands in one class.
2. **Four disagreeing continuation classifiers** — `diagnostic.continuationOnly`, `diagnostic.taskContinuation`, `App._planResumeIntent`, `TaskLifecycle.classifyPrompt`.
3. **`_planResumeIntent` was anchored only at the start**, so any paste beginning with `continue` / `proceed` / `resume` was read as plan-resume intent. `continue` at the top of a pasted code block is extremely common.
4. **Plan leakage.** `plan.activeFor()` (ownership-checked) existed, but `/plan run → _runPlanBody` opened with ownership-blind `plan.load()`. `App.start()` additionally printed `▶ Active plan: "<title>" … /plan run continues it` for another session's plan. Complete path from *new session* to *executing a foreign plan*.
5. **Eight concurrent task-state axes** on one object: `taskMode`, `intentMode`, `currentPhase`, `taskstate` (14 states), `TaskLifecycle` (6), `relayState` (17), plan step status, `permMode`.
6. **Model/effort/provider fused into one string.** 3,761 registry entries, 1,359 effort-suffixed, 3,497 distinct upstream ids, 1.29 MB of config. One model appeared four times.
7. **The correct model architecture existed only as a view.** `connections.js` was wired to the `/oauth` picker; `modelcatalog` to the `/model` picker. The request path used the flat `provider:model-effort` key verbatim.
8. **~11k tokens of fixed prefix per request** — persona 3,543 + charter 827 + 68 tool schemas 6,483 — re-sent on every step of a turn, with prompt caching wired only for the Anthropic protocol.
9. **Guard accretion.** Every write guard carries a comment about the loop it later caused (`_newProjectNestGuard`: *"caused the web-counter ∞-loop"*). Added blind, debugged in production.
10. **Six fingerprint systems, three hash algorithms**, no shared invalidation rule.
11. **`src/tools.js` contains a raw NUL byte** at offset 15,935; `file` reports the source as binary. A one-shot repair script existed and was never run.
12. **Duplicate `case '/status'`** in one switch — the second branch is dead. A `command-registry.validate()` that detects exactly this existed and was never applied to the real command list.

## C. What was only unit-tested

- **`plan.js` session isolation** — 18 well-designed cases, every one calling module functions directly. Not one constructed an `App` or touched `runPlan`. This is precisely why finding B4 survived.
- `command-registry.js` — test-only module, zero production referrers.
- `idebridge.js` — test-only.
- `diagnostic.noProgress` — sole caller is an orphaned test file.
- `relay.js` — extensive tests for a subsystem disabled by default.

## D. What was actually live-tested

**Nothing, in an automated sense.** Zero tests spawn `bin/dotcli.js`. 88 test files run in-process; `routing.test.js` only imports `parseArgs`. Live behaviour was verified by hand and never captured as a regression test.

## E. What was never wired

| Item | Evidence |
|---|---|
| **FGM's AST path** | `fgmlang.analyse` only reaches AST when `deep === true`. Its one caller, `fgm.js:291`, passes no options. `grep "deep: true"` across `src/` returns a single **comment**. Every FGM edge was regex. |
| **FGM supersession / history** | Depends entirely on `graph.history`, written only by `snapshot()`. The live graph had `history: 0`. `SUPERSEDED_CANDIDATE`, `MIGRATION_INCOMPLETE` and `findReplacements` could never fire. |
| **FGM ↔ edits** | Never consulted before an edit, never updated after one, never used by verification or rollback. Model-invoked tool only. |
| **External planner** | Did not exist. `_draftPlanBody` called `backend.complete({ model: this.cfg.model })` — same model, same process, ~7.5k extra tokens per draft. |
| **`track.record()`** | Never called from `src/`. `/track` only reads a ledger nothing writes. |
| **Capability honesty** | FGM printed `python … ast ✓` for a scan that used regex, because `capabilities()` probed whether python *exists*, not whether it was *used*. |

## F. Architectural ideas to retain

1. Tool protocol persisted into the conversation (`core/turn.js`).
2. Provider failure reported as an event, never thrown out of the loop.
3. Evidence ledger as a **cache keyed on content**, never a prohibition.
4. Task-scoped vs session-scoped lifetimes made explicit.
5. Availability learned lazily from real requests; no background polling.
6. `REQUEST_READY` requires a successful request.
7. PROVIDER ≠ CONNECTION, with credential ownership modelled.
8. Effort as an axis orthogonal to model identity.
9. Plans owned by a session, retired rather than deleted.
10. Completion requires evidence; a model saying "Done." is not evidence.
11. Turn-wide tool accumulation.
12. Steering appended as *context*, never as a forced tool.

## G. Architectural ideas that must NOT return

1. A god-object REPL.
2. More than one implementation of any single question.
3. Free-text heuristics that decide whether a historical plan is "related".
4. First-character command dispatch that runs before paste awareness.
5. Single-regex continuation detection.
6. Flat `provider:model-effort` keys as the runtime identity.
7. Correct architecture built as a render-time view over a wrong data model.
8. A mandatory planning round-trip.
9. Digests assembled from a dozen overlapping producers and clipped by rank.
10. Decorative state machines that production never feeds.
11. Guards that deny the model's chosen action to enforce a workflow.
12. Claiming "implemented" on the strength of a module and a unit test.
13. Reachability gated behind a flag no caller ever sets.
14. Test suites that never launch the real binary.
