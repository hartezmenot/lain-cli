//! THE GUARDIAN — runtime authority for the things a model is not allowed to own.
//!
//! ------------------------------------------------------------------------
//! THE MEASUREMENT THAT PUT THIS FILE HERE.
//!
//! A turn dies — the provider 502s, or a limit lands, or the socket goes away.
//! The person watching types `continue`. Node has nothing to consult, so it
//! sends the literal word `continue` to whatever model answers next, and that
//! model receives one word with no antecedent. It does the only sane thing: it
//! re-reads the README, re-lists the tree, re-opens the files the dead model
//! had already read, and rebuilds by hand a picture that was on disk the whole
//! time. Measured on this repository that is a six-figure input request, paid
//! for facts LAIN already held.
//!
//! The word `continue` is INTENT. It is not context. Nothing in Node was in a
//! position to know the difference, because the thing that knew the turn had
//! died was the turn, and the turn was gone.
//!
//! ------------------------------------------------------------------------
//! SO WHAT MOVED HERE IS NOT CODE, IT IS AUTHORITY. Three questions, and the
//! only reason they share a file is that they share a lifetime — each is a fact
//! with a future in it, learned by a process that is about to stop existing:
//!
//!   WHAT IS THE TURN DOING?   a state machine, not booleans scattered over an
//!                             App object that dies with the process holding it.
//!   MAY THIS INPUT BE SENT?   the gateway. A held sentence is written to disk
//!                             before the caller is answered, so a crash between
//!                             the two loses a socket write and not a person's
//!                             words.
//!   WHAT DID IT COST?         usage, per session, live where the provider says
//!                             so and completion-only where it does not — and
//!                             never interpolated between them.
//!
//! ------------------------------------------------------------------------
//! WHAT IT WILL NOT DO, and this list matters more than the one above.
//!
//! It does not COMPOSE the handover. It says HOLD and names what it saw; Node
//! builds the packet out of the session, the checkpoints and the evidence
//! ledger, because those are Node's records and copying them here would be the
//! second authority §23 forbids. It does not read the model's prose. It does
//! not decide whether held text is a steer or a new task — that is identify.js,
//! and it is a language question. It classifies nothing it was not told.
//!
//! And it never infers that a turn is dead from silence. A tool that runs for
//! two hours is silent for two hours and is perfectly healthy; the only evidence
//! accepted for TURN_LOST is that the owning process no longer exists. Guessing
//! from a clock would hold a person's input away from a model that was about to
//! answer, which is the failure this file exists to prevent, wearing a hat.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::jobs::{alive, now};
use crate::json::{self, Value};

/// The cache behind `alive_cached`. Small by construction — one entry per pid
/// that has ever owned a turn on this machine, which is one per LAIN process.
static ALIVE_CACHE: Mutex<Option<BTreeMap<u32, (u64, bool)>>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// IS THAT PROCESS ALIVE — asked at most once a second per pid.
///
/// A LIE IN ONE DIRECTION ONLY, and it is the safe direction. A cached `true`
/// can be up to a second stale, which delays a recovery by one keystroke. A
/// cached `false` cannot wrongly hold input, because a pid that was dead a
/// second ago is not going to be alive now — pids are not reused that fast, and
/// a reused one would belong to something that never owned this turn.
pub fn alive_cached(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    let t = now_ms();
    let mut guard = match ALIVE_CACHE.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let map = guard.get_or_insert_with(BTreeMap::new);
    if let Some((at, v)) = map.get(&pid) {
        if t.saturating_sub(*at) < ALIVE_TTL_MS {
            return *v;
        }
    }
    let v = alive(pid);
    map.insert(pid, (t, v));
    v
}

/// A session's held input, capped. A person who typed nine sentences at a dead
/// model meant all nine; a loop that queued nine thousand did not, and the cap
/// is what keeps the second case from becoming a file nobody can read back.
const MAX_HELD: usize = 32;
/// Held text is a sentence, not a document. Long enough for the first screen of
/// a pasted stack trace; short enough that the packet stays a briefing.
const MAX_TEXT: usize = 4000;
/// How large the event log may grow before it is rotated. See `append_event`.
const MAX_EVENT_BYTES: u64 = 2_000_000;

/// ------------------------------------------------------------------------
/// HOW LONG "THAT PROCESS IS ALIVE" STAYS TRUE ENOUGH TO REUSE.
///
/// `jobs::alive` shells out to `tasklist` on Windows — there are no signals, so
/// there is no cheaper way to ask. One gateway call used to spend THREE of those
/// spawns: `effective()` asked once, and the snapshot it returned asked twice
/// more. On a loaded machine that pushed a call that sits on a person's Enter
/// key past its own timeout, and a timed-out gateway answers DELIVER — so the
/// cost of asking too often was, precisely, the feature not working.
///
/// A second is chosen because of what the answer is FOR. It gates a recovery
/// that follows a process dying, and a process that died within the last second
/// is a process the person has not finished noticing yet; the next keystroke
/// gets the fresh answer. Making it longer would start holding input away from a
/// LAIN that had come back.
const ALIVE_TTL_MS: u64 = 1000;

/// ------------------------------------------------------------------------
/// WHAT THE TURN IS DOING.
///
/// Every name here is a DIFFERENT ANSWER to "may this input be sent", which is
/// the only reason for a name to exist in this list. Four of them come straight
/// off turn.js's existing `PHASE` vocabulary rather than being invented — the
/// loop already computed them before every provider call and every tool, and
/// threw them away when the process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    /// Nothing in flight. Input goes straight through.
    Idle,
    /// The request is out and nothing has come back. turn.js: WAITING_MODEL.
    ModelThinking,
    /// Bytes are arriving. turn.js: RECEIVING.
    Receiving,
    /// A tool is executing on this machine. turn.js: RUNNING_TOOL.
    ToolRunning,
    /// A transient provider failure, waiting before another attempt. RETRYING.
    Retrying,
    /// The provider stated a limit. Input is HELD: the next request would be
    /// refused, and refusing a person's sentence is worse than parking it.
    RateLimited,
    /// The provider stopped answering for a reason that is not a limit.
    ProviderFailed,
    /// A boundary was crossed — a model switch, or a turn that ended badly —
    /// and the next request must carry a packet rather than a bare sentence.
    HandoverPending,
    /// The owning process is gone. Nobody is going to finish this turn.
    Lost,
    /// It finished.
    Completed,
    /// Somebody stopped it.
    Cancelled,
}

impl TurnState {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnState::Idle => "IDLE",
            TurnState::ModelThinking => "MODEL_THINKING",
            TurnState::Receiving => "RECEIVING",
            TurnState::ToolRunning => "TOOL_RUNNING",
            TurnState::Retrying => "RETRYING",
            TurnState::RateLimited => "RATE_LIMITED",
            TurnState::ProviderFailed => "PROVIDER_FAILED",
            TurnState::HandoverPending => "HANDOVER_PENDING",
            TurnState::Lost => "LOST",
            TurnState::Completed => "COMPLETED",
            TurnState::Cancelled => "CANCELLED",
        }
    }

    /// Both spellings are accepted for the in-flight three, because turn.js's
    /// own words arrive here unchanged and translating at the call site would
    /// put a second vocabulary in Node.
    pub fn from_str(s: &str) -> TurnState {
        match s {
            "IDLE" => TurnState::Idle,
            "MODEL_THINKING" | "WAITING_MODEL" => TurnState::ModelThinking,
            "RECEIVING" => TurnState::Receiving,
            "TOOL_RUNNING" | "RUNNING_TOOL" => TurnState::ToolRunning,
            "RETRYING" => TurnState::Retrying,
            "RATE_LIMITED" => TurnState::RateLimited,
            "PROVIDER_FAILED" => TurnState::ProviderFailed,
            "HANDOVER_PENDING" => TurnState::HandoverPending,
            "LOST" => TurnState::Lost,
            "COMPLETED" => TurnState::Completed,
            "CANCELLED" => TurnState::Cancelled,
            _ => TurnState::Idle,
        }
    }

    /// Is a model expected to be working on this right now?
    pub fn in_flight(self) -> bool {
        matches!(
            self,
            TurnState::ModelThinking
                | TurnState::Receiving
                | TurnState::ToolRunning
                | TurnState::Retrying
        )
    }

    /// Is this an ending that needs a packet before the next request?
    ///
    /// `Cancelled` is deliberately NOT here. A person pressing Ctrl+C knows
    /// exactly what they stopped and what they mean to say next; handing them a
    /// recovery briefing they did not ask for spends tokens explaining a
    /// decision they made on purpose.
    pub fn needs_handover(self) -> bool {
        matches!(
            self,
            TurnState::RateLimited
                | TurnState::ProviderFailed
                | TurnState::HandoverPending
                | TurnState::Lost
        )
    }
}

