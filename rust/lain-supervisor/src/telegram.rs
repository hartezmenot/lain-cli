//! TELEGRAM — A TRANSPORT, AND DELIBERATELY NOTHING ELSE.
//!
//! ------------------------------------------------------------------------
//! WHAT IS ON EACH SIDE OF THIS FILE.
//!
//!                       TELEGRAM
//!                          |            bytes in, bytes out
//!                          v
//!                     telegram.rs       <- this file
//!                          |
//!               +----------+----------+
//!               |                     |
//!               v                     v
//!           brain.rs             capability.rs
//!        (the voice: English    (the authority: a closed
//!         in, a capability       list, validated, executed)
//!         name out)                   |
//!                                     v
//!                      guardian / jobs / providers
//!
//! THIS FILE OWNS NO STATE ABOUT LAIN. It knows about long polling, update ids,
//! chat ids and backoff — Telegram's problems — and for everything else it
//! asks. There is no session model here, no idea what a turn is, and no second
//! opinion about whether anything is running. §20: one runtime, several windows.
//!
//! ------------------------------------------------------------------------
//! TWO ROADS IN, AND THE SHORT ONE DOES NOT PASS THROUGH A MODEL.
//!
//!   `/session`, `/status`, …   -> straight to a capability. Deterministic,
//!                                 instant, and available when no local model
//!                                 is configured or when it has died.
//!   anything else              -> brain.rs interprets it, the capability
//!                                 answers, brain.rs puts it into words.
//!
//! The second road is a convenience over the first. That ordering is why §14
//! costs a phrasing rather than a feature: the local model dying takes the
//! English away and leaves the whole of the runtime's authority reachable.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::brain;
use crate::capability;
use crate::http;
use crate::json::{self, Value};
use crate::remote::Identity;
use crate::Kernel;

/// How long Telegram holds a poll open with nothing to say.
const POLL_SECS: u32 = 25;
const HTTP_TIMEOUT_SECS: u32 = POLL_SECS + 15;

/// Backoff after a failure, doubling to the ceiling. NOT A SPIN: a network down
/// for an hour is polled once a minute, not sixty times.
const BACKOFF_MIN_MS: u64 = 2_000;
const BACKOFF_MAX_MS: u64 = 60_000;

/// Telegram refuses a message over 4096 characters. Cut with a visible marker,
/// never silently.
const MAX_REPLY: usize = 3_500;

/// How often the notifier looks for something worth saying.
const NOTIFY_EVERY_MS: u64 = 5_000;

/// THE SHORT ROAD. A slash command is a capability by another name; this is the
/// whole of the translation, and there is no entry that reaches a shell.
const DIRECT: &[(&str, &str)] = &[
    ("/session", "session.list"),
    ("/status", "runtime.status"),
    ("/models", "provider.list"),
    ("/tokens", "token.current"),
    ("/jobs", "job.list"),
    ("/diagnostics", "diagnostic.list"),
    ("/continue", "session.continue"),
    ("/stop", "session.stop"),
];

// ---------------------------------------------------------------------------
// PROVING A CREDENTIAL
// ---------------------------------------------------------------------------

/// `getMe`. The only thing that turns a typed string into a stored credential —
/// a token is never persisted on the strength of having been typed.
pub fn verify(token: &str) -> Result<Identity, String> {
    if !http::valid_token(token) {
        return Err("that is not a Telegram bot token — they look like 123456789:AA…".to_string());
    }
    if !http::available() {
        return Err("no HTTPS transport on this machine: curl was not found".to_string());
    }
    let r = http::call(token, "getMe", &[], 20);
    if !r.error.is_empty() {
        return Err(r.error.clone());
    }
    let body = match json::parse(&r.body) {
        Some(v) => v,
        None => return Err(format!("Telegram answered {} with something that is not JSON", r.status)),
    };
    if !matches!(body.get("ok"), Some(Value::Bool(true))) {
        // TELEGRAM'S OWN WORDS — "Unauthorized" for a bad token. Better than
        // anything invented here, and it never quotes the token back.
        let why = body.str("description");
        return Err(if why.is_empty() {
            format!("Telegram rejected the token ({})", r.status)
        } else {
            format!("Telegram said: {why}")
        });
    }
    let me = match body.get("result") {
        Some(v) => v,
        None => return Err("Telegram said ok but described no bot".to_string()),
    };
    Ok(Identity {
        bot_id: me.num("id").unwrap_or(0.0) as i64,
        username: me.str("username"),
        name: me.str("first_name"),
    })
}

