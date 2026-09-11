# LAIN Harness Blueprint

**File:** `LAIN_HARNESS_BLUEPRINT.md`  
**Purpose:** Persistent architecture, product definition, implementation roadmap, and status ledger for LAIN Harness.  
**Updated:** 2026-09-10  
**Authority:** This document is the project blueprint unless the user explicitly changes a decision.  
**Recommended repository location:** `docs/LAIN_HARNESS_BLUEPRINT.md`

---

# 0. How to Use This Blueprint

This file exists so the project direction survives model switches, compaction, new chats, and provider changes.

When continuing LAIN development:

1. Read this file before proposing architecture.
2. Preserve decisions marked **FROZEN** unless the user explicitly changes them.
3. Do not infer that a capability exists because a similar lower-level tool exists.
4. Update the **Implementation Status** section after real implementation work.
5. Distinguish design, partial implementation, implemented, fixture verified, real-local verified, and live-external verified.
6. Never mark a capability complete from a mock UI, static screenshot, or stub.
7. When the user asks to add, remove, or change the architecture, update this file rather than creating a competing blueprint.

The user explicitly allows this blueprint to be revised when they ask for additions, implementation changes, or architectural corrections.

---

# 1. Product Definition — FROZEN

LAIN Harness is a **model-agnostic AI development and work operating environment**.

It is not a prettier terminal, ChatGPT clone, Claude clone, giant dashboard, single coding agent, frontend-only IDE, bot UI, or second runtime beside LAIN Core.

LAIN Harness is the **desktop workbench** that exposes structured coding, browser, desktop, creative, productivity, verification, and execution capabilities to any supported LLM.

The model is replaceable. The Harness owns the capabilities.

```text
                    LAIN INSTALLER
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
       LAIN Harness.exe            lain
       Desktop Workbench            CLI
              │                     │
              └──────────┬──────────┘
                         ▼
                    LAIN Core
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   Capabilities       Execution        Evidence
        │                │                │
   Browser/Android    Processes        Verification
   Blender/Desktop   Files/Terminal    Artifacts
   Office/Image      VM/Host           Screenshots
```

---

# 2. Product Boundary — FROZEN

## 2.1 LAIN CLI

`lain` remains a standalone expert surface optimized for terminal users, fast coding, automation, deterministic execution, remote shells, direct project work, and advanced commands.

It must remain usable without LAIN Harness.

## 2.2 LAIN Harness

LAIN Harness is a separate desktop application optimized for:

- project/session navigation,
- source editing,
- visual frontend work,
- browser verification,
- Android development,
- 2D/3D creative work,
- desktop application work,
- Cowork,
- Bot supervision,
- artifacts,
- model selection,
- rich previews.

Harness is **not finally delivered by printing a localhost URL and password inside the CLI**.

The existing `/app` HTTP surface is a prototype.

## 2.3 Installer

The final LAIN installer bundles both:

```text
LAIN Harness
lain CLI
```

The user may launch either independently.

---

# 3. Harness ↔ CLI Relationship — FROZEN

LAIN Harness and LAIN CLI share LAIN Core/Harness authority.

They must not parse each other's rendered UI to discover state.

```text
                    LAIN Core / Harness State
                         /             \
                        /               \
                 LAIN CLI          Harness Desktop
```

When Harness opens a project it may start a `lain` session in that project, attach to an existing LAIN session, run LAIN in background, or expose an optional integrated PTY/terminal.

Structured state must travel through IPC/Core contracts.

ANSI terminal output is for humans, not for application state synchronization.

---

# 4. `/app` Prototype — CURRENT DECISION

Current `/app` is useful as a prototype but is not the final Harness architecture.

Current prototype problems include:

- manual loopback password flow,
- password paste/Enter failure,
- errors not clearly printed,
- URL/password output inside an interactive CLI area that is difficult to select/copy,
- Harness visually behaving like a child of CLI.

Short-term prototype direction:

- `/app` may launch/open the prototype externally,
- no unnecessary manually-entered password for a loopback-only temporary prototype,
- clear connection/error state.

Final direction:

```text
/app
  ↓
launch/focus LAIN Harness desktop
  ↓
open/attach current project/session
```

The native desktop app should use local IPC/auth appropriate to a desktop application rather than a user-pasted loopback password.

---

# 5. Primary Harness Experiences — FROZEN

LAIN Harness has three major user experiences:

```text
Chat / Coding
Cowork
Bot
```

Chat and Coding share one engineering-session history.

Cowork and Bot are **different roles** even when they use overlapping capabilities.

---

# 6. Chat / Coding

## 6.1 One Engineering Session

Chat and Coding are turn semantics, not separate session silos.

```text
User: Why is checkout failing?
→ CHAT

User: Fix it.
→ CODING

User: Why did you change router.js?
→ CHAT
```

Same session, project, workspace, history, goal, and model provenance.

## 6.2 Model Sources

Engineering Chat supports:

- LAIN runtime/local/provider models,
- ChatGPT.com,
- Gemini.google.com.

ChatGPT.com and Gemini.google.com are browser-backed, user-authenticated model sources with dynamically discovered account model lists.

Website models are **model sources**, not machine execution authorities.

If a ChatGPT/Gemini turn becomes a coding request, LAIN Core owns filesystem, tools, execution, and verification.

---

# 7. Cowork — FROZEN ROLE

Cowork means:

> **Do work for me.**

