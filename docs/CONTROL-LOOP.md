# The control-loop investigation — why Claude Code + GLM-5.3 feels more effective than LAIN + GLM-5.3

Date: 2026-09-06. Read-only investigation; no LAIN code was changed by this
document. Evidence comes from three sources, kept separate throughout:

1. **LAIN v2 source** (cited by file) — what the harness does, CONFIRMED.
2. **The benchmark baseline** (docs/BENCHMARK.md, bench/out/run-mock-2026-09-05T20-18-39)
   — reproducible mock measurements. **Its mock scripts choose the tools, so it
   demonstrates harness mechanics and strategy COST, never strategy CHOICE.**
3. **The live session corpus** (~584 real GLM-5.3 LAIN sessions in ~/.lain-v2/sessions,
   2026-08-15 → 2026-09-05) — real model behavior, retrospective, no
   counterfactual. The deep trace is session `20260905-112051-o2pn` (the E:\AI
   Telegram-assistant stabilization, 23 turns, 2026-09-05).

This session itself runs GLM-5.3 through Claude Code, so statements about how
Claude Code treats me are labeled **CONFIRMED-by-introspection** — first-person
observation of the same model under the other harness, not wire-side proof.

---

## 1. The current LAIN v2 agent loop

```
bin/lain.js            exit hygiene only (process.exitCode + unref'd 3s fallback;
                       dodges a Node 24 / Windows undici keep-alive assertion)
  └─ src/cli.js        parseArgs; -p one-shot; --resume explicit-only;
                       NEW sessions always start empty
      └─ App           REPL shell; owns UI, checkpoints, availability
          └─ identify() per input: classify → sameTask? (machinery only) →
             mode verdict → probe handoff; new task resets lifecycle/plan/
             budgets; STEER adjusts task + plan (done steps never rewritten)
              └─ runTurn (turn.js) — UNBOUNDED steps (maxSteps 0; the legacy 30
                 was LAIN's own opinion written into configs)
                  step loop:
                    steer delivery → contextfit.fit → provider.chat
                    → assistant text + tool_calls
                    → askgate → per call: gate.check → evidence check →
                       execute (tools/index.js): tool.run, then for every
                       mutation append diagnostics.reportFor (parse) +
                       filecheck.reportFor (project linter) to the result
                    → ledger.observe → result pushed to session.messages
                  endings (all through one close()): model stops / user aborts /
                  provider fails / no credential / breaker open
                      └─ turnclose: accountTo lifecycle · remember ·
                         settleScratch (only 'end'/'no-credential' spend it) ·
                         tellRuntime → guardian.rs (outcome word-map; the
                         guardian decides what an ending MEANS)
```

Who owns what — the answer to "is it the loop or the model?":

- **Strategy is 100% model-owned.** LAIN never picks tools, never decides when
  enough has been read, never impersonates the user. Its nudges are tool
  descriptions (`understand`: "read this BEFORE listing directories";
  `locate`: "Prefer this over chaining symbols → read_symbol → dependents") and
  a system prompt that says "Cheapest first / Start LOCAL". The 8-state control
  loop (DISCOVER/UNDERSTAND/PLAN/IMPLEMENT/INSPECT/VERIFY/REPAIR/DONE) exists
  implicitly, entirely as capabilities the model may drive; nothing names the
  states or transitions between them. That is deliberate: accounting, never
  judgment.
