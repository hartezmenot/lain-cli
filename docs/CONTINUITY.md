# CONTINUITY — the implementation record

Mission: **implement deterministic continuity, not Claude Code cloning.** The
measured inefficiency: provider interruptions → resumed turns → lost cache
locality → manual re-grounding → runtime facts reconstructed through model
narration. The constraint: fix that without weakening the existing
deterministic evidence, verification, lifecycle, cache, or completion
machinery — by composing it, not by building parallel state systems.

This is the §17 report: what was traced, what already existed, what was
adapted, what is new, and what was proved — with the verification state of
each claim stated as it actually stands.

---

## A. The architecture, as traced

Every point at which a request enters with a past:

1. **Session start / explicit resume** — the `App` constructor
   (src/app.js:98-108) takes `opts.resume` to `Session.resume(id)`; a missing
   id is announced ("Nothing was resumed; starting a new session"), never a
   silent restart. `adopt()` (src/app.js:135-163) rebinds the session, the
   checkpoint store (`load: Boolean(resumedFrom)`), and the evidence ledger —
   which now carries the owning session id, so a resumed session recognizes
   its own writes.
2. **Post-provider-interruption** — the end-of-turn save (src/app.js:366)
   fires inside `if (record)`, *including provider-death turns*; the turns
   projection records `stopReason` (src/turnclose.js:105). Nothing needs a
   stored flag: on the next prompt build, `handover.build` arms on runtime
   account, model switch, or a saved `stopReason !== 'end'`.
3. **Every entry** — `prompt.build` (src/prompt.js:381-392) calls
   `handover.build`; a non-empty packet REPLACES the working context under
   `# Session handover — continue this work`, an empty one leaves the ordinary
   `# Already established` block. One builder serves session start, explicit
   resume, post-interruption, and post-handover (C2); a finished turn with the
   same model produces no packet at all.

The packet IS the §12 compositional concept: no new database, no persistence
format — a briefing rendered from the session's own records (task, plan,
lifecycle, checkpoints, evidence ledger, turns) at read time,
deterministically, reconstructible without an LLM call (C1, C3).

## B. ALREADY EXISTED · ADAPTED · NEW

**ALREADY EXISTED** (traced, unchanged):

- The handover packet builder and its injection path (src/handover.js,
  src/prompt.js), the arming clauses, the end-of-turn save, `stopReason` in
  the turns projection, resume + adopt.
- The stable-prefix / volatile-tail split, and the fit layer that sends the
  volatile half as a trailing user turn (src/prompt.js:356-397,
  src/contextfit.js:54-61).
- Exact addressability of prior results, failures, verdicts, evidence and
  mutations: the saved session JSON (messages + turns projection), the
  evidence ledger, the checkpoint store keyed by session id. Task #17 closed
  as already-existing; nothing was added.
- The evidence mechanism itself: staleness and foreign-write refusal.

**ADAPTED** (invented-field bugs in existing projections — the machinery was
present, reading fields that exist nowhere):

- **handover.js plan section** — read a `done` field no step has ever
  carried, so every packet said `0/N done` with nothing outstanding, however
  much work had finished. Now reads `plan.completed` / `plan.remaining` —
  the same getters every other projection of the plan reads
  (src/handover.js:352-367).
- **externalrequest.js facts** — the `plan` row read `x.done`; the
  `last check` row read `s.lastVerification`, a field on no session. The
  first said "0/N steps done" forever; the second never fired, so an advisor
  was never told about a red check. Both now read the records:
  `x.status === 'done'` and `s.lifecycle.lastCommand`
  (src/externalrequest.js:128-139).
- **evidence.js / mutation guards** — the existing staleness + foreign-write
  questions gained a third: `noInspection` (src/evidence.js:374-389) — "this
  session never inspected this target at all → refuse" — composed into the
  existing `refuseIfUnsafe` (src/tools/edit.js:282-329; waived when the
  mutation is anchored to verified content) and the existing write_file
  guard chain (src/tools/fs.js:174-196). The ledger carries its owner so
  LAIN's own writes are never reported as foreign across a resume.
