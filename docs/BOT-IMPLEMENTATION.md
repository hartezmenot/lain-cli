# LAIN Bot implementation report

Implementation date: 9 September 2026. This report covers the messaging gateway
pass in the existing, already modified LAIN workspace. It does not attribute the
other CLI/Harness changes in that workspace to this pass. Setup and configuration
are in [BOT.md](BOT.md); the pre-implementation decision is in
[BOT-ARCHITECTURE.md](BOT-ARCHITECTURE.md).

## 1. Existing LAIN remote/bot baseline

LAIN already had an App, Session, turn loop, Harness, background jobs, permission
authorities and a Rust supervisor. Historical Telegram support kept its token,
private-chat pairing, long poller, outbound HTTP and legacy remote handling in
that supervisor. The newer CLI had already removed `/rc`. This implementation
reuses that poller and credential boundary, without restoring `/rc` or creating a
second Telegram client. Legacy handling remains available only in supervisor
homes that have never selected gateway mode.

## 2. Hermes architecture studied

The supplied local Hermes dump was indexed by file boundary, rather than read
sequentially. Relevant entries included `gateway/platforms/event.py`,
`platform_registry.py`, `platforms/ADDING_A_PLATFORM.md`, `session_context.py`,
`authz_mixin.py`, `delivery.py`, `delivery_ledger.py`, `media_fetch.py`,
`relay/descriptor.py` and platform manifests. Some large adapter/session source
files were absent from the supplied dump; the available guides are reference
material, not evidence that those implementations were fully audited.

## 3. Concepts adopted

Normalized events/actions, explicit source identity, adapter factories, passive
capability descriptors, admission authorization, bounded reply context,
transient typing, independent adapter failure and persistent delivery receipts.
The gateway carries source context explicitly so concurrent conversations cannot
change each other's destination through global environment state.

## 4. Concepts deliberately rejected

No second agent loop, tool registry, memory store, permission policy, task engine
or verification engine. No broad plugin framework, guessed cross-platform
identity, wildcard sender authorization, raw platform payloads in model context,
or automatic resend after an ambiguous delivery. External connector execution
remains optional future work.

## 5. Final LAIN Bot architecture

Telegram/Discord/WhatsApp adapter → normalized event → Gateway authorization and
source queue → existing App/Session → existing turn loop, Harness and permissions.
Responses return through generic delivery actions and the originating adapter.

`src/bot/gateway.js` owns admission and bounded scheduling. `runtime.js` calls
App.submit and App.startBackground. `src/interaction.js` is a presentation seam
into existing approval/clarification owners. Protocol details remain in adapters;
no platform branches were added to the Core turn loop.

## 6. Normalized event/action contracts

Version 1 events include platform/account, chat/thread/message/sender IDs, context
kind, bounded text/reply context, opaque attachment metadata and normalized prompt
responses. A whitelist drops raw payloads, credentials and download URLs.

Actions cover send, edit, typing, interactive prompts and owned media. Descriptors
declare message length, formatting, edit/typing/thread/button and media support.
Unsupported actions fail before transport. A registry factory is the extension
point; this is also the initial versioned connector descriptor contract.

## 7. Session identity model

A hash of the JSON tuple `(platform, account profile, chat, thread, sender)` maps
to a full existing Session ID. Each dimension participates in isolation. Changing
a display name does not move a session. Resuming refuses any different Session ID;
there is no latest-session fallback. Account profiles bind to actual bot identity
and refuse a different bot behind the same profile. Cross-platform linking is
not inferred. Users still share the explicitly configured project workspace.

## 8. Authorization model

Stable sender IDs are checked before Session construction, model invocation,
media download or tools. Previously paired Telegram private users retain access.
Groups/channels need configured location access and an allowed sender, plus an
explicit mention/reply unless ambient handling is configured. Bot/webhook echoes
are ignored. Messaging access supplies no filesystem, shell or desktop grant.
Remote mutations pass through existing trust gates, including cwd checks when an
operation does not name a file.

## 9. Telegram implementation

A leased, bounded Rust mailbox connects the existing poller to the generic Node
adapter. Events persist before the Telegram cursor advances. Only one gateway
owner can hold the lease; polling pauses on lease loss or mailbox backpressure.
Gateway mode is latched on disk, preventing a crash from invoking the legacy
remote brain. Text, replies/topics, typing, keyboards, stop and background
notifications use the existing supervisor HTTP transport. Initial token
provisioning verifies through that boundary; it cannot replace an existing bot.

## 10. Discord implementation

Native Gateway WebSocket and REST transport support DMs, configured guild
channels, separate thread identity, replies, text, editing, typing and prompt
components. Heartbeat ACKs, identify, resume, invalid sessions, reconnect backoff
and fatal close states are handled. Admission is bounded and incoming events are
serialized before advancing the resumable sequence. Mentions are suppressed on
outbound content. Node 22+ and the configured Message Content intent are required.
Sharding, voice and slash-command registration are outside this pass.

## 11. WhatsApp transport decision/implementation

The official Meta Cloud API was chosen. The adapter hosts a loopback webhook,
handles GET verification and validates POST HMAC against original bytes before
parsing. Account phone-number IDs must match. Outbound text and media use the
configured supported Graph API version and customer-service response window.
The operator supplies HTTPS forwarding and Meta configuration. Unsupported
typing/edit/thread/button features are declared false; prompts use numbered text.
No WhatsApp Web automation or unofficial phone session is embedded.

## 12. Interactive approval/clarify mapping