/// ------------------------------------------------------------------------
/// WHAT IS TRUE OF A CONVERSATION, WHICH IS NOT WHAT IS TRUE OF ITS LAST TURN.
///
/// `TurnState` answers "what is the model doing". This answers "what is the
/// state of this piece of work", and collapsing the two is exactly the mistake
/// a remote status view makes first: a session whose last turn COMPLETED is not
/// a finished project, and a session with a dead owner is not merely idle.
///
/// EVERY VARIANT IS BACKED BY EVIDENCE THE RUNTIME HOLDS. There is no variant
/// meaning "the model said it was done" - see `of`, which reads a pid, a
/// recorded ending and a queue, and nothing anybody claimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// A turn is in flight in a process that still exists.
    Running,
    /// The route said no, with or without a reset time.
    RateLimited,
    /// A turn ended badly and nothing has retried it.
    Failed,
    /// A boundary is owed: the next request must carry a packet.
    Blocked,
    /// There is input to run and nothing attached that could run it.
    Waiting,
    /// Somebody stopped it, or the process that owned it disappeared.
    Interrupted,
    /// The last turn finished cleanly. NOT "the project is done" - see the
    /// note on `of`, and see `verified` for the only evidence that means that.
    Completed,
    /// Known, and nothing is happening.
    Idle,
    /// Recorded, but no turn has ever run. Nothing is claimed about it.
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Running => "RUNNING",
            Status::RateLimited => "RATE_LIMITED",
            Status::Failed => "FAILED",
            Status::Blocked => "BLOCKED",
            Status::Waiting => "WAITING",
            Status::Interrupted => "INTERRUPTED",
            Status::Completed => "COMPLETED",
            Status::Idle => "IDLE",
            Status::Unknown => "UNKNOWN",
        }
    }

    /// A mark for a list. Deliberately three characters wide in every case so
    /// a column of sessions lines up.
    pub fn mark(self) -> &'static str {
        match self {
            Status::Running => "*",
            Status::Completed => "+",
            Status::Failed | Status::Interrupted => "!",
            Status::RateLimited | Status::Blocked | Status::Waiting => "~",
            Status::Idle | Status::Unknown => "-",
        }
    }
}

/// ------------------------------------------------------------------------
/// HOW FAR THROUGH SOMETHING IS - WHEN SOMETHING COUNTED IT.
///
/// THERE IS NO CONSTRUCTOR THAT INVENTS ONE. A progress figure exists here only
/// because a caller counted a real thing and said what it counted: plan steps
/// completed, tests passed of tests planned, a worker's own reported position.
/// `source` is mandatory for that reason - a number with no provenance is a
/// number somebody guessed, and the whole complaint that produced this file was
/// a status view showing 47% of nothing.
///
/// A session with no counted work has NO progress, and the renderers say what
/// it is doing instead. That is a better answer than a percentage.
#[derive(Debug, Clone)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    /// What the units are: "steps", "tests", "files".
    pub label: String,
    /// WHO COUNTED. `plan`, `tests`, `worker`, `checkpoint`.
    pub source: String,
    pub at: u64,
}

impl Progress {
    pub fn percent(&self) -> Option<u64> {
        if self.total == 0 {
            return None;
        }
        Some(((self.done.min(self.total) as f64 / self.total as f64) * 100.0).round() as u64)
    }

    fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("done", Value::n(self.done as i64));
        v.set("total", Value::n(self.total as i64));
        v.set("label", Value::s(&self.label));
        v.set("source", Value::s(&self.source));
        v.set("at", Value::n(self.at as i64));
        v.set("percent", self.percent().map(|p| Value::n(p as i64)).unwrap_or(Value::Null));
        v
    }

    fn from_value(v: &Value) -> Option<Progress> {
        let source = v.str("source");
        // NO SOURCE, NO PROGRESS. A row that lost its provenance is discarded
        // rather than shown, because it can no longer be defended.
        if source.is_empty() {
            return None;
        }
        Some(Progress {
            done: v.num("done").unwrap_or(0.0).max(0.0) as u64,
            total: v.num("total").unwrap_or(0.0).max(0.0) as u64,
            label: v.str("label"),
            source,
            at: v.num("at").unwrap_or(0.0).max(0.0) as u64,
        })
    }
}

/// SOMETHING THAT WAS ACTUALLY CHECKED, and by what.
///
/// This is the only thing in the runtime that means "done" in the sense a person
/// means it. A model saying so is not evidence; a plan reaching its last step is
/// not evidence. A test run that reported counts is.
#[derive(Debug, Clone)]
pub struct Verified {
    pub label: String,
    pub passed: u64,
    pub failed: u64,
    /// The runner's own summary line, when there was one.
    pub detail: String,
    pub at: u64,
}

impl Verified {
    fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("label", Value::s(&self.label));
        v.set("passed", Value::n(self.passed as i64));
        v.set("failed", Value::n(self.failed as i64));
        v.set("detail", Value::s(&self.detail));
        v.set("at", Value::n(self.at as i64));
        v
    }

    fn from_value(v: &Value) -> Option<Verified> {
        let label = v.str("label");
        if label.is_empty() {
            return None;
        }
        Some(Verified {
            label,
            passed: v.num("passed").unwrap_or(0.0).max(0.0) as u64,
            failed: v.num("failed").unwrap_or(0.0).max(0.0) as u64,
            detail: v.str("detail"),
            at: v.num("at").unwrap_or(0.0).max(0.0) as u64,
        })
    }
}

/// WHAT A REQUEST COST. Two halves with different truth values, kept apart on
/// purpose — see `to_value`, which labels them on the wire so no renderer can
/// draw a live number that nobody measured.
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub requests: u64,
    /// The OPEN request's input side, known at `message_start` — before a single
    /// output token exists. This is the only part that is genuinely live.
    pub live_input_tokens: u64,
    pub live_cache_read_tokens: u64,
    pub live_cache_creation_tokens: u64,
    /// Is a request open whose input side we have and whose output side we do
    /// not? The terminal needs this to know when to print `—` and not `0`.
    pub live_open: bool,
    /// HAS ANY PROVIDER EVER STATED A CACHE FIGURE FOR THIS SESSION?
    ///
    /// Without this, `cache_read_tokens: 0` says two irreconcilable things -
    /// "this route reported a cache and it was cold" and "this route has never
    /// mentioned a cache in its life". A remote reader asked for token
    /// accounting must print `unknown` for the second, and it cannot without
    /// being told which one it is holding. Unknown stays unknown.
    pub saw_cache: bool,
    pub updated_at: u64,
}

impl Usage {
    fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("input_tokens", Value::n(self.input_tokens as i64));
        v.set("output_tokens", Value::n(self.output_tokens as i64));
        v.set("cache_read_tokens", Value::n(self.cache_read_tokens as i64));
        v.set("cache_creation_tokens", Value::n(self.cache_creation_tokens as i64));
        v.set("requests", Value::n(self.requests as i64));
        v.set("live_input_tokens", Value::n(self.live_input_tokens as i64));
        v.set("live_cache_read_tokens", Value::n(self.live_cache_read_tokens as i64));
        v.set("live_cache_creation_tokens", Value::n(self.live_cache_creation_tokens as i64));
        v.set("live_open", Value::Bool(self.live_open));
        // THE HONESTY FIELD. Output is completion-only on every provider LAIN
        // speaks to: Anthropic states it in `message_delta` at the end, and the
        // OpenAI-compatible shape states it in the final chunk. So while a
        // request is open there IS no output number, and a renderer that draws
        // one is drawing a guess. It is told so here rather than left to infer.
        v.set("output_is_live", Value::Bool(false));
        v.set("cache_reported", Value::Bool(self.saw_cache));
        v.set("updated_at", Value::n(self.updated_at as i64));
        v
    }

    fn from_value(v: &Value) -> Usage {
        let n = |k: &str| v.num(k).unwrap_or(0.0).max(0.0) as u64;
        Usage {
            input_tokens: n("input_tokens"),
            output_tokens: n("output_tokens"),
            cache_read_tokens: n("cache_read_tokens"),
            cache_creation_tokens: n("cache_creation_tokens"),
            requests: n("requests"),
            live_input_tokens: n("live_input_tokens"),
            live_cache_read_tokens: n("live_cache_read_tokens"),
            live_cache_creation_tokens: n("live_cache_creation_tokens"),
            live_open: matches!(v.get("live_open"), Some(Value::Bool(true))),
            saw_cache: matches!(v.get("cache_reported"), Some(Value::Bool(true))),
            updated_at: n("updated_at"),
        }
    }
}

