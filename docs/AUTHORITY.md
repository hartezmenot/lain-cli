# LAIN — the authority matrix

One authority per transition. Not "everything in Rust": Node is a legitimate
adapter wherever it only executes what a runtime has admitted or what is purely
local state. This file is the contract; when code and this file disagree, one
of them is a bug.

| Domain | Authority | Node's role |
|---|---|---|
| Input admission / held input | Rust Guardian (`offer`/`deliver`) | asks, obeys, recovers (inputgate.js) |
| Turn lifecycle truth | Rust Guardian (`turn_begin/phase/end`, owner-pid liveness) | reports facts; word-maps the outcome, judges nothing |
| **Request admission** | **Rust Guardian (`request_begin/end`)** — wired since the request-admission pass | turn.js awaits begin BEFORE the wire; denial ⇒ zero provider calls; every retry its own request id |
| Provider transport execution | Node adapter (provider.js) | sends what the runtime admitted; classified failures only |
| Provider health / rate limits (durable) | Rust supervisor (providers.rs) | availability.js is a process-local cache, refreshed before failover decisions |
| Compaction | Node ContextAuthority | the deliberate Node-side authority; Guardian owns lifecycle, not context |
| Prompt construction / cache shape | Node (promptparts/promptcache) | stable prefix + volatile tail |
| Tool implementation / dispatch | Node (tools/) | primitives stay; capability intent composes them |
| Project intelligence | `<project>/.lain/` via lainstore (sole path authority) | adapters only; the model may record intent through the four doors, never silently |
| Structural index | `.lain/index.json`, never read without checking disk | projectindex.js refreshes; no stale accessor exists |
| Architecture intent vs observed | `.lain/architecture` (intent) + reconcile.js (the ONLY writer of `observed`) | two axes never collapsed |
| Runtime notes | `~/.lain-v2/concerns/<project>.json` (`/note`) | session-scoped observations; NOT project truth |
| Evidence-backed facts | `.lain/memory/facts.json` (scratch promote) | promotion refused without evidence |
| Scratch | `.lain/scratch/<session>` | opened per turn, settled only on completion |
| Undo / source safety | checkpoint/undo subsystem; ONE snapshot system | truncation guard, verified-text edits, atomic writes |
| Conversation | session transcript | compacted in place; nothing durable deleted |
| Background shell jobs | supervisor (jobs.rs) | survive CLI death |
| `/bg` agent jobs | Node process (forked session) | die with the process; scratch survives — see classification below |
| Remote capability validation | Rust capability catalog (closed) + `unsupported_numbers` | brain.rs interprets, never commands |
| LLM reasoning | the model | may propose; the runtime decides what is allowed to happen |

## STEER IS NOT ORDINARY USER INPUT

It is a **privileged session-scoped control channel**, deliberately outside
Guardian input admission:

- accepted only for an active session/turn (steerqueue.js);
- delivered only at safe step boundaries (turn.js, between steps);
- preserved in the turn record (`record.steerTexts`, with the step it landed);
- cannot create an independent turn (it never calls submit);
- does not bypass request admission — it changes what the next admitted
  request says, and that request is admitted like any other;
- does not invoke provider transport directly.

Routing it through ordinary admission would add a round trip to a correction
whose session already passed the gate. This is a boundary decision, not an
oversight; guard it here.

## `.lain` status vocabulary

Say all four or say nothing:

    MACHINERY  the code paths exist and are tested
    POPULATED  this repository has real records
    CONSUMED   something reads them on a real path
    ENFORCED   something refuses to work without them

As of the request-admission pass, for THIS repository: architecture/dictionary/
wiring/validation are **machinery, unpopulated** (index.json and scratch are
populated; facts when promoted); architecture is consumed by handover and
`/lain` only; nothing is enforced. "Implemented" alone is a banned word for
this layer — it is how machinery came to be reported as intelligence.

## Decisions that look like gaps but are not

- **No persisted call graph.** imports/dependents/locate already answer the
  questions a call graph would, refreshed against disk; wiring records the
  edges no import graph can express (WAKES/BLOCKS/SENDS). Persisting a derived
  view would add a second thing to age. Derived stays derived.
- **Model switch: Guardian records intent, Node executes.** Rust owns the
  durable boundary (requested_model, handover arming); the execution needs the
  session's provider state that lives in Node. Adapter, not competing
  authority.
- **Browser is CLI-process-owned CDP; `/bg` agent jobs
  are Node-process-owned.** Neither is a supervisor worker yet — both die with
  the CLI process (scratch and session files survive). Classified P3: moving
  them is future work, not an oversight, and must not be assumed safe.

## The boot-window rule

A runtime that is not running cannot be an authority — for input (offer
degrades to deliver) and for requests (`requestBegin` returns null ⇒ allow).
A **booting** runtime is equally not an authority *for requests*: the first
request of a turn fires microseconds after `turnBegin` armed `wake()`, and
admission that waits out the boot stalls the hottest path in LAIN. Lifecycle
tells still queue behind the boot and land when it completes; the request
boundary arms from the first request made with a runtime already up. This is
the fix for the parked-question regression and is guarded by the fourth test
in tests/integration/requestadmission.test.js.