Cowork is the general productivity executor.

Examples:

- clean spreadsheets,
- edit documents,
- organize files,
- image editing,
- create/export artifacts,
- research,
- reminders,
- calendar,
- notes,
- contacts,
- email drafting/reply/send with permission,
- office workflows,
- conversion and cleanup work.

Cowork should feel like:

```text
input/object
   ↓
understand task
   ↓
deterministic tools
   ↓
finished artifact/action
```

not a chatbot explaining what the user should do.

---

# 8. Bot — FROZEN ROLE

Bot is **not the same thing as Cowork**.

Bot means:

> **Supervise LAIN, other AI applications, sessions, and remote work.**

Examples:

- check whether Claude is still working,
- check whether ChatGPT is still working,
- inspect LAIN background tasks,
- inspect project processes,
- report whether a build is still active,
- notify when a task completes,
- steer/stop/resume LAIN sessions,
- supervise Cowork jobs,
- remotely inspect applications,
- use Computer MCP when structured state is insufficient.

Bot may also perform useful tasks through shared capabilities.

Example:

- receive a photo from Telegram,
- edit it through LAIN's native photo/image tools,
- return the edited artifact.

Bot can therefore use image/photo tools, Computer MCP, browser tools, session/process inspection, messaging transport, artifacts, and LAIN tools.

The user's current local LLM/runtime under `E:\AI` may serve Bot/Cowork during development, but final capability contracts remain model-agnostic.

---

# 9. Messaging Transport

Messaging platforms are transports into LAIN, not separate brains.

Current targets:

- Telegram,
- Discord,
- WhatsApp.

```text
Telegram / Discord / WhatsApp
            ↓
    normalized message event
            ↓
        LAIN Bot
            ↓
   LAIN Core / capabilities
            ↓
 normalized outbound action
            ↓
 originating platform
```

Messaging admission does not grant machine permissions.

---

# 10. Model-Agnostic Capability Registry — CRITICAL / FROZEN

No important capability should belong to one model.

Wrong:

```text
if model == astra:
    expose_blender()
```

Correct:

```text
Capability Registry
│
├── source
├── filesystem
├── browser
├── frontend
├── backend
├── android
├── desktop
├── computer
├── image
├── spreadsheet
├── documents
├── email
├── blender
├── 2d-assets
├── 3d-assets
├── testing
├── database
└── ...
```

Any supported LLM may use available capabilities.

If Astra discovers a good Blender workflow, convert it into a deterministic Harness capability so Opus, GPT, GLM, Claude, Kimi, and local models can use it too.

Target philosophy:

```text
80% deterministic tools/workers
20% LLM reasoning
```

---

# 11. Core Engineering Workspace

An engineering session should progressively expose:

- Conversation,
- Source,
- Changes,
- Terminal,
- Verification,
- Artifacts,
- Workshop.

Do not permanently show every panel.

```text
Engineering Session
│
├── Conversation
├── Source
├── Changes
├── Terminal
├── Verify
├── Artifacts
└── Workshop
```

---

# 12. Source Workspace — REQUIRED

The Harness needs a real code/source surface.

Minimum capabilities:

- project tree / quick open,
- HTML/CSS/JS/TS/JSX/TSX/JSON/Markdown/Python/Rust and other text source,
- syntax highlighting,
- line numbers,
- find,
- edit,
- save,
- small tab set,
- unsaved marker,
- disk-change detection,
- diff/change marker,
- source selection,
- open changed file,
- ask LAIN about selected code,
- fix selected code.

The editor is presentation.

Canonical filesystem/write/trust authority remains in LAIN Core/Harness.

---

# 13. Live LLM Code Editing Visualization — REQUIRED

When LAIN modifies source inside Harness, the user should see the real operation.

Example:

```diff
- opacity: 0.2
+ opacity: 0.5
```

Harness should visually show:

- changed line,
- removed value,
- inserted value,
- current patch location,
- file being modified.

This must be based on real patch/write events.

Do not fake model token typing.

---

# 14. Bidirectional Source ↔ UI Mapping — CRITICAL

This is one of the defining LAIN Harness features.

## 14.1 UI → Source

User says:

> Fix the Save button.

If multiple candidates exist, Harness visually highlights candidates:

```text
[1] Settings Save
[2] Account Save
[3] Editor Save
```

LAIN asks:

> Which button?

User clicks the intended button.

Harness then:

1. identifies rendered object,
2. resolves DOM/AX/component identity,
3. opens the relevant source file,
4. highlights the controlling code,
5. scopes the next LAIN turn to that object/code.

## 14.2 Source → UI

User clicks/selects code.

When mapping is evidence-backed, Harness highlights the rendered UX/UI object controlled by that code.

## 14.3 Identity Graph

```text
SOURCE SYMBOL
      ↕
COMPONENT
      ↕
DOM NODE
      ↕
ACCESSIBILITY NODE
      ↕
VISIBLE REGION
      ↕
EVENT HANDLER
      ↕
NETWORK REQUEST
      ↕
BACKEND ROUTE
```

Relationships must be evidence-backed.

Do not invent source mapping when confidence is insufficient.

---

# 15. Web Frontend Workshop

The Web Workshop is the first rich workshop.

Capabilities:

- start/adopt dev server,
- Harness-owned Chromium,
- Preview,
- DOM inspection,
- AX inspection,
- element picker,
- click/type/navigation,
- console,
- network,
- screenshots,
- before/after,
- viewport presets,
- visual evidence,
- horizontal-overflow checks,
- source association when reliable,
- selected element → Ask LAIN,
- selected element → Fix this.

