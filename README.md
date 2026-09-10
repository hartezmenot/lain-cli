# LAIN v2

An agentic coding CLI — an **LLM harness that works across multiple model
providers and connections**. The model decides what to do; LAIN supplies tools,
state, evidence, reversibility and routing, and otherwise stays out of the way.

LAIN is **provider-agnostic**. It is not tied to any one vendor or to any one
runtime, local or hosted: a provider is configured, not built in.

> **Status: alpha.** Every capability described here is implemented and verified;
> [`docs/STATUS.md`](docs/STATUS.md) records the verification tier for each one.
> Nothing is documented before it exists.

> **The harness.** LAIN no longer ends a task when the model stops talking — it
> ends one when EVIDENCE says so, and keeps the receipts. There is no method
> anywhere that marks a task done; the only route to `PASSED` runs through a
> verification contract. See [`docs/HARNESS.md`](docs/HARNESS.md) for the
> architecture, the commands (`/harness`, `/verify`, `/artifacts`, `/env`,
> `/tasks`) and the stated limitations, and
> [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) for how `lain` gets onto a
> machine and what was verified rather than assumed.

## Install

Messaging access through Telegram, Discord and WhatsApp is available as an
optional surface of the same runtime. See [LAIN Bot setup and limits](docs/BOT.md)
for `lain --bot`, `/bot`, authorization, credentials and tested capabilities.

**One product, one install, one command.** Installing LAIN Harness gives you the
`lain` executable with the harness inside it. There is no separate LAIN CLI to
install first, and no integration step.

```bash
npm install -g lain
```

Then, in any project:

```bash
lain --version
lain --doctor
lain
```

`--doctor` is the check to run after installing: it reports what works on this
machine and why anything does not, contacts no provider and creates no session.

### From a clone, or without npm

```bash
node distribution/install.js
```

This writes a launcher into `~/.lain-v2/bin`, adds that one directory to your
**user** PATH (never the machine PATH, never with administrator rights), and
then *verifies the result by actually running `lain --version`*. It does not
copy the runtime — the launcher points at your checkout, so there is exactly one
LAIN on the machine.

If PATH cannot be written it still installs, says so, and prints the exact
command to add it yourself. It never claims global availability it has not
proved. Undo it with `node distribution/uninstall.js`, which removes the
launcher and the PATH entry and leaves your config, your sessions and your
checkout alone.

### Developing on LAIN

Nothing needs installing:

```bash
node bin/lain.js --help        # zero runtime dependencies, Node >= 18
node tests/run.js              # unit · integration · smoke · distribution
```

### What is required, and what is optional

Core needs Node 18+ and nothing else — LAIN has **no runtime dependencies**, so
an install cannot fail on a transitive package. Everything below is optional,
degrades honestly, and never blocks installation:

| Optional | Without it |
|---|---|
| Chrome/Chromium (Node 22+ for the client) | browser checks report INCONCLUSIVE, with the reason |
| a git repository | change observation falls back to the filesystem |
| a declared test/build script | `/verify full` says the project declares nothing to prove |
| the Rust supervisor | background work does not outlive the process |
| a desktop bridge (MCP) | `computer` is simply absent |

`lain --doctor` lists all of it, and marks an absent optional capability `○`
rather than `✗` — it is a fact, not a fault.

## Concepts

LAIN keeps these separate, because collapsing them is what produces wrong
answers ("the server is down" vs "log in" vs "you disabled it"):

| Concept | Meaning |
|---|---|
| **Model identity** | *what* you are talking to — `claude-opus-5`. One identity, however many ways it is reachable. |
| **Provider** | who serves it — `anthropic`, `github`, `opencode`. |
| **Connection** | a concrete route to a provider: native with a credential, or a bridge that holds its own. |
| **Credential / auth** | how a connection authenticates: `api_key`, `oauth`, or `none` for a bridge. |
| **Readiness** | how far the auth chain has got: `NONE` → `CREDENTIAL_FOUND` → `AUTHENTICATED` → `REQUEST_READY`. Only a **successful request** earns `REQUEST_READY`. |
| **Availability** | whether the route answers *now*: `AVAILABLE`, `DEGRADED`, `UNAVAILABLE`, `MAINTENANCE`, `DISABLED`, `UNKNOWN`. Learned lazily from real requests — there is no polling. |
| **Effort** | reasoning effort, orthogonal to identity. `claude-opus-5` at `low`/`high` is one model, not two. |
| **Catalog** | what a connection actually serves. **Discovered from the route**, cached on disk, never transcribed by hand. |
| **Routing** | `(model, connection, effort)` → the exact upstream id, resolved at send time. |
| **Session** | owns the conversation, the task, the evidence and the plan. |
| **Task identity** | one classifier decides new task / continuation / restatement / steer / content. |
| **Turn loop** | one user message → as many model steps and tool calls as the model wants. Tool counting is **turn-wide**. |
| **Lifecycle / liveness** | `ACTIVE`/`DONE`/`BLOCKED`/… fed by the real turn loop; notices genuine non-progress without dictating tools. |
| **Evidence** | a content-keyed memory of what has been read. A cache, never a prohibition. |
| **Plans** | optional, session-owned, written by **either** the model or you. Completed steps are evidence. |
| **Completion** | requires evidence **and** a check that is not currently failing. A finished checklist over a red test suite is not a finished task. |
| **Checkpoints / undo** | prior bytes captured before every mutating call; restored on `/resume`, and never written over a change made since. |
| **Tools** | filesystem, search (`grep`/`glob`/`symbols`/`dependents`), semantic edits by symbol name, unrestricted shell, plans, `ask_user` — the model asks YOU a question and the panel renders the choices — and `web_fetch`/`web_search`, so a question whose answer is in a changelog is not answered from a training cut-off. |
| **Execution** | every command states the shell it ran in and the directory it ran in; every failure comes back CLASSIFIED, with the fact about that shell that explains it, and with what the same command already did. |
| **Mode** | what KIND of work this is (implement / bugfix / audit / …), inferred locally and for free. Selects workflow guidance; never blocks anything. |
| **Task record** | the harness half of a task: a durable state (`PLANNED`/`RUNNING`/`BLOCKED`/`VERIFYING`/`PASSED`/`FAILED`/`INCONCLUSIVE`/`CANCELLED`) under `.lain/tasks/<id>/`, outliving the session. `PASSED` is reachable only from `VERIFYING`. |
| **Verification contract** | requirements, each naming the evidence that would establish it — a suite, a build, an endpoint, a file, a service, a browser flow. Every check returns PASSED / FAILED / **INCONCLUSIVE**, and the task verdict is arithmetic over them. A model's claim is never evidence. |
| **Managed service** | a long-running process (dev server, API) with a port, a health check, restarts and an **owner task** that takes it down. Distinct from a *job*, which is a command that ends and yields a result. |
| **Observation** | a question — element, page, errors, screen, changes, logs, endpoint — routed to the cheapest source that can answer it: DOM before screenshot, git before reading files. A source that cannot answer says so. |
| **Artifacts** | durable evidence per task: verification reports, test output, logs, real PNG screenshots. Never compacted, addressable long after the transcript has been folded. |