// ---------------------------------------------------------------------------
// LIFETIME
// ---------------------------------------------------------------------------

/// Start the adapter if there is a credential to start it with.
///
/// IDEMPOTENT BY GENERATION rather than by a flag. `reconnect` and `disconnect`
/// bump the number; every loop checks it and a stale thread returns. That is how
/// a thread parked in a 25-second long poll is retired without being killed.
pub fn supervise(kernel: Arc<Kernel>) {
    let (configured, generation) = {
        let r = lock(&kernel);
        (r.configured(), r.generation)
    };
    if !configured {
        return;
    }
    if !http::available() {
        lock(&kernel).note_unavailable("curl was not found, so Telegram cannot be reached from this machine");
        return;
    }
    let k = kernel.clone();
    thread::spawn(move || poll_loop(k, generation));
    thread::spawn(move || notify_loop(kernel, generation));
}

fn lock(kernel: &Arc<Kernel>) -> std::sync::MutexGuard<'_, crate::remote::Remote> {
    match kernel.remote.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    }
}

fn poll_loop(kernel: Arc<Kernel>, generation: u64) {
    let mut backoff = BACKOFF_MIN_MS;
    loop {
        let (token, offset, mine) = {
            let r = lock(&kernel);
            (r.token(), r.offset, r.generation == generation && r.configured())
        };
        if !mine {
            return;
        }

        // NO LOCK IS HELD ACROSS THIS. It can take 25 seconds, and `/rc status`
        // in the terminal must answer in one.
        let r = http::call(
            &token,
            "getUpdates",
            &[
                ("offset", (offset + 1).to_string()),
                ("timeout", POLL_SECS.to_string()),
                // Only what this adapter understands: no edits, joins,
                // reactions or channel posts will ever arrive.
                ("allowed_updates", "[\"message\"]".to_string()),
            ],
            HTTP_TIMEOUT_SECS,
        );

        let parsed = if r.error.is_empty() && r.status == 200 { json::parse(&r.body) } else { None };
        let good = parsed
            .as_ref()
            .map(|b| matches!(b.get("ok"), Some(Value::Bool(true))))
            .unwrap_or(false);

        if !good {
            // NEVER THE BODY IN THE MESSAGE: a Telegram error can echo the
            // request, and the request carries the token.
            let why = if !r.error.is_empty() {
                r.error.clone()
            } else if r.status == 401 {
                "Telegram rejected the credential (401) — the bot token may have been revoked".to_string()
            } else if r.status == 409 {
                "another client is polling this bot (409)".to_string()
            } else {
                format!("Telegram answered {}", r.status)
            };
            {
                let mut rem = lock(&kernel);
                if rem.generation != generation {
                    return;
                }
                rem.note_error(&why);
            }
            thread::sleep(Duration::from_millis(backoff));
            backoff = (backoff * 2).min(BACKOFF_MAX_MS);
            continue;
        }

        backoff = BACKOFF_MIN_MS;
        {
            let mut rem = lock(&kernel);
            if rem.generation != generation {
                return;
            }
            rem.note_ok();
        }

        let updates = match parsed.as_ref().and_then(|b| b.get("result").cloned()) {
            Some(Value::Arr(rows)) => rows,
            // `ok: true` with no array is malformed, not fatal.
            _ => Vec::new(),
        };
        for u in updates {
            handle_update(&kernel, generation, &token, &u);
        }
    }
}