```text
source
  ↓
change
  ↓
live preview
  ↓
observe
  ↓
verify
  ↓
artifact/evidence
```

---

# 16. Backend Workshop / Backend Observation

LAIN Harness should not treat backend work as shell-only.

Target capabilities:

- process/service health,
- logs,
- API calls,
- HTTP tracing,
- route discovery,
- database/schema inspection,
- source graph,
- AST/FGM,
- build/test,
- dependency/runtime state,
- network activity,
- error correlation,
- frontend request ↔ backend route tracing.

Desired diagnosis:

```text
visible button problem
      ↓
click handler works
      ↓
POST /api/checkout
      ↓
500 response
      ↓
paymentService.js
```

---

# 17. Android Workshop — TARGET

Target capabilities:

- Android SDK,
- Gradle,
- ADB,
- emulator management,
- install/uninstall APK,
- device profiles,
- logcat,
- screenshots,
- input/touch,
- accessibility/layout inspection,
- activity lifecycle,
- permissions,
- Compose/XML relationships where practical,
- network inspection,
- build/test,
- responsive/device-specific verification.

---

# 18. Desktop / Native Application Workshop — TARGET

Target capabilities:

- run native application,
- inspect windows,
- inspect native controls,
- operate dialogs,
- screenshots,
- process state,
- app logs where available,
- package/install testing,
- Computer MCP integration,
- clean VM smoke.

---

# 19. Blender / 3D Workshop — TARGET

Blender should become a structured Harness capability rather than a model-specific trick.

Target structured capabilities:

- scene inspection,
- objects,
- meshes,
- transforms,
- materials,
- textures,
- armatures,
- rigging,
- animation,
- cameras,
- lights,
- modifiers,
- geometry,
- render,
- import/export,
- Blender Python scripting.

Prefer Blender structured APIs/Python before Computer MCP mouse clicking.

---

# 20. 2D / Game Asset Workshop — TARGET

Target capabilities:

- image/canvas operations,
- layers,
- sprite sheets,
- frame animation,
- palettes,
- vector assets where supported,
- background removal,
- inpainting,
- upscaling,
- resizing,
- export,
- asset preview,
- game-character 2D creation/editing.

---

# 21. Native Photo/Image Editor — REQUIRED

LAIN Harness needs a native image editing capability.

Bot and Cowork must both be able to use it.

Target operations:

- open/import image,
- crop,
- rotate,
- resize,
- background removal,
- background replacement,
- inpaint/remove object,
- simple retouch,
- sharpen,
- denoise,
- upscale,
- face enhancement where available,
- compositing/layers where appropriate,
- generate/edit image,
- export artifact.

Remote example:

```text
Telegram
  + photo
  + "remove the background and make it white"
        ↓
Bot
        ↓
shared Image capability
        ↓
edited artifact
        ↓
Telegram
```

Do not implement separate Telegram image logic.

---

# 22. Computer MCP — HORIZONTAL INFRASTRUCTURE

Computer MCP belongs to LAIN Core/Harness, not to one lane.

```text
                    Computer MCP
                    /     |      \
                   /      |       \
              Coding    Cowork     Bot
```

V1 target:

- displays,
- windows,
- foreground app,
- UI Automation/accessibility tree,
- screenshots,
- pointer,
- click/double/right-click,
- drag,
- scroll,
- type,
- key/hotkey,
- focus window,
- find control,
- click control,
- type into control,
- wait for control/window,
- clipboard with explicit need.

Observation preference:

```text
1. native structured control/UI information
2. semantic control bounds
3. screenshot/vision
4. OCR fallback
```

V1 explicitly excludes memory scanning/writing, DLL injection, pointer/address discovery, Cheat Engine-style flows, and trainer functionality.

---

# 23. Bot + Computer MCP

Bot may use Computer MCP to supervise external AI applications.

Example:

> Is Claude still working?

Preferred evidence order:

1. structured LAIN/process/session state if available,
2. app-native state if exposed,
3. Computer MCP observes Claude UI.

Same for ChatGPT.

Bot should not infer "working" from PID existence alone.

---

# 24. Harness-Owned Browser Architecture — FROZEN

Normal LAIN testing must not use the user's personal browser/profile.

Three browser purposes:

## Verification Browser

- clean/throwaway,
- Harness-owned Chromium,
- smoke/e2e,
- no personal cookies.

## Workshop Browser

- Harness-owned Chromium,
- project-bound,
- interactive preview,
- may persist during a development session.

## WebModel Browser

- ChatGPT.com/Gemini.google.com,
- persistent authenticated profile,
- explicitly user-authenticated.

Profiles and lifecycle remain separate.

---

# 25. Execution Environments

Tasks may run in:

```text
HOST
VM:<registered-id>
```

Environment-sensitive operations must agree on the same environment.

Use HOST for coding, fast tests, and normal Workshop development.

Use VM for clean installation smoke, isolated app verification, destructive/experimental testing, future native desktop testing, and future Computer MCP guest targets.

---

# 26. VMware

VMware is one environment provider.

Target operations:

- status,
- list registered Harness VMs,
- start,
- stop,
- snapshot,
- restore,
- exec,
- copy in/out,
- health.

Only explicitly Harness-owned/registered VMs may be controlled automatically.