## How LAIN approaches a request

You do not tell LAIN what kind of job this is, and you do not need to know where
anything lives in your own project. The request is classified **locally** — no
model call, no tokens — and that decides what happens first:

| You say | LAIN infers | and starts by |
|---|---|---|
| "Add a Telegram signal on/off button." | IMPLEMENT | finding the existing signal system, settings owner and API before adding anything |
| "The button doesn't switch from OFF to ON." | BUGFIX | tracing trigger → handler → API → state → response, then fixing the one broken link |
| "Something is wrong with Telegram signals." | TROUBLESHOOT | narrowing it down with evidence, cheapest checks first |
| "Audit this project." | AUDIT | mapping it and reporting — **changing nothing** |
| "Explain what this file does." | EXPLAIN | reading and describing — **changing nothing** |
| "Create me a trading bot." | NEW PROJECT | building in stages, each one verified before the next |
| "continue" | RESUME | picking up the existing plan rather than re-planning |
| "thanks" | CHAT | answering, without scanning the repository |

The classification is **advisory**: it selects a paragraph of workflow guidance
and nothing else. It never forces a tool, forbids a tool, or dictates an order,
so a wrong guess costs one wrong hint rather than a blocked task. A **paste is
always content** — a stack trace full of "error" and "failed" is evidence for
the work in hand, never a new instruction — and a continuation keeps the mode it
is continuing.

What this buys, on a real multi-layer project: asked to add a Telegram toggle,
LAIN found the existing `notifications` settings section, the existing API route
and the existing service, and extended them — rather than inventing a second
place for settings to live.

## Configure a provider

LAIN reads `~/.lain-v2/config.json` (override with `LAIN_CONFIG_DIR`). The
simplest form is an environment variable:

```bash
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY
```

The fuller form declares **connections** — routes that can serve models. A
connection states **where it is**; what it *serves* is discovered from it:

```json
{
  "connections": {
    "anthropic": {
      "provider": "anthropic", "via": "native", "auth": "api_key",
      "envKey": "ANTHROPIC_API_KEY"
    },
    "omniroute": {
      "provider": "omniroute", "via": "bridge",
      "baseUrl": "http://localhost:20128/v1",
      "default": "claude-opus-5"
    }
  }
}
```

### Catalog discovery

There is no list of models to write out. On first use LAIN asks each connection
what it serves (`GET /models`) and caches the answer under `~/.lain-v2/catalog/`
for a day. `/provider refresh [id]` re-reads it.

This is a **catalog** request, not a model call: no tokens, no completion. It
runs at most once per connection per launch, it is announced on screen while it
happens, and there is no timer or background poll. A route that declares its own
`"models": [...]` is never contacted — you already answered the question.

`models` entries, whether declared or discovered, may be bare ids or catalog
records carrying `root` / `parent` / `owned_by`; that **provider-declared**
metadata is what decides which ids are the same model. On a real router this
collapses **2,760 upstream ids into 934 canonical models**.

### Choosing a model

`"default"` on a connection names the model to start with, matched against that
connection's own catalog. Without one, LAIN selects a model **only** when the
catalog holds exactly one — it has no opinion about which of a router's thousands
of entries is good at code, and will say `No model selected` and point you at
`/models` rather than guess.

A `bridge` connection holds its own upstream credential. LAIN never reads it and
never needs it — which is what makes using a bridge legitimate rather than a
credential grab.

Any OpenAI-compatible (`"protocol": "chat"`) or Anthropic-compatible
(`"protocol": "anthropic"`) endpoint can be a connection. A local runtime that
speaks either protocol is simply one more connection — it is not the foundation
of the system.

Secrets belong in the config file or the environment — never in source, tests,
logs or plans.

## Use

```bash
lain                          # interactive; ALWAYS a new, empty session
lain -p "add a --json flag"   # one shot
lain --resume 7f4c            # explicitly restore a session (short token)
lain --sessions               # list saved sessions
```

## The interface

One terminal UI with four framed regions — not four windows. Only the ACTIVE
view owns the workspace; the panel at the foot is hidden until something needs
choosing. Every region carries its name on its own top edge, so the boundary
between *what LAIN is doing* and *where you type* is always visible.

### Reading the screen

Four questions, four places, so nothing has to be untangled from anything else:

```
TASK  fix the telegram signal toggle
STEP 2/5  ██████░░░░░░░░░░░░░░  20%   ◐ Thinking…  4s
ACTIVITY

  MODEL
    Looking at the settings owner and the API between them.

  ACTIONS
    ✓ Listed src
    ✓ Read web/settings.js

  MODEL
    The toggle writes the wrong state key.

  ACTIONS
    ✓ Wrote web/settings.js
    ✓ Ran the focused test
```

**Progress is two rows**, not a block: what the task is, where in the plan the
work is, how much is *finished*, and what is happening this second. On an 80×24
terminal that leaves twelve of fourteen rows for the work itself.

**The work is PRESENTED, not dumped — and the presentation never paces the
agent.** One operation is live at a time, wearing a quotation box under its own
verb (`reading` over `python.js`), long enough to actually read. An edit opens a
temporary window on a light surface and *performs* the change: it scrolls to the
first hunk, stops, strikes the old lines through in red, writes the replacement
character by character in blue, settles it green, then moves to the next one —
while the `+n -m` on the card climbs with it. Prose resolves as it arrives
rather than appearing as a block.

All of that is a pure function of (real events, clock). Nothing in the turn loop
awaits it, the model can be several operations ahead of what the screen is
showing, and over a pipe or with no TTY it collapses to the same content with no
animation at all. It can be behind reality; it cannot change it, and it never
shows an event that did not happen.

**Lines announcing what the screen is already showing are dropped before they
are drawn.** "Let me read the runner log" is a worse copy of the `reading /
runner.log` box under it. This is presentation only — `/copy last` and
`/copy context` hand back exactly what the model wrote.

**MODEL is what the model said to you; ACTIONS is what LAIN actually ran.** They
used to share one undifferentiated stream, where a sentence and a tool call
looked alike. On a narrow terminal the labels drop and the indentation and `✓`
keep them apart.

**The input row is a viewport that follows the caret.** Type past the right edge
and the window scrolls with you, marked `…` where the text continues; `←` `→`
`Home` `End` move within the line, and `↑` `↓` walk the lines of a pasted block
(and recall history when there is no block to walk). Nothing you type can end up
somewhere you cannot see.

### Is it still working?

The screen answers this at all times, and never by guessing. `turn.js` announces
each phase from the point in the loop where it becomes true, and the UI shows it:

| You see | It means |
|---|---|
| `THINKING` · `◐ Thinking… 45s` | the request is out; nothing has come back yet |
| `WORKING` · `◐ Writing…` | the model is producing output |
| `RUNNING` · `◐ Reading src/auth.js…` | a tool is executing on this machine |
| `WAITING` · `◐ Provider busy — retry 1/2 in 15s` | a transient failure; the wait is counting down |
| `NEEDS USER` · `◐ Waiting for you…` | `ask_user` is open and LAIN is blocked on you |
| `INTERRUPTING` → `INTERRUPTED` | Ctrl+C landed, and then the turn stopped |
| `ERROR` | the turn ended badly — the provider died, timed out or refused |
| `COMPLETE` | the lifecycle accepted completion, with evidence |
| `READY` | nothing is running |

**Nothing here is fabricated.** The spinner frame is derived from the clock, so
it cannot animate while nothing is happening, and the elapsed figure beside it is
real: an accumulator over wall time that cannot be advanced by drawing a frame.
When the turn ends the row rests rather than spinning on. There is exactly one
timer in the program — it redraws the existing state during a genuine wait, costs
no tokens, and stops the moment the wait does.

**The clock is the TASK's, not the phase's.** It starts when you press Enter and
runs until the task reaches a real terminal state — through every model call,
tool call, test run and retry in between. It does not count time LAIN could not
work: a rate limit, a retry-after wait, an interruption or a question waiting on
you all PAUSE it and hold the figure, because four minutes of 429 backoff
reported as four minutes of work is a lie about what the machine did.

Work already done stays on screen **while the next step runs**: the changes and
verdicts of the turn in flight are shown as they happen, not only once it ends.

`STEP`, `PROGRESS` and `STATUS` are three separate things and are never
collapsed into one indicator — where the work is, how much is *finished*, and
what is happening this second. Progress counts completed steps only: starting
step 1 of 5 is 0%, not 20%.

```
    LAIN   scalppbot   claude-opus-5                                 ~1204
     USER · fix the authentication flow ──────────── ↓ 3 new · End ──

    USER
    ❯ fix the authentication flow

    │ ✓ edited · src/auth/token.js   +18 -4
    │ ✓ npm · test

    Summary

    The refresh handler was never reached. It is reached now, and the
    test covers the empty case.

    ───────────────────────────────────────────────

    USER
    ❯ now run the smoke test

    ◐ Verifying  the contract                    ↑2.1K ↓4   00:01:37

     Ask LAIN…

    Commands

      ❯ /exit        Save the session and leave
        /status      Session, provider and tool state
        /token       Where this conversation's tokens went

      ↑↓ select · Tab complete · Enter run · Esc cancel
```

**ONE CONTENT FRAME.** Every region — the header, the conversation, the live row,
the composer, the command menu — is laid out inside one rectangle with EQUAL
gutters, computed once and handed to each of them. No renderer works out its own
horizontal margins, which is how the left and right whitespace used to stop
matching. The gutter scales gently with the terminal (one column at 40, two at 80,
four at 200) and is never asymmetric, at any width, odd or even.

**PROSE GETS A READABLE MEASURE; STRUCTURE DOES NOT.** A paragraph stretched
across two hundred columns is harder to read than the same paragraph at ninety, so
prose narrows on a very wide terminal. Code, diagrams, tables and diff hunks keep
the whole frame — their width is part of what they mean.

**NO BOXES.** The composer is a filled grey region with no outline, three rows
tall, with what you are typing centred in it. The command menu is a list: no
frame, no rules, no shouted title, and as wide as its contents rather than as wide
as the screen. There is exactly ONE horizontal line on the surface and it belongs
to the header.

**THE HIERARCHY IS INVERTED FROM WHERE IT STARTED.** The final answer has the
highest contrast on the screen; the user's own words are bold on their own ground;
a tool row is dim apart from its outcome mark and the path it names; metadata is
dimmer still. Tool progress is transient and subdued. The thing it was evidence
for is not.

The header's rule carries two things that have nowhere better to be: a **one-line
preview of the prompt the running turn came from**, on its own quiet ground, once
that prompt has scrolled away — click it to go back to the message itself — and
news about content you have not read. The preview is the SUBMITTED TEXT, flattened
to one line and truncated; never a task name, an objective or a summary, because
an anchor that lies about its destination is worse than no anchor.

**A DIVIDER MARKS WHERE ONE EXCHANGE ENDS**, and nothing smaller. Between every
paragraph it would be card borders arrived at by another route.

**NOTHING THE RUNTIME SAYS TO ITSELF REACHES THE CONVERSATION.** A provider retry,
the end of a rate-limit wait, a continuation LAIN composes to resume with, a steer
acknowledgement, an interruption — all of those are transient: the live row says
them and then replaces them. A rate limit reads `Ⅱ Rate limited · 6s · attempt 4/5`
and not a paragraph of upstream JSON; the provider's own words stay on the turn
record where `/status` and the diagnostics read them. What stays durable is what
you would come back for: a missing credential, a failing check, a question waiting
on you, a verdict. **And streamed reasoning is not speech** — it is counted as
output because it is billed as output, and it is kept off the conversation. The row above the caret
says what is happening **this second**, and the figure on its right is **one
elapsed-work clock for the whole task** — `HH:MM:SS`, which does not restart
between a read, a write, a test run or a retry, and which **pauses** rather than
accumulating while a provider is rate limiting us.

What the conversation KEEPS is what somebody comes back for: what was said, what
CHANGED, what failed, and the verdict the turn ended on. A successful read, search
or mechanics command is live state — shown in the row above the caret while it
happens, replaced in place by the next one, and then over. The full account of
every call is still in the turn record, the Harness timeline and its artifacts, and
is reachable through `/brief`, `/jobs <n>` and `/ps`.

Launching shows a start screen rather than an empty dashboard:

```
                        L   A   I   N

                          scalppbot
                    C:\Projects\scalppbot

                        Ready to work.

                    Model       Claude Opus 5
                    Connection  anthropic · omniroute
                    Effort      auto

                      Type a task below.

                   /  commands        @  files
```

## One surface

LAIN has ONE screen. There are no tabs, no panes and nothing to navigate.

```
LAIN   lain-v2   claude-opus-5                                       ~624
────────────────────────────────────────────────────────────────────────

  YOU
  ❯ fix the frontend routing issue

  Implemented the route correction and re-ran the unit suite.

  · Read src/router.js
  · Patched src/router.js  +12 -3




  ◐ TOOL   VERIFYING   unit tests                                     8s
 Ask LAIN…
```

Four regions, and nothing else is ever permanently on screen:

**Header** — one dim row: `LAIN`, the project folder, the model, and the
**output tokens of the response in front of you**. That last number climbs while
the model writes, which is what makes it worth a permanent row. It carries a `~`
while it is an estimate from the characters received, and loses it when the
provider's own count arrives. Everything else about tokens — the session
account, context occupancy, cache reads, what the last request was made of — is
`/token`.