/// ONE UPDATE. Every failure here is "ignore it and keep polling" — a malformed
/// row, a missing chat, a sticker, an id already acted on. None of them may stop
/// the adapter.
fn handle_update(kernel: &Arc<Kernel>, generation: u64, token: &str, u: &Value) {
    let update_id = match u.num("update_id") {
        Some(n) => n as i64,
        None => return,
    };

    // THE CURSOR MOVES WHETHER OR NOT THE MESSAGE WAS UNDERSTOOD. A sticker LAIN
    // cannot read must still be acknowledged, or Telegram redelivers it forever
    // and nothing else is ever seen.
    let duplicate = {
        let mut rem = lock(kernel);
        if rem.generation != generation {
            return;
        }
        let dup = rem.seen(update_id);
        rem.set_offset(update_id);
        dup
    };
    if duplicate {
        return;
    }

    let msg = match u.get("message") {
        Some(m) => m,
        None => return,
    };
    let chat = match msg.get("chat") {
        Some(c) => c,
        None => return,
    };
    let chat_id = match chat.num("id") {
        Some(n) => n as i64,
        None => return,
    };
    let text = msg.str("text");
    if text.trim().is_empty() {
        return;
    }
    let label = {
        let u = chat.str("username");
        if u.is_empty() { chat.str("first_name") } else { format!("@{u}") }
    };

    // ---- A SLOW LOCAL MODEL MUST NOT STOP THE POLL ------------------------
    //
    // A CPU-bound 7B answering a question can take half a minute. Handling it
    // inline would block every other message and delay the cursor, so each
    // message is answered on its own thread. Ordering between two messages sent
    // a second apart is not guaranteed and does not matter; the alternative is
    // a bot that goes silent whenever it is thinking.
    let k = kernel.clone();
    let tok = token.to_string();
    thread::spawn(move || {
        if let Some(reply) = respond(&k, chat_id, &label, &text) {
            send(&tok, chat_id, &reply);
        }
    });
}

fn send(token: &str, chat_id: i64, text: &str) {
    let body: String = if text.chars().count() > MAX_REPLY {
        let cut: String = text.chars().take(MAX_REPLY).collect();
        format!("{cut}\n… (truncated)")
    } else {
        text.to_string()
    };
    // Plain text. Markdown would mean escaping every underscore in every model
    // name and job id, and a formatting bug that eats a message is worse than a
    // message with no bold in it.
    let _ = http::call(token, "sendMessage", &[("chat_id", chat_id.to_string()), ("text", body)], 20);
}

// ---------------------------------------------------------------------------
// AUTHORIZATION, THEN ROUTING
// ---------------------------------------------------------------------------

/// The reply to one message, or `None` to stay silent.
///
/// Public because the integration tier drives it directly: exercising routing
/// and authorization without standing up a fake Telegram as well is worth the
/// one extra symbol.
pub fn respond(kernel: &Arc<Kernel>, chat_id: i64, label: &str, text: &str) -> Option<String> {
    let trimmed = text.trim();
    let first = trimmed.split_whitespace().next().unwrap_or("");
    // `/status@lain_remote_bot` — Telegram appends the bot name in groups.
    let cmd = first.split('@').next().unwrap_or("").to_ascii_lowercase();
    let rest = trimmed[first.len()..].trim().to_string();

    let authorized = lock(kernel).authorized(chat_id);

    // ---- PAIRING IS THE ONLY THING AN UNKNOWN CHAT MAY DO -----------------
    if cmd == "/pair" || cmd == "/start" {
        if authorized {
            return Some("This chat is already authorized.".to_string());
        }
        if cmd == "/start" || rest.is_empty() {
            return Some(
                "LAIN remote control.\n\nThis chat is not authorized yet. Run /rc in the LAIN \
                 terminal to get a pairing code, then send:\n\n/pair XXXX-XXXX"
                    .to_string(),
            );
        }
        let mut r = lock(kernel);
        return Some(match r.try_pair(&rest, chat_id, label) {
            None => format!("Authorized.\n\n{}", help()),
            // GENERIC ON PURPOSE: a guesser learns they were wrong and nothing
            // else — not whether a code is open, not how close they came.
            Some(why) => format!("Pairing failed: {why}."),
        });
    }

    if !authorized {
        // NOT ONE FACT ABOUT THE RUNTIME. Not a job name, not a model, not
        // whether LAIN is running at all. A sentence rather than silence,
        // because the person who most often lands here is the legitimate user.
        return Some(
            "This chat is not authorized. Run /rc in the LAIN terminal for a pairing code."
                .to_string(),
        );
    }

    if cmd == "/help" {
        return Some(help());
    }

    // ---- THE SHORT ROAD: A COMMAND IS A CAPABILITY ------------------------
    if let Some((_, name)) = DIRECT.iter().find(|(c, _)| *c == cmd) {
        let mut args = Value::obj();
        if *name == "session.continue" && !rest.is_empty() {
            // "carry on but skip the migration" is a better intent than
            // "continue", and there is no reason to discard it.
            args.set("intent", Value::s(&rest));
        }
        if *name == "session.list" && !rest.is_empty() {
            // `/session 2`, or `/session lain-v2`.
            return Some(session_detail(kernel, &rest));
        }
        // A CHAT THAT PAIRED MAY USE THE VERBS. That is what pairing means:
        // whoever holds it proved they were at the machine.
        return Some(capability::run(kernel, name, &args, true).text);
    }

    // ---- THE LONG ROAD: ENGLISH ------------------------------------------
    if cmd.starts_with('/') {
        return Some(format!("That is not a command.\n\n{}", help()));
    }
    let cfg = lock(kernel).brain();
    if !cfg.configured() {
        return Some(format!(
            "No local model is configured, so I can only answer commands.\n\
             Run /rc in the LAIN terminal to choose one.\n\n{}",
            help()
        ));
    }
    Some(brain::converse(kernel, &cfg, trimmed, true))
}

