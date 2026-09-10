# LAIN CLI vs Claude Code — the competitive gap matrix

Rules this matrix obeys (from the mission brief): every row carries a confidence
label; "do not assume Claude is better, do not assume LAIN is better"; claims are
grounded in files read this pass, in `bench/out/` measurements, in
docs/CONTROL-LOOP.md's labelled corpus findings, or in first-person observation
of Claude Code from the prior session. Where neither harness was measured on the
specific claim, the row says UNKNOWN rather than guessing.

Labels: **CONFIRMED** (code read + tests, or a measurement) · **INFERRED**
(consistent with code/measurements, not directly isolated) · **UNKNOWN**.
Verdicts: LAIN-AHEAD / PAR / CLAUDE-AHEAD / MISSING (LAIN has no equivalent).

---

## A. Where LAIN is ahead — protect, do not rebuild

| # | Capability | Claude Code behavior | LAIN behavior | Evidence | Label / verdict |
|---|---|---|---|---|---|
| 1 | **Mutation guards** | Edit is exact-string replace; failure says "not found", no closest-line report; no truncation guard on Write | apply_patch: content anchor + uniqueness + CRLF-normalise + `whyNotFound` (CHANGED SINCE READ / WHITESPACE / lone CR / UNICODE FORM / INVISIBLE CHARACTERS) + closest-line; write_file: staleness (WRITE CONFLICT) → NO_INSPECTION_PROVENANCE → TRUNCATION REFUSED; delete_range/move/delete `expect`-anchored | src/tools/edit.js, src/tools/fs.js, src/evidence.js; tests/unit/staleread.test.js | CONFIRMED · LAIN-AHEAD |
| 2 | **Completion truth** | Model claims done; nothing checks the claim against a check | red check cannot complete; plan_step_done refuses false finish; contradiction check challenges "all tests pass" over a red suite; BASE: "CODE EXISTS IS NOT THE FEATURE WORKS" | src/app.js submit tail (maybeComplete→contradiction), src/gate.js, src/prompt.js BASE | CONFIRMED · LAIN-AHEAD |
| 3 | **Evidence ledger + stale-read protection** | none | per-path stamps; ledger substitution for unchanged ≥250-line whole reads; foreign-write detection across forked sessions; digest with recovery routes | src/evidence.js; bench D/F planted REUSE verified | CONFIRMED · LAIN-AHEAD |
| 4 | **Request accounting** | /cost summary | reqtrace: per-request id/turn/step/reason (closed set: step/refit/retry/external/machinery) + ms + usage receipt incl. cache fields; token pane labels MEASURED vs ESTIMATED; audits per request | src/reqtrace.js, src/tokenaudit.js, ui/tokenview.js | CONFIRMED · LAIN-AHEAD |
| 5 | **Rate-limit policy** | opaque retry | hours-long limits END the turn with resumeAt ("a decision, not a retry"); circuit breaker skips shut routes costing zero requests; availability learned lazily, no ping loop | src/ratelimit.js, src/turn.js, src/availability.js | CONFIRMED · LAIN-AHEAD |
| 6 | **Background jobs across death** | background shell jobs die with the process | supervisor-owned jobs survive app death; HANDOVER-6/7/13 tested (worker completes after app died; same job across model switch) | src/supervisor.js; tests/integration/supervisor.test.js | CONFIRMED · LAIN-AHEAD |
| 7 | **Runtime authority** | none (in-process) | request admission under runtime-issued ids; turn authority; guardian.rs owns endings' meaning | src/guardian.js, src/turnauthority.js; tests/integration/requestboundary.test.js 7/7 | CONFIRMED · LAIN-AHEAD |
| 8 | **Provenance refusals** | permission prompts, no provenance concept | NO_INSPECTION_PROVENANCE: refuses replacing a file this session never inspected; exemptions enumerated (absent file, our own write standing, session-less ctx) | src/evidence.js noInspection; src/tools/fs.js | CONFIRMED · LAIN-AHEAD |
| 9 | **Stable-prefix discipline** | cache managed by the harness, invisible | stable/live split measured: billed input −11.2%, cache hit 59.2%→63.8%, total input unchanged; volatile block is a user turn, never system | docs/STATUS.md token-incident section; src/promptparts.js, src/contextfit.js | CONFIRMED · LAIN-AHEAD (the *discipline*; the post-resume cache outcome is row 20) |
| 10 | **Deterministic compaction** | model-generated summary of the dropped context (irreversible, lossy-by-judgement) | never summarizes: stubs with name+args+first-line+"Re-run the call"; semantic residue (~18× smaller present-tense outline); fold keeps user words verbatim ≤400; index-0 objective never folded | src/session.js compact/_semanticResidue/_foldOldest | CONFIRMED · LAIN-AHEAD on recoverability; Claude ahead on shrink ratio (a summary is smaller) — the tradeoff is documented, not resolved |
| 11 | **Resume → state re-entry** | auto-continues inside one window; across windows, a model-written summary | deterministic handover packet: runtime why, task+steers, VERIFIED-changed-on-disk vs notLanded, .lain alarms, last check + exit code, plan N/M + outstanding, jobs, shut routes, evidence digest, undelivered input, verbatim continuation directive | src/handover.js; tests/integration/continuation.test.js T3/T4 | CONFIRMED · LAIN-AHEAD on determinism; Claude ahead on *frequency of the break* (see row 20/21) |
| 12 | **External advisor** | none native | /external: second model review; facts fixed to read real records (plan.status, lifecycle.lastCommand); capability discriminator on model names | src/externalrequest.js; tests/unit/externalrequest.test.js | CONFIRMED · LAIN-UNIQUE |