The route, the effort and a status word used to live here. Routing is LAIN
choosing correctly rather than announcing its classifier (`/status` still shows
it); effort is a setting (`/effort`); and what LAIN is *doing* is the live row,
one line above the caret, where it is said in more detail and nearer the eye.

**Conversation** — what you said and what LAIN said and did, interleaved in the
order it happened. It reads from the top and grows downward, follows new output
unless you have scrolled away, and gets every row the other three do not need.
Command output (`/status`, `/ps`, …) opens in a panel under the input rather
than over it.

**Live activity** — ONE row, directly above the input, and only ever the current
operation: `VERIFYING · unit tests`, `READING · src/router.js`, `WAITING · user
approval`. It is projected from the turn loop's real phase — never a timer,
never an inferred verb — and it disappears when nothing is running. What
happened *before* is the conversation above it.

**Input** — one region on a subtle grey ground, full width, no border and no
prompt symbol. The contrast is the region. A large paste is collapsed to
`<pasted text>` **while you are composing** so it cannot bury the sentence you
typed in front of it; the full content is what gets sent, what the transcript
records, and what the model receives.

Two more regions cost nothing when there is nothing to say: a steer you have
typed while a turn runs, and one row per background task.

### Everything else is a command

The nine panes LAIN used to have are all still reachable, and none of them is a
place you can be in by mistake:

| was a pane | is now |
|---|---|
| activity | the surface |
| context / detail | `/brief` · `/brief detail` |
| plan | `/plan` |
| diff / files | `/changes` |
| output | `/jobs <n>` |
| memory | `/note` |
| tokens | `/token` |

`/help` lists the rest, grouped by what you are doing rather than by the order
they happen to be defined in.

### Background work

```
/bg run the complete integration suite     start something beside the conversation
/bg                                        what is running, and how it went
/bg stop 17                                end one
/ps                                        the processes and services that work IS
```

`/bg` is LOGICAL work — what you asked for. `/ps` is the PHYSICAL projection —
pids, ports, services, state. One request can be several processes, or none yet,
or none any more, which is why they are two commands.

Neither invents machinery. `/bg` delegates to the same job runner the model's own
`run_background` uses, and whether your request becomes a **job** (it ends and
yields a result) or a **service** (it stays up and has a health) is decided by
the tools LAIN reaches for. `/ps` keeps no registry: every row is projected from
the harness's process manager and the job collection.

**Background is not unverified.** A `/bg` task obeys the same contract as the
conversation — execution, then verification, then settlement. A row reads
`COMPLETED` when the work ended and `task PASSED` only once the harness has
settled it from evidence. A process exiting zero has proved nothing.

### The window title

The terminal's own title is a glanceable signal for when LAIN is behind another
window: the project folder, with one symbol in front of it.

```
lain-v2       nothing is happening
◐ lain-v2     work in flight — the glyph turns while it lasts
✓ lain-v2     the last turn finished cleanly, briefly, then back to idle
Ⅱ lain-v2     stopped: interrupted, rate limited, blocked, or waiting on you
✕ lain-v2     it failed
```

The glyph comes from the same live state the row above the caret is drawn from,
so the two cannot disagree — and the spinner turns only because redraws are
happening, which only happens while the turn loop has a phase. A rate limit gets
the pause bar rather than a spinner that would turn for four hours while every
request is refused.


### While the model is working

The interface stays yours. `/` opens the palette, `@` completes a path, and a
command chosen there **runs immediately** rather than queueing behind the turn.
The work carries on underneath and is not disturbed by you looking something up.

Commands that would rewrite the session, the plan or the working tree while a
turn owns them — `/new`, `/resume`, `/undo`, `/cwd`, `/plan`, `/exit` — say so
instead of half-applying:

```
/new can't run while a turn is in flight — it would change the session
under it. Press Ctrl+C to stop the turn first, or wait for it to finish.
```

`/exit` waits for the turn and then leaves. To leave *now*, use Ctrl+C.

### Keys

| Key | Does |
|---|---|
| `Tab` | completes when a menu is open. It no longer cycles anything — there is one surface |
| `↑` `↓` | the open menu if there is one, otherwise move within a multi-line prompt, then history |
| `Enter` | run/select in a menu; otherwise send the prompt |
| `Shift+Enter` `Alt+Enter` `Ctrl+J` | a new line in the prompt |
| `→` | accept a completion · `←` back in a drill-down |
| `Esc` | close a menu, dismiss a question, stop a retry wait |
| `PgUp` `PgDn` `Home` `End` | scroll the conversation |
| `Alt+↑` `Alt+↓` | jump to the previous / next thing **you** said — an instruction, a decision, a pasted attachment |
| `Ctrl+C` | while working, cancel it; when idle, press once to confirm then again to exit |

**Ctrl+C is global.** It is read by the input reader itself, so no panel, menu or
question can swallow it, and it never depends on closing a menu first. While work
is in flight the first press cancels it and the header shows `INTERRUPTING`
immediately — before the unwind finishes — then settles on `INTERRUPTED`. When
idle the first press arms `Press Ctrl+C again to exit` on the input frame and the
second leaves cleanly; no Escape is required, and any other key cancels it.

LAIN names the **terminal tab** after the project — `scalppbot`, or
`● scalppbot — fix the telegram toggle` while a turn is running — so a row of
terminals is readable. It writes only to a real TTY, follows `/cwd` and
`/resume`, hands the tab back on exit, and `LAIN_NO_TITLE=1` turns it off.

**Pasted text is literal until you submit it.** A paste lands in the input box
and stays there — you can read it, edit it, or throw it away. Nothing in it is
interpreted on the way in: a pasted `/models` does not open the picker, a pasted
`/exit` does not leave, a pasted `@src/` does not open the file menu, and the
newlines inside it are content rather than a series of Enters. The box shows how
many lines arrived (`[7 lines]`) so a long paste is visibly long rather than a
truncated sentence. One Enter submits the whole thing as exactly one task.

The distinction is structural, not a guess about what the text looks like:
terminals wrap a paste in bracketed-paste markers, so LAIN knows a keystroke from
content because the terminal said which it was. Typing is unaffected — a `/` you
type still opens the palette, mid-task and otherwise.

There is no mouse support: the interface is keyboard-only by decision.

There is exactly one `/effort`; `/efforts` does not exist. Anything that is not a
registered command **on a single line** goes to the model.

### `/models`

`/models` is the **one** model picker. `/model` is an alias for it — same
picker, same filter, same Enter; there is no second implementation and no second
idea of what the keys do.

```
/models            browse everything
/models sonnet     browse what matches, filter already applied
/model sonnet      identical
```

**Search understands how people type.** Spacing and punctuation do not have to
match the provider's spelling: `qwen 3.7`, `qwen3.7` and `QWEN 3.7` all find the
same models, and `qwen free` finds `Qwen3.8 27B Free` even though those two words
are separated by a version and a size. Multi-word queries are an AND — `qwen
free` returns the free Qwen, not every Qwen — and results are ranked, most exact
first. It is local string work: no request, no tokens.

