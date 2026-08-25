# LAIN v2 — benchmark & evidence baseline (established, not optimized)

This pass established the measurement baseline the optimization work will be
judged against. **No optimization was implemented.** Everything here is
projected from records the runs themselves wrote (persisted sessions, the
request ledger); nothing is measured by watching a process.

## What exists now

- `bench/` — a deterministic fixture repo ("orderdesk", green at rest) and
  seven representative task classes + one deliberately wasteful twin + one
  retry probe. `node bench/run.js` (mock, required) · `--live` (explicit
  opt-in; refuses rather than silently skips when no bridge answers).
- Every task starts from a byte-hash-verified copy of the fixture; scenario
  state is only ever ADDED. Ground truth is behavioural (verifiers run the
  fixture's modules and its suite); task C's tests are hashed goalposts the
  run must satisfy but cannot edit.
- `bench/evidence.js` classifies every evidence acquisition: FIRST / REUSE
  (ledger substitution, measured) / VALID RECHECK (post-edit or post-elision
  reread — legitimate, never waste) / STALE INVALIDATION / REDISCOVERY (the
  waste). Pinned by 16 unit tests in both directions.
- Mock mode validates the measurement itself: A2 plants waste and it MUST be
  counted, D and F plant ledger reuse and it MUST be recognised, G plants an
  ECONNRESET and the retry MUST be accounted. 8/8 tasks verified, 8/8
  instrumentation matches.

## The two runtime seams (env-gated, following the LAIN_MOCK_WIRELOG precedent)

1. `LAIN_REQTRACE=<file>` — the request ledger `src/reqtrace.js` already built
   in memory gains an opt-in sink, one JSON line per provider request.
2. `src/provider.js` captures the usage receipt at its single funnel;
   `src/reqtrace.js` normalizes it onto the row (cache fields only when the
   protocol states them).
3. `src/turnclose.js` now persists the `steps` and `evidenceReuse` counters it
   already maintained — they were computed and then dropped at save.

## What the mock baseline measured (all ESTIMATED tokens from tokenaudit)

- **The fixed floor**: every request carries ~16,362 estimated tokens of
  machinery (system ≈3.4k + 50 tool schemas ≈12.4k, corroborated by raw byte
  counts) against 0.8–4.6k of task content. Per request, 81–95% of the payload
  is fixed machinery; the stable (cacheable) prefix is nearly all of it.
- **The cost of waste, planted and counted**: the wasteful twin produced the
  identical verified result for +140% requests, +175% tool calls (2
  rediscoveries, 3 duplicate calls) and +1.4k est tokens of re-acquired content.
- **The ledger's coverage gap**: substitution guards only ≥250-line whole-file
  reads. A 354-line catalogue reread was served by the ledger (REUSE, D); a
  52-line source file was re-served verbatim (REDISCOVERY, A2).
- **Evidence survives a resume**: F's re-ask for the catalogue in E's session
  was served by the ledger across `--resume` (measured, not assumed).
- **UNKNOWN (honestly)**: real provider cost, latency and cache-hit behaviour
  (no bridge this pass); exact diagnostics run count (silent when clean — only
  an at-least bound and raised-findings count are reported).

The candidates, experiments and the single next move are in the pass report;
this file records what the baseline IS, so later passes can diff against it.
