# LAIN CLI v2 — representative benchmark & evidence baseline

A reproducible, evidence-backed baseline of what a LAIN task run costs and
where those costs come from — established BEFORE any performance work, per
the benchmark brief. **It measures; it does not optimize.**

## Run it

```sh
node bench/run.js                # mock mode — deterministic, required, hermetic
node bench/run.js --task A,C     # a subset (F needs E in the same run)
node bench/run.js --live         # live mode — explicit opt-in, costs money
```

`--live` (or `LAIN_BENCH_LIVE=1`) contacts a real provider through the real
CLI at `LAIN_LIVE_BASE_URL` (default `http://127.0.0.1:20128/v1`, the same
bridge convention as the adversarial tier). No credential is stored or read.
If nothing answers, live mode refuses to run rather than silently skipping.

Outputs land in `bench/out/` (gitignored):

- `run-<mode>-<stamp>/<task>/{fixture,home,reqtrace-*.jsonl}` — the working
  copy, isolated config home and request ledger for each task, kept for
  after-the-fact inspection against the report;
- `report.txt` — the terminal report as printed;
- `baseline-<mode>.json` — the machine-readable baseline (fine for regression
  diffs; the human report is the primary artifact).

## What a task is

| id | class | what it exercises |
|----|-------|-------------------|
| A  | local symbol change | one function in one known file — the floor |
| A2 | detector validation | A done deliberately wastefully; the waste detectors MUST fire |
| B  | cross-file API change | one signature, five callers, tests included |
| C  | bug fix | a latent bug exposed by a scenario-injected failing test the run must never edit (hashed goalposts) |
| D  | unknown location | a symptom with no file named; plants an evidence-ledger reuse |
| E  | multi-step feature | new function + format option + tests |
| F  | follow-up | E's task again in E's session (`--resume`): does prior evidence carry over? |
| G  | transport retry | one planted `ECONNRESET`; mock-only (a live provider cannot be made to fail on demand) |

Every task starts from a byte-verified copy of `bench/fixture` (a small
deterministic "orderdesk" repo, green at rest, 30 tests) — the copy fidelity
is hash-checked at reset, never assumed. Scenarios only ADD state (C's
failing test); they never mutate the base.

Ground truth is behavioural: each task has a verifier that requires the
fixture's modules and runs its suite. A run cannot pass by narrating success,
and (for C) cannot pass by weakening the tests it was asked to satisfy.

## What is measured, and where each number comes from

Everything is projected from records the run itself wrote — the persisted
session JSON (the primary truth: full conversation, per-turn usage, mutations,
per-request token-audit payloads) and the opt-in request ledger
(`LAIN_REQTRACE`, one JSON line per provider request, following the
`LAIN_MOCK_WIRELOG` precedent). Nothing is measured by watching the process.

- **MEASURED** — read from a record (turn usage, reqtrace rows, mutations).
- **DERIVED** — deterministic counts/classification over the transcript.
- **ESTIMATED** — characters ÷ `tokenaudit.CHARS_PER_TOKEN`, labelled as an
  estimate everywhere it appears. Never a provider receipt.
- **UNKNOWN** — the runtime does not record it (e.g. how many times silent
  diagnostics ran); reported as UNKNOWN with whatever bound IS known.

### The evidence trace

For every evidence acquisition the trace asks: *did the run already know this
when it asked for it again?* Classification is deterministic, keyed on
content fingerprints of tool results:

- **REUSE** — the evidence ledger served the answer (the `[evidence]`
  substitution is in the transcript). Measured, not inferred.
- **VALID RECHECK** — re-acquired and it CHANGED (an edit sat between), or
  the earlier copy had been elided/folded out of context. **Legitimate;
  never counted as waste.**
- **STALE INVALIDATION** — changed with no mutation of ours between looks.
  In a hermetic fixture this means isolation leaked, and it is reported loudly.
- **REDISCOVERY** — the same, unchanged evidence re-acquired while the
  earlier copy was still in the conversation. This is the waste the
  benchmark exists to count.

Duplicate tool calls (identical name+args, both successful, nothing mutating
in between) are counted separately; a duplicate that is also a rediscovery is
counted once, as a rediscovery.

### Mock mode validates the measurement, nothing else

Mock scripts replay known tool sequences against the REAL tool layer,
filesystem and turn loop, with numbers planted on purpose: A2 plants waste
(it must be counted), D and F plant ledger reuse (it must be recognised, and
must not be called waste), G plants a transport failure (the retry must be
accounted). The report compares planted vs measured per task and a mismatch
fails the run. Mock token figures are the script's own numbers — they prove
receipts are collected and accounted, and are never comparable to provider
cost.

## The two runtime seams this added

The benchmark reuses existing instrumentation everywhere it could. Two gaps
required minimal, env-gated additions (nothing runs unless asked):

1. `LAIN_REQTRACE=<file>` — `src/reqtrace.js` appends one line per provider
   request (it already built the record in memory; it now has a sink).
2. Provider usage receipts are captured at the single funnel in
   `src/provider.js` and normalized onto the reqtrace row (cache fields only
   when the protocol states them).

Plus one persistence fix: `src/turnclose.js` now carries the `steps` and
`evidenceReuse` counters (already maintained by the runtime) into the saved
turn record — they were computed and then dropped on save.

## Non-goals (from the brief, enforced here too)

No optimization was implemented as part of establishing this baseline. No
new telemetry authority, no dashboard, no HTML. The fixture and tasks are
version-controlled; working copies are disposable.