The same neutral prompt transports existing trust, desktop permission and
clarification choices. Random IDs bind each pending request to its sender,
account, conversation, choices and expiry. Telegram keyboards and Discord
components carry these IDs; the text fallback is `/answer <id> <answer>`.
Wrong-source, expired, repeated and invalid replies cannot resolve consent.
Cancellation, timeout or delivery failure resolve to no answer. Directory consent
allows one operation through the existing gate; it does not persist blanket trust.

## 13. Background notification integration

`/bg` calls existing App.startBackground. Completion consumes the job's settlement
promise and retains its originating destination, including when later messages
arrive. No polling or second model turn creates notifications. `/stop`, `/steer`,
`/cancel` and `/bg stop` reach existing cancellation/steering owners. Job/process
views expose only the conversation's owned work. Concurrency is bounded across
sources, with one lead writer per source and at most two background jobs per App.

## 14. Media/artifact design

Discord and WhatsApp fetch opaque attachment references at the adapter boundary.
Exact HTTPS hosts, redirect refusal, timeouts, cancellation and the existing
2 MiB artifact limit constrain downloads. Files become untrusted artifacts owned
by an active Harness task; automatic OCR, transcription or execution is not added.

`/artifacts` and `/send <artifact-id>` use the conversation's latest task and the
existing artifact index. Export uploads actual bytes, never arbitrary host paths
or Base64 chat text. Another conversation's artifacts are denied. Telegram
currently supplies attachment descriptions only and advertises media unsupported.

## 15. Lifecycle/reconnect

`--bot` owns a foreground service; `/bot start` owns it within the interactive CLI.
Status, stop, restart, platforms and doctor share a local authenticated control
endpoint. A canonical-config-derived OS socket prevents duplicate services without
PID killing. One unavailable adapter does not stop the others. Shutdown cancels
prompts and work, closes owned resources and detaches transports.

Delivery records distinguish pending, sending, delivered, failed and uncertain.
Only explicit bounded 429 responses retry automatically. A send without a known
ACK is uncertain and is not repeated. Never-started text can recover after a known
predecessor ACK and current authorization; interrupted tool turns never replay.
Receipt trimming preserves predecessors needed by pending fragments.

## 16. Tests

Platform fixtures replace external network/model transports while exercising the
real App, Session, permission gates, Harness artifacts, Rust poller/mailbox,
webhook server and lifecycle socket. No live personal account or paid model was
used. Fixture success is not live-platform certification.

| Check | Result | Scope |
| --- | --- | --- |
| Full JavaScript unit run | 2,375 passed, 1 failed | Shared `turn.js` exceeds the architecture test's line limit (745 lines); this pass did not edit it. |
| Bot unit checks within that run | 18 passed, 0 failed | Contracts, all three adapters, authorization, prompts, concurrency, permissions, recovery, media and receipt retention. |
| Full integration run | 175 passed, 0 failed | Includes the real Core and four bot integration tests. |
| Focused bot integration after final restart fix | 5 passed, 0 failed | Includes the added external-service restart timing regression. The full suite was not repeated after this addition. |
| Bot CLI smoke after final restart fix | 2 passed, 0 failed | Actual foreground process, authenticated shutdown, help and platform listing. |
| Rust supervisor tests | 98 passed, 0 failed | Includes mailbox latch, capacity/deduplication and private identity/secret handling. |
| Earlier broader CLI smoke selection | 70 passed, 2 failed | Click-to-open navigation and research activity display expectations remain unresolved; this was not a full smoke run. |
| Packaging preview | Passed | Gateway modules, interaction seam and setup/architecture documentation included; nothing published. |

The earlier legacy remote integration failure was a fixture that did not capture
the current renderer's operational output. Its output sink was corrected, and the
final full integration run above passed. No legacy routing change was made to
obtain that result. The architecture size failure and the earlier CLI display
failures are not covered by a claim that the bot-specific tests pass.

Logs are retained in the host temporary directory as
`lain-bot-handoff-all-unit.log`, `lain-bot-final-all-integration.log`,
`lain-bot-handoff-integration.log`, `lain-bot-handoff-cli.log`,
`lain-bot-rust-test.log`, `lain-bot-smoke.log` and `lain-bot-pack.json`.

## 17. Remaining limitations

- Real Telegram/Discord/Meta account setup and live delivery validation remain
  operator steps. WhatsApp requires external HTTPS forwarding.
- The workspace release supervisor was built successfully. The existing user
  daemon still holds an older debug binary; it was preserved. Telegram gateway
  RPCs require restarting that daemon after its existing work can safely stop.
- One account per platform per configuration; no Discord sharding, WhatsApp
  templates, cross-platform identity linking or external relay process.
- Telegram media transfer is not implemented. Messaging artifact listing/export
  covers the latest in-memory task, not previous process lifetimes.
- Text output is capped at 128,000 characters with an explicit shortening notice.
  Routing has bounded session/App/receipt capacity; deduplication is limited by
  retention and is not an eternal exactly-once guarantee.
- Uncertain deliveries need review; the implementation deliberately cannot claim
  handset receipt or reconstruct interrupted model/tool work after a crash.
- The shared workspace has broader CLI display/architecture test failures,
  listed with the final results below. This report does not claim a fully green
  repository or production account certification.

## 18. Architecture verdict

**Does Telegram, Discord or WhatsApp own a separate LAIN agent runtime? NO.**
They are platform adapters into the same existing LAIN App/Session/runtime.

**Can adding another platform require changing LAIN Core? NO**, except a genuinely
new cross-platform capability contract. Adapter registration handles new protocols.

**Can an authorized messaging user bypass LAIN machine permissions? NO.**
Admission and machine consent remain separate, enforced by existing authorities.

**Can one messaging user accidentally inherit another user's transcript? NO**
through this routing model: bindings include stable source and sender identity,
and an unavailable exact Session binding fails closed.
