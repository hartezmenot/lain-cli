# Harness stabilization evidence — 8–9 September 2026

This report covers the existing Harness infrastructure in the shared working
tree. The concurrent CLI pass continued changing the tree during validation;
the counts below describe particular runs, not an immutable release commit.

## 1. Baseline inspected

The starting tree already contained the Harness, its integration seams, six
distribution modules, and extensive uncommitted CLI work. The historical
147-test Harness claim includes integration scenarios; the initial unit-only
Harness selection had 139 tests. Independent baseline runs found:

| Run | Passed | Failed |
|---|---:|---:|
| Full unit baseline | 2,221 | 3 |
| Harness scenarios, execution lifetime and supervisor baseline | 25 | 0 |

Two unit failures expected the deliberately removed `/audit` or
`/troubleshoot` commands. A third inherited `TERM=dumb` from the host. Neither
removed command was restored. The initial OS inventory contained 150
supervisors: 149 from the repository release path and one debug executable.

## 2. Ownership boundary confirmed

`task.js` retains conversation task identity and continuation classification;
`lifecycle.js` retains conversation liveness; `events.js` is the canonical bus.
Harness execution state adapts to those systems. `testing.js` and `execution.js`
retain their classifications, `lainstore.js` owns `.lain` paths, and
`gate.js`, `trust.js`, and `permissions.js` retain enforcement. `jobs.js` still
owns finite background jobs; managed services retain their health vocabulary.

No new CLI surface or dashboard was built. The presentation seam adds an
event-derived `{state, action, target, timestamp}` activity projection, without
model reasoning text or a presentation timer. Narrow shared edits cover
supervisor startup, foreground execution ownership, task-path normalization,
the existing Harness projection, and regression tests. CLI title assertions
follow the concurrent pass's documented project-only title; UI code was not
changed for those assertions.

## 3. Process lifecycle investigation

### Spawn path and ownership

* `supervisor.ensure()` starts the Rust `serve --home <captured home>` process.
  Production supervisors remain intentionally durable. Test runners and each
  spawned CLI instead provide a loopback lease whose EOF ends their supervisor.
* Services, verification commands, shell commands and direct program execution
  share `processes.spawnOwned()`. The application owns a detached guardian via
  IPC. The guardian owns a stable command-tree root; that root owns the shell
  or program and its descendants. The public execution PID is the actual
  command's PID; its cleanup owner is recorded separately.
* On normal command exit, failure, timeout, cancellation or caller death, the
  guardian kills the command tree from outside that tree and waits for exit.
  POSIX uses a separate process group; Windows uses `taskkill /T /F`.
* Managed task settlement and Harness shutdown await service/browser cleanup.
  Browser scratch cleanup also has a sibling helper that can outlive the
  browser tree. Startup timeouts stop the actual spawned supervisor even when
  discovery was never published.

### Root causes and fixes

The supervisor's deliberately durable detached lifetime was also used by
short-lived test clients. Happy-path teardown could not handle an interrupted
or killed owner. In addition, startup read mutable global home state, concurrent
clients could publish competing endpoints, and failed startup could lose the
spawned PID. Startup now captures its home, shares in-flight work per home,
tracks owned children, and removes failed/cancelled launches. Rust holds an OS
file lock for the entire serving lifetime and refuses failed endpoint
publication. Tests require the non-serving `where` response's `lease-v1`
marker before they can start a supervisor; an old binary produces a clear
rebuild error rather than silently bypassing ownership.

Real descendant tests also exposed foreground Windows failures. Passing cmd
command text as ordinary argv escaped quoted paths. The cmd path now uses
Node's Windows shell quoting. A cleanup owner attached to its caller's Windows
lifetime could die before handling IPC disconnect. It is now detached, while
referenced IPC keeps normal calls awaitable. The command-tree root stays alive
after a shell exits, and the killer runs outside its target subtree.