- **write_file schema description** — states the read-first requirement for
  existing files (src/tools/fs.js:117-124).

**NEW** (tests only — no new production subsystem):

- T1/T2, tests/unit/handover.test.js — the packet's rendered plan section:
  position from the getters, deterministic across rebuilds, present in the
  prompt of a dead-turn entry, and a completed step never re-listed as
  outstanding.
- T3/T4, tests/integration/continuation.test.js — a red check and a
  half-done plan survive a provider death; the SAME packet crosses a
  save/resume boundary.
- The EXT facts test, tests/unit/externalrequest.test.js.
- The no-inspection contract cases, tests/unit/staleread.test.js.

## C. Files changed

- src: handover.js, externalrequest.js, evidence.js, session.js,
  tools/edit.js, tools/fs.js.
- tests: unit/handover.test.js, unit/externalrequest.test.js,
  unit/staleread.test.js, integration/continuation.test.js.

## D. Continuity proof (T3, T4)

**T3** (integration tier; real App, mock provider): a turn writes a two-step
plan, reads the target, writes it, completes step 1, runs `node check.js`
(which really exits 1), and dies at a 429 QUOTA refusal. Asserted from the
runtime's own records, not the dead turn's prose:

- `lifecycle.lastCommand.ok === false`, `exitCode === 1` — the check is red
  in lifecycle, with the exit code the OS reported;
- `plan.completed.length === 1` — the step that finished stays finished;
- lifecycle not DONE — a red check completes nothing;
- and the next entry's prompt carries `Last check actually run:
  \`node check.js\` — FAILED (exit 1).`, `Plan: 1/2 steps done.`, and
  `Still outstanding:` naming `verify it` — "continue" has a there.

**T4** (same rig): after the death the session is auto-saved; a NEW App
process resumes it by id and the same facts are asserted — objective,
completed step, red check, exit code, and the last turn's
`stopReason === 'provider'` (the fact that arms the handover). Its prompt and
the in-process prompt carry the same packet lines, because both are rendered
from the same records through the one builder.

## E. Inspection-provenance proof

The third question, in the existing mechanism's own refusal shape.
tests/unit/staleread.test.js covers every answer with a distinct reason
code:

- a file that changed after the read → WRITE CONFLICT (pre-existing);
- a file this session **never read** → NO_INSPECTION_PROVENANCE (new) —
  no stale bytes, just no bytes, with an existing file about to be replaced
  by content composed from nothing inspected;
- read, unchanged, write → the ordinary path proceeds;
- LAIN's own write → never reported as somebody else's change (owner match).

Exemptions in evidence.js `noInspection`, each deliberate: no session or
ledger (a session-less context), no ledger entry for the path (staleness
answers first), an absent file (creation), and our own previous write still
standing. `edit_file`/`apply_patch` verify content by construction and are
not guarded; the destructive trio (`delete_range`, `move`, `delete`) and
`write_file` are — `delete_range`'s `expect` anchor waives the question,
because anchoring to verified content is the stronger guarantee.

## F. Cache analysis

INFERRED by construction, plus a MEASURED baseline. **No improvement is
claimed.**

- **By construction**: the digest never enters the stable prefix.
  `prompt.separate` builds the stable half from BASE + cwd + environment +
  model only (src/prompt.js:356-364); the handover packet goes into `live`
  (src/prompt.js:381-392); the fit layer sends `live` as a trailing user
  turn (src/contextfit.js:54-61). Normal turns receive no packet at all, so
  the stable prefix is byte-identical to pre-mission on uninterrupted turns
  and the volatile tail changes only at re-entry boundaries — which is what
  C2 requires. No volatile timestamps or health reports were added to the
  prefix.
