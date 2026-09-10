# LAIN Bot architecture decision

Reference inspected before implementation: the supplied local Hermes source dump
`nousresearch-hermes-agent-8a5edab282632443.txt`. Entry points traced:
`gateway/platforms/event.py`, `platform_registry.py`, `platforms/ADDING_A_PLATFORM.md`,
`session_context.py`, `authz_mixin.py`, `delivery.py`, `delivery_ledger.py`,
`media_fetch.py`, `relay/descriptor.py`, and platform manifests. Some large adapter
and session implementations are absent from this dump; their guide is a reference,
not evidence that LAIN implements those features.

Adopt: explicit source identity, adapter factories with passive capability metadata,
authorization before admission, transient typing, reply context bounds, independent
adapter failure, and durable delivery attempt states. Pass source explicitly; never
route concurrent sessions through environment variables.

Reject: a second agent loop, a second permission authority, wildcard sender access,
raw platform payloads in model context, broad plugin/setup machinery, implicit
cross-platform linking, and resending an ambiguous delivery after restart. Unlike
Hermes's best-effort ledger, LAIN must record a send attempt before sending.

Minimum P0: generic event/action contract, stable per-sender conversation bindings
to existing Session files, bounded admission and delivery records, a neutral ask
transport into existing permission authorities, Telegram through the existing Rust
poller, native Discord Gateway/REST, lifecycle commands and fixture tests. WhatsApp
Cloud API follows P0 verification. Media and relay remain separate capabilities.

Telegram credentials stay inside the supervisor. A leased mailbox transfers bot
events to Node without creating a second Telegram polling loop. Selecting gateway
mode latches it: a crashed gateway must never fall back to the legacy remote brain
or machine-wide session controls. Legacy remote behavior remains for installations
that have never attached a gateway.

The gateway creates a headless App per source, calls App.submit/startBackground,
and disposes the same Harness, jobs and desktop bridge. Messaging authentication
only admits a sender; filesystem trust and desktop consent retain their existing
owners. The local pipe shortcut in the filesystem gate must not apply to a remote
interaction transport. No adapter imports a provider, tool registry or turn loop.