`cleanupOwned()`, CLI teardown and Harness shutdown expose cleanup errors.
Temporary filesystem-lock races receive bounded retries; persistent locks
remain visible failures.

Remote tracing identified another concrete Windows defect: Rust's curl
children could allocate a console for each HTTP call beneath the detached
supervisor. Concurrent runs exceeded a 20-second test deadline even though the
local model fixture answered immediately. The narrow repair uses
`CREATE_NO_WINDOW` for the existing curl commands; transport, protocol and
deadlines are unchanged. The same isolated two-call remote case took 22.1
seconds before the change and 0.8 seconds afterward, with request/response
timestamps confirming the difference. This change preceded the final
sequential remote runs and full integration rerun.

## 4. Existing orphan handling

`tools/cleanup-supervisors.ps1` is a dry run unless passed `-Apply`. Eligibility
requires the exact repository executable path, a serving command, a temporary
test-home endpoint, matching PID/start time, and an absent or reused parent.
PID creation time and executable identity are rechecked immediately before
termination. It never kills by name alone and does not scan the user's runtime
home for deletion.

The applied cleanup stopped 42 proven stale test supervisors and preserved 109
whose identity or test ownership was unproven at that scan. Later global
counts changed while other runs were active; they are not attributed to this
patch. Pre-fix controlled crash fixtures were separately stopped only after
matching their recorded PID, creation time and exact fixture command. Three
recorded workers from a failed diagnostic experiment were also removed after
confirming their original owners were absent.

## 5. Regression coverage

The integration fixtures start real OS processes and listening sockets. They
check actual PID exit and closed ports for success, failure, timeout,
cancellation, application hard death, supervisor startup failure, test-owner
death and simultaneous clients. Browser tests check real Chrome processes,
DevTools ports, sessions and scratch-profile removal. One-shot CLI tests start
a real service and check its port is closed after CLI exit. Assertions do not
merely verify that a cleanup function was called.

Additional checks cover continuation/repair lineage, material-only persistence,
read-only doctor behavior, CRLF source guards, temporary versus persistent cwd
locks, truthful result PIDs, artifact index publication failure, and current
command-surface expectations. Literal control characters in three newly added
CLI tests were expressed as escapes; the product behavior was preserved.

An additional active-job lease test was added after the combined lifecycle
repetitions. It passed three times: killing the test owner stopped the Rust
supervisor, its running job, the command and leaf process, and the listening
port. The final full integration run includes this additional test.

## 6. Verification invariant audit

Only a report actually issued by the verifier, bound to the same task ID, can
settle that task. Reports are deeply frozen and registered by identity. A
fabricated or cross-task report fails before changing history. Task state is
private and read-only to callers; `moveTo(PASSED)` also requires the genuine
report. The runtime requires `VERIFYING` before settlement. There is no new
`complete()`, `succeed()` or `markDone()` path. Historical deserialization
reconstructs stored records; it is not the runtime's settlement path.

Known failed checks outrank unavailable checks, all requirements are collected,
and missing exit status cannot become exit zero through numeric coercion.
Unavailable dependencies and empty browser flows stay INCONCLUSIVE. Repairs
create new lineage and preserve the original terminal result. Persistence is
armed per task by material work; late evidence is filed against its owner,
even when another task is active.

Artifacts are task-associated and read only from existing files within the
task's real path. Pruning removes only eligible known terminal records and
preserves active, unknown or unreadable records. Limits are 256 artifacts and
64 MiB of indexed artifact data per task, 2 MiB per body, and 4 MiB of events.
Text truncation is recorded; oversized binary evidence is refused rather than
corrupted. Failed index publication rolls back the new artifact and reports
the failure. Existing evidence is retained when a capacity limit is reached.

## 7. Browser lifecycle audit