- **The runtime owns safety, transport, accounting, and completion gates.**
  Evidence gates on every mutation (`refuseIfUnsafe`: PATCH CONFLICT on
  staleness; "copy the lines out of a read_file result rather than retyping");
  per-write parse+lint diagnostics appended to results; a run_tests pre-gate
  (pretest.js: diagnostics ladder then project linter on session-changed files,
  8s budget, force:true escape named in the refusal); completion refuses while
  the last check is red; plan_step_done refuses a false finish ("that was the
  last step, but the task is NOT complete: <failing check>").
- **Compaction is pure local work and NEVER summarizes** (session.js: "COMPACTION
  HAS NEVER SUMMARISED"): results >400 chars beyond the 10 most recent are
  stubbed with first-line + "Re-run the call if you need it"; _forgetElided
  retracts the ledger's evidence claims; _semanticResidue keeps a ~18x smaller
  present-tense outline; folding snaps to unit boundaries and keeps the index-0
  objective verbatim.

## 2. Why Claude Code may feel better — with confidence labels

**CONFIRMED (code + live transcript evidence):**

- LAIN has the write-level feedback loop Claude Code is praised for. Every
  mutation returns diagnostics inline and immediately; the live 2026-09-05
  transcript shows the model riding it: `apply_patch` → `py_compile && pytest`
  → `plan_step_done` → next targeted read; an 8-op batch patch with
  anchor-counting; single-test traceback diagnosis; routing suite progressed
  4/12 → 12/12 and the full suite reached 213 passed / 2 skipped. **GLM-5.3
  under LAIN already behaves like the "experienced VS Code developer."**
- The dominant inefficiencies in that same session are harness/context-level,
  not strategy-level:
  - **Fragmentation**: 23 turns, 12+ of them "continue" handovers after
    rate-limit endings (stopReason "provider" on most turns).
  - **Cache — corrected 2026-09-07 by full-corpus extraction; see §2a.** The
    earlier claim in this file — "every later, resumed turn shows
    cacheReadTokens = 0" — is contradicted by the corpus it cites: five of the
    seven turns that read cache (t3 78,912; t12 767,936; t13 628,800;
    t14 733,184; t19 3,228,643) were themselves resumed turns. Dead cache is
    not a resume property and not a TTL property (t12: 2h13m gap → 767k
    cached; t23: 1h52m gap → 0). It is a **late-session phase change**: turns
    through t19 (Sep 5, ≤15:00) cached; from t20 onward nearly everything
    reads 0, against requests that are 98–99% stable prefix by LAIN's own
    audit. This is still the largest single measured inefficiency in the
    corpus — but its cause splits into one confirmed LAIN-side ceiling (§2a,
    fold regime) and one unexplained floor that per-request instrumentation
    (reqtrace, sink off in this run) exists to catch.
  - **Re-grounding ritual**: 12+ turns open with the model manually rebuilding
    its trust-state in narration ("Re-grounded on the verified state: 9 files
    changed, routing suite 9/12, three pinned failures…") — the model paying
    tokens to reconstruct what a harness could hand it.
  - **Plan churn**: a plan that grew to 133 steps, mostly later dropped, 15+
    revisions logged.
  - **Elision pressure**: 286–338 elided results per request at 753–755
    messages; the model self-managing output size (`| tail -14 | cut -c1-120`,
    `--tb=no`, redirect to /tmp then grep) and narrating "tiny reads only,
    since larger outputs keep getting elided".
  - **Tool bypass**: `run_tests` and `discover_tests` were used 0 times in 914
    tool calls; `run_bash` ×479 instead, with self-managed truncation. The
    verification loop still worked (pytest output carries the signal), but the
    purpose-built tools were unattractive enough to bypass entirely. **Why, is
    UNKNOWN** — possible causes (verbosity, elision distrust, flexibility) are
    not separable with current evidence.
- **Anthropic-protocol caching is implemented and correct** (provider.js: moving
  breakpoint on the last message; system + tools marked). The chat/gateway path
  does not send markers because a real A/B measurement on this gateway showed
  they changed nothing (promptcache.js header: marked and unmarked requests
  cached identically). So "LAIN forgot caching" is false; "caching silently
  stops helping after a resume on this route" is what the receipts show.

### 2a. The corrected cache finding (full-corpus extraction, 2026-09-07)

Every number below was read directly from
`sessions/20260905-112051-o2pn.json` (765 requests; turn-level `usage` and
per-request `audits`). The turn table, verified by sum: the seven turns that
read cache account for exactly the session's total cacheReadTokens of
7,538,787 (2,083,200 + 78,912 + 767,936 + 628,800 + 733,184 + 3,228,643 +
18,112).

| turn | window (2026-) | req | est-tok/req | cacheRead | stop |
|------|----------------|-----|------------|-----------|------|
| t1   | 09-05 03:21 | 98  | ~48k avg | 2,083,200 | provider |
| t2   | 09-05 06:38 | 74  | 90–110k | 0 | provider |
| t3   | 09-05 08:56 | 5   | ~89k | 78,912 | provider |
| t12  | 09-05 11:19 | 62  | 90k+ | 767,936 | aborted |
| t13  | 09-05 11:45 | 19  | 90k+ | 628,800 | provider |
| t14  | 09-05 13:26 | 77  | 90k+ | 733,184 | provider |
| t19  | 09-05 14:37 | 141 | 90k+ | 3,228,643 | provider |
| t23  | 09-05 18:36 | 64  | ~90k | 0 | end |
| t24  | 09-06 05:30 | 19  | ~90k | 0 | provider (429) |
| t25  | 09-06 11:48 | 101 | ~120k | 18,112 | provider |
| t26  | 09-06 16:20 | 4   | ~135k | 0 | provider |

**FALSIFIED:** "resume kills cache" (t3/t12/t13/t14/t19 all resumed turns and
all cached); "TTL gap kills cache" (t12 resumed after a 2h13m gap and cached
767,936; t23 resumed after 1h52m and read 0).

**What the dead turns actually look like.** The per-request `audits` carry
`chars.stablePrefix` — the size of the part of the request that did not change
since the previous request. t26's four requests show it growing monotonically
(480,749 → 481,237 → 483,042 → 484,231 chars, i.e. each request shared
~120k est tokens of head with its predecessor — the ideal append-only cache
shape) with a constant head, and read 0 on all four.

**Confirmed LAIN-side cause 1 — head drift at turn boundaries.** The stable
half's own size changed repeatedly across the session: system 12,714 (t1) →
12,732 (t2–t3) → 12,716 (t4) → 12,720 (t5–t18) → 12,721 (t19) → 12,731
(t20–t22) → 12,732 (t23–t24) → 12,721 (t25–t26); toolSchemas 39,276 (t1) →
45,351 (t2+) → 45,521 (t~20+) → 45,616 (t25+). Any byte change at the head
re-prices everything behind it. The system drift has an identified mechanism:
the stable half carries the project brief, whose tree listing reacts to the
target tree's own mutations — a session that edits its own cwd rewrites its
own cache head at every turn boundary. The schema drift has a candidate
mechanism only: the tool list is conditional on live state (tools/index.js —
probe/connection, browser runtime, MCP config), so an environment change
adds/removes tools mid-session.

**Confirmed LAIN-side cause 2 — the fold regime (explains t25's 18,112).**
t25's only cache read ≈ the head: est system 3,534 + toolSchemas 12,671 +
first user (objective) message ≈ 18k tokens — cache served tools + system +
messages[0] and diverged at messages[1]. `_foldOldest` (session.js) does
`messages.splice(1, gone.length, summary)`: every fold rewrites messages[1].
At the message cap this session ran at (753–755 messages, 286–363 elided per
request), every append past the cap triggers a fold, so **every request
re-prices from index 1 onward** — the conversation body never caches, only
the head does. This is a structural ceiling: as long as the session sits at
the message cap with folding active, cache is bounded at the head (~18k),
not the conversation. It is also the one cause with a cheap, isolated
candidate fix on LAIN's side (fold into the TAIL's stable position less
often, or hold messages[1] stable across folds — see §6).

**Unexplained floor — turns t23/t24/t26 read 0 against ideal shape.** t26's
head was byte-identical to t25's (system 12,721, toolSchemas 45,616; t25
still got its head-only 18,112 read 17 seconds earlier) and t26 read 0. t24
held a constant 12,732 head across its requests and read 0 for its whole 19
requests. These point at something per-request that the session JSON does
not record: model/connection failover (t24's own transcript narrates
omniroute upstream auth-verify timeouts and mid-turn 401/429s — a route
change is a cache-namespace change), or gateway-side upstream eviction.
`cacheCreationTokens: 0` on every one of the 765 requests — including turn
1, which read 2.08M — means this gateway never reports cache writes at all,
so creation-0 is evidence of nothing.

**The instrument already exists.** `src/reqtrace.js` records per request:
model, connection, reason (STEP/REFIT/RETRY), ms, and the usage receipt with
cacheReadTokens, and `LAIN_REQTRACE=<path>` appends the ledger as JSONL —
one line per request. The corpus ran with the sink off; that is the only
gap. The §5 experiment therefore needs zero code changes: run live with the
sink on, and the model/connection column either confirms or eliminates the
failover hypothesis directly. bench/run.js already sets `LAIN_REQTRACE` for
mock runs (line 250), so benchmark comparisons get the same ledger for free.

**CONFIRMED-by-introspection (I am running under it):**

- Claude Code stamps a rich environment into every system prompt (cwd, OS,
  git status with the full modified-file list, recent commits) and promises
  continuity across context breaks ("work can continue — you don't need to
  wrap up early or hand off mid-task"; the summary plus remaining context is
  handed to the next window). Under LAIN, an equivalent break ends the turn
  and the model must hand itself back in.

**LIKELY (consistent with all evidence, not yet isolated):**

- The felt gap is mostly **continuity**: same model, same write-loop, but one
  harness preserves momentum across provider interruptions and context breaks
  while the other makes the model re-earn its state every "continue".

**POSSIBLE / UNKNOWN (do not act on these):**

- Claude Code's wire-side cache behavior against this gateway (I cannot see
  its request bodies from inside): UNKNOWN.
- Its retry/sampling policy: UNKNOWN.
- Whether a harness-rendered task list (Claude Code) is intrinsically cheaper
  to keep coherent than LAIN's model-re-emitted plan: UNKNOWN; the churn is
  observed, the mechanism is not.

## 3. The "VS Code effect"

The user's theory was: Claude Code works local (small read → hypothesis → seam
edit → inspect → verify → stop) while LAIN works global (read everything →
giant plan → many edits → late discovery → repair damage).

