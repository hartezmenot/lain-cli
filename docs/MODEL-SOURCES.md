# Chat model sources — the contract

**Who answers a chat turn.** LAIN's own runtime, ChatGPT.com, or
Gemini.google.com. This document is the contract the Harness frontend consumes;
it deliberately says nothing about how a page is read, because a frontend must
never need to know.

---

## 1. The two things that are not the same thing

```
ModelSource                          MessagingTransport   (src/bot — not here)
  ├─ RuntimeModelSource  "lain"        ├─ Telegram
  └─ WebModelSource                    ├─ Discord
       ├─ "chatgpt-web"                └─ WhatsApp
       └─ "gemini-web"
```

A **ModelSource** is a model LAIN can consult.
A **MessagingTransport** is a place a person can talk to LAIN.

They are orthogonal, and they are not behind one "external adapter"
abstraction. A messaging transport carries the user's own authority; a consulted
model carries none. Merging them merges the one boundary that decides whether a
sentence may cause an action.

---

## 2. One engineering session, two kinds of turn

Chat and coding are **not** separate modes, tabs or sessions. They share one
session, one project, one workspace and one history:

```
  user: why is checkout failing?          -> CHAT
  user: show me the architecture          -> CHAT
  user: implement the fix and run tests   -> CODING
  user: why did you change router.js?     -> CHAT
```

Nobody starts a new session because the next sentence changed register.

### Which lane a turn is in

`src/modelsource/lane.js` — and it is a **projection of `mode.js`, not a second
classifier**:

```
  mode.READ_ONLY  (CHAT, EXPLAIN, AUDIT)   -> CHAT lane
  everything else                          -> CODING lane
```

It is computed from `mode.READ_ONLY` itself, so it cannot disagree with the one
classifier that already exists. There is no LLM call, no second regex table.

### The invariant that matters most

> **Selecting ChatGPT.com changes who answers a question. It never changes who
> writes a file.**

A CODING turn runs `turn.js` with the tool registry, the permission gate, the
checkpoints and the verification contract, exactly as it always has, whatever
chat source is selected. A web model reply is untrusted text: no tool is offered
to it, `gate.js` is not consulted on its behalf, it cannot settle a task, and a
reply claiming to have *acted* is flagged rather than passed through.

---

## 3. What a frontend reads

### The picker

```js
const registry = require('./src/modelsource/registry');
await registry.overview(app);
```

```jsonc
{
  "selected": "chatgpt-web",
  "sources": [
    {
      "source": "lain",
      "label": "LAIN",
      "kind": "RUNTIME",
      "state": "READY",
      "why": "",
      "selected": "glm-5.3-flash",
      "models": null,            // discovery is a separate, paid call
      "modelsAt": null,
      "capabilities": { "text": true, "streaming": true, "authoritativeUsage": true, … },
      "chosen": false
    },
    { "source": "chatgpt-web", "label": "ChatGPT.com", "kind": "WEB", "state": "AUTH_REQUIRED", … }
  ]
}
```

`overview` is **cheap**: it launches no browser and refreshes no catalog. A
picker rendering three sources must not start three Chromiums.

### The model list

```js
const src = registry.get(app, 'chatgpt-web');
await src.discoverModels({ refresh: false });
// { ok, models: [{ id, label, state }], cached, at, why, authRequired? }
```

Model `state` is one of `AVAILABLE` · `UNAVAILABLE` · `UNKNOWN` ·
`AUTH_REQUIRED`. **`UNKNOWN` is a real value** — a site that stops declaring
availability produces it rather than an optimistic `AVAILABLE`. A model list
that cannot be *read* returns `ok: false` with a reason, never an empty array:
"this account has no models" and "the site changed" are different statements and
a person would act on the first by re-subscribing.

The inventory is cached for 10 minutes, refreshable by hand
(`discoverModels({ refresh: true })`), and thrown away when authentication
changes.

### Selecting

```js
await registry.selectSource(app, 'gemini-web');   // local, no browser
await registry.selectModel(app, 'gemini-web', 'gemini-x');
```

A model outside the discovered inventory is refused. **"Selecting
ChatGPT.com" never means "use whatever is active."**

### Connection state

`DISCONNECTED` · `CONNECTING` · `AUTH_REQUIRED` · `DISCOVERING` · `READY` ·
`RATE_LIMITED` · `UNAVAILABLE` · `FAILED`

### Live activity

On the **one** `EventBus` (`src/events.js`) — not a second channel:

```
webmodel.connecting   webmodel.auth_required   webmodel.discovering
webmodel.ready        webmodel.sending         webmodel.waiting
webmodel.receiving    webmodel.rate_limited    webmodel.failed
webmodel.cancelled
```

Payloads carry a source id, a model id, a state and a short reason. Never a
cookie, never a URL with a token in it, never a prompt, never a reply.

### The normalized result

Website-specific detail stops at the adapter. The session only ever sees:

```jsonc
{
  "source": "chatgpt-web",
  "model": "gpt-x",
  "status": "COMPLETED",       // | CANCELLED | AUTH_REQUIRED | RATE_LIMITED | UNAVAILABLE | FAILED
  "text": "…",
  "usage": null,               // websites publish no authoritative count — see below
  "conversationBinding": { "threadId": "…" },
  "retryAfterMs": null,        // only when the site STATED one
  "error": null,
  "provenance": { "sourceId": "chatgpt-web", "sourceLabel": "ChatGPT.com",
                  "model": "gpt-x", "label": "ChatGPT.com · gpt-x", "at": 1788… }
}
```

`COMPLETED` **requires text** — an empty one is rewritten to `FAILED` at the one
place every source passes through. `usage` is `null` for web sources and
`authoritativeUsage: false` says so: unknown stays unknown, never a plausible
estimate that reads like a measurement.