Never assume authority over arbitrary user VMs.

---

# 27. Verification Philosophy — FROZEN

LAIN must not self-declare success.

```text
DO WORK
  ↓
OBSERVE RESULT
  ↓
VERIFY
  ↓
PASS / FAIL / INCONCLUSIVE
```

A sent click is not success.
A changed file is not proof the frontend is correct.
A launched VM is not proof the guest is ready.
A browser tab opening is not proof the workflow works.

---

# 28. Harness Application UX Principles — FROZEN

LAIN Harness should feel like a modern workbench, not a dashboard.

Use:

- whitespace,
- hierarchy,
- contextual tools,
- progressive disclosure,
- live artifacts,
- source ↔ preview relationships.

Avoid:

- permanent giant grids,
- raw event streams,
- exposing every internal capability as a top-level tab,
- fifteen toolbars,
- model reasoning dump,
- fake activity.

---

# 29. Session Model

## Engineering Session

Contains workspace/project, Chat/Coding history, model source/model, goal, plan, current work, artifacts, verification, source state, and Workshop state.

## Cowork Session

Contains general work/artifact/action context.

## Bot Session

Contains supervision/remote-operator context.

Remote transport identity remains explicit.

---

# 30. Goal / Plan / Step / Steer

```text
GOAL
= what the user wants to achieve

PLAN
= current strategy

PLAN_STEP
= active execution steps

STEER
= user correction during active work
```

---

# 31. CLI Copy Semantics — REQUIRED TWEAK

## `/copy`

Copy a concise useful task summary.

Include user request, result, changes, verification, remaining work, and how to run where relevant.

Exclude spinner, activity, token telemetry, timer, READY, command menu, transient warnings, hidden reasoning, recovery glue, and decorative UI.

## `/copy context`

Copy diagnostic context from the initiating user input through the current point using canonical session/turn records.

Do not scrape rendered terminal pixels.

Potential future:

```text
/copy context all
```

for full-session export.

---

# 32. CLI Manual Text Selection — REQUIRED TWEAK

The interactive renderer must not make useful terminal text effectively impossible to select/copy.

The user should be able to copy URLs, commands, paths, errors, final summaries, and prototype connection information.

---

# 32a. CLI Mouse / Transcript Navigation Contract — REQUIRED

Default behavior should prioritize native terminal selection while preserving reliable transcript navigation.

```text
Default
  drag           → native terminal text selection
  PgUp/PgDn      → LAIN transcript navigation
  Home/End       → transcript navigation where appropriate
  wheel          → LAIN transcript scrolling only if the host can provide it without stealing selection

/mouse on
  → explicit full LAIN mouse interaction mode
  → wheel/clicks owned by LAIN
  → native drag selection may be unavailable

/mouse off
  → terminal owns mouse completely
```

Do not simply re-enable global DEC mouse capture to fix the wheel; that would regress the selection bug already fixed.

---

# 32b. Diagnostic Context Projection — REQUIRED CORRECTION

`/copy context` must serialize semantic public turn content.

Wrong:

```text
USER (mid-turn)
[object Object]
```

Correct behavior:

- render the actual submitted/steer text when a structured record contains public user content,
- omit internal-only records that have no public textual representation,
- never stringify arbitrary objects as diagnostic conversation text.

---

# 33. Native Artifact Principle

Whenever possible, return the real object:

- edited image,
- workbook,
- document,
- code patch,
- build,
- screenshot,
- report.

Do not replace artifacts with a paragraph describing what the user should do.

---

# 33a. Account Manager / Add Account — FROZEN DIRECTION

The old `/oauth` concept should evolve into **Add Account**.

OAuth is an implementation mechanism; the user concept is an account connection.

```text
ACCOUNT
= who/how LAIN is authenticated

PROVIDER
= where inference or service capability comes from

MODEL
= the concrete model selected

ROUTE
= how LAIN chooses/uses a provider/model path
```

Harness should expose this contextually from model selection/settings rather than as a permanent giant dashboard:

```text
Model
  current model

  Add account
  Manage accounts
```

Supported account connection classes may include:

- OAuth / device-flow provider account,
- authenticated web session (for example ChatGPT.com or Gemini.google.com),
- router/aggregator account,
- direct API/provider credential where supported,
- local model/runtime endpoint.

Account secrets must never become ordinary model context, transcript, `/copy`, `/copy context`, Bot messages, artifacts, or normal logs. Use the existing secret/credential authority or OS-backed secure storage rather than inventing a second secret system.

The capability must remain model-agnostic. A connected account expands LAIN's model/service inventory; it does not belong to Astra, Opus, GPT, GLM, or any other specific model.

CLI direction:

```text
/account
/account add
/account status
/account disconnect
```

`/oauth` may remain only as a compatibility alias during migration if required.

---

# 33b. Context Builder + Context Cost Observatory — REQUIRED

Direct accounts alone do not solve excessive input context. LAIN must distinguish router/provider overhead from LAIN's own context composition.

Target architecture:

```text
                LAIN Context Builder
                        │
                normalized packet
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   direct account   router/aggregator   local/web source
```

Provider adapters should not independently decide to replay project/session context.

The Context Cost Observatory should be inspectable on demand, not permanently shown:

```text
Current request
System                 ...
Project context        ...
Conversation           ...
Tool contracts         ...
Evidence/handover      ...
User input             ...
──────────────────────────
Sent                    ...
Output                  ...
```