/// A SENTENCE THAT WAS NOT SENT. Written to disk before the caller is told it
/// was held — the ordering is the whole guarantee.
#[derive(Debug, Clone)]
pub struct Held {
    pub id: String,
    pub text: String,
    /// What Node called it when it offered it: `user`, `steer`, `resume`.
    /// Carried, never interpreted here.
    pub kind: String,
    pub at: u64,
    /// The state that caused the hold, so a packet can say WHY without
    /// re-deriving it from a state that has since moved on.
    pub reason: String,
}

impl Held {
    fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("id", Value::s(&self.id));
        v.set("text", Value::s(&self.text));
        v.set("kind", Value::s(&self.kind));
        v.set("at", Value::n(self.at as i64));
        v.set("reason", Value::s(&self.reason));
        v
    }

    fn from_value(v: &Value) -> Option<Held> {
        let id = v.str("id");
        if id.is_empty() {
            return None;
        }
        Some(Held {
            id,
            text: v.str("text"),
            kind: v.str("kind"),
            at: v.num("at").unwrap_or(0.0).max(0.0) as u64,
            reason: v.str("reason"),
        })
    }
}

/// ONE SESSION'S RUNTIME TRUTH.
#[derive(Debug, Clone)]
pub struct Sess {
    pub session: String,
    pub state: TurnState,
    pub turn_id: String,
    pub turn_started_at: u64,
    pub last_progress_at: u64,
    /// The Node process that owns this turn. THE ONLY EVIDENCE accepted for
    /// "nobody is going to finish this" — see the note at the top of the file
    /// about not inferring death from silence.
    pub owner_pid: u32,
    pub model: String,
    pub provider: String,
    pub connection_id: String,
    /// How the last turn ended, in the words errors.js already uses.
    pub failure_kind: String,
    pub failure_reason: String,
    /// Set when a boundary is crossed, cleared when a packet is delivered.
    /// Survives a restart, which is the point: a model switch decided in a
    /// process that then died is still a model switch.
    pub handover_pending: bool,
    pub handover_reason: String,
    /// The model that ran the turn being handed over FROM, so a packet can say
    /// who stopped and not merely that somebody did.
    pub previous_model: String,
    pub usage: Usage,
    pub held: Vec<Held>,
    pub counter: u64,
    /// WHAT THIS CONVERSATION IS ABOUT, in the user's words rather than in a
    /// session id. Reported by the CLI, which is the only party that knows -
    /// the runtime sees an id and a working directory and could name a session
    /// only by guessing.
    pub name: String,
    pub cwd: String,
    /// The current operation in words: a tool name, a phase, a step label.
    /// Distinct from `state`, which is a vocabulary; this is the detail under
    /// it, and it is what a person actually wants to read.
    pub activity: String,
    /// A MODEL SOMEBODY ASKED FOR, which is not the model that is running.
    ///
    /// The runtime validates a switch and records it; the CLI is what actually
    /// changes a model, because the configuration, the connection and the
    /// context all live there. Kept separate from `model` for exactly that
    /// reason - conflating "requested" with "in use" would let a remote request
    /// report itself as having already taken effect.
    pub requested_model: String,
    /// Counted by somebody, or absent. Never derived here.
    pub progress: Option<Progress>,
    /// Checked by something, or absent. Never inferred here.
    pub verified: Option<Verified>,
    /// THE PROVIDER REQUEST THAT IS OPEN RIGHT NOW, if one is.
    ///
    /// Issued by `request_begin` and cleared by `request_end`. It is what makes
    /// the runtime the LIFECYCLE authority for a model request rather than an
    /// observer of one: a request with no id was never admitted, and a session
    /// holding an id whose owner process is gone is a request nobody will ever
    /// finish. See `request_begin` for what is actually refused.
    pub open_request: String,
    pub open_request_at: u64,
    pub request_seq: u64,
    /// SOMEBODY WHO IS NOT AT THE KEYBOARD ASKED FOR THIS TO STOP.
    ///
    /// A remote surface has no Ctrl+C. It cannot reach into the attached CLI's
    /// abort controller either - nothing outside that process can - so it
    /// records the REQUEST here and the attached process honours it. Set by
    /// `request_stop`, cleared when a turn ends, so a stop can never apply to a
    /// turn that started after it was asked for.
    pub stop_requested: bool,
}

impl Sess {
    fn new(session: &str) -> Sess {
        Sess {
            session: session.to_string(),
            state: TurnState::Idle,
            turn_id: String::new(),
            turn_started_at: 0,
            last_progress_at: now(),
            owner_pid: 0,
            model: String::new(),
            provider: String::new(),
            connection_id: String::new(),
            failure_kind: String::new(),
            failure_reason: String::new(),
            handover_pending: false,
            handover_reason: String::new(),
            previous_model: String::new(),
            usage: Usage::default(),
            held: Vec::new(),
            counter: 0,
            name: String::new(),
            cwd: String::new(),
            activity: String::new(),
            requested_model: String::new(),
            open_request: String::new(),
            open_request_at: 0,
            request_seq: 0,
            progress: None,
            verified: None,
            stop_requested: false,
        }
    }

    /// THE EFFECTIVE STATE, which is not always the recorded one.
    ///
    /// A turn recorded as `TOOL_RUNNING` by a Node process that no longer exists
    /// is not running a tool. Resolving that here rather than at write time is
    /// deliberate: the process may die at any moment including this one, and a
    /// stored word cannot be kept honest by the thing that stored it.
    ///
    /// `owner_pid == 0` means NOBODY CLAIMED IT, which must not read as dead —
    /// a client that does not send a pid gets the old, permissive behaviour
    /// rather than a session wedged shut by an absent field.
    pub fn effective(&self) -> TurnState {
        self.effective_given(self.owner_alive())
    }

    /// ------------------------------------------------------------------------
    /// THE STATE OF THE WORK, from evidence only.
    ///
    /// THE ORDER IS THE ARGUMENT. Each test below is more specific than the one
    /// after it, so a rate-limited session is never reported merely as blocked
    /// and a lost one is never reported merely as idle.
    ///
    /// COMPLETED MEANS "THE LAST TURN FINISHED", and it is the weakest claim in
    /// the list on purpose. It does not mean the project is done - nothing the
    /// runtime can see means that - and anything stronger belongs in `verified`,
    /// which holds a count somebody actually produced.
    pub fn status(&self) -> Status {
        let alive = self.owner_alive();
        let eff = self.effective_given(alive);
        // A turn in flight, owned by a process that exists.
        if eff.in_flight() {
            return Status::Running;
        }
        match eff {
            TurnState::RateLimited => Status::RateLimited,
            // The owner is gone mid-turn: interrupted, not failed. Nobody
            // decided to stop it and the provider did nothing wrong.
            TurnState::Lost => Status::Interrupted,
            TurnState::ProviderFailed => Status::Failed,
            TurnState::Cancelled => Status::Interrupted,
            _ => {
                // INPUT WITH NOTHING TO RUN IT. A person queued work from a
                // phone and no CLI is attached; that is not idleness.
                if !self.held.is_empty() && !(alive && self.owner_pid != 0) {
                    return Status::Waiting;
                }
                if self.handover_pending {
                    return Status::Blocked;
                }
                if eff == TurnState::Completed {
                    return Status::Completed;
                }
                // NEVER RAN. Recorded because something mentioned it, and
                // nothing is claimed about it.
                if self.turn_started_at == 0 {
                    return Status::Unknown;
                }
                Status::Idle
            }
        }
    }

    /// Does the process that claimed this turn still exist?
    ///
    /// `owner_pid == 0` means NOBODY CLAIMED IT and answers `true` — a client
    /// that sends no pid gets the old, permissive behaviour rather than a
    /// session wedged shut by an absent field.
    pub fn owner_alive(&self) -> bool {
        self.owner_pid == 0 || alive_cached(self.owner_pid)
    }

    /// The same judgement with the expensive half already answered, so one
    /// request asks the operating system once rather than three times.
    pub fn effective_given(&self, owner_alive: bool) -> TurnState {
        if self.state.in_flight() && !owner_alive {
            return TurnState::Lost;
        }
        self.state
    }

    fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("session", Value::s(&self.session));
        v.set("state", Value::s(self.state.as_str()));
        v.set("turn_id", Value::s(&self.turn_id));
        v.set("turn_started_at", Value::n(self.turn_started_at as i64));
        v.set("last_progress_at", Value::n(self.last_progress_at as i64));
        v.set("owner_pid", Value::n(self.owner_pid as i64));
        v.set("model", Value::s(&self.model));
        v.set("provider", Value::s(&self.provider));
        v.set("connection_id", Value::s(&self.connection_id));
        v.set("failure_kind", Value::s(&self.failure_kind));
        v.set("failure_reason", Value::s(&self.failure_reason));
        v.set("handover_pending", Value::Bool(self.handover_pending));
        v.set("handover_reason", Value::s(&self.handover_reason));
        v.set("previous_model", Value::s(&self.previous_model));
        v.set("usage", self.usage.to_value());
        v.set("counter", Value::n(self.counter as i64));
        v.set("name", Value::s(&self.name));
        v.set("cwd", Value::s(&self.cwd));
        v.set("activity", Value::s(&self.activity));
        v.set("requested_model", Value::s(&self.requested_model));
        v.set("open_request", Value::s(&self.open_request));
        v.set("open_request_at", Value::n(self.open_request_at as i64));
        v.set("request_seq", Value::n(self.request_seq as i64));
        // ABSENT, NOT ZERO. `null` here is the difference between "nothing
        // counted this" and "it is 0% done", and a renderer that cannot tell
        // them apart will print the second when it means the first.
        v.set("progress", self.progress.as_ref().map(Progress::to_value).unwrap_or(Value::Null));
        v.set("verified", self.verified.as_ref().map(Verified::to_value).unwrap_or(Value::Null));
        v.set("stop_requested", Value::Bool(self.stop_requested));
        v.set("held", Value::Arr(self.held.iter().map(Held::to_value).collect()));
        v
    }

    /// The snapshot a client reads. Carries BOTH the recorded state and the
    /// effective one, because "it says TOOL_RUNNING and the process is gone" is
    /// information a diagnostic wants and a single word would destroy.
    pub fn snapshot(&self) -> Value {
        let mut v = self.to_value();
        let live = self.owner_alive();
        let eff = self.effective_given(live);
        v.set("effective_state", Value::s(eff.as_str()));
        v.set("owner_alive", Value::Bool(live));
        v.set("in_flight", Value::Bool(eff.in_flight()));
        v.set("needs_handover", Value::Bool(eff.needs_handover() || self.handover_pending));
        v.set("held_count", Value::n(self.held.len() as i64));
        // THE WORK'S STATE, alongside the turn's - both, never one collapsed
        // into the other. See `Status`.
        v.set("status", Value::s(self.status().as_str()));
        v.set("attached", Value::Bool(live && self.owner_pid != 0));
        v
    }

    fn from_value(v: &Value) -> Option<Sess> {
        let session = v.str("session");
        if session.is_empty() {
            return None;
        }
        let held = match v.get("held") {
            Some(Value::Arr(rows)) => rows.iter().filter_map(Held::from_value).collect(),
            _ => Vec::new(),
        };
        Some(Sess {
            session,
            state: TurnState::from_str(&v.str("state")),
            turn_id: v.str("turn_id"),
            turn_started_at: v.num("turn_started_at").unwrap_or(0.0).max(0.0) as u64,
            last_progress_at: v.num("last_progress_at").unwrap_or(0.0).max(0.0) as u64,
            owner_pid: v.num("owner_pid").unwrap_or(0.0).max(0.0) as u32,
            model: v.str("model"),
            provider: v.str("provider"),
            connection_id: v.str("connection_id"),
            failure_kind: v.str("failure_kind"),
            failure_reason: v.str("failure_reason"),
            handover_pending: matches!(v.get("handover_pending"), Some(Value::Bool(true))),
            handover_reason: v.str("handover_reason"),
            previous_model: v.str("previous_model"),
            usage: v.get("usage").map(Usage::from_value).unwrap_or_default(),
            held,
            counter: v.num("counter").unwrap_or(0.0).max(0.0) as u64,
            name: v.str("name"),
            cwd: v.str("cwd"),
            activity: v.str("activity"),
            requested_model: v.str("requested_model"),
            open_request: v.str("open_request"),
            open_request_at: v.num("open_request_at").unwrap_or(0.0).max(0.0) as u64,
            request_seq: v.num("request_seq").unwrap_or(0.0).max(0.0) as u64,
            progress: v.get("progress").and_then(Progress::from_value),
            verified: v.get("verified").and_then(Verified::from_value),
            stop_requested: matches!(v.get("stop_requested"), Some(Value::Bool(true))),
        })
    }
}

/// ------------------------------------------------------------------------
/// THE STORE. One file per session — the shape jobs.rs and providers.rs already
/// use, for the same reason: a whole-store rewrite on every note turns one
/// session's chatter into a rewrite of everybody's.
pub struct Guardian {
    pub dir: PathBuf,
    pub sessions: BTreeMap<String, Sess>,
}

/// A session id becomes a filename here. Anything that could climb out of the
/// directory is REPLACED rather than rejected, because rejecting would discard
/// the state of a session whose id LAIN did not choose.
///
/// THE DOT IS THE INTERESTING CHARACTER. It has to survive — real session ids
/// carry timestamps — but a RUN of dots is `..`, which is a directory and not a
/// name. Separators are already gone by the time that matters, so `..` could not
/// traverse anything on its own; it is collapsed anyway, because a store whose
/// safety depends on two separate rules holding at once is a store that will
/// one day be unsafe for a reason nobody predicted.
fn safe(id: &str) -> String {
    let mapped: String = id
        .chars()
        .take(120)
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let mut out = String::with_capacity(mapped.len());
    let mut prev_dot = false;
    for c in mapped.chars() {
        let dot = c == '.';
        out.push(if dot && prev_dot { '_' } else { c });
        prev_dot = dot && !prev_dot;
    }
    out
}

impl Guardian {
    pub fn open(dir: PathBuf) -> Guardian {
        let mut g = Guardian { dir, sessions: BTreeMap::new() };
        let _ = fs::create_dir_all(g.store_dir());
        g.load();
        g
    }

    pub fn store_dir(&self) -> PathBuf {
        self.dir.join("guardian")
    }