fn help() -> String {
    let mut t = String::from("Commands:\n");
    for (c, name) in DIRECT {
        let help = capability::lookup(name).map(|c| c.help).unwrap_or("");
        t.push_str(&format!("  {c}  — {help}\n"));
    }
    t.push_str("  /session N  — one conversation in detail\n");
    t.push_str("\nOr just ask in plain English.");
    t
}

/// `/session 2` and `/session lain-v2`.
fn session_detail(kernel: &Arc<Kernel>, want: &str) -> String {
    let mut args = Value::obj();
    // A NUMBER IS A POSITION IN THE LISTING, not an id. Resolved here rather
    // than in capability.rs, because the numbering is a property of how a
    // listing was drawn and the runtime should not carry a display index.
    if let Ok(n) = want.trim().parse::<usize>() {
        match capability::nth_session(kernel, n) {
            Some(id) => args.set("session", Value::s(&id)),
            None => return format!("There is no session {n}. Send /session for the list."),
        }
    } else {
        args.set("session", Value::s(want.trim()));
    }
    capability::run(kernel, "session.get", &args, true).text
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS — §13
// ---------------------------------------------------------------------------

/// WHAT IS WORTH INTERRUPTING SOMEBODY FOR.
///
/// Deliberately short. A phone that buzzes for every phase change is a phone
/// that gets muted, and a muted phone reports nothing at all — so this is the
/// list of things that either finished, broke, or need a person.
const NOTABLE: &[&str] = &[
    "JOB_COMPLETED",
    "JOB_FAILED",
    "JOB_ERROR",
    "JOB_DEADLINE_REACHED",
    "JOB_CANCELLED",
    "TURN_INTERRUPTED",
    "HANDOVER_CREATED",
    "MODEL_SWITCHED",
    "INPUT_HELD",
];

fn notify_loop(kernel: Arc<Kernel>, generation: u64) {
    loop {
        thread::sleep(Duration::from_millis(NOTIFY_EVERY_MS));
        let (token, chats, runtime_seq, jobs_seq, mine) = {
            let r = lock(&kernel);
            (
                r.token(),
                r.chats.keys().cloned().collect::<Vec<i64>>(),
                r.notified_runtime,
                r.notified_jobs,
                r.generation == generation && r.configured(),
            )
        };
        if !mine {
            return;
        }
        if chats.is_empty() {
            continue;
        }

        let dir = kernel.dir.clone();
        let runtime_events = crate::guardian::events_since(&dir, runtime_seq, 50);
        let job_events = crate::jobs::events_since(&dir, jobs_seq, 50);

        let mut highest_runtime = runtime_seq;
        let mut highest_jobs = jobs_seq;
        let mut lines = Vec::new();
        for e in runtime_events.iter().chain(job_events.iter()) {
            let seq = e.num("seq").unwrap_or(0.0) as usize;
            let from_jobs = e.get("job_id").is_some() || e.str("kind").starts_with("JOB_");
            if from_jobs {
                highest_jobs = highest_jobs.max(seq);
            } else {
                highest_runtime = highest_runtime.max(seq);
            }
            let kind = e.str("kind");
            if !NOTABLE.contains(&kind.as_str()) {
                continue;
            }
            lines.push(headline(e));
        }

        // THE CURSOR MOVES EVEN FOR EVENTS NOBODY IS TOLD ABOUT, or a quiet
        // stretch of phase changes would be re-read on every tick forever.
        {
            let mut r = lock(&kernel);
            if r.generation != generation {
                return;
            }
            r.note_notified(highest_runtime, highest_jobs);
        }

        if lines.is_empty() {
            continue;
        }
        // AT MOST A HANDFUL PER TICK. A machine that ran forty jobs while the
        // phone was off does not deserve forty messages.
        let shown: Vec<String> = lines.iter().take(6).cloned().collect();
        let more = lines.len().saturating_sub(shown.len());
        let mut text = shown.join("\n");
        if more > 0 {
            text.push_str(&format!("\n… and {more} more. Send /session for the current state."));
        }
        for chat in &chats {
            send(&token, *chat, &text);
        }
    }
}

/// ONE EVENT, IN A SENTENCE. States WHAT HAPPENED and never why — the why is a
/// judgement, and an event log entry is not evidence for one.
fn headline(e: &Value) -> String {
    let kind = e.str("kind");
    let detail = e.get("detail").cloned().unwrap_or_else(Value::obj);
    match kind.as_str() {
        "JOB_COMPLETED" => {
            let code = detail.num("exit_code").or_else(|| e.num("exit_code"));
            match code {
                Some(c) if c == 0.0 => format!("worker finished: {}", short(e)),
                Some(c) => format!("worker finished with exit {}: {}", c as i64, short(e)),
                // NOT "exit 0". Nothing reported a code.
                None => format!("worker finished: {}", short(e)),
            }
        }
        "JOB_FAILED" | "JOB_ERROR" => format!("worker failed: {}", short(e)),
        "JOB_CANCELLED" => format!("worker cancelled: {}", short(e)),
        "JOB_DEADLINE_REACHED" => format!(
            "worker reached its deadline and is still running: {}\n\
             (the runtime does not guess what it would have produced)",
            short(e)
        ),
        "TURN_INTERRUPTED" => format!("a turn did not finish — {}", detail.str("reason")),
        "HANDOVER_CREATED" => format!("a handover is owed — {}", detail.str("reason")),
        "MODEL_SWITCHED" => format!("model changed: {} → {}", detail.str("from"), detail.str("to")),
        "INPUT_HELD" => "a message was held rather than sent into a broken turn".to_string(),
        other => other.to_string(),
    }
}

fn short(e: &Value) -> String {
    let d = e.get("detail").cloned().unwrap_or_else(Value::obj);
    let cmd = if !d.str("command").is_empty() { d.str("command") } else { e.str("command") };
    if cmd.is_empty() {
        e.str("job_id")
    } else {
        cmd.chars().take(60).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_short_road_reaches_only_listed_capabilities() {
        for (cmd, name) in DIRECT {
            assert!(cmd.starts_with('/'), "{cmd} is not a command");
            assert!(
                capability::lookup(name).is_some(),
                "{cmd} maps to {name}, which is not in the capability catalog"
            );
        }
    }

    #[test]
    fn no_command_can_reach_a_shell() {
        let all: String = DIRECT.iter().map(|(c, n)| format!("{c}{n}")).collect();
        for banned in ["exec", "shell", "eval", "bash", "cmd", "spawn", "file", "read", "write"] {
            assert!(!all.contains(banned), "{banned} must not be reachable from a chat");
        }
    }

    #[test]
    fn notifications_are_the_things_that_finished_broke_or_need_a_person() {
        // A phase change is not notable: a phone that buzzes constantly is muted.
        assert!(!NOTABLE.contains(&"TURN_STARTED"));
        assert!(!NOTABLE.contains(&"INPUT_DELIVERED"));
        assert!(NOTABLE.contains(&"JOB_COMPLETED"));
        assert!(NOTABLE.contains(&"HANDOVER_CREATED"));
    }

    #[test]
    fn a_deadline_headline_never_claims_a_result() {
        let mut e = Value::obj();
        e.set("kind", Value::s("JOB_DEADLINE_REACHED"));
        let mut d = Value::obj();
        d.set("command", Value::s("npm test"));
        e.set("detail", d);
        let line = headline(&e);
        assert!(line.contains("deadline"));
        assert!(line.contains("does not guess"));
        assert!(!line.contains("passed"));
    }

    #[test]
    fn verify_refuses_a_malformed_token_without_touching_the_network() {
        let e = verify("obviously not a token").unwrap_err();
        assert!(e.contains("not a Telegram bot token"));
        assert!(!e.contains("obviously"), "the rejected value is not quoted back");
    }

    #[test]
    fn a_long_answer_is_cut_visibly() {
        let long = "x".repeat(MAX_REPLY + 500);
        let cut: String = long.chars().take(MAX_REPLY).collect();
        let shown = format!("{cut}\n… (truncated)");
        assert!(shown.contains("truncated"));
        assert!(shown.chars().count() < 4096);
    }
}