Requirements:

- expose authoritative usage when available,
- explicitly mark estimates/unknown values,
- do not invent token usage for website-backed sources,
- make it possible to compare the **same normalized LAIN packet** across direct provider vs router paths,
- identify repeated/redundant context and rediscovery costs,
- keep raw secrets and private auth metadata out of the observable context packet.

This subsystem is intended to diagnose the "huge input / small output" problem with evidence instead of blaming a router or model without measurement.

---

# 34. Current Implementation Status

Status legend:

- **DESIGN** — architecture decided only.
- **PARTIAL** — some implementation exists but product contract is incomplete.
- **IMPLEMENTED** — code exists.
- **FIXTURE VERIFIED** — deterministic test verified.
- **REAL LOCAL VERIFIED** — driven against a real local application/runtime.
- **LIVE EXTERNAL VERIFIED** — tested against a real external account/service.
- **NOT IMPLEMENTED** — absent.
- **PAUSED** — work exists but owner/session is currently unavailable or incomplete.

| Capability | Status | Notes |
|---|---|---|
| Standalone LAIN CLI | **REAL LOCAL VERIFIED** | Stable expert surface. |
| CLI simplified one-surface UX | **REAL LOCAL VERIFIED** | Recent finishing work landed. |
| CLI authoritative execution timer | **REAL LOCAL VERIFIED** | Duplicate/dead timer fixed. |
| CLI primary token cleanup | **IMPLEMENTED** | Detailed metrics behind `/token`. |
| CLI geometry rails | **REAL LOCAL VERIFIED** | Shared horizontal frame fixed. |
| CLI hard-glue removal | **IMPLEMENTED / VERIFIED** | Retry/resume/reasoning glue removed from durable feed. |
| `/model` single advertised command | **REAL LOCAL VERIFIED** | `/models` hidden compatibility alias, and it is genuinely typable: the command palette used to swallow Enter for any line it could not offer, so the alias ran through a pipe and did nothing in the TUI. |
| `/plan` / `/goal` bare-command fallback | **REAL LOCAL VERIFIED** | Interactivity is decided from `input.isTTY`, not from whether a screen is drawn. A piped run reads the plan/goal out; a real terminal still gets the editor. Six smoke failures across four files had this one cause. |
| Live strip accounting | **IMPLEMENTED** | The `↑ ⚡ ↓ +…` session cluster is `/token`; the header's OUTPUT figure is the one authoritative token signal on the primary surface. |
| `/goal` | **IMPLEMENTED** | Editable durable goal. |
| `/plan` editor UX | **IMPLEMENTED** | Replace/Add/Cancel. |
| `plan_step` lifecycle | **IMPLEMENTED** | Evidence-gated completion preserved. |
| `/copy` summary semantics | **REAL LOCAL VERIFIED** | Copies task summary from turn records; excludes live UI/activity noise. |
| `/copy context` | **IMPLEMENTED / REAL LOCAL VERIFIED** | Chronological, from the initiating user turn, built from `session.turns`. `steerTexts` holds `{step,text}` RECORDS, not strings — a projection that stringified them emitted `[object Object]`. `publicText` extracts the sentence or OMITS the entry; it never stringifies. |
| Native terminal selection cleanup | **IMPLEMENTED / REAL LOCAL VERIFIED** | Capture defaults OFF and `/mouse` persists. The WHEEL is unavailable in that mode by construction (it arrives as SGR buttons 64/65, which need mouse reporting), so the scroll hints now name the keys — `↑ more · PgUp` — and `/mouse` states the trade. No hybrid wheel + native drag selection exists under VT input. |
| Engineering Chat/Coding shared session | **IMPLEMENTED** | Backend/session semantics landed. |
| Runtime/local model source | **IMPLEMENTED** | Existing LAIN source. |
| ChatGPT.com model source | **FIXTURE VERIFIED** | Not real-account verified. |
| Gemini.google.com model source | **FIXTURE VERIFIED** | Not real-account verified. |
| Dynamic web-model discovery | **FIXTURE VERIFIED** | Live site selectors not certified. |
| Persistent WebModel browser profile | **IMPLEMENTED** | Separate from verification profile. |
| `/app` Harness HTTP prototype | **REAL LOCAL VERIFIED** | Temporary loopback prototype now opens in Harness-owned Chromium app-window mode with single-use token and no manual password entry. Still CLI-process-owned, not the final desktop boundary. |
| Native LAIN Harness desktop app | **NOT IMPLEMENTED** | Final product boundary. |
| Bundled Harness + CLI installer | **PARTIAL** | CLI packaging exists; desktop bundle not complete. |
| Harness project/session binding | **DESIGN / PARTIAL** | Prototype has session projection; final desktop IPC not done. |
| Structured Harness↔CLI IPC | **NOT IMPLEMENTED** | Required final architecture. |
| Harness Source Workspace | **REAL LOCAL VERIFIED** | Tree, quick open, tabs, line numbers, find, save, content-hash stale-write protection, and single-pass syntax highlighting verified. |
| Live LLM edit visualization | **IMPLEMENTED / REAL LOCAL VERIFIED** | Real patch/write events can surface focused source mutations; continue hardening editor visualization as desktop IPC lands. |
| Web Frontend Workshop core | **REAL LOCAL VERIFIED** | Dev server, preview, element inspect, AX, console/network, viewport, evidence. |
| UI → source mapping | **REAL LOCAL VERIFIED / PARTIAL COVERAGE** | Evidence-backed correlation returns EXACT/LIKELY/MULTIPLE/UNKNOWN and closes a real Harness self-dogfood round trip; generated/ambiguous names are refused honestly. |
| Source → UI highlighting | **PARTIAL** | Selector derivation exists, but corresponding rendered element is not yet visually highlighted in Preview. |
| Harness-owned Chromium runtime | **REAL LOCAL VERIFIED** | Personal Chrome attach path removed. |
| Clean verification Chromium profile | **REAL LOCAL VERIFIED** | Profile cleanup defects fixed. |
| Workshop Chromium profile | **IMPLEMENTED / VERIFIED** | Project-bound browser path exists. |
| HOST/VM environment abstraction | **IMPLEMENTED / FIXTURE VERIFIED** | Host path active. |
| VMware provider | **IMPLEMENTED CONTRACT / NOT REAL VERIFIED** | VMware unavailable on measured machine. |
| Guest runner/bridge | **IMPLEMENTED CONTRACT** | Not real-VM certified. |
| Computer MCP | **NOT IMPLEMENTED** | Next major horizontal capability. |
| Backend full trace workshop | **PARTIAL** | Logs/network/process capabilities exist, full UI→API→backend mapping not done. |
| Android Workshop | **NOT IMPLEMENTED** | Target capability. |
| Native/Desktop Workshop | **NOT IMPLEMENTED** | Target capability. |
| Blender/3D Workshop | **NOT IMPLEMENTED** | Target capability. |
| 2D/Game Asset Workshop | **NOT IMPLEMENTED** | Target capability. |
| Native Harness photo editor | **NOT IMPLEMENTED** | Required shared capability. |
| Cowork backend | **PARTIAL / PAUSED** | Astra work started; capability surface incomplete. |
| Bot gateway architecture | **PARTIAL / PAUSED** | Telegram/Discord/WhatsApp architecture substantially landed; live hardening/certification incomplete. |
| Telegram gateway | **IMPLEMENTED / FIXTURE VERIFIED** | Live certification pending. |
| Discord gateway | **IMPLEMENTED / FIXTURE VERIFIED** | Live certification pending. |
| WhatsApp Cloud adapter | **IMPLEMENTED / FIXTURE VERIFIED** | Public webhook/live certification pending. |
| Bot supervisor role | **DESIGN / PARTIAL** | Full external-app supervision not complete. |
| Bot → Computer MCP | **NOT IMPLEMENTED** | Requires Computer MCP. |
| Bot native photo editing | **NOT IMPLEMENTED IN HARNESS** | Must use shared Image capability; local `E:\AI` stack may be used during transition. |
| Cowork spreadsheets | **NOT IMPLEMENTED IN FINAL COWORK** | Tool concept defined. |
| Cowork email | **NOT IMPLEMENTED IN FINAL COWORK** | Tool concept defined. |
| Add Account / Account Manager | **DESIGN** | Replaces old `/oauth` as a user-facing account abstraction; OAuth/device flow is only one authentication mechanism. |
| Context Cost Observatory | **DESIGN** | Required to explain per-turn input composition and distinguish LAIN context cost from router/provider overhead. |
| Provider-independent Context Builder | **DESIGN / PARTIAL CONCEPT** | One normalized LAIN context packet should feed direct providers, routers, web-model sources, and local models rather than provider-specific context stuffing. |
| Central retry/backoff policy | **IMPLEMENTED / VERIFIED** | Standard recoverable provider schedule is 10/15/30/45/60/90/120/180/300/300s with `MAX(local, trusted Retry-After)` and bounded attempts. |
| B.AI provider | **IMPLEMENTED / FIXTURE VERIFIED** | `https://api.b.ai/v1` in the ONE table; wire URL proved by recording the sender's actual fetch: `https://api.b.ai/v1/chat/completions`. No live account call has been made. |
| Z.AI provider | **IMPLEMENTED / FIXTURE VERIFIED** | Already correct and NOT modified. Wire URL proved as `https://api.z.ai/api/paas/v4/chat/completions`. |
| `/api` add / re-key custom provider | **IMPLEMENTED / FIXTURE VERIFIED** | Naming a route that exists re-keys it under the SAME id; naming a provider with no route adds it preselected; a connection id is never stored as a credential. |
| Structured user-prompt rendering | **IMPLEMENTED / REAL LOCAL VERIFIED** | User messages go through ui/markdown.js, the same renderer model answers use. `=====` separators are recognised as sections. Verified through the real binary at 80/120/160 columns. |
| Artifact authority | **IMPLEMENTED** | Existing Harness capability. |
| Verification authority | **IMPLEMENTED** | Existing PASS/FAIL/INCONCLUSIVE contract. |
| Process/service authority | **IMPLEMENTED** | Existing Harness capability. |
| Browser/CDP core | **IMPLEMENTED** | Used by Workshop/verification/web models through separated lifecycles. |