    fn load(&mut self) {
        let d = self.store_dir();
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let mut s = String::new();
            if fs::File::open(&p).and_then(|mut f| f.read_to_string(&mut s)).is_err() {
                continue;
            }
            // A FILE THAT DOES NOT PARSE IS SKIPPED, not fatal. One corrupt
            // session must not stop the supervisor loading the others — §12.
            if let Some(sess) = json::parse(&s).as_ref().and_then(Sess::from_value) {
                self.sessions.insert(sess.session.clone(), sess);
            }
        }
    }

    fn save(&self, sess: &Sess) {
        let d = self.store_dir();
        let _ = fs::create_dir_all(&d);
        let name = safe(&sess.session);
        let tmp = d.join(format!("{name}.tmp"));
        // WRITE THEN RENAME. A half-written state file read back after a crash
        // is a session whose held input parses as nothing, which is precisely
        // the loss this store exists to prevent.
        if fs::write(&tmp, json::write(&sess.to_value()).as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, d.join(format!("{name}.json")));
        }
    }

    fn entry(&mut self, session: &str) -> &mut Sess {
        self.sessions.entry(session.to_string()).or_insert_with(|| Sess::new(session))
    }

    pub fn get(&self, session: &str) -> Option<&Sess> {
        self.sessions.get(session)
    }

    /// A TURN IS STARTING. `owner_pid` is the Node process taking responsibility
    /// for it, and is the only thing that will later prove it stopped.
    pub fn turn_begin(
        &mut self,
        session: &str,
        turn_id: &str,
        model: &str,
        provider: &str,
        connection_id: &str,
        owner_pid: u32,
    ) -> Sess {
        let t = now();
        let s = self.entry(session);
        // A NEW TURN DOES NOT CLEAR THE HELD QUEUE. If Node started a turn while
        // something was still parked, the parked sentence is still undelivered —
        // it is cleared by `deliver`, which is the only call that knows it
        // actually reached a model.
        s.state = TurnState::ModelThinking;
        s.turn_id = turn_id.to_string();
        s.turn_started_at = t;
        s.last_progress_at = t;
        s.owner_pid = owner_pid;
        // A MODEL CHANGE IS A BOUNDARY, and it is OBSERVED here rather than
        // announced by a command: `/model` is one way to cross it and a failover
        // inside provider.js is another, and nobody types the second one.
        if !s.model.is_empty() && !model.is_empty() && s.model != model {
            s.previous_model = s.model.clone();
            s.handover_pending = true;
            s.handover_reason = format!("the model changed from {} to {model}", s.model);
        }
        if !model.is_empty() {
            s.model = model.to_string();
        }
        if !provider.is_empty() {
            s.provider = provider.to_string();
        }
        if !connection_id.is_empty() {
            s.connection_id = connection_id.to_string();
        }
        s.failure_kind.clear();
        s.failure_reason.clear();
        s.counter += 1;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// A PHASE THE TURN LOOP ALREADY COMPUTED. Free on the Node side — it is the
    /// same callback the status strip is drawn from, routed to one more reader.
    pub fn turn_phase(&mut self, session: &str, phase: &str) -> Sess {
        let t = now();
        let s = self.entry(session);
        let next = TurnState::from_str(phase);
        // ONLY THE IN-FLIGHT WORDS MAY ARRIVE THIS WAY. A phase callback saying
        // COMPLETED would be turn.js claiming an outcome it does not decide —
        // `turn_end` is the only thing that may finish a turn, because it is the
        // only one told how it ended.
        if next.in_flight() {
            s.state = next;
        }
        // THE PHASE IS ALSO THE ACTIVITY, when nothing better has been said.
        // Free: this callback already fires before every request and every
        // tool, so a remote reader gets "what is it doing" for no extra traffic.
        if s.activity.is_empty() || !phase.is_empty() {
            s.activity = phase.chars().take(120).collect();
        }
        s.last_progress_at = t;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// THE TURN ENDED, AND HOW.
    ///
    /// `outcome` is a word turnrecord.js already uses — `completed`, `aborted`,
    /// `provider`, `rate_limited`, `max-steps`, `no-credential`. Mapping it to a
    /// state is the only judgement made here, and it is the judgement that
    /// decides whether the NEXT sentence a person types is held.
    pub fn turn_end(&mut self, session: &str, outcome: &str, kind: &str, reason: &str) -> Sess {
        let t = now();
        let s = self.entry(session);
        let state = match outcome {
            "completed" | "ok" | "" => TurnState::Completed,
            "aborted" | "cancelled" => TurnState::Cancelled,
            "rate_limited" | "RATE_LIMITED" => TurnState::RateLimited,
            // EVERY OTHER ENDING IS A FAILED TURN, and `max-steps` and
            // `no-credential` are in that set on purpose: both leave work
            // half-finished, both are things a replacement model must be told,
            // and both are followed by a person typing `continue`.
            _ => TurnState::ProviderFailed,
        };
        s.state = state;
        s.last_progress_at = t;
        s.failure_kind = kind.chars().take(80).collect();
        s.failure_reason = reason.chars().take(300).collect();
        // A STOP APPLIES TO THE TURN IT WAS ASKED ABOUT AND NO OTHER. Whether
        // the turn stopped because of the request or finished on its own, the
        // request is spent - leaving it set would abort the NEXT turn, which is
        // the one thing a person asking to stop this one did not ask for.
        s.stop_requested = false;
        if state.needs_handover() {
            s.handover_pending = true;
            if s.handover_reason.is_empty() {
                // ---- THE KIND TRAVELS WITH THE REASON -----------------------
                //
                // `offer` writes `RATE_LIMITED: the route was limited`, and
                // inputgate.js reads the word before the colon to choose the
                // sentence a person sees. This wrote the bare detail, so a
                // recovery reached through the OTHER door - a continuation
                // queued from a phone, which reads this field rather than
                // `offer`'s answer - got a packet with no kind on it and fell
                // back to "the runtime is recovering". Both producers now write
                // the same shape, so both readers get the same answer.
                let detail: String = reason.chars().take(280).collect();
                s.handover_reason = if detail.is_empty() {
                    format!("{}: the previous turn did not finish", state.as_str())
                } else {
                    format!("{}: {}", state.as_str(), detail)
                };
            }
            s.previous_model = s.model.clone();
        } else if state == TurnState::Completed {
            // ---- AND A TURN THAT FINISHED CLOSES ONE --------------------------
            //
            // A completed turn is the ONLY evidence there is that a briefing was
            // delivered and acted on. The conversation is healthy again, so the
            // next sentence a person types must go straight through — leaving the
            // flag set would wrap every later message in a recovery nobody needed,
            // which is the token waste this whole mechanism exists to remove.
            //
            // THIS DECISION LIVES HERE, and it used to live in Node: inputgate.js
            // read `record.stopReason` after its recovery turn and called
            // `handover_done`. That worked and was the wrong shape — it put a
            // second party in charge of a flag this file owns, and an
            // architecture test caught it as exactly that. It also could not see
            // an ordinary turn succeeding, only a recovery one.
            //
            // A CANCELLATION DOES NOT CLOSE IT. Ctrl+C is not evidence that
            // anything was read, and the boundary is still owed.
            s.handover_pending = false;
            s.handover_reason.clear();
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// ------------------------------------------------------------------------
    /// THE GATEWAY. May this sentence be sent?
    ///
    /// Returns `(deliver, reason, held_id, state)`. When it does not deliver, the
    /// text is on disk BEFORE this returns.
    pub fn offer(&mut self, session: &str, text: &str, kind: &str) -> (bool, String, String, Sess) {
        let t = now();
        // The effective state may consult a pid, and the borrow checker would
        // rather that happened before the mutable entry is taken.
        let eff = self.sessions.get(session).map(Sess::effective).unwrap_or(TurnState::Idle);
        let pending = self.sessions.get(session).map(|s| s.handover_pending).unwrap_or(false);
        let s = self.entry(session);

        // THE MOST SPECIFIC REASON WINS, and the order below is that ranking
        // rather than a convenience. `turn_end` arms a handover on every ending
        // that needs one, so a rate limit and a dead provider BOTH also have
        // `handover_pending` set — and answering "HANDOVER_PENDING" to a person
        // whose route was rate limited buries the one fact that tells them when
        // to try again. The observed state is checked first for that reason;
        // the pending flag is the fallback for a boundary nothing else explains.
        let reason = match eff {
            TurnState::RateLimited => format!(
                "RATE_LIMITED: the route was limited{}",
                if s.failure_reason.is_empty() { String::new() } else { format!(" — {}", s.failure_reason) }
            ),
            TurnState::ProviderFailed => format!(
                "PROVIDER_FAILED: the previous turn did not finish{}",
                if s.failure_reason.is_empty() { String::new() } else { format!(" — {}", s.failure_reason) }
            ),
            // THE ONE THAT PAYS FOR THIS WHOLE FILE. The recorded state says a
            // turn is in flight and the process that would finish it does not
            // exist: Node restarted, crashed, or was killed.
            TurnState::Lost => {
                format!("TURN_LOST: the process running the previous turn (pid {}) is gone", s.owner_pid)
            }
            TurnState::HandoverPending => "HANDOVER_PENDING: a model boundary was crossed".to_string(),
            // A BOUNDARY THAT WAS NEVER CLOSED — a model switch, or a packet that
            // was owed and never delivered. Checked only once the states above
            // have declined, and never while a turn is genuinely in flight,
            // because a steer into a healthy turn is not a recovery.
            _ if pending && !eff.in_flight() => {
                let why = if s.handover_reason.is_empty() {
                    "a model boundary was crossed".to_string()
                } else {
                    s.handover_reason.clone()
                };
                format!("HANDOVER_PENDING: {why}")
            }
            _ => String::new(),
        };

        if reason.is_empty() {
            // HEALTHY. Node's ordinary steer/submit semantics decide what happens
            // next; the Guardian's answer is only that nothing is in the way.
            let out = s.clone();
            return (true, String::new(), String::new(), out);
        }

        s.counter += 1;
        let id = format!("in-{t}-{}", s.counter);
        s.held.push(Held {
            id: id.clone(),
            text: text.chars().take(MAX_TEXT).collect(),
            kind: kind.to_string(),
            at: t,
            reason: reason.clone(),
        });
        // THE OLDEST GO FIRST at the cap. Dropping the NEWEST would throw away
        // the sentence the person just typed — the one they are watching for.
        while s.held.len() > MAX_HELD {
            s.held.remove(0);
        }
        // Holding input is itself a boundary: whatever happens next must carry a
        // packet, or the held sentence arrives as bare as it would have before.
        s.handover_pending = true;
        if s.handover_reason.is_empty() {
            s.handover_reason = reason.clone();
        }
        let out = s.clone();
        self.save(&out);
        (false, reason, id, out)
    }

    /// INPUT FROM A SURFACE THAT HAS NO PROMPT BEHIND IT.
    ///
    /// ------------------------------------------------------------------------
    /// WHY THIS IS NOT `offer`, AND WHY IT IS NOT A SECOND QUEUE.
    ///
    /// `offer` answers a question a WAITING PROCESS asked: someone typed a line
    /// at a prompt and Node is holding it, about to send. Its `true` means
    /// "carry on", and the caller carries on.
    ///
    /// A message from Telegram has no such caller. Nothing is holding the text,
    /// nothing is about to send it, and answering `true` would drop it on the
    /// floor. So remote intent is always WRITTEN DOWN, and the attached CLI
    /// picks it up from the same `held` queue a local hold uses - the same
    /// rows, drained by the same `deliver`, recovered by the same code path in
    /// inputgate.js. ONE queue and one recovery, reached through two doors.
    ///
    /// IT DOES NOT DECIDE ANYTHING. Whether the intent becomes a plain turn or a
    /// turn carrying a verified handover packet is decided later, by the state
    /// at the moment it is drained - which is right, because a route that is
    /// limited now may be open by the time anybody reads this.
    pub fn enqueue(&mut self, session: &str, text: &str, kind: &str) -> (String, Sess) {
        let t = now();
        let eff = self.sessions.get(session).map(Sess::effective).unwrap_or(TurnState::Idle);
        let s = self.entry(session);
        s.counter += 1;
        let id = format!("rc-{t}-{}", s.counter);
        s.held.push(Held {
            id: id.clone(),
            text: text.chars().take(MAX_TEXT).collect(),
            kind: kind.to_string(),
            at: t,
            reason: format!("QUEUED: arrived from {kind} while the turn was {}", eff.as_str()),
        });
        while s.held.len() > MAX_HELD {
            s.held.remove(0);
        }
        let out = s.clone();
        self.save(&out);
        (id, out)
    }

    /// WHAT THIS CONVERSATION IS CALLED. Reported by the CLI at the start of a
    /// session; the runtime never guesses a name from a path.
    pub fn identify(&mut self, session: &str, name: &str, cwd: &str) -> Sess {
        let s = self.entry(session);
        if !name.is_empty() {
            s.name = name.chars().take(80).collect();
        }
        if !cwd.is_empty() {
            s.cwd = cwd.chars().take(300).collect();
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// SOMEBODY COUNTED SOMETHING.
    ///
    /// `source` is required and a note without one is DISCARDED rather than
    /// stored - see `Progress`. `total == 0` is allowed and means "counting up
    /// with no known end", which is honest and yields no percentage.
    ///
    /// An empty `source` with a `label` is how a caller says "no number, but
    /// this is what is happening": the activity is recorded and any stale
    /// progress is cleared, so a finished plan does not leave 80% on a screen.
    pub fn progress_note(
        &mut self,
        session: &str,
        done: u64,
        total: u64,
        label: &str,
        source: &str,
        activity: &str,
    ) -> Sess {
        let t = now();
        let s = self.entry(session);
        if !activity.is_empty() {
            s.activity = activity.chars().take(120).collect();
        }
        if source.is_empty() {
            s.progress = None;
        } else {
            s.progress = Some(Progress {
                done,
                total,
                label: label.chars().take(40).collect(),
                source: source.chars().take(40).collect(),
                at: t,
            });
        }
        s.last_progress_at = t;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// A MODEL SWITCH WAS ASKED FOR AND VALIDATED.
    ///
    /// Arming the handover here is the whole reason this belongs in the runtime:
    /// a replacement model is owed a briefing, and after this call that is true
    /// ON DISK - so it survives the CLI dying between the request and the switch,
    /// which is exactly when a boundary is most likely to be forgotten.
    pub fn request_model(&mut self, session: &str, model: &str) -> Sess {
        let s = self.entry(session);
        s.requested_model = model.chars().take(120).collect();
        s.previous_model = s.model.clone();
        s.handover_pending = true;
        if s.handover_reason.is_empty() {
            s.handover_reason = format!(
                "a model switch to {} was requested from a remote surface",
                s.requested_model
            );
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// The CLI applied it (or declined to). Either way it is no longer pending.
    pub fn clear_model_request(&mut self, session: &str) -> Sess {
        let s = self.entry(session);
        s.requested_model.clear();
        let out = s.clone();
        self.save(&out);
        out
    }

    /// SOMETHING WAS CHECKED. The only claim in the runtime that means "done"
    /// in the sense a person means it.
    pub fn verified_note(
        &mut self,
        session: &str,
        label: &str,
        passed: u64,
        failed: u64,
        detail: &str,
    ) -> Sess {
        let t = now();
        let s = self.entry(session);
        if !label.is_empty() {
            s.verified = Some(Verified {
                label: label.chars().take(60).collect(),
                passed,
                failed,
                detail: detail.chars().take(200).collect(),
                at: t,
            });
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// ------------------------------------------------------------------------
    /// MAY A MODEL REQUEST BE MADE, AND UNDER WHAT IDENTITY?
    ///
    /// This is the difference between a runtime that OBSERVES the model boundary
    /// and one that OWNS it. Every provider request is admitted here first and
    /// carries an id issued here; a request without one was never admitted, and
    /// that is a fact a test can check rather than a convention a caller can
    /// forget.
    ///
    /// IT CAN SAY NO, and the two refusals are both things only this process
    /// knows:
    ///
    ///   LOST      the turn is recorded as in flight and the process that owns
    ///             it is gone. Another request against that session would build
    ///             on a turn nobody is going to finish.
    ///   SHUT      the caller was told the route is closed with a reset time in
    ///             the future. The caller passes that in - this store does not
    ///             hold provider health - so the decision is made once, here,
    ///             rather than by each surface separately.
    ///
    /// Everything else is admitted. It is an authority, not a rationing scheme:
    /// refusing on anything it merely suspects would make the runtime a source
    /// of failures instead of a guard against them.
    pub fn request_begin(&mut self, session: &str, route_shut: &str) -> (bool, String, String, Sess) {
        let t = now();
        let eff = self.sessions.get(session).map(Sess::effective).unwrap_or(TurnState::Idle);
        if eff == TurnState::Lost {
            let s = self.entry(session).clone();
            return (
                false,
                String::new(),
                format!("TURN_LOST: the process that owned this turn (pid {}) is gone", s.owner_pid),
                s,
            );
        }
        if !route_shut.is_empty() {
            let s = self.entry(session).clone();
            return (false, String::new(), format!("ROUTE_SHUT: {route_shut}"), s);
        }
        let s = self.entry(session);
        s.request_seq += 1;
        let id = format!("rq-{}-{}", t, s.request_seq);
        s.open_request = id.clone();
        s.open_request_at = t;
        let out = s.clone();
        self.save(&out);
        (true, id, String::new(), out)
    }

    /// A REQUEST FINISHED, however it finished.
    ///
    /// Clears the open id whatever the outcome: a request that failed is still
    /// a request that is no longer open, and leaving the id set would make the
    /// next one look like a second request against the same identity.
    pub fn request_end(&mut self, session: &str, request_id: &str) -> Sess {
        let s = self.entry(session);
        // ONLY THE REQUEST THAT IS ACTUALLY OPEN may close it. A late reply from
        // an abandoned request must not clear the id of the one that replaced it.
        if request_id.is_empty() || s.open_request == request_id {
            s.open_request.clear();
            s.open_request_at = 0;
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// STOP, ASKED FOR FROM SOMEWHERE WITH NO CTRL+C.
    ///
    /// Recorded rather than done, because the thing that can actually stop a
    /// model turn is the process running it and this is not that process. The
    /// attached CLI reads the flag and aborts exactly as if the key had been
    /// pressed; with no CLI attached the flag simply expires with the turn.
    /// Nothing here pretends the turn stopped.
    pub fn request_stop(&mut self, session: &str) -> Sess {
        let s = self.entry(session);
        s.stop_requested = true;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// The attached process honoured it (or found nothing to honour).
    pub fn clear_stop(&mut self, session: &str) -> Sess {
        let s = self.entry(session);
        s.stop_requested = false;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// THE SESSION A REMOTE COMMAND MEANS.
    ///
    /// Somebody typing `/continue` on a phone is not going to name a session id,
    /// and asking them to would make the feature useless. The most recently
    /// active conversation is the one they are thinking about - and the reply
    /// says which one it chose, so a wrong guess is visible rather than silent.
    pub fn latest(&self) -> Option<&Sess> {
        self.sessions.values().max_by_key(|s| s.last_progress_at.max(s.turn_started_at))
    }

    /// TAKE THE HELD INPUT — the only thing that empties the queue, and only
    /// when Node is actually about to send it.
    pub fn deliver(&mut self, session: &str, clear_handover: bool) -> (Vec<Held>, Sess) {
        let s = self.entry(session);
        let taken: Vec<Held> = s.held.drain(..).collect();
        if clear_handover {
            s.handover_pending = false;
            s.handover_reason.clear();
        }
        let out = s.clone();
        self.save(&out);
        (taken, out)
    }

    /// A packet was built and sent. The boundary is closed; the held queue is
    /// NOT touched, because delivering a packet and delivering the sentence are
    /// two events and only `deliver` knows about the second.
    pub fn handover_done(&mut self, session: &str) -> Sess {
        let s = self.entry(session);
        s.handover_pending = false;
        s.handover_reason.clear();
        let out = s.clone();
        self.save(&out);
        out
    }

    /// A boundary the runtime could not observe for itself — `/model` before a
    /// turn ever ran, or `/resume` onto a turn that never finished.
    pub fn handover_arm(&mut self, session: &str, reason: &str) -> Sess {
        let s = self.entry(session);
        s.handover_pending = true;
        s.handover_reason = reason.chars().take(300).collect();
        if s.previous_model.is_empty() {
            s.previous_model = s.model.clone();
        }
        let out = s.clone();
        self.save(&out);
        out
    }

    /// WHAT THE REQUEST COST.
    ///
    /// `live` means "this is the input side of a request that is still open". It
    /// REPLACES rather than accumulates, because a live figure is a property of
    /// one request, and adding it to the running total twice — once live and once
    /// at completion — is exactly how a counter starts lying.
    pub fn usage_note(&mut self, session: &str, v: &Value) -> Sess {
        let t = now();
        let live = matches!(v.get("live"), Some(Value::Bool(true)));
        let s = self.entry(session);
        let n = |k: &str| v.num(k).unwrap_or(0.0).max(0.0) as u64;
        // THE KEY BEING PRESENT IS THE FACT, not the number in it. A provider
        // that sends `cache_read_tokens: 0` has told us something; one that
        // sends no such key has not.
        if v.get("cache_read_tokens").is_some() || v.get("cache_creation_tokens").is_some() {
            s.usage.saw_cache = true;
        }
        if live {
            s.usage.live_input_tokens = n("input_tokens");
            s.usage.live_cache_read_tokens = n("cache_read_tokens");
            s.usage.live_cache_creation_tokens = n("cache_creation_tokens");
            s.usage.live_open = true;
        } else {
            s.usage.input_tokens += n("input_tokens");
            s.usage.output_tokens += n("output_tokens");
            s.usage.cache_read_tokens += n("cache_read_tokens");
            s.usage.cache_creation_tokens += n("cache_creation_tokens");
            s.usage.requests += n("requests").max(1);
            s.usage.live_input_tokens = 0;
            s.usage.live_cache_read_tokens = 0;
            s.usage.live_cache_creation_tokens = 0;
            s.usage.live_open = false;
        }
        s.usage.updated_at = t;
        let out = s.clone();
        self.save(&out);
        out
    }

    /// Forget a session outright — the tests, and a session a person deleted.
    pub fn forget(&mut self, session: &str) -> bool {
        let existed = self.sessions.remove(session).is_some();
        let _ = fs::remove_file(self.store_dir().join(format!("{}.json", safe(session))));
        existed
    }

    pub fn all(&self) -> Vec<Value> {
        self.sessions.values().map(Sess::snapshot).collect()
    }
}

/// ------------------------------------------------------------------------
/// THE RUNTIME EVENT STREAM.
///
/// jobs.rs already has one for EXECUTION; this is the same file format for
/// everything else, and it is a separate file rather than a merged one because
/// the two have different retention. A job event is worth keeping until somebody
/// reasons about the job; a phase change is worth keeping until the next frame.
///
/// NOT EVENT SOURCING. Nothing is rebuilt from this log — the state files above
/// are the state. This is the record a person, or a replacement model, reads to
/// answer "what happened while I was not here", which is a different question
/// and deserves a cheaper thing.
pub fn append_event(dir: &Path, kind: &str, session: &str, detail: &Value) {
    let d = dir.join("guardian");
    let _ = fs::create_dir_all(&d);
    let p = d.join("events.jsonl");
    // ROTATED, NEVER UNBOUNDED. A log that grows forever eventually cannot be
    // read back inside a socket timeout, and the moment it fails to be is the
    // moment somebody is recovering.
    if let Ok(md) = fs::metadata(&p) {
        if md.len() > MAX_EVENT_BYTES {
            let _ = fs::rename(&p, d.join("events.1.jsonl"));
        }
    }
    let mut v = Value::obj();
    v.set("at", Value::n(now() as i64));
    v.set("kind", Value::s(kind));
    v.set("session", Value::s(session));
    if let Value::Obj(m) = detail {
        for (k, val) in m {
            v.set(k, val.clone());
        }
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        // ONE LINE, NEWLINE-TERMINATED, and the WRITER guarantees it. A reader
        // that has to repair frames is a reader that will one day repair one
        // wrongly. §12: no invisible garbage crosses a boundary unowned.
        //
        // THE GUARANTEE IS json.rs's, not a scrub here. `put_str` escapes every
        // character below 0x20 — newline, carriage return and a build tool's
        // stray 0x07 alike — so a serialised value cannot contain a raw line
        // break. Stripping them again here would be a second, weaker copy of
        // that rule, and the day the two disagreed this one would silently
        // MANGLE a detail rather than escape it.
        let _ = writeln!(f, "{}", json::write(&v));
    }
}

pub fn events_since(dir: &Path, after: usize, limit: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let text = match fs::read_to_string(dir.join("guardian").join("events.jsonl")) {
        Ok(t) => t,
        Err(_) => return out,
    };
    for (i, line) in text.lines().enumerate() {
        let seq = i + 1;
        if seq <= after {
            continue;
        }
        if let Some(mut v) = json::parse(line) {
            v.set("seq", Value::n(seq as i64));
            out.push(v);
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> Guardian {
        let d = std::env::temp_dir().join(format!("lain-guard-{tag}-{}", crate::providers::now_ms()));
        Guardian::open(d)
    }

    /// A pid high enough that no process on a normal machine holds it. Used to
    /// stand in for "the Node that owned this turn is gone".
    const DEAD_PID: u32 = 999_999_990;

    #[test]
    fn a_healthy_session_delivers_input_untouched() {
        let mut g = store("healthy");
        g.turn_begin("s1", "t1", "m", "p", "c", std::process::id());
        g.turn_end("s1", "completed", "", "");
        let (deliver, reason, id, _) = g.offer("s1", "continue", "user");
        assert!(deliver);
        assert!(reason.is_empty());
        assert!(id.is_empty());
    }

    #[test]
    fn a_failed_turn_holds_the_next_sentence_and_says_why() {
        let mut g = store("failed");
        g.turn_begin("s1", "t1", "m", "p", "c", std::process::id());
        g.turn_end("s1", "provider", "PROVIDER_DOWN", "502 from the gateway");
        let (deliver, reason, id, s) = g.offer("s1", "continue", "user");
        assert!(!deliver);
        assert!(reason.starts_with("PROVIDER_FAILED"));
        assert!(reason.contains("502"));
        assert!(!id.is_empty());
        assert_eq!(s.held.len(), 1);
        assert_eq!(s.held[0].text, "continue");
    }

    #[test]
    fn a_rate_limit_holds_and_a_cancellation_does_not() {
        let mut g = store("limits");
        g.turn_begin("a", "t", "m", "p", "c", std::process::id());
        g.turn_end("a", "rate_limited", "RATE_LIMITED", "429");
        assert!(!g.offer("a", "carry on", "user").0);

        let mut g2 = store("cancel");
        g2.turn_begin("b", "t", "m", "p", "c", std::process::id());
        g2.turn_end("b", "aborted", "", "");
        // A person who pressed Ctrl+C knows what they stopped; a recovery packet
        // would spend tokens explaining their own decision back to them.
        assert!(g2.offer("b", "do it differently", "user").0);
    }

    #[test]
    fn an_unclaimed_turn_is_not_a_dead_one() {
        // `owner_pid == 0` means no client sent a pid. That must read as "no
        // evidence", never as "the owner died" — otherwise an absent field
        // wedges a healthy session shut.
        let mut g = store("unowned");
        g.turn_begin("s", "t", "m", "p", "c", 0);
        g.turn_phase("s", "RUNNING_TOOL");
        assert!(g.offer("s", "hello", "user").0);
    }

    #[test]
    fn a_turn_owned_by_a_dead_process_is_lost_however_it_was_recorded() {
        let mut g = store("lost");
        g.turn_begin("s", "t", "m", "p", "c", DEAD_PID);
        g.turn_phase("s", "RUNNING_TOOL");
        let (deliver, reason, _, snap) = g.offer("s", "continue", "user");
        assert!(!deliver);
        assert!(reason.starts_with("TURN_LOST"), "got {reason}");
        // The RECORDED state is preserved even while the effective one differs —
        // "it says TOOL_RUNNING and nobody is there" is the diagnosis.
        assert_eq!(snap.state, TurnState::ToolRunning);
        assert_eq!(snap.effective(), TurnState::Lost);
    }

    #[test]
    fn a_running_turn_still_takes_input_because_that_is_a_steer() {
        let mut g = store("running");
        g.turn_begin("s", "t", "m", "p", "c", std::process::id());
        g.turn_phase("s", "RUNNING_TOOL");
        // The Guardian's answer is only "nothing is in the way". Whether this
        // becomes a steer or a queued turn is identify.js's decision and stays
        // there.
        assert!(g.offer("s", "also fix the readme", "user").0);
    }

    #[test]
    fn a_phase_callback_may_not_declare_a_turn_finished() {
        let mut g = store("phase");
        g.turn_begin("s", "t", "m", "p", "c", std::process::id());
        g.turn_phase("s", "COMPLETED");
        assert_eq!(g.get("s").unwrap().state, TurnState::ModelThinking);
    }

    #[test]
    fn held_input_survives_being_reopened_from_disk() {
        let d = std::env::temp_dir().join(format!("lain-guard-disk-{}", crate::providers::now_ms()));
        {
            let mut g = Guardian::open(d.clone());
            g.turn_begin("s", "t", "m", "p", "c", std::process::id());
            g.turn_end("s", "provider", "", "the socket closed");
            g.offer("s", "continue", "user");
        }
        let g2 = Guardian::open(d);
        let s = g2.get("s").expect("the session came back");
        assert_eq!(s.held.len(), 1);
        assert_eq!(s.held[0].text, "continue");
        assert!(s.handover_pending);
    }

    #[test]
    fn a_new_turn_does_not_silently_drop_what_is_still_held() {
        let mut g = store("carry");
        g.turn_begin("s", "t1", "m", "p", "c", std::process::id());
        g.turn_end("s", "provider", "", "");
        g.offer("s", "continue", "user");
        g.turn_begin("s", "t2", "m", "p", "c", std::process::id());
        assert_eq!(g.get("s").unwrap().held.len(), 1);
        let (taken, after) = g.deliver("s", true);
        assert_eq!(taken.len(), 1);
        assert!(after.held.is_empty());
        assert!(!after.handover_pending);
    }

    #[test]
    fn a_turn_that_finishes_closes_the_boundary_and_a_cancelled_one_does_not() {
        // The flag decides whether the NEXT sentence is held. A completed turn
        // is the only proof a briefing landed; a Ctrl+C proves nothing.
        let mut g = store("closes");
        g.turn_begin("s", "t1", "m", "p", "c", std::process::id());
        g.turn_end("s", "provider", "", "the socket closed");
        assert!(g.get("s").unwrap().handover_pending);
        g.turn_begin("s", "t2", "m", "p", "c", std::process::id());
        g.turn_end("s", "completed", "", "");
        assert!(!g.get("s").unwrap().handover_pending, "the recovery worked");
        assert!(g.offer("s", "and now the tests", "user").0, "so this goes straight through");

        let mut g2 = store("stays");
        g2.turn_begin("s", "t1", "m", "p", "c", std::process::id());
        g2.turn_end("s", "provider", "", "");
        g2.turn_begin("s", "t2", "m", "p", "c", std::process::id());
        g2.turn_end("s", "aborted", "", "");
        assert!(g2.get("s").unwrap().handover_pending, "a cancellation reads nothing");
    }

    #[test]
    fn changing_the_model_arms_a_handover_without_anybody_saying_so() {
        let mut g = store("switch");
        g.turn_begin("s", "t1", "claude-opus", "anthropic", "c1", std::process::id());
        g.turn_end("s", "completed", "", "");
        g.turn_begin("s", "t2", "glm-5.3", "zai", "c2", std::process::id());
        let s = g.get("s").unwrap();
        assert!(s.handover_pending);
        assert_eq!(s.previous_model, "claude-opus");
        assert!(s.handover_reason.contains("claude-opus"));
    }

    #[test]
    fn a_live_usage_note_replaces_and_a_final_one_accumulates() {
        let mut g = store("usage");
        let mut live = Value::obj();
        live.set("live", Value::Bool(true));
        live.set("input_tokens", Value::n(42_000));
        live.set("cache_read_tokens", Value::n(31_000));
        g.usage_note("s", &live);
        let s = g.get("s").unwrap();
        assert_eq!(s.usage.live_input_tokens, 42_000);
        assert_eq!(s.usage.input_tokens, 0, "a live figure is not a total");
        assert!(s.usage.live_open);

        let mut done = Value::obj();
        done.set("input_tokens", Value::n(42_000));
        done.set("output_tokens", Value::n(1_200));
        done.set("cache_read_tokens", Value::n(31_000));
        g.usage_note("s", &done);
        let s = g.get("s").unwrap();
        assert_eq!(s.usage.input_tokens, 42_000);
        assert_eq!(s.usage.output_tokens, 1_200);
        assert_eq!(s.usage.requests, 1);
        assert_eq!(s.usage.live_input_tokens, 0);
        assert!(!s.usage.live_open, "the request closed; there is no live figure");
    }

    #[test]
    fn output_tokens_are_never_advertised_as_live() {
        // §10: "Never fake a live number." Output is completion-only on every
        // provider LAIN speaks to, and the wire says so rather than leaving a
        // renderer to assume.
        let v = Usage::default().to_value();
        assert_eq!(v.get("output_is_live"), Some(&Value::Bool(false)));
    }

    #[test]
    fn the_hold_queue_drops_the_oldest_not_the_newest() {
        let mut g = store("cap");
        g.turn_begin("s", "t", "m", "p", "c", std::process::id());
        g.turn_end("s", "provider", "", "");
        for i in 0..(MAX_HELD + 3) {
            g.offer("s", &format!("line {i}"), "user");
        }
        let s = g.get("s").unwrap();
        assert_eq!(s.held.len(), MAX_HELD);
        assert_eq!(s.held.last().unwrap().text, format!("line {}", MAX_HELD + 2));
    }

    #[test]
    fn a_session_id_cannot_climb_out_of_the_store() {
        assert_eq!(safe("../../etc/passwd"), ".__.__etc_passwd");
        assert_eq!(safe(".."), "._");
        assert_eq!(safe("2026-09-04T10-11-12_abc"), "2026-09-04T10-11-12_abc");
    }

    #[test]
    fn events_are_one_line_each_and_numbered_from_one() {
        let d = std::env::temp_dir().join(format!("lain-guard-ev-{}", crate::providers::now_ms()));
        let _ = fs::create_dir_all(&d);
        let mut det = Value::obj();
        det.set("text", Value::s("a detail\nwith a newline in it"));
        append_event(&d, "INPUT_HELD", "s", &det);
        append_event(&d, "INPUT_DELIVERED", "s", &Value::obj());

        // THE FRAME IS THE FILE LINE, and it is what may not break. A two-event
        // log is two lines however many newlines the detail contained.
        let raw = fs::read_to_string(d.join("guardian").join("events.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 2, "one event, one line");

        let rows = events_since(&d, 0, 10);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].num("seq"), Some(1.0));
        assert_eq!(rows[0].str("kind"), "INPUT_HELD");
        // AND THE VALUE IS NOT MANGLED TO ACHIEVE IT. The newline survives the
        // round trip escaped, which is the whole difference between framing a
        // payload and damaging it.
        assert!(rows[0].str("text").contains('\n'));
        assert_eq!(events_since(&d, 1, 10).len(), 1);
    }
}