The transport remains real CDP over Node's built-in WebSocket, with no new
browser dependency. Own launches use an ephemeral debug port and a throwaway
profile. An attached existing browser contributes only a newly owned tab;
the Harness does not close another user's browser. Failed tab creation does
not silently fall back to an existing page.

Flows close their sessions on completion, assertions, navigation failure,
deadline or cancellation. Pending load waits are resolved on close and their
timers are cleared. Console assertions require the Runtime domain to have
been enabled. Optional absence and an invalid explicitly configured binary
remain distinct availability states; inability to inspect is INCONCLUSIVE,
while an observed assertion failure remains FAILED.

## 8. Capability registry audit

Capabilities expose their name, category, source, availability, requirements
and limitations alongside existing effect/trust metadata. Configuration alone
does not mark an MCP bridge connected. Doctor and registry read an observed
bridge handshake where one exists; Python discovery verifies the interpreter
without claiming project dependencies are installed. Registry metadata advises;
the existing permission systems enforce.

The manifest-derived project profile and current MCP bridge/tool integration
remain implemented. There is no skill-package loader or new plugin framework.

## 9. Remote/tier boundaries

**Implemented:** local shell/direct execution, finite jobs, managed services,
verification, observations, CDP browser flows, persistence, and canonical
projections. The existing Rust remote-control protocol implements its own
credentials, pairing, capabilities and command handling. Tests exercise the
real supervisor against controlled local Telegram/model fixtures.

**Interface only:** a Harness snapshot can be consumed by another surface;
it is not itself a remote transport. Tier 3 container/VM isolation and tier 4
remote execution are future adapters, not implemented executors. The current
tree does not contain operational named tier-3/tier-4 backends.

The attachment contract for a future backend is:

1. Discovery describes backend identity, availability and reason, supported
   operations, isolation, requirements and limits. An interface's existence
   cannot produce AVAILABLE.
2. Execution accepts task ID, workspace/mount mapping, an explicit command or
   executable/argv, environment, signal/deadline, and the authorization already
   granted by the existing gate. It returns the actual backend process/job
   identity and observed output, exit status or explicit unavailability.
3. Cancellation and teardown acknowledge stopped descendants, released leases,
   and cleaned resources before completion; cleanup failure stays visible.
   Retries require the existing operation's idempotency policy and identity.
4. Evidence carries its task/backend identity through the existing event and
   artifact seams. The adapter never settles a task or grants permissions.
   Verification remains the sole route to PASSED.

**Blocked:** remote Harness task/evidence publication needs an authenticated,
versioned Rust transport capability, task/workspace identity and artifact
retrieval semantics. The existing remote-control RPCs do not implement that
transport. Doctor explicitly reports remote Harness projection unavailable.
No parallel Rust remote framework, VM provisioner or privileged execution
system was added.

## 10. Test results

| Validation | Passed | Failed | Notes |
|---|---:|---:|---|
| Initial full unit | 2,221 | 3 | Removed-command expectations and host terminal environment |
| Final full unit | 2,259 | 0 | 105.2 seconds; shared tree gained CLI tests during the pass |
| Full integration before the final transport fix | 169 | 1 | Remote English response exceeded the test deadline |
| Final full integration | 171 | 0 | 165.9 seconds; includes the active-job lease regression |
| Full smoke run | 532 | 2 | Terminal-title assertions; completed in 2,298.1 seconds |
| Later smoke recheck | 43 | 0 | Corrected title assertion and the CLI files whose control bytes were repaired |
| Distribution | 40 | 0 | Distribution implementation unchanged |
| Rust | 95 | 0 | Includes the final HTTP transport change |

The other failing full-smoke file (`integration-push`) passed in the earlier
54-test targeted run; its only failure was the stale title assertion in
`relay-dash-mcp`, which then passed in the 43-test recheck. Both original smoke
failures have passing rechecks. A second complete smoke run after all final
changes was not performed, and no fully green final smoke total is claimed.

The final sequential repetitions used the updated isolated release binary:

| Cluster | Pass counts, runs 1 / 2 / 3 | Tracked processes, runs 1 / 2 / 3 | Survivors after each run |
|---|---|---|---|
| Lifecycle, browser and Harness scenarios | 29 / 29 / 29 | 208 / 213 / 188 | 0 / 0 / 0 |
| Remote control and supervisor | 33 / 33 / 33 | 113 / 128 / 145 | 0 / 0 / 0 |
| Harness CLI, including one-shot service cleanup | 16 / 16 / 16 | 103 / 114 / 94 | 0 / 0 / 0 |

Every run exited zero. The isolated supervisor count was **0 before and 0
after all nine runs**. An external OS inventory followed each runner's parent
relationships and creation times; it checked observed descendants after
bounded cleanup. This excludes the unrelated running LAIN session that a
preliminary global helper count had included. Fixture assertions additionally
checked actual command/leaf PIDs, closed ports and browser scratch removal.
The structured records are in [HARNESS-STABILITY-RUNS.json](HARNESS-STABILITY-RUNS.json).

The additional active-job lease checks passed 1/1 on each of three runs using
the rebuilt workspace debug binary. No test deadlines were increased for the
remote fix. The final release binary SHA-256 was
`733EADBE5B579FE07B3BBAF5C9CA0DD90BCE9D8EF2D93CC4E80D891454304253`.
`npm pack --dry-run` confirmed that the existing allowlist includes all three
process helper modules; it did not publish or install anything globally.

Reproduce with the rebuilt supervisor selected automatically, or set
`LAIN_SUPERVISOR_BIN` to the updated binary explicitly:

```powershell
cargo build --offline --manifest-path rust/lain-supervisor/Cargo.toml
node tests/run.js unit
node tests/run.js integration
node tests/run.js integration 'harness-lifecycle|harness-browser-lifecycle|harness-scenarios'
node tests/run.js integration 'remote|supervisor'
node tests/run.js smoke 'harness-cli'
node tests/run.js distribution
```

Detailed run logs remain in the OS temporary directory under
`lain-ancestry-*`, `lain-accepted-integration.log`, `lain-final-all-unit.log`,
`lain-hardened-smoke-1.log`, `lain-final-smoke-recheck.log`,
`lain-final-distribution.log`, `lain-accepted-rust.log` and `lain-lease-job-*`.

## 11. Remaining known limitations

Actual lifecycle and browser tests ran on Windows with Node 24 and installed
Chrome. POSIX process-group code was not exercised on this host. The Rust
supervisor now requires Rust 1.89 or newer for the lifetime file lock. Repeated
counts use an isolated release executable with its canonical Windows path, so
other runs cannot contaminate its count. The workspace debug executable was
also rebuilt offline after verifying it was unused; it is available for new
launches. The existing durable production supervisor was not restarted. Tests
reject an older binary without lease-v1.

The remote tests use local protocol fixtures, not a live Telegram account or
paid model. No VM/container/remote executor or remote Harness publication is
claimed. Ordinary production background supervisors intentionally remain
durable. Artifact limits bound a task's stored evidence, not all user-created
workspace data; active/unknown tasks are never deleted merely to reach a
global size target. Hard killing the cleanup guardian itself, adversarially
detached descendants and machine shutdown are outside the application-owner
crash cases tested here.

## 12. Architecture verdict

The existing Harness remains the execution and verification substrate. It
adapts to the canonical authorities and gives the CLI a projection. The added
process helpers implement OS lifetime ownership; they are not new task,
permission or verification authorities. Distribution implementation remains
unchanged and no runtime package dependency was added.

Can repeated Harness execution leak additional LAIN-owned processes?

**NO — verified by repeated lifecycle runs**

This verdict describes the tested Windows application/test-owner lifetimes,
including normal completion, failure, timeout, cancellation and hard owner
death. The platform and execution boundaries in section 11 still apply.