---

# 35. Immediate Known Product Issues

1. Harness remains CLI-process-owned; closing the owning CLI still closes the current app-window prototype. A genuine desktop process + structured process-boundary IPC is the next architectural blocker.
2. Source → UI selector derivation exists, but the corresponding rendered element is not yet highlighted in Preview.
3. **RESOLVED (FIXTURE VERIFIED).** `/copy context` rendered structured mid-turn user records as `[object Object]`. `turn.js` pushes `{ step, text }` records into `steerTexts`; the projection assumed strings. `copysummary.js` now extracts the public sentence and OMITS an entry that has none — heading included — rather than stringifying it. Hostile shapes (functions, Symbols, Maps, Dates) return empty and never throw. `/copy` itself is unchanged byte for byte.
4. Native terminal selection now works with mouse capture off, but the internal transcript mouse wheel then does not receive scroll events; `/mouse on` restores LAIN mouse interaction at the cost of native selection. Hybrid/default navigation needs a deliberate solution; PgUp/PgDn must remain usable.
5. Provider abort/refusal and continuation runs can still surface excess durable narration/glue in some paths; transient alert semantics must remain authoritative.
6. Continuation/handover can still cause model-driven rediscovery and repeated reads despite evidence/handover infrastructure, wasting context on interrupted runs.
7. Shell dialect leakage remains observable: models can still attempt bash idioms such as `tail` in PowerShell contexts instead of using shell-neutral deterministic tools. **Measured this pass and the specific reported symptom did not reproduce**: through the shell LAIN resolves (pwsh 7) every failure shape already exits non-zero, and `| tail -30` SUCCEEDS here because `tail` exists in Git's `usr/bin`. A speculative `$LASTEXITCODE` epilogue was written, measured to change nothing, and removed rather than shipped.
8. Computer MCP does not yet exist.
9. VMware clean proof cannot be REAL LOCAL VERIFIED until a Harness-owned VMware environment is actually available.
10. WebModel ChatGPT/Gemini remain fixture-verified rather than live-account certified.
11. Cowork/Bot implementation remains incomplete/paused under Astra ownership.
12. Shared native photo/image editor has not yet been promoted into a first-class Harness capability usable by Chat/Coding, Cowork, and Bot.
13. Android, Blender/3D, 2D/game-asset, and richer native-desktop workshops are future work.
14. Add Account / account management and context-cost observability are designed but not implemented.