**The live evidence does not support the model-level half of this theory.**
GLM-5.3 under LAIN works local: targeted `sed -n`/`grep -n` reads before
patches, immediate compile+test after each patch, failure-driven repair,
pinned-failure triage ("identity-test assertion — test-side; `_run_image_intent`
returns no `outputs` — app-side"). The wasteful global pattern exists — the
benchmark's A2 twin demonstrates it costs +140% requests / +175% tool calls —
but that twin is a script written to be wasteful, not a measured behavior of
the live model.

What the live session shows instead is the effect being **punctuated, not
absent**: every interruption (rate limit → "continue") resets the working
rhythm, and the model spends its own tokens re-grounding before it can resume
the local pattern. The "VS Code developer" is in there the whole time; the
harness keeps tapping them on the shoulder. **The effect lives in the
harness's continuity, not the model's strategy.**

## 4. Missing LAIN capabilities (evidence-backed, ranked)

- **P0 — State carry across turn boundaries.** The re-grounding ritual is
  12+ occurrences of the model reconstructing what the runtime already knows
  (files changed, last verified check, pinned failures). Evidence: live
  transcript. This is the direct candidate for a "verified-state digest at
  handover" — but see §6: not implemented, not yet justified for
  implementation.
- **P1 — Cache after resume → re-scoped 2026-09-07: the late-session cache
  phase change.** The original framing ("cacheReadTokens = 0 on resumed
  turns") is falsified by the corpus (§2a): five of the seven caching turns
  were themselves resumed turns. Dead cache begins Sep 5 evening (turns 20+)
  and has two confirmed LAIN-side contributors — head drift at turn
  boundaries and the fold regime bounding cache at the ~18k head — plus an
  unexplained literal-0 floor (t23/t24/t26) that per-request
  model/connection recording (reqtrace) exists to catch. This is
  measurement-first work: run live with the `LAIN_REQTRACE` sink on (§5); the
  receipts already capture everything needed.
- **P2 — Test-feedback tool attractiveness.** run_tests/discover_tests 0/914
  uses; the model self-served via run_bash. The loop worked; the tool did not
  get used. Cause UNKNOWN. Any change here needs a live A/B before it is
  justified.
- **P3 — Elision pressure on just-learned signals.** The 10-recent window
  stubs test output the model just used, and the model narrates distrust of
  large results. This is a real observation but entangled with P1/P2; no
  change proposed.
- **Not gaps:** seam discovery (locate/understand answer "where does this
  live, who imports it" in one pass, with the LEXICAL honesty caveat), tool
  provenance stamps, refusal-with-reason, execution failure classification,
  evidence ledger, completion gates. LAIN is at or ahead of Claude Code on
  each of these by direct comparison.

## 5. The smallest experiment (zero code changes)

Run benchmark task A (or the E:\AI task shape) **live** through LAIN v2 on the
real provider, and the same task through Claude Code CLI in the same fixture
copy, when the bridge returns (~2026-09-12). Compare using only existing
instrumentation: LAIN's session JSON (requests, toolNames, actions, mutations,
verifiedChecks, stopReason, per-request audits, usage receipts incl.
cacheReadTokens) against Claude Code's own transcript records. Both runs must
finish with green tests to count. Then:

- Live LAIN shows the LOCAL pattern → the model-level theory is falsified
  (it is already contradicted by the retrospective corpus; this makes it
  controlled).
- Live LAIN shows the GLOBAL pattern → the user's theory survives and the
  harness explanation weakens.
- Separately, one config A/B (`promptCache: true` vs default, 2 runs each),
  **with `LAIN_REQTRACE=<file>` set in both arms** — the sink was off in the
  corpus run, and it is the only instrument that records model/connection per
  request, which is what the §2a unexplained floor (t23/t24/t26) needs. Read
  the ledger per request, not per turn: the fold regime (§2a, confirmed)
  predicts head-only reads (~18k) on every request past the message cap;
  route failover predicts literal-0 requests clustered around errors; a
  literal-0 with no route change and ideal stablePrefix shape points at the
  gateway. If the promptCache arms move cacheReadTokens, a small real fix
  exists; if they stay at the head-only/0 pattern (the honest prediction, per
  promptcache.js's measurement), the cost is structural and the fix target is
  the fold regime (§6), not the markers.

## 6. If a code change is justified (not implemented)

**One cause is now confirmed and has a candidate fix; the rest remain behind
the bar.** Per §2a: the fold regime (every fold rewrites `messages[1]`,
bounding cache at the head) is confirmed from the corpus; head drift from the
project brief reacting to the session's own mutations is confirmed as a
mechanism; turns t23/t24/t26's literal-0 remains unexplained pending the
reqtrace-backed live run. The candidates, in the order the evidence points:

1. **Fold-regime cache ceiling (the §2a confirmed cause).** The candidate:
   `_foldOldest` splices at index 1 — every fold changes the byte content at
   messages[1], so the conversation body never caches at the message cap.
   Options: fold into a position that leaves messages[1] byte-stable across
   folds (a fixed fold summary slot), or cap fold frequency (batch folds so
   a fold happens every N steps, not every append). Touches session.js
   `_foldOldest` only; unit-testable without a provider (assert the bytes of
   messages[1] across folds). **Requirement: the live reqtrace run first** —
   if the gateway serves head-only reads even for ideal payloads, fixing the
   fold changes nothing on this route, and per the mission's §23 rule the
   fix would not survive measurement.
2. A verified-state digest served at handover (replaces the re-grounding
   ritual; touches identify/turnclose; small, isolated).
3. Keeping a turn alive across provider rate-limit endings instead of closing
   it (touches turn.js endings; larger; only if the cache A/B proves the cost
   is structural, not marker-related).
4. Trim/reshape test tool output (touches tools/tests.js; only after a live
   A/B shows the bypass is about the tool, not the context).

## 7. Benchmark plan (baseline vs candidate, without corrupting the baseline)

The benchmark is the evidence baseline and stays untouched: mock runs stay
reproducible, reqtrace/audits/usage receipts/evidence classifier unchanged,
A/A2 twins unchanged. Any candidate LAIN is evaluated by: (1) reproduce the
mock baseline on the same bench version; (2) run the LIVE variant of the same
tasks on baseline and candidate from separate checkouts, same fixture copies,
same quota window; (3) report **correctness-adjusted work per completed task**
— completed-with-green-tests as the gate, then requests / toolCalls /
est-tokens / cacheReadTokens as cost (all already captured); (4) decision
quality read from the transcript by the existing FIRST/REUSE/VALID-RECHECK
classifier. Strategy cost is MEASURED (the twins); strategy CHOICE remains
UNKNOWN until live runs return, and the report says so rather than inventing
a metric.

---

### What was falsified, what survived

- **Falsified:** "GLM-5.3 through LAIN works globally-greedy." The one deep
  live trace shows the opposite. The A2 pattern is real but priced by
  construction, not observed.
- **Falsified 2026-09-07 (§2a):** "caching dies after resume" and "TTL gap
  kills cache" — both contradicted by the corpus's own resumed-turn reads
  (t12: 2h13m gap, 767,936 cached).
- **Survived and sharpened:** "The harness is the difference." But the
  difference is not the write/verify loop (LAIN has it, and it works); it is
  continuity across interruptions — the late-session cache phase change
  (§2a: fold-regime ceiling confirmed, t23/t24/t26 floor unexplained pending
  reqtrace), state carry, and context pressure under elision.
- **Unknown and honestly so:** Claude Code's wire-side cache/retry/sampling;
  why the live model bypassed run_tests; whether harness-rendered task
  tracking is intrinsically more coherent than a model-re-emitted plan; the
  per-request cause of t23/t24/t26's literal-0 reads.

### Separate note

The live session record contains a provider API key the user pasted into chat
during that task (the model flagged it as leaked and refused to use it).
Treat that credential as compromised and rotate it. The value is not
reproduced here.