## B. Where the harnesses are at par (different shapes, same capability)

| # | Capability | Claude | LAIN | Evidence | Label / verdict |
|---|---|---|---|---|---|
| 13 | **Slash commands** | large built-in set + custom | commands.js with deterministic guards; /health /token /doctor /bg /ps /note /external; completion.js guards | src/commands.js, completion.js; smoke commands-audit | CONFIRMED · PAR |
| 14 | **Multi-model / failover** | Opus/Sonnet/Haiku + custom; manual switch | catalog, failover offering cheap-before-expensive, provider health moving to runtime, model switch carries handover packet | src/catalog.js, src/failover.js | CONFIRMED · PAR (LAIN ahead on health observability) |
| 15 | **Plan mode** | plan mode + approval gate | plan.js immutable completed steps; migration_plan contract tools; plan digest rides the volatile tail | src/plan.js, tools/plan.js, tools/migrate.js | CONFIRMED · PAR (LAIN lacks an approval gate — deliberate: runtime authority instead) |
| 16 | **Task tracking** | TodoWrite (model-claimed) | session.plan completed/remaining getters are the position; plan_step_done verifies | src/plan.js | CONFIRMED · LAIN-AHEAD (truth-checked) — listed par-to-ahead |
| 17 | **Web access** | WebSearch + WebFetch always | web_fetch always (plain GET, headless); web_search follows the browser runtime | src/tools/web.js, tools/index.js:135-147 | CONFIRMED · PAR |
| 18 | **Thinking modes** | extended thinking, effort control | reasoning stream kept separate from answer text, bounded; effort in header | src/turn.js reasoning branch, ui/conversation.js | CONFIRMED · PAR |
| 19 | **Input UX** | readline: history, paste, emacs keys | lineedit, keydecode, mouse caret placement, paste-as-one, history browse over input box | src/input.js, lineedit.js; smoke uxfoundation | CONFIRMED · PAR |
| 20 | **Prompt caching mechanics** | automatic, invisible, effective across turns (observed from inside: this session's own context survives compaction boundaries) | moving breakpoint on anthropic path; system+tools marked; chat path reads cached_tokens from all spellings; markers off by default after an honest A/B (gateway cached identically without them) | src/provider.js:386-435, src/promptcache.js; corpus extraction 2026-09-07 (CONTROL-LOOP §2a) | CONFIRMED mechanics · **dead cache is a LATE-SESSION PHASE CHANGE, not a resume property** — fold-regime ceiling (every fold rewrites messages[1]) CONFIRMED; t23/t24/t26 literal-0 UNEXPLAINED, needs the reqtrace sink (CONTROL-LOOP §5) |
| 21 | **Interruption survival** | one window continues through provider errors without user action | provider death ends the turn with a record; next input arms the handover; rate limits are asked about (wait or switch model) | src/turnclose.js, src/app.js handleRateLimit | CONFIRMED · Claude-AHEAD on seamlessness — the 12+ "continue" boundary ritual in the live corpus is LAIN's largest measured UX gap (CONTROL-LOOP §2) |
| 22 | **Diagnostics on edit** | IDE squiggles feed back only in IDE | parse + unresolved-names + project linter appended to every mutating result, silently clean otherwise | src/tools/index.js execute, src/diagnostics.js, filecheck.js | CONFIRMED · LAIN-AHEAD |
| 23 | **Undo/checkpoints** | git implicit; explicit rewind in some builds | capture-before-mutate per session; /undo /changes; earliest-bytes diff rule; settle fingerprints | src/checkpoints, ui/panes.js:42 | CONFIRMED · LAIN-AHEAD |

## C. Where Claude Code is ahead — the genuine gaps

| # | Capability | Claude behavior | LAIN behavior | Evidence | Label / verdict |
|---|---|---|---|---|---|
| 24 | **Environment snapshot (git)** | stamps cwd, OS, git status + modified files + recent commits into every system prompt | envdetect: cwd, OS, shell, package manager, venv, test runner — **no git state at all**; gitsense.js exists but is wired only to survey.js + review_changes, never the prompt | src/envdetect.js (read in full — no git), src/gitsense.js, grep: only survey.js:84 + tools/semantic.js:577 require it | CONFIRMED · **GAP — candidate 1** |
| 25 | **Prior-result addressability** | transcripts replayable by the harness; the model can quote old results from the summary it was handed | session JSON holds every result, but NO tool retrieves a prior result by id; stubs say "Re-run the call"; quietPass explicitly advises re-running the suite with run_bash+grep to confirm one test — concrete repeat-generators | src/tools/tests.js:270-273, src/session.js stubs, grep across tools/ for retrieve/recall | CONFIRMED · **GAP — candidate 10** |
| 26 | **Test-tool attractiveness** | n/a (no dedicated test tool; shell+judgement, works fine) | run_tests/discover_tests well-built (pretest gate, classified verdicts, cheap discovery) but live corpus: **0/914 uses, run_bash ×479**; cause UNKNOWN — the tools lose to raw shell choreography despite being better built | docs/CONTROL-LOOP.md:106-111; mock bench uses run_tests heavily (harness works) | CONFIRMED observation · **UNKNOWN cause — candidate 6, needs live A/B** |
| 27 | **Sandboxed execution** | commands run sandboxed by default | no sandbox: trust.js directory gate + permission prompts on writes outside trust | src/gate.js, src/trust.js | CONFIRMED · MISSING (architectural; not in mission scope to build) |
| 28 | **Subagents / hooks / IDE / skills** | Task tool; PreToolUse/PostToolUse hooks; IDE extensions; skills | none of these (grep: no hook system, no CLAUDE.md/AGENTS.md reader; probe-side skills only); /bg covers the background case | greps across src/ | CONFIRMED · MISSING — and per mission §2 deliberately NOT to be copied (no multi-agent orchestration, no hook layer); recorded as intentional divergence, not backlog |

---

## The rows that drive implementation ranking

- **Row 24 (git snapshot)** is the smallest confirmed gap with daily frequency:
  the instrumentation (gitsense.status) exists unused; the injection seam
  (handover packet / workingContext, volatile tail only) exists and is measured;
  the memo discipline (stable prefix) shows exactly where it must NOT go.
- **Row 25 (addressability)** is the confirmed repeat-generator: three concrete
  instances found (stub advice, quietPass advice, no retrieve-by-id).
- **Row 20/21 (cache + interruption rhythm)** is the largest measured cost but
  the cause is UNKNOWN and needs the live experiment before any code — per the
  mission's own "do not rewrite cache architecture blindly".
- **Row 26 (test tools)** needs a live A/B to separate verbosity/elision/
  flexibility hypotheses; mock mode cannot answer it (the script chooses tools).