**Enter uses the highlighted model.** It commits the moment there is nothing
left to decide — and usually there isn't: measured on a real router, 890 of 975
models have exactly one provider. A model served by several asks which one; a
route with several effort levels asks which level; everything else is selected in
a single keypress. A screen that would contain only one choice is never shown.

You then get a confirmation and the header changes immediately — no `/status`
needed to find out whether it worked:

```
✓ Model selected
    Qwen3.8 27B Free
    omniroute
    effort auto
```

`↑↓` move · `Enter` uses · `→` looks at the providers first · `←` back ·
`Esc` cancels and leaves the model alone · `Ctrl+C` twice exits from anywhere,
including with the picker open. The model you are using is marked `●`, and when
a filter hides it the title says which it is.

Model identity is shown rather than raw upstream ids, and the detail is still
there when it is needed:

```
MODEL IDENTITY  →  PROVIDER / CONNECTION  →  ROUTE DETAIL + EFFORT
```

**Level 1** — one row per model, however many ways it is reachable. **Type to
filter**; a real router's 975 models narrow to 52 as you type `sonnet`. It opens
on the model you are currently using.

```
MODELS   50 matching "sonnet"
  Claude Sonnet 5                     4 routes  ·  low/medium/high/xhigh
❯ Claude Sonnet 4.6                   2 routes  ·  low/medium/high
```

**Level 2** — the routes that serve it, one row each plus the levels it offers:

```
CLAUDE SONNET 5   ·   4 routes
❯ anthropic
      low · medium · high · xhigh
  openrouter
      low · medium · high
```

**Level 3** — the route's own state, with the effort levels choosable. Picking
one settles model, connection and level in a single act:

```
CLAUDE SONNET 5   ·   anthropic
  connection    omniroute:anthropic
  provider      omniroute  ·  via bridge
  credential    none
  readiness     AUTHENTICATED
  availability  AVAILABLE

  EFFORT
❯   low
    medium
```

`←` goes back a level, `Esc` closes. Identity, provider, connection, credential,
readiness, availability and effort stay **separate fields** — collapsing them is
what makes "is it down or am I logged out?" unanswerable.

Collapsing changes what is **displayed**. The upstream id, provider, connection,
auth, readiness, availability and effort set are all preserved internally, and
the exact upstream id is what travels on the wire. Browsing and filtering are
entirely local: the catalog is already in memory and no request is made.

Where the provider gives no evidence that two ids are the same model, LAIN keeps
them apart and says so in the name — `Claude Opus 5 (anthropic)`,
`Claude Opus 5 (no-think/gh)`. A false merge is worse than an extra row.

## What LAIN does, and does not do

**It does not put the model in a workflow.** No required tool order, no
read-before-write rule, no forced planning step, no mandatory verification, no
command allowlist. `run_bash`, `run_powershell` and `run_cmd` run what they are
given — pipes, redirects, chaining, `git`, `npm`, `curl`, process inspection.
The command string is never rewritten; on Windows LAIN only picks a *real* bash
(Git Bash, MSYS) in preference to the WSL launcher in `System32`, which is not a
shell and fails every call on a host with no WSL distribution.

**It orients before it reads.** The project brief in the system prompt is
written once per session and served from cache thereafter, and it carries
*meaning* rather than only names: what the project says it is, taken from its
own README; that README's section headings **with their line numbers**, so the
architecture is one ranged read instead of a whole file; where the documentation
lives; and the entry points the manifest already declares. The module inventory
is still there — that is what answers "does this already exist?" — but it comes
last, because a listing is what truncation should eat and a description is not.
Anything recorded with `/note` — decisions, facts, limitations, the durable
truths of a project — rides every request too, so a session does not re-derive
what an earlier one settled.

**It never claims you have something it took away.** The evidence ledger stops a
file being read into the transcript twice, and its premise is that the content
*is* in the transcript. Compaction is the one operation that makes that false.
Until this was traced, compaction elided a read and told the model
"re-run the call if you need the rest" while the ledger answered "unchanged
since you read it — continue from what you already have"; the model had neither
the content nor permission to fetch it, and the refusal for the rest of the
session left ranged reads as the only reads still served. Eliding a body now
retracts the claim that went with it. Searches are untouched: a stubbed `grep`
never claimed content was in context, so it has nothing to retract.

**Compaction changes what knowledge looks like, not whether it exists.** A
20,000-character read is *evidence*; that a file declares `budgetChars`,
`Session.compact` and `Session.resume`, and where each begins, is *knowledge*,
and the two were being discarded together only because they arrived in the same
message. An elided read now keeps its receipt **and** gains the file's
declarations with their line numbers — around 33x smaller than the body it
replaces — so the next question is answered by `read_symbol` on the one
definition that matters instead of by replaying the file. The ledger reports
which state each file is in, and says so plainly: *read earlier, body since
elided, you no longer have it*. None of this is a prohibition — the ranged read
and the whole read both remain available, because evidence that is cheap is not
the same as evidence that is sufficient, and only the model can tell which it
needs.

**Work can outlive the program that started it.** A background job used to live
in memory on the App object: it survived a failed *turn* and died with the
*process*, appeared in no session state, and a suite that finished thirty seconds
after LAIN crashed finished for nobody. `rust/lain-supervisor` is a small
zero-dependency Rust process that owns those workers instead. LAIN exiting closes
a socket, and closing a socket does not signal anybody's children — so the work
carries on, its real exit status is written to disk as it happens, and a
replacement model is told what happened while nothing was connected to hear it.
It speaks the same JSON-lines protocol the desktop bridge uses, over a loopback
socket rather than stdio, because stdio pipes belong to the spawn and reconnect
is the entire requirement. It is **optional**: LAIN is a zero-dependency Node
program, so with the binary unbuilt everything behaves exactly as before. Build
it with `cargo build --release` in `rust/lain-supervisor`.

**An execution window belongs to the job, not to a model request.** "Run the
training for two hours" is a fact about the work, so `run_background` takes
`for_seconds` and the supervisor owns the deadline from then on — it survives the
model, the provider and the LAIN process, and no later turn can quietly decide
the window was really three hours. When the window ends **nothing is killed and
nothing is assumed**: the worker keeps running, no exit status is invented, and
an event says the window is over so the model can look at the actual output and
decide. A worker that fails *before* its deadline produces its own event carrying
the real exit code and how much of the window was left. Whether two hours of
training went well is a question about loss curves; the supervisor is required
not to have an opinion about it.