# 35a. Architecture Corrections Discovered

- **Desktop boundary:** Chromium `--app=` is useful prototype presentation, but does not make Harness a genuine independent desktop process. Final Harness must communicate with LAIN runtime through structured IPC and remain alive independently of an originating CLI terminal.
- **Mouse ownership:** native text selection and LAIN transcript wheel navigation compete under terminal mouse-reporting modes. `/mouse on` is an explicit full-interaction mode, not the default fix. The product must preserve native selection by default and provide reliable keyboard transcript navigation even if true hybrid wheel capture is unavailable in the host terminal.
- **Diagnostic context projection:** `/copy context` is correctly record-based, but record serialization must project public semantic content rather than blindly stringifying structured payloads.
- **Continuation efficiency:** durable handover/evidence should allow a resumed model to continue from verified/unverified state rather than reacquiring the same files and facts after every interruption.
- **Account abstraction:** `/oauth` is too implementation-specific. The product concept is now **Add Account**, separating account/authentication, provider, model inventory, and routing.
- **Context-cost truth:** router/provider comparisons are meaningless unless LAIN can report the actual normalized context packet it sent. Context accounting must be first-class and provider-independent.

---

# 36. Recommended Implementation Order

## Phase A — Desktop Foundation

1. Native Harness desktop shell.
2. Bundle Harness + CLI.
3. Project opening.
4. Session binding.
5. Structured IPC/Core bridge.
6. Background LAIN execution.
7. Optional integrated PTY.
8. Retire manual-password `/app` UX.

## Phase B — Source + Web Workshop Integration

1. Source Workspace.
2. File tree/quick open.
3. Editor/diff.
4. Live LLM patch visualization.
5. UI candidate highlighting.
6. UI → source opening.
7. Source → UI highlighting.
8. Selection → Ask LAIN/Fix.
9. Dogfood: use LAIN Harness to improve LAIN Harness.

## Phase C — Computer MCP

1. Windows UI Automation.
2. Displays/windows.
3. Structured control discovery.
4. Mouse/keyboard fallback.
5. Observation → action → observation → verification.
6. Host target.
7. VM target contract.
8. Harness UI projection.
9. Bot/Cowork reuse.

## Phase D — Backend Depth

1. Route/API tracing.
2. Logs/process correlation.
3. DB/schema tools.
4. UI event → network → backend route graph.
5. Backend evidence UI.

## Phase E — Android

1. Android SDK/ADB.
2. Emulator.
3. Build/install.
4. Layout/accessibility.
5. Device presets.
6. UI ↔ source where practical.
7. Verification.

## Phase F — Creative Tools

1. Shared native Image capability/editor.
2. 2D asset/sprite workflow.
3. Blender/3D adapter.
4. Structured Blender operations.
5. Game-character workflow.
6. Artifact export.

## Phase G — Cowork + Bot Completion

1. Cowork file workflows.
2. Spreadsheet.
3. Documents.
4. Email.
5. Image/photo.
6. Reminders/calendar.
7. Bot supervision.
8. External AI app observation.
9. Telegram/Discord/WhatsApp live certification.
10. Remote artifacts/approvals/background notifications.

## Phase H — Release

1. Clean install.
2. Installer bundle.
3. Harness-owned Chromium package.
4. VM certification.
5. Windows desktop smoke.
6. Project migration/resume.
7. Security review.
8. Performance.
9. Documentation.

---

# 37. Dogfood Acceptance Goal