- **MEASURED baseline** (docs/CONTROL-LOOP.md:88-105, :173-177):
  cacheReadTokens = 0 on every resumed turn in the observed run, while those
  turns sent an estimated 90–110k tokens against an 86–109k stable prefix;
  turn 1 of that run cached 2.08M across 98 requests. Cause unisolated
  (gateway TTL vs session restart vs marker placement — the last already
  measured irrelevant on that route).
- **UNKNOWN / not attempted**: provider cache survival across a resume is
  not fully controllable by LAIN. This mission does not rewrite the cache
  architecture (§8) and does not claim the digest improves cache survival —
  that remains the measurement-first work recorded as P1 in CONTROL-LOOP.md.

## G. Tests

Executed after the outage cleared (see below); each run is this session's
own output, not a prior baseline.

- **Syntax**: `node --check` over all eleven edited files — ALL-SYNTAX-OK.
- **Unit**: 2,156 passed, 0 failed (65.2s) — includes the new T1/T2,
  EXT-facts, and no-inspection contract tests. UNIT-VERIFIED.
- **Integration**: 135 passed, 4 failed (767.6s). All continuation tests —
  including new T3/T4 — passed. The 4 failures are the pre-existing
  remote.test.js RC cluster (bot/remote timing), environmental and
  unrelated to every file this mission touched. INTEGRATION-VERIFIED for
  this mission's surface.
- **Smoke**: 530 passed, 1 failed (2251.7s). The one failure —
  `smoke/workspace.test.js :: WS: activity shows the request, the narration
  and each call with its subject — no per-call timings in the default view` —
  is reported here as it stands, not fixed by verdict:
  - the `!/\d+ms/` assertion is **pre-existing** (an unchanged context line in
    the file's diff; its pending changes are prior UX-audit work);
  - it does **not reproduce in isolation**: three runs of the file alone
    passed 14/14 each time, and a standalone reproduction of the exact
    scenario (same workScript, same stdin steps, same delay) exited 0 with
    zero ms-bearing lines in any frame;
  - no ms renderer exists on the activity path: `dur()` in src/ui/views.js
    is defined and never called, every live time formatter emits
    seconds/minutes, and src/ui/phrasing.js documents the old ms format's
    removal;
  - the failure occurred only in the full 37-minute, 530-test run under
    system load.

  Classification: a load-dependent timing flake, NOT this mission's surface —
  none of the files this mission touched (src/handover.js,
  src/externalrequest.js, src/evidence.js, src/session.js, src/tools/edit.js,
  src/tools/fs.js) renders UI. Labeled per the STATUS.md rule: the assertion
  is NOT REPRODUCIBLE IN ISOLATION and no fix is claimed for it.

  **The confirmation re-run landed: 531 passed, 0 failed (2239.0s).** The
  full smoke tier re-run under this session's own execution passed every
  test, including the exact workspace assertion that failed under load in
  the first run. Flake confirmed, not systematic; the classification stands,
  and nothing was changed to make it pass.

**The classifier outage, reported as it happened**: for most of this
session the Bash/PowerShell/Monitor safety classifier was unavailable
("cc/claude-opus-5 is temporarily unavailable…"), so no command could be
executed; every claim above was verified statically by byte-tracing the
source until the outage cleared. The tier runs recorded here are real and
were executed the moment execution became possible; nothing above was
upgraded because the code looked correct.

## H. Deliberately not implemented

The §8 list, held to:

- No model-generated compaction summaries; no LLM summarizer of any kind —
  the digest is deterministic rendering of runtime state.
- No multi-agent or workflow engine; no Claude-style task framework; no
  second task list — the runtime's own plan is the position.
- No learned safety classifier — the provenance refusal is deterministic.
- No plan-mode clone; no environment scan before every request; no static
  git-status prompt blob.
- No tool-count expansion; no browser/Telegram/LAIN Probe work.
- No provider abstraction rewrite; no cache architecture rewrite without
  measurement; no completion guard weakening.

Immutable-completed-step semantics are unchanged except where a genuine bug
was found — the two invented-field reads — which is the mission's own
permitted exception.