**A rate limit outlives the process that learned it.** Provider health used to
live entirely in a `Map` on the App object, described as in-memory by design
because "a restart legitimately knows nothing" — which is true of a circuit
breaker and false of the thing that actually costs an afternoon. Measured live
against a real router: `retry in 4 hours`. Restart LAIN five minutes later and
that number was gone, so the next turn called the closed route, was refused, and
bought the same fact again, while the model picker showed the shut door as
untried. The supervisor now owns that half and LAIN mirrors it, so `/models`
shows a limit with its real clock across restarts and a handover tells the
replacement model which road is closed. **The two halves have different
lifetimes and are treated differently**: a breaker is a guess about reachability
and a fresh process is right to re-guess it, so it is never adopted; a limit
with a stated reset still in the future is; and a limit recorded with *no*
stated reset is deliberately **not** adopted, because a limit with no clock
could be twenty seconds or three days old and adopting it would wedge a working
route shut with nothing able to discover it had cleared. A state a *person* set
— disabled, maintenance — survives whenever the supervisor is up to hear it,
because a decision is not an observation; it does not *start* one, since typing
`/provider disable` should not spawn a background process. **No countdown is
ever invented**: where the provider did not say when, LAIN says the reset is
unknown rather than drawing a clock nobody supplied. A limit with a stated reset
is the one fact worth starting a supervisor for, because it is true for hours.

**It never decides that a job succeeded.** The supervisor records an exit status
it observed, or it records that it does not know. After its own restart a job it
was watching becomes `lost` (the process is gone and nobody saw how it went) or
`unknown` (still alive, but no longer its child, so its exit can never be
collected) — never `completed`. A retried submission carrying the same request id
returns the *same* job rather than launching a second build, which is what a
client that lost its connection mid-submit actually needs.

**It finds code without reading it.** `symbols` answers "where is X defined" and
"who calls X" in one call, already sorted into definitions, imports and uses.
`grep` searches contents and returns `file:line`; `glob` finds files by name
pattern, newest first. Both skip
generated trees, skip binaries, and **say so when a result is truncated** — a
silent cap produces confident wrong conclusions. This is a capability rather than
a shell command because `grep` is not present on a stock Windows machine.

**It answers "what depends on this file?".** `dependents` lists every file that
imports, requires or links to a given path, with the line that does it — the
question you ask before changing something. It is computed from the tree as it
is at that instant, so there is no index that can disagree with the code. When
nothing is found it says so as a *finding*, never as proof: an entry point has
no importer by definition, and a project that loads code by name can reach a
file in ways no scan can see. It says that too, when it sees it.

**It answers "what is in this file?" without reading it.** `check_symbols` with
`list_symbols` returns a file's **outline** — every definition with its line and
kind, methods carrying their container — and that is the answer to the most
common orientation question in a codebase. Reading a file to find out what is in
it is the most expensive possible way to ask: measured over the eight largest
modules here, the whole reads cost ~77,000 estimated tokens and the outlines
~5,000, so the outline is what belongs in front of the decision and the read is
what follows it once you know which part you need. It works in **every
language** — JavaScript through a real tokeniser, and everything else read
lexically from declaration lines, which can miss a declaration written in an
unusual shape and never invents one. The same call reports names the file uses
that nothing declares — `getUser` where `getUsers` was meant is valid syntax and
no parser will catch it — and that half is JavaScript-only, so it says plainly
when it did not run.

**It edits definitions, not files.** `read_symbol`, `replace_symbol`,
`insert_near_symbol` and `remove_symbol` work on a JavaScript definition by
name, using exact byte ranges from a real tokeniser — so you never quote a body
you are not changing, and nothing outside the definition can be touched. Every
one of them re-parses the file afterwards and **restores it unchanged if the
edit broke it**. `rename_symbol` renames across the project on tokens, so the
same word inside a string, a comment, a regex or a URL is never rewritten by
accident — and it reports exactly where those untouched occurrences are, because
a string holding the old name is very often a real reference. For every other
language, and for changes smaller than a definition, `apply_patch` does the same
job with the same refuse-rather-than-guess rule.

**It catches the typo a parser cannot.** `getUser` where `getUsers` was meant is
valid syntax; nothing compiles it into an error. After every write, LAIN checks
whether the file uses a name that nothing declares *and* something very close to
it does — and reports both, with the line. It reports nothing otherwise: an
unresolved name with no near miss stays silent, because one false alarm is
enough to make a channel worthless. Calibrated at zero reports across 63,228
references in this repository's own working code.

**It knows a command failed *how*.** A failing command comes back with the shell,
the directory, a classification — `COMMAND_NOT_FOUND`, `SHELL_SYNTAX`,
`NO_SUCH_PATH`, `APPLICATION_ERROR` — and the deterministic fact about that shell
which explains it. `&&` under Windows PowerShell 5.1 is answered with *that
operator arrived in PowerShell 7*, once, instead of being rediscovered over four
tool calls. Run the same command again and the result carries what happened last
time; run it under a second shell and it says so: *all 3 failed the same way
under 2 different shells, so the shell is not the difference.* It never refuses a
call — re-running after an install is often exactly right.

**It checks that the old thing actually went.** "Replace X with Y" is two
claims, and a test suite only ever checks one of them: the new path works, so it
is green whether or not the old implementation is still sitting in another file
being imported by something nobody looked at. `find_residue` checks the second
claim, classifying every remaining occurrence on tokens — a name in a changelog
is a different finding from a name in a `require`. It reports and never deletes:
whether a leftover is deliberate is a judgement about intent.

**It briefs you, and it briefs the model.** `/brief` — and `engineering_brief`
for the model — is one call that replaces the six you would otherwise spend
orienting. It grades health on **five separate axes** (build, tests, runtime,
frontend, engineering) because a compiler has no opinion on a leftover dataset
or a name that resolves to nothing on an untaken path: `BUILD: PASS` beside
`ENGINEERING: DEGRADED` is the ordinary state of most real code, and the report
says so in words. Every finding carries a **stable id** that survives the report
being regenerated, an exact file and line, the enclosing function, an
explanation of what the message actually means, how sure it is
(`PROVEN`/`OBSERVED`/`INFERRED`/`SUSPECTED`), and which instrument saw it.
Findings that share a file or symbol are grouped into **root-cause candidates**,
so four symptoms of one migration are not fixed four times. What was *not*
measured is listed as `UNVERIFIED` rather than omitted — and on a re-run, a
finding that disappeared because its analyser was **skipped** is reported as
unobserved, never as fixed.

**It states the project's conventions so nobody re-derives them.** `/brief`
opens with an operational contract: which shell, where commands run, what a
reported line number counts from, whether a byte range includes its end, which
arguments are decimal and which are hexadecimal. These are **measured, not
read** — `lineAt` is run on a known string rather than having its source
paraphrased — so they cannot drift from the build they describe. Facts with a
known wrong form carry it: *`;` — NOT `&&`, Windows PowerShell 5.1 has no such
operator*. And a convention the repository does **not** settle is reported as
`UNKNOWN` with the exact call that answers it, never filled in with the likely
value: a plausible wrong fact is worse than an absent one, because an absent
fact makes you look.