The strongest LAIN Harness proof is:

> Use LAIN Harness to improve LAIN Harness.

```text
Launch LAIN Harness desktop
        ↓
Open lain-v2
        ↓
Engineering session attaches/starts LAIN
        ↓
Open Harness frontend source
        ↓
User selects a UI element in live Harness
        ↓
Harness asks which candidate if ambiguous
        ↓
User clicks target
        ↓
Source editor opens exact related code
        ↓
relevant code is highlighted
        ↓
LAIN applies a real patch
        ↓
editor highlights the actual mutation
        ↓
Workshop reloads
        ↓
UI object updates
        ↓
desktop/mobile verification
        ↓
console/network checks
        ↓
before/after artifacts
        ↓
evidence-backed completion
```

---

# 38. Example: Ambiguous Button Repair

User:

> Fix that button.

Harness detects multiple candidate controls.

```text
Which button?

[1] Save — Settings
[2] Save — Editor toolbar
[3] Save — Account
```

Candidates are highlighted in Preview.

User clicks `[2]`.

Harness resolves:

```text
visible button
→ AX node
→ DOM node
→ component
→ source
```

Source opens:

```tsx
<Button opacity={0.2}>Save</Button>
                 ^^^
```

LAIN changes:

```tsx
<Button opacity={0.5}>Save</Button>
```

Harness displays the real patch:

```diff
- opacity={0.2}
+ opacity={0.5}
```

The changed range is highlighted.

Preview updates.

LAIN verifies the selected button, not the other Save buttons.

---

# 39. Example: Bot Supervises Claude

User on Telegram:

> Check if Claude is still working.

Bot:

1. checks LAIN-owned/native process/session state if authoritative,
2. if insufficient, invokes Computer MCP,
3. observes Claude application,
4. identifies current visible state,
5. replies with evidence-based status.

Bot should not infer "working" from PID existence alone.

---

# 40. Example: Bot Edits a Photo

Telegram:

```text
[photo]
remove the background and clean the lighting
```

Flow:

```text
Telegram adapter
→ Bot
→ shared Image capability
→ background removal
→ lighting adjustment
→ artifact
→ Telegram attachment
```

The image editor belongs to Harness capability infrastructure, not Telegram code.

---

# 41. Capability Discovery Principle

The Harness should expose task-relevant capabilities, not every tool at once.

Examples:

Node backend project:

```text
Source
Terminal
Backend
Tests
Database
Browser if needed
```

Android project:

```text
Source
Android
Emulator
ADB
Logcat
Verify
```

Blender character task:

```text
Source/assets
Blender
Image
3D
Render
Artifacts
```

Excel Cowork task:

```text
Spreadsheet
Files
Artifacts
```

---

# 42. Security / Trust Principles

1. One canonical machine trust/permission authority.
2. Messaging authorization is separate from machine permission.
3. WebModel output is untrusted external content.
4. Browser profiles remain isolated by purpose.
5. Computer MCP requires explicit session authorization.
6. Do not scrape/store credentials in model context.
7. Do not expose arbitrary host/guest paths as artifacts.
8. Do not let frontend UI become a second filesystem authority.
9. Do not let VM isolation imply unlimited network/host permission.
10. Do not create separate permission engines per workshop.

---

# 43. Architecture Anti-Patterns — FORBIDDEN

Do not build:

- another LAIN Core inside Harness,
- another task runtime,
- another verification engine,
- another event bus,
- another process manager,
- separate model-specific tool ecosystems,
- a second Cowork brain for Telegram,
- a second Computer controller for Bot,
- screenshot-only desktop automation when structured UI exists,
- a permanent giant dashboard,
- an IDE clone where every tool is always visible,
- fake success from UI shells,
- fake activity states from timers,
- automatic source mappings without evidence,
- a frontend that parses ANSI CLI output to infer Core state.

---

# 44. Definition of Done for a Capability

A capability may be called **IMPLEMENTED** when code exists and its real contract is wired.

A capability may be called **FIXTURE VERIFIED** when deterministic fixtures exercise the actual orchestration path.

A capability may be called **REAL LOCAL VERIFIED** only when driven against a real local app/runtime.

A capability may be called **LIVE EXTERNAL VERIFIED** only when tested against the real external service/account.

---

# 45. Blueprint Maintenance Rules

When an implementation report is received:

1. locate the capability in **Current Implementation Status**,
2. update status,
3. add evidence/known limitation,
4. update architecture only if implementation revealed a genuine design correction,
5. do not delete future requirements simply because current implementation is incomplete.

When the user says:

> add this to the blueprint

update the relevant architecture section.

When the user says:

> this changed

mark the previous decision superseded and update the frozen rule.

When the user says:

> implement this

the implementation prompt should reference this blueprint and preserve unrelated sections.

---

# 46. Current North Star

LAIN Harness should become:

> **A model-agnostic desktop workbench where the user, the LLM, source code, the running application, backend state, creative tools, desktop applications, and verification evidence are connected into one observable execution environment.**

The defining experience is not:

> "Chat with an AI that tells me what code to change."

It is:

> "Show LAIN the thing I want changed, let LAIN identify the exact object and source, watch the real change happen, run the result, inspect the outcome, and verify that the intended thing actually changed."

And outside coding:

> "Give LAIN something to do, or ask Bot to supervise what is happening, using the same shared capabilities regardless of which LLM is currently selected."