### Provenance

Stamped **at execution time** and stored on the assistant message, so history,
resume and any later comparison read the truth rather than whatever the picker
shows later:

```
  LAIN · glm-5.3-flash
  ChatGPT.com · gpt-x
  Gemini.google.com · gemini-x
```

---

## 4. Authentication is the person's

LAIN opens a browser window. A **human** logs in, answers the MFA prompt and
solves the CAPTCHA. There is no credential entry, no stored password, no cookie
import from Chrome/Edge/Firefox, no anti-bot evasion. `AUTH_REQUIRED` is a
first-class result, not an error.

Three-valued on purpose: `READY` / `AUTH_REQUIRED` / `UNKNOWN`. Telling somebody
to sign in when they already are hides the real problem, which is that the page
is not the page the adapter knows.

### Two browsers, kept apart

| | Verification browser | Web model browser |
|---|---|---|
| owner | `harness/browserharness.js` | `modelsource/webbrowser.js` |
| profile | `mkdtemp`, deleted with the task | persistent, under `configDir()/webmodels/<source>` |
| headless | yes | **no** — a person has to log in |
| pointed at | code under test | a site the person is signed into |

Reusing one for the other in either direction is a real failure: a verification
run driving somebody's authenticated Google session, or a login thrown away
every time a task finishes. `webprofile.isolatedFrom()` is the assertion, and it
is a test rather than a comment because the failure is silent.

`/source disconnect` stops using a source and **leaves the login alone**.
`/source forget` removes the saved profile, and is only reached by asking.

---

## 5. What actually leaves the machine

`modelsource/context.js`. Bounded, redacted **at the build** so the bytes
previewed are the bytes sent.

Included: the question; on a first turn also a handful of session facts (project
path, runtimes, test command, files changed this session, plan position, last
check result) and the recent user/assistant exchange.

Never included: raw tool logs, command output, file bodies, the environment,
LAIN's own reasoning, credentials.

On a **resumed thread** the site already holds the earlier exchange, so the
payload is the question and nothing else.

---

## 6. Website thread bindings

One per source per session, in `session.providerBindings`, **owned** by the
session that minted it. `binding.resolve` refuses to serve a binding recorded
against a different session id.

Before every send the page's actual conversation is compared against the
binding. A mismatch **fails closed**: the binding is dropped and a new thread is
started. It never adopts whatever thread happens to be on screen — that is how
one project's context lands in another project's ChatGPT conversation, and
nothing on screen would say so.

---

## 7. Sending is proved, not assumed

Before: signed in · the right conversation · the intended model (clicked **and
read back**).
After: the assistant turn count **grew** · the reply settled (not streaming, and
unchanged for a quiet period).

Any of those unestablished ⇒ `FAILED` with a reason. Never a fabricated success,
and never the previous answer returned as this turn's.

**An uncertain send is never repeated.** If the composer provably refused the
text, nothing left and one bounded retry is safe. If the prompt may have been
submitted, LAIN does not send it again — a duplicate message in somebody's own
ChatGPT thread cannot be withdrawn.

**Cancellation** adopts the caller's `AbortSignal` (the turn's own — there is no
second cancellation system), presses the site's stop button, and leaves the
authenticated profile untouched.

**Rate limits** keep their source: `{ status: RATE_LIMITED, source: "chatgpt-web",
retryAfterMs }`, and `retryAfterMs` is `null` unless the page stated a time. A
web rate limit deliberately does **not** arm app.js's automatic resume, which
would re-send somebody's question into their own thread unasked.

---

## 8. Verification status

| Claim | Tier | Label |
|---|---|---|
| The orchestration — guards, retry rule, bindings, cancellation, rate-limit classification, provenance, session isolation | unit (conformance, run under both source ids) | **FIXTURE VERIFIED** |
| Chat/coding lane routing, one shared history, per-source model persistence, resume | unit | **FIXTURE VERIFIED** |
| The context policy — bounds, redaction, no tool output | unit | **FIXTURE VERIFIED** |
| The profile boundary against the verification browser | unit | **FIXTURE VERIFIED** |
| `/source` reaches a user through the real binary | smoke | **LIVE-VERIFIED (CLI)** |
| chatgpt.com's page structure still matches `chatgpt.js` | — | **NOT LIVE VERIFIED** |
| gemini.google.com's page structure still matches `gemini.js` | — | **NOT LIVE VERIFIED** |

No default test tier opens a browser or contacts either site. Only
`/source check chatgpt` (or `gemini`) can earn a LIVE claim, and it says at the
end exactly what it did and did not establish. `/source check fixture` runs the
same five steps against a fake site, which is how a red live run is told apart
from a broken check.

---

## 9. What `/external` became

`/external` and its four modules (`external.js`, `actors.js`,
`externalrequest.js`, `investigation.js`) are retired. The relay had been
unreachable since `/troubleshoot` left the command registry.

Reused rather than rewritten:

- the bounded, redacted session-facts packet → `modelsource/context.js`
- the call ledger, including *RESPONDED requires a response* → `externalstate.js`,
  kept whole and now written by the web sources
- the overclaim check → `modelsource/contract.js`
- "advisory input, not a result, and not from the user" → `chatdispatch.js`

Retired: the actor taxonomy (API / HUMAN / REVERSE), the clipboard relay, the
draft/confirm/send state machine, and the bounded LAIN → EXTERNAL → LAIN relay.

A second opinion is now a **selection**, not a verb: choose ChatGPT.com and the
next question goes there, in the same history, with provenance on the answer.
Two consultation systems would have been worse than either.