**It tells a fact from a finding from a contradiction.** "The PID argument is
decimal" is a fact. "Something passed hex to `--pid`" is a finding. "The
documentation says hex and the parser converts decimal" is a contradiction — the
most valuable of the three, because it is the case where reading the
documentation makes things worse. LAIN reports documented tool parameters and
command flags that nothing behind them ever reads.

**You can drag to select in the conversation, and let go to copy.** The
workspace is repainted in place rather than written to the scrollback, so the
terminal's own selection copies whatever was on the glass — and the text you
want is usually scrolled away. LAIN selects over the whole feed instead, so a
selection survives scrolling, keeps its highlight through a colour reset, and
puts plain text on the clipboard when you release.

**It uses your toolchain, not a copy of it.** A type error in TypeScript is a
question only `tsc` can answer, so the briefing finds the tool, runs it, and
translates what it says. When a language *applies* but its tool is not
installed, that becomes an `UNVERIFIED` finding naming what is missing — never
silence, because silence is indistinguishable from a clean result.

**It looks at the shape of the diff.** `review_changes` reads `--numstat` rather
than the diff itself, so it costs almost nothing, and says the part that is hard
to see from inside the work: a file where nearly every line is on both sides of
the diff is a whole-file rewrite or a reformat rather than an edit; a `dist/`
directory in the change set was produced rather than written; and files that
differ from the last commit but which LAIN did not write are named separately
from the ones it did.

**It tells you when work is not done.** Completion needs evidence *and* a check
that currently passes. If every plan step is ticked off but the last command
exited non-zero, LAIN refuses to report completion and names the command — and
tells the *model*, in the tool result, since the model is the only party that can
fix it. Failing, then fixing, then passing completes normally: it is the end
state that counts, not whether anything ever failed.

**It checks a success claim against what actually ran.** If a turn ends by
saying the tests pass and the last command this task ran exited non-zero, LAIN
says so underneath, and names the command. It contradicts the *claim*, never the
work: a turn that claims nothing gets nothing said back, and a passing check is
never argued with. This costs no tokens — it is a string compared against an
exit code.

**It keeps the conversation inside the window.** Every step re-sends the whole
conversation, so a long task grows its own payload until a provider refuses it.
Before each request LAIN checks the size and, if it is over, elides the bulk:
an old tool result becomes a one-line stub *naming the call that produced it*,
so the model can simply run it again. Nothing is deleted and nothing is
reordered — your objective and the recent working set are untouched, and every
tool result keeps the call it belongs to. It costs no tokens and makes no
request; `/compact` does it on demand and `/status` shows how full the window
is. If a provider advertises a context length it cannot honour — common for a
local model behind an OpenAI-shaped API — `LAIN_CONTEXT_CHARS` overrides it.

**It remembers what was decided, not just what was said.** Alongside the
conversation, the model is told what is already established: the corrections you
made after the first request (and that they override it), which files have been
changed, whether the last check passed, and what has already been read. These are
conclusions, never the evidence behind them — a file can be re-read, but a
decision you made an hour ago cannot be recovered by looking at the repository.
It is what makes `--resume` restore a working context rather than just a screen.

The rendered activity feed is **not** part of that. What you see on screen is
drawn from the turn record; the model receives the conversation and tool results
only, so a screenful of `✓ Read foo.js` is never paid for twice.

**It can tell you what an older version could do that it can't.** `/compare
<folder>` — or a GitHub URL, or a flattened-repository dump — checks both trees
for the same set of capabilities and prints a grid: what survived, what is done
differently here, what is genuinely missing, and what was left out on purpose.
Nothing is copied. `/compare add <capability>` hands the one you name to the
normal workflow as a request, with the old implementation pointed at as reading
material and the rules stated — build it for *this* codebase, extend what is
already here, add no dependency. What gets built is then subject to the same
evidence rules as any other task.

**It picks up a model you added elsewhere.** `/model refresh` — also spelled
`/models refresh` and `/api refresh`, because there is no guessing which one
you will reach for — re-asks every route what it serves and reports the
*difference*: what is new, what is gone, and whether the model you are using
survived. It is a catalog request, never a completion, so it costs no tokens.

**It can tell you why it isn't working.** `/doctor` reports the machine rather
than the configuration: the Node version, whether there is a terminal, whether
the config directory can actually be written (if not, sessions and undo silently
do not persist), which shell `run_bash` will get, whether a credential is
present, and how full the window is. Every check is a local syscall — it costs
no request, because a diagnostic you have to pay for is one nobody runs.

**It orients itself before asking.** A bounded local scan names the project's
languages, manifests, likely commands and the files inside its source
directories — one `readdir` each, no recursion, no index, capped. Measured on a
real task, that is three tool calls the model no longer spends rediscovering the
shape of the project.

**It remembers real state.** Tool calls and their results stay in the
conversation, so the model can see what it already did. Files read are tracked by
content: an unchanged large file is not re-injected, while a **ranged read is
always executed** and a changed file is always re-read.

**It makes changes recoverable.** `/undo` restores prior bytes; undoing a
creation deletes the file again. No git required. Snapshots survive a restart, so
`/resume` restores a session's own undo history — and undo **refuses** when a
file no longer holds what LAIN left there, because reverting to pre-edit bytes
would silently discard whatever changed it since.

**It keeps sessions apart.** A new session is empty. No plan, task, objective or
evidence crosses a session boundary except through an explicit `/resume`. There
is no "restore previous plan?" prompt and no automatic choice among historical
sessions.

**It survives its dependencies.** A provider failure is reported, never thrown.
The REPL stays interactive, every command works while a provider is dead, a
circuit breaker prevents retry storms, and `/provider retry` is the escape hatch.

**It spends tokens once.** One model request per model step. No planner
round-trip, no second model, no background polling. Everything the interface
does is local: `/`, `@`, the model browser, filtering, the liveness indicator and
every redraw cost zero tokens, because they only ever show state the program
already holds.

**It works on a small terminal.** Verified at 120x40, 80x24, 60x15 and 40x9. When
rows run out the frames and decoration go first; the current status, the progress
line and the input are the last things sacrificed, so "is it still working?"
remains answerable at every size.

## Architecture

```
bin/lain.js → src/cli.js → src/app.js        the REPL shell, and only that
  input.js        the ONE editing state machine — paste-aware (a paste is ONE
                  input), key events, bounded in-memory prompt history
  task.js         the ONE task-identity classifier
  session.js      conversation, task, evidence, plan; new Session() reads nothing
  turn.js         the loop; tool protocol persisted, tool count TURN-WIDE
  lifecycle.js    the ONE lifecycle + liveness mechanism
  evidence.js     content-keyed read cache
  plan.js         session-owned plans; no filesystem access, by design
  session.js      owns the conversation, and keeps it inside the window
  checkpoint.js   the ONE snapshot/undo system
  diagnose.js     what /doctor and /status report about this machine
  compare.js      capability comparison against another version of a project
  capabilities.js the probe table /compare runs — a row per capability
  provider.js     the network boundary (anthropic | chat | mock)
  catalog.js      model × connection × effort as three orthogonal things
  connections.js  provider ≠ connection ≠ credential ≠ readiness
  availability.js the circuit breaker; lazy health, no ping loop
  project.js      a shallow, capped project brief + bounded `@` path completion
  tools/          one vocabulary, one dispatch table:
                    fs.js      read / write / edit / list
                    search.js  grep · glob · symbols · dependents, bounded
                    shell.js   unrestricted bash / powershell / cmd
                    semantic.js edit a definition by NAME; residue; diff shape
  execution.js    shell identity · cwd · failure classification, one owner
  attempts.js     what this command already did, so a loop cannot form
  jsscan.js       a real tokeniser: a name in a string is not a name
  codemodel.js    declarations with exact byte ranges, computed fresh
  typos.js        names that resolve to nothing, when something close does
  rename.js       project-wide rename on tokens, rolled back per file
  residue.js      did the OLD implementation actually go away
  gitsense.js     the shape of the working tree, from --numstat
  findings.js     one shape for every finding; ids that survive a re-run
  survey.js       gather every instrument into FIVE separate health axes
  langscan.js     parse + symbols + names, in process, no toolchain needed
  toolchain.js    tsc / eslint / python / go vet / cargo, or a declared NO
  rootcause.js    findings that share a file or symbol, grouped
  briefing.js     the report; the only place allowed to be long
  briefcommand.js /brief — see the file for why it is not /steer
  facts.js        a project convention, with its evidence; UNKNOWN is a value
  contracts.js    shell · cwd · path · line/offset numbering, MEASURED
  clifacts.js     tools, commands, config — and documented-but-unimplemented
  probefacts.js   what the Probe contract proves, and what only a live one can
  datafacts.js    where data really lives; two sources of truth
  ui/textselect.js drag-select over the feed; plain text to the clipboard
                    plan.js    plan_write / plan_step_done → plan.js, no new rules
                    ask.js     ask_user — the model's question, rendered by the panel
  ui/views.js     pure state -> lines (header, welcome, activity, plan)
  ui/panes.js     pure state -> lines for diff / files / output, from checkpoint bytes
  ui/panel.js     the ONE interaction panel (+ its kinds) and its data adapters
  ui/layout.js    the four-region screen: sizing, scrolling, resize
  ui/index.js     the only place the App talks to the terminal UI; owns the
                  live phase, the redraw ticker and the as-you-type menus
```

**One responsibility, one implementation.** `tests/unit/architecture.test.js`
fails the build if a second task classifier, a second stall detector, a second
snapshot system, a duplicate command, an unreachable module, a god object, a
shell allowlist, a mandatory tool order or a raw NUL byte appears.

**Deliberately absent:** external planner, feature graph, AST intelligence,
provider OAuth implementations, git-aware recovery, context compaction, and
**mouse support** (the UI is keyboard-only). These are excluded by decision, and
`docs/STATUS.md` says so rather than implying they exist.

## Tests

```bash
npm test                  # unit + integration + smoke + live
npm run test:unit
npm run test:integration
npm run test:smoke        # spawns bin/lain.js as a real child process
npm run test:live         # contacts a REAL provider; self-skips if none
```

| tier | what it proves |
|---|---|
| `unit` | one module in isolation |
| `integration` | real modules wired together |
| `smoke` | the real binary, spawned as a child process |
| `live` | a real provider actually answered |

Smoke tests may not `require()` application modules. Only the `live` tier
contacts a provider, and it skips itself — printing the reason — when none is
reachable, so a green run of the first three never implies live verification. The
other tiers use a scripted mock (`LAIN_PROVIDER=mock`) that replaces the network
call and nothing else; the child environment is scrubbed of `LAIN_*` variables so
a test can never inherit the mock by accident.

Point the live tier elsewhere with `LAIN_LIVE_BASE_URL`.

## Asking things, and what LAIN will let itself touch

### `/permissions mode ask | auto | deny`

How the filesystem gate behaves when a path is not already decided about.

| mode | outside the project |
|---|---|
| `ask` | anything outside asks you first |
| `auto` | ordinary paths pass; system and credential locations still ask |
| `deny` | refused, and nobody is asked — for an unattended run |

No mode opens `C:\Windows`, `/etc` or `~/.ssh` without asking. `/trust` still
decides what THIS directory is allowed to do, and `/trust strict` and
`/trust auto` are the same setting under older names.

### `/external <what you want>`

Everything goes through LAIN first. It reads what you asked, gathers the session
facts that are relevant, and shows you the exact bytes that would leave. Nothing
is sent until you say so, and drafting costs no tokens and opens no socket.

```
/external create a plan for this
/external this looks like a bug
/external human write a complaint about the build
```

Then `Send it` in the panel, or `/external send` where there is no panel.
`/external show` prints the held draft; `/external cancel` drops it.
`/external` with no arguments still chooses WHO the external actor is, and
`/external <model-name>` — one token, no spaces — still selects a model.

## Tests, as LAIN sees them

`discover_tests` reads the manifests, the CI config and the tree, spawns nothing
and costs nothing. `run_tests` actually runs a suite and classifies the result.
They are separate tools because the two answers must never be sayable with one
word:

```
NO_TESTS_FOUND        looked, found nothing — and says where it looked
TESTS_FOUND_NOT_RUN   a suite exists; nothing has been run
TESTS_RUNNING
TESTS_PASSED
TESTS_FAILED          the code is what is wrong
TESTS_BLOCKED         a rate limit, a quota, a missing dependency, no runner
TESTS_PARTIAL         some ran; some were skipped or blocked
```

`TESTS_BLOCKED` is not a failing test. A run stopped by a provider quota exits
non-zero exactly like a broken assertion, and only one of them is a reason to
change code.

**A green suite reports its verdict, not its roll-call.** A passing run of this
project's own unit tier prints 132,846 characters, and 1,973 of those lines are
one tick and the name of a test that did what it was written to do — about
36,000 estimated tokens restating a result the classifier has already reduced to
`counts: 1974 passed, 0 failed`. Since verification is the most repeated step in
a coding loop, that is not one large result but one per fix. So on `TESTS_PASSED`
— and *only* there — the individual pass lines are dropped and the count of what
went is stated. Every other line survives: headers, deprecation warnings, the
runner's own summary, anything unrecognised. A `TESTS_FAILED`, `TESTS_BLOCKED`
or `TESTS_PARTIAL` run is returned **whole and untouched**, because failure
output is the most valuable evidence this tool can produce and abbreviating it
would be the one saving worth nothing.

## Credits

V1 is preserved as an immutable historical reference; see
[`v1-backup/`](v1-backup/) for the archive and the audit that shaped this
rebuild. V1 was a different architecture — LAIN v2 does not carry its code.
