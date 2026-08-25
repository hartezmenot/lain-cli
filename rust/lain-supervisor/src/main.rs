//! LAIN SUPERVISOR — the part of LAIN that is still running when LAIN is not.
//!
//! ------------------------------------------------------------------------
//! THE ONE JOB. A background worker in LAIN lives on `app._jobs`, in memory, on
//! the App object. It survives a failed turn and dies with the process, and it
//! appears in no session state, so a suite that finished thirty seconds after
//! LAIN crashed finished for nobody. This process owns those workers instead.
//! LAIN exiting closes a socket; closing a socket does not signal anybody's
//! children, so the work continues and its result is on disk when LAIN returns.
//!
//! ------------------------------------------------------------------------
//! WHY A SOCKET AND NOT THE EXISTING STDIO SEAM.
//!
//! `mcp.js` speaks JSON lines over a child's stdio, and that seam is the right
//! shape for the desktop bridge — but stdio pipes belong to the spawn. A NEW
//! LAIN process cannot reattach to the stdin of a child some earlier process
//! started, which makes reconnect-after-restart structurally impossible over
//! that transport, and reconnect is the entire requirement here.
//!
//! So: the same JSON-lines PROTOCOL, over a loopback socket, discovered through
//! a small file under LAIN's config home — which is the convention `dash.js` and
//! `instances.js` already use for exactly this problem, down to trusting the pid
//! over the file. Nothing new was invented; the transport was changed to one
//! that can be re-entered.
//!
//! ------------------------------------------------------------------------
//! THE SECOND THING THAT MUST OUTLIVE A LAIN PROCESS: PROVIDER HEALTH.
//!
//! A background job and a rate limit look like unrelated subjects and are the
//! same subject — a fact with a future in it, learned by a process that is
//! about to stop existing. `availability.js` holds provider health in a `Map`
//! on the App object, which is right for a circuit breaker and wrong for a
//! limit that a provider said would clear in four hours: restart LAIN and the
//! limit is forgotten, so the next turn calls the closed route and pays for the
//! same discovery again. So `providers.rs` keeps that here, next to the jobs,
//! for the same reason and with the same refusal to guess.
//!
//! ------------------------------------------------------------------------
//! WHAT IT IS NOT. It does not reason, plan, summarise, or talk to a model. It
//! starts processes, watches them, and reports what it saw. Every question it
//! answers is a question about a pid, an exit code, or a status line a provider
//! sent, and where it does not know the answer it says `unknown` — see jobs.rs,
//! and see `reset_at: null` in providers.rs, which is the same refusal wearing
//! different clothes.

mod brain;
mod capability;
mod guardian;
mod http;
mod jobs;
mod json;
mod projects;
mod providers;
mod remote;
mod telegram;

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process;
use std::sync::{Arc, Mutex};
use std::thread;

use guardian::Guardian;
use jobs::Registry;
use json::Value;
use projects::Projects;
use providers::Providers;
use remote::Remote;

const VERSION: &str = "0.4.0";

/// THE RUNTIME'S AUTHORITATIVE STATE, in one place so there is exactly one.
///
/// FIVE LOCKS, NOT ONE, and that is the point of the struct rather than an
/// accident of it. `refresh_all` walks every job and shells out per pid; holding
/// a single kernel lock across that would make every provider note wait behind a
/// process scan it has nothing to do with — and the provider note happens on the
/// failure path of a model request, which is the worst possible moment to add
/// latency.
///
/// The Guardian is separate because `guardian_input` is asked on the keystroke
/// that submits a line, and making a person's Enter key wait behind a scan of
/// every background job is the one latency nobody would forgive. The remote
/// adapter is separate because it parks in a 25-second long poll and its local
/// model can take half a minute to answer. Projects is separate because opening
/// one happens on the first keystroke of a session.
pub struct Kernel {
    pub jobs: Mutex<Registry>,
    pub providers: Mutex<Providers>,
    pub guardian: Mutex<Guardian>,
    pub remote: Mutex<Remote>,
    /// WHICH TREES THIS MACHINE HAS SEEN. Identity and a digest — never the
    /// project index itself, which lives in `<project>/.lain` because it
    /// describes the project rather than this computer. See projects.rs.
    pub projects: Mutex<Projects>,
    /// Where the event log lives. Held here so an event can be appended without
    /// taking a lock on the state it is describing.
    pub dir: PathBuf,
}

fn home() -> PathBuf {
    // The same home LAIN's config.js uses. LAIN_HOME is honoured first so a test
    // can run a private supervisor without touching the user's real one.
    if let Ok(h) = std::env::var("LAIN_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    let base = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join(".lain-v2")
}

fn state_dir() -> PathBuf {
    home().join("supervisor")
}

fn endpoint_file() -> PathBuf {
    state_dir().join("endpoint.json")
}

/// Is a supervisor already serving? The pid is the truth and the file is a hint,
/// exactly as in `instances.js` — pointing a client at a port that now belongs
/// to something else is the one failure this must not have.
fn existing() -> Option<(u32, u16)> {
    let text = std::fs::read_to_string(endpoint_file()).ok()?;
    let v = json::parse(&text)?;
    let pid = v.num("pid")? as u32;
    let port = v.num("port")? as u16;
    if !jobs::alive(pid) {
        return None;
    }
    Some((pid, port))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("serve");
    match cmd {
        // Print where a supervisor is, if one is. Used by the Node client to
        // decide whether it needs to start one, without opening a socket.
        "where" => {
            match existing() {
                Some((pid, port)) => {
                    let mut v = Value::obj();
                    v.set("running", Value::Bool(true));
                    v.set("pid", Value::n(pid as i64));
                    v.set("port", Value::n(port as i64));
                    println!("{}", json::write(&v));
                }
                None => {
                    let mut v = Value::obj();
                    v.set("running", Value::Bool(false));
                    println!("{}", json::write(&v));
                }
            }
        }
        _ => serve(),
    }
}

fn serve() {
    // ALREADY RUNNING IS A SUCCESS, not an error. Two LAINs starting at once
    // must converge on one supervisor rather than race to own the file.
    if let Some((pid, port)) = existing() {
        let mut v = Value::obj();
        v.set("running", Value::Bool(true));
        v.set("pid", Value::n(pid as i64));
        v.set("port", Value::n(port as i64));
        v.set("note", Value::s("a supervisor was already serving; this one exited"));
        println!("{}", json::write(&v));
        return;
    }

    let dir = state_dir();
    let _ = std::fs::create_dir_all(&dir);

    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("lain-supervisor: could not bind loopback: {e}");
            process::exit(1);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let pid = process::id();

    let mut ep = Value::obj();
    ep.set("pid", Value::n(pid as i64));
    ep.set("port", Value::n(port as i64));
    ep.set("version", Value::s(VERSION));
    ep.set("started_at", Value::n(jobs::now() as i64));
    let tmp = dir.join("endpoint.tmp");
    if std::fs::write(&tmp, json::write(&ep).as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, endpoint_file());
    }

    // Announced on stdout so a parent that wants to wait for readiness can, and
    // so `where` and this agree about the shape.
    println!("{}", json::write(&ep));
    let _ = std::io::stdout().flush();

    let kernel = Arc::new(Kernel {
        jobs: Mutex::new(Registry::open(dir.clone())),
        providers: Mutex::new(Providers::open(dir.clone())),
        guardian: Mutex::new(Guardian::open(dir.clone())),
        remote: Mutex::new(Remote::open(dir.clone())),
        projects: Mutex::new(Projects::open(dir.clone())),
        dir,
    });

    // ---- THE ADAPTER COMES UP WITH THE RUNTIME, NOT WITH THE CLI ------------
    //
    // A credential stored yesterday means the bot should be listening today,
    // whether or not anybody has opened a terminal. That is what makes it a
    // runtime service rather than a feature of a session: it does not depend on
    // a model request, a Node event loop, or a turn. It does nothing when
    // nothing is configured, and reports UNAVAILABLE rather than retrying
    // forever when the machine cannot speak HTTPS at all.
    telegram::supervise(kernel.clone());

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let k = kernel.clone();
                // A client per thread. There are never many, and a client that
                // hangs must not stop the others being served.
                thread::spawn(move || handle(s, k));
            }
            Err(_) => continue,
        }
    }
}

fn handle(stream: TcpStream, kernel: Arc<Kernel>) {
    let peer = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut out = stream;
    let reader = BufReader::new(peer);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let reply = respond(&line, &kernel);
        if writeln!(out, "{}", json::write(&reply)).is_err() {
            break;
        }
        let _ = out.flush();
        // A client that asked us to stop gets its answer first.
        if reply.str("op") == "shutdown" {
            process::exit(0);
        }
    }
    // THE CLIENT LEAVING IS NOT AN EVENT. No job is touched here, and that
    // omission is the feature: LAIN disconnecting is precisely the case where
    // the work must carry on.
}

fn err(op: &str, why: &str) -> Value {
    let mut v = Value::obj();
    v.set("ok", Value::Bool(false));
    v.set("op", Value::s(op));
    v.set("error", Value::s(why));
    v
}

fn respond(line: &str, kernel: &Arc<Kernel>) -> Value {
    // A MALFORMED MESSAGE IS A REPLY, NEVER A CRASH. Bad input must not reach
    // authoritative state, and it must not take the supervisor with it.
    let req = match json::parse(line) {
        Some(v) => v,
        None => return err("", "malformed JSON line"),
    };
    let op = req.str("op");

    // PROVIDER OPS TAKE ONLY THE PROVIDER LOCK. See Kernel: a health note lands
    // on the failure path of a model request and must not queue behind a job
    // scan.
    if op.starts_with("provider_") {
        let mut p = match kernel.providers.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        return provider_op(&op, &req, &mut p);
    }

    // REMOTE AND CAPABILITY OPS TAKE NO LOCK HERE, deliberately rather than by
    // oversight: `remote_connect` makes a NETWORK CALL to prove a token, and a
    // capability reads several stores in turn. Taking one lock at the top would
    // serialise the terminal behind a timeout. Each arm locks what it needs for
    // as long as it needs it.
    if op.starts_with("remote_") || op == "capability" {
        return remote_op(&op, &req, kernel);
    }

    // ---- THE MODEL BOUNDARY ------------------------------------------------
    //
    // Two stores, so it cannot take one lock at the top: whether a route is shut
    // is the provider store's, and whether the turn is still owned is the
    // Guardian's. Taken in that order, briefly, and never held across the other.
    if op.starts_with("request_") {
        return request_op(&op, &req, kernel);
    }

    // PROJECT BOOKKEEPING TAKES ONLY ITS OWN LOCK. Opening a project happens on
    // the first keystroke of a session, and must not queue behind a job scan.
    if op.starts_with("project_") {
        let mut p = match kernel.projects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        return project_op(&op, &req, &mut p);
    }

    // GUARDIAN OPS TAKE ONLY THE GUARDIAN LOCK, for the reason in `Kernel`: the
    // input gateway sits on a keystroke.
    if op.starts_with("guardian_") {
        let mut g = match kernel.guardian.lock() {
            Ok(x) => x,
            Err(e) => e.into_inner(),
        };
        return guardian_op(&op, &req, &mut g, &kernel.dir);
    }

    let mut reg = match kernel.jobs.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };

    match op.as_str() {
        "ping" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("ping"));
            v.set("pid", Value::n(process::id() as i64));
            v.set("version", Value::s(VERSION));
            v
        }
        "submit" => {
            let command = req.str("command");
            if command.is_empty() {
                return err("submit", "submit needs a command");
            }
            // THE DEADLINE IS THE JOB'S, not the request's. See Job::deadline_at.
            let deadline_secs = req.num("deadline_secs").unwrap_or(0.0).max(0.0) as u64;
            let job = reg.submit(
                &req.str("request_id"),
                &req.str("session"),
                &command,
                &req.str("shell"),
                &req.str("cwd"),
                deadline_secs,
            );
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("submit"));
            v.set("job", job.to_value());
            v
        }
        "status" => {
            let id = req.str("job_id");
            reg.refresh(&id);
            match reg.jobs.get(&id) {
                Some(j) => {
                    let mut v = Value::obj();
                    v.set("ok", Value::Bool(true));
                    v.set("op", Value::s("status"));
                    v.set("job", j.to_value());
                    v
                }
                None => err("status", "no such job"),
            }
        }
        "list" => {
            reg.refresh_all();
            let session = req.str("session");
            let mut arr: Vec<Value> = Vec::new();
            for j in reg.jobs.values() {
                if !session.is_empty() && j.session != session {
                    continue;
                }
                arr.push(j.to_value());
            }
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("list"));
            v.set("jobs", Value::Arr(arr));
            v
        }
        // WHAT HAS HAPPENED SINCE YOU LAST LOOKED. The reconnect path for
        // reasoning: a job may have finished, failed or run out its window while
        // no LAIN was running at all.
        "events" => {
            let after = req.num("after").unwrap_or(0.0).max(0.0) as usize;
            let limit = req.num("limit").unwrap_or(50.0).max(1.0) as usize;
            let dir = reg.dir.clone();
            let rows = jobs::events_since(&dir, after, limit);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("events"));
            v.set("events", Value::Arr(rows));
            v
        }
        "cancel" => {
            let id = req.str("job_id");
            match reg.cancel(&id) {
                Some(j) => {
                    let mut v = Value::obj();
                    v.set("ok", Value::Bool(true));
                    v.set("op", Value::s("cancel"));
                    v.set("job", j.to_value());
                    v
                }
                None => err("cancel", "no such job"),
            }
        }
        "shutdown" => {
            // Only ever used by tests and by an explicit operator action. A
            // running worker is NOT killed — it is this process that stops.
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("shutdown"));
            v
        }
        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// PROVIDER HEALTH OVER THE WIRE.
///
/// Four ops, and the split between them is a trust boundary in miniature.
/// `provider_note` is an OBSERVATION — a request happened and this is how it
/// went — and it is the only way a machine may change this state.
/// `provider_set` and `provider_clear` are DECISIONS, and only a person makes
/// those. A model asking to mark a route available is asking to manufacture
/// "verified", which is the one thing the runtime does not do on request.
fn provider_op(op: &str, req: &Value, p: &mut Providers) -> Value {
    let now = providers::now_ms();
    let id = req.str("connection_id");
    // AN EMPTY ID IS A BUG IN THE CALLER, not a route called "". Recorded under
    // a blank key it would collect every unattributable failure in the process
    // into one row and then report it as a real closed door.
    let needs_id = |op: &str| -> Option<Value> {
        if id.is_empty() { Some(err(op, "needs a connection_id")) } else { None }
    };

    match op {
        // A REQUEST HAPPENED. `ok` says how it went; `kind` is the classified
        // failure, so the store can tell a limit from a breaker from an auth
        // problem without re-parsing anybody's error text.
        "provider_note" => {
            if let Some(e) = needs_id(op) { return e; }
            let ok = matches!(req.get("ok"), Some(json::Value::Bool(true)));
            // `reset_at` ABSENT AND `reset_at: 0` MEAN THE SAME THING HERE and
            // both mean "nobody said". Only a real future timestamp becomes a
            // countdown — see providers.rs, which will not invent one.
            let reset_at = match req.num("reset_at") {
                Some(n) if n > 0.0 => Some(n as u64),
                _ => None,
            };
            let threshold = req.num("failure_threshold").unwrap_or(0.0) as u32;
            let h = p.note(
                &id,
                ok,
                &req.str("kind"),
                &req.str("reason"),
                &req.str("provider"),
                &req.str("model"),
                reset_at,
                if threshold > 0 { threshold } else { providers::FAILURE_THRESHOLD },
            );
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("health", h.to_value(now));
            v
        }
        // EVERY ROUTE THIS MACHINE KNOWS ABOUT. The reconnect path for provider
        // state: a brand-new LAIN asks once at startup and is told which doors
        // were shut while it did not exist, and until when.
        "provider_list" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("now", Value::n(now as i64));
            v.set("providers", Value::Arr(p.all(now)));
            v
        }
        // A DECISION A PERSON MADE. `/provider disable`, `/provider maintenance`.
        "provider_set" => {
            if let Some(e) = needs_id(op) { return e; }
            let status = providers::Status::from_str(&req.str("status"));
            let h = p.set(&id, status, &req.str("reason"));
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("health", h.to_value(now));
            v
        }
        // `/provider retry` — back to knowing nothing. `forget: true` removes
        // the row entirely, for a connection that is gone from the config.
        "provider_clear" => {
            if let Some(e) = needs_id(op) { return e; }
            if matches!(req.get("forget"), Some(Value::Bool(true))) {
                let existed = p.forget(&id);
                let mut v = Value::obj();
                v.set("ok", Value::Bool(true));
                v.set("op", Value::s(op));
                v.set("forgotten", Value::Bool(existed));
                return v;
            }
            let h = p.clear(&id);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("health", h.to_value(now));
            v
        }
        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// THE MODEL BOUNDARY OVER THE WIRE.
///
/// ------------------------------------------------------------------------
/// WHAT THIS IS FOR, stated plainly because the honest version matters.
///
/// The bytes of a model request do not pass through this process. `provider.js`
/// still builds the payload and still opens the socket, because the streaming
/// SSE path and the TLS behind it are provider-specific and working, and moving
/// them here would be a rewrite with no user-visible gain.
///
/// What passes through here is the LIFECYCLE. Every request is admitted before
/// it is made and closed after, and it carries an id issued here. That is the
/// difference between Node being an ADAPTER — which may speak a protocol, but
/// may not decide whether a request happens — and Node being a second authority
/// that can start a turn the runtime knows nothing about.
///
/// AND IT CAN REFUSE. Two cases, both of them things only this process knows:
/// a turn whose owning process is gone, and a route the runtime recorded as
/// shut with a reset still in the future. The second is checked here rather
/// than in each surface, so there is one answer to "is this door open".
///
/// A REQUEST THAT WAS NEVER ADMITTED IS A BYPASS, and it is detectable: the
/// session carries the open id, so a client making a second request while one
/// is open, or making one with no id at all, is visible in the state rather
/// than being a convention somebody has to remember.
fn request_op(op: &str, req: &Value, kernel: &Arc<Kernel>) -> Value {
    let session = req.str("session");
    if session.is_empty() {
        return err(op, "needs a session");
    }
    match op {
        "request_begin" => {
            // ---- IS THE DOOR OPEN? --------------------------------------
            //
            // Asked of the provider store FIRST and released immediately: the
            // Guardian lock is taken on a keystroke and must never wait behind
            // this one.
            let connection = req.str("connection_id");
            let shut = if connection.is_empty() {
                String::new()
            } else {
                let now = providers::now_ms();
                let p = match kernel.providers.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                p.all(now)
                    .into_iter()
                    .find(|r| r.str("id") == connection)
                    .and_then(|r| {
                        // A LIMIT WITH A FUTURE RESET IS EVIDENCE. A limit with
                        // no stated reset is not a clock, and refusing on it
                        // would strand a session on a route that may already be
                        // open — see providers.rs on why null is not zero.
                        let limited = matches!(r.get("limited_now"), Some(Value::Bool(true)));
                        let resets = r.num("resets_in_ms").unwrap_or(0.0);
                        if limited && resets > 0.0 {
                            Some(format!(
                                "{} is rate limited for another {}m",
                                r.str("id"),
                                ((resets as u64) / 60_000).max(1)
                            ))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default()
            };

            let mut g = match kernel.guardian.lock() {
                Ok(x) => x,
                Err(e) => e.into_inner(),
            };
            let (allow, id, why, s) = g.request_begin(&session, &shut);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("allow", Value::Bool(allow));
            v.set("request_id", Value::s(&id));
            v.set("reason", Value::s(&why));
            v.set("state", s.snapshot());
            v
        }
        "request_end" => {
            let mut g = match kernel.guardian.lock() {
                Ok(x) => x,
                Err(e) => e.into_inner(),
            };
            // THE COST TRAVELS WITH THE ENDING, so a reader that sees a request
            // close already has the bill for it. `usage_note` accumulates when
            // `live` is absent — see guardian.rs on why those are two operations.
            if req.get("input_tokens").is_some() || req.get("output_tokens").is_some() {
                g.usage_note(&session, req);
            }
            let s = g.request_end(&session, &req.str("request_id"));
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("state", s.snapshot());
            v
        }
        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// PROJECTS OVER THE WIRE.
///
/// THE SPLIT THIS ENFORCES, and it is the whole reason these ops exist:
///
///     ~/.lain-v2        identity, and when the runtime last synchronised a tree
///     <project>/.lain   the materialised index: symbols, imports, per file
///
/// `project_open` answers "have I seen this tree, and has it moved" WITHOUT
/// READING ANYTHING — the caller supplies the digest its worker computed, and
/// this compares it with what was recorded. `project_synced` is the only way
/// that record moves, and it carries counts and a digest rather than an index:
/// a symbol table here would be a second copy of the project's own, and a
/// second authority for the same truth.
fn project_op(op: &str, req: &Value, p: &mut Projects) -> Value {
    let path = req.str("path");
    if path.is_empty() {
        return err(op, "needs a project path");
    }
    match op {
        "project_open" => {
            let (verdict, pr) = p.open_project(
                &path,
                &req.str("digest"),
                req.num("index_version").unwrap_or(0.0).max(0.0) as u64,
            );
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            // NEW | UNCHANGED | MODIFIED | RESHAPED — the synchronisation
            // decision, made by the runtime and acted on by the worker.
            v.set("verdict", Value::s(&verdict));
            v.set("project", pr.to_value());
            v
        }
        "project_synced" => {
            let pr = p.synced(
                &path,
                &req.str("digest"),
                req.num("index_version").unwrap_or(0.0).max(0.0) as u64,
                req.num("files").unwrap_or(0.0).max(0.0) as u64,
                req.num("symbols").unwrap_or(0.0).max(0.0) as u64,
                &req.str("result"),
            );
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("project", pr.to_value());
            v
        }
        "project_list" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("projects", Value::Arr(p.all()));
            v
        }
        "project_forget" => {
            let existed = p.forget(&path);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("forgotten", Value::Bool(existed));
            v
        }
        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// REMOTE CONTROL OVER THE WIRE.
///
/// NOT ONE OP RETURNS A CREDENTIAL. There is no `remote_token`, no
/// `include_secret`, no debug variant — `Remote::snapshot` is the only
/// projection and it cannot carry one, so a client that wanted to leak the bot
/// token would have to be rewritten rather than merely misconfigured.
///
/// THE ONE OP THAT RECEIVES A TOKEN is `remote_connect`, and what it does with
/// it is the point: the value is proved against Telegram BEFORE being written
/// anywhere, so a typo is never persisted and never reported as a working
/// connection. The request line carrying it is never logged — the event below
/// carries the bot's public username and nothing else.
///
/// `capability` IS HERE RATHER THAN IN ITS OWN FAMILY because it is the same
/// subject: it is how a client that is not a chat — the terminal's `/session`,
/// and a dashboard later — reaches the identical bounded vocabulary the remote
/// surface reaches. One vocabulary, one validation, several windows.
fn remote_op(op: &str, req: &Value, kernel: &Arc<Kernel>) -> Value {
    let lock = || match kernel.remote.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let snapshot = |op: &str| -> Value {
        let mut v = Value::obj();
        v.set("ok", Value::Bool(true));
        v.set("op", Value::s(op));
        v.set("remote", lock().snapshot());
        v
    };

    match op {
        // ---- THE ONE DOOR EVERY SURFACE USES -----------------------------
        //
        // `allow_control` is the CALLER'S authority and never the request's
        // claim about itself. A local client on the loopback socket has already
        // proved more than any remote chat can — it is running as the user, on
        // the user's machine — so the terminal gets the verbs. A chat gets them
        // only after pairing, and that check lives in telegram.rs where the
        // chat id is known.
        "capability" => {
            let name = req.str("name");
            if name.is_empty() {
                return err(op, "needs a capability name");
            }
            let args = req.get("args").cloned().unwrap_or_else(Value::obj);
            let allow_control = !matches!(req.get("read_only"), Some(Value::Bool(true)));
            let outcome = capability::run(kernel, &name, &args, allow_control);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(outcome.ok));
            v.set("op", Value::s(op));
            v.set("capability", Value::s(&outcome.name));
            // BOTH RENDERINGS, from the same read — see capability.rs. A client
            // that draws its own table and one that prints the text cannot end
            // up describing different runtimes.
            v.set("text", Value::s(&outcome.text));
            v.set("result", outcome.value);
            v
        }

        "remote_status" => snapshot(op),

        "remote_connect" => {
            let token = req.str("token");
            if token.trim().is_empty() {
                return err(op, "no token was given");
            }
            // ---- PROVED FIRST, STORED SECOND, AND OUTSIDE THE LOCK --------
            let identity = match telegram::verify(token.trim()) {
                Ok(i) => i,
                // Telegram's own words, already scrubbed by http.rs. Nothing is
                // stored, so a bad token leaves no trace at all.
                Err(why) => return err(op, &why),
            };
            let code = {
                let mut r = lock();
                r.connect(token.trim(), identity);
                // A CREDENTIAL IS NOT AN AUTHORIZATION. The code is minted here
                // so the terminal shows it in the same breath as the success —
                // the one moment the user is certainly looking at the screen.
                r.new_pairing()
            };
            telegram::supervise(kernel.clone());
            let mut d = Value::obj();
            // THE USERNAME, WHICH IS PUBLIC. Never the token, never a chat id.
            d.set("bot", Value::s(&lock().identity.username));
            guardian::append_event(&kernel.dir, "REMOTE_CONNECTED", "", &d);
            let mut v = snapshot(op);
            v.set("pairing_code", Value::s(&code));
            v
        }

        // WHICH LOCAL MODEL SPEAKS. Separate from the credential on purpose:
        // choosing a voice is not connecting a bot, and either may be changed
        // without disturbing the other.
        "remote_brain" => {
            {
                let mut r = lock();
                r.set_brain(&req.str("base_url"), &req.str("model"), &req.str("key"));
            }
            snapshot(op)
        }

        "remote_disconnect" => {
            let removed = lock().disconnect();
            guardian::append_event(&kernel.dir, "REMOTE_DISCONNECTED", "", &Value::obj());
            let mut v = snapshot(op);
            v.set("removed", Value::Bool(removed));
            v
        }

        "remote_reconnect" => {
            {
                let mut r = lock();
                if !r.configured() {
                    return err(op, "nothing is connected");
                }
                r.reconnect();
            }
            telegram::supervise(kernel.clone());
            snapshot(op)
        }

        // A FRESH CODE, for a user who let one expire or is adding a second
        // device. Minting one does not revoke an existing authorization.
        "remote_pair_code" => {
            let code = {
                let mut r = lock();
                if !r.configured() {
                    return err(op, "nothing is connected");
                }
                r.new_pairing()
            };
            let mut v = snapshot(op);
            v.set("pairing_code", Value::s(&code));
            v
        }

        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// THE GUARDIAN OVER THE WIRE.
///
/// Every op here is one of two shapes, and the split is the same trust boundary
/// providers.rs draws. `turn_*` and `usage` are OBSERVATIONS: Node reporting
/// something that happened in a process this one can watch die. `input` is the
/// only op that ASKS A QUESTION rather than stating a fact, and its answer is
/// the one thing in LAIN a model may not overrule.
///
/// A `session` is required on all of them for the same reason a `connection_id`
/// is required on a provider note: recorded under a blank key, every session on
/// the machine collects into one row that is then reported as real state.
fn guardian_op(op: &str, req: &Value, g: &mut Guardian, dir: &PathBuf) -> Value {
    let session = req.str("session");
    if session.is_empty() && op != "guardian_events" && op != "guardian_list" {
        return err(op, "needs a session");
    }

    // Every reply carries the session snapshot, so a client never has to make a
    // second call to find out what its own call did.
    fn reply(op: &str, s: &guardian::Sess) -> Value {
        let mut v = Value::obj();
        v.set("ok", Value::Bool(true));
        v.set("op", Value::s(op));
        v.set("state", s.snapshot());
        v
    }

    match op {
        "guardian_turn_begin" => {
            let before = g.get(&session).map(|s| s.model.clone()).unwrap_or_default();
            let s = g.turn_begin(
                &session,
                &req.str("turn_id"),
                &req.str("model"),
                &req.str("provider"),
                &req.str("connection_id"),
                req.num("owner_pid").unwrap_or(0.0).max(0.0) as u32,
            );
            let mut d = Value::obj();
            d.set("turn_id", Value::s(&s.turn_id));
            d.set("model", Value::s(&s.model));
            guardian::append_event(dir, "TURN_STARTED", &session, &d);
            // A MODEL SWITCH IS ITS OWN EVENT, because a person reading the log
            // to understand a bad handover needs to SEE the boundary rather than
            // infer it from two turns with different model names.
            if !before.is_empty() && before != s.model {
                let mut m = Value::obj();
                m.set("from", Value::s(&before));
                m.set("to", Value::s(&s.model));
                guardian::append_event(dir, "MODEL_SWITCHED", &session, &m);
            }
            reply(op, &s)
        }
        "guardian_turn_phase" => {
            let s = g.turn_phase(&session, &req.str("phase"));
            // NOT LOGGED. A phase changes several times a second inside a busy
            // turn; writing each one would turn the event log into a spool and
            // make the interesting lines unfindable. The state file has it.
            reply(op, &s)
        }
        "guardian_turn_end" => {
            let outcome = req.str("outcome");
            let s = g.turn_end(&session, &outcome, &req.str("kind"), &req.str("reason"));
            let mut d = Value::obj();
            d.set("outcome", Value::s(&outcome));
            d.set("state", Value::s(s.state.as_str()));
            d.set("reason", Value::s(&s.failure_reason));
            let kind = if s.state.needs_handover() { "TURN_INTERRUPTED" } else { "TURN_COMPLETED" };
            guardian::append_event(dir, kind, &session, &d);
            reply(op, &s)
        }
        // THE GATEWAY.
        "guardian_input" => {
            let text = req.str("text");
            let (deliver, why, id, s) = g.offer(&session, &text, &req.str("kind"));
            let mut v = reply(op, &s);
            v.set("deliver", Value::Bool(deliver));
            v.set("reason", Value::s(&why));
            v.set("input_id", Value::s(&id));
            let mut d = Value::obj();
            d.set("reason", Value::s(&why));
            // THE TEXT IS NOT LOGGED, only how long it was. The event log is read
            // by people and by tools; a person's prompt is their business, and a
            // log that quietly accumulates it is a disclosure nobody agreed to.
            // The text lives in the state file, which exists to give it back.
            d.set("chars", Value::n(text.chars().count() as i64));
            guardian::append_event(dir, if deliver { "INPUT_DELIVERED" } else { "INPUT_HELD" }, &session, &d);
            v
        }
        // WHAT IS STILL WAITING — read WITHOUT taking it, so a client can build a
        // packet around it before committing to delivery.
        "guardian_pending" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            match g.get(&session) {
                Some(s) => {
                    let snap = s.snapshot();
                    v.set("held", snap.get("held").cloned().unwrap_or(Value::Arr(Vec::new())));
                    v.set("state", snap);
                }
                None => {
                    v.set("state", Value::Null);
                    v.set("held", Value::Arr(Vec::new()));
                }
            }
            v
        }
        // TAKE IT. The only call that empties the queue, and Node makes it at the
        // moment it is actually about to send.
        "guardian_deliver" => {
            let clear = !matches!(req.get("keep_handover"), Some(Value::Bool(true)));
            let (taken, s) = g.deliver(&session, clear);
            let mut v = reply(op, &s);
            let rows: Vec<Value> = taken
                .iter()
                .map(|h| {
                    let mut r = Value::obj();
                    r.set("id", Value::s(&h.id));
                    r.set("text", Value::s(&h.text));
                    r.set("kind", Value::s(&h.kind));
                    r.set("at", Value::n(h.at as i64));
                    r.set("reason", Value::s(&h.reason));
                    r
                })
                .collect();
            v.set("taken", Value::Arr(rows));
            if !taken.is_empty() {
                let mut d = Value::obj();
                d.set("count", Value::n(taken.len() as i64));
                guardian::append_event(dir, "INPUT_DELIVERED", &session, &d);
            }
            v
        }
        // WHAT THIS CONVERSATION IS CALLED, and where it is running. The CLI is
        // the only party that knows either; the runtime never guesses a name
        // from a path.
        "guardian_identify" => {
            let s = g.identify(&session, &req.str("name"), &req.str("cwd"));
            reply(op, &s)
        }
        // SOMEBODY COUNTED SOMETHING. A note with no `source` clears any stale
        // figure rather than storing an unattributable one — see `progress_note`.
        "guardian_progress" => {
            let s = g.progress_note(
                &session,
                req.num("done").unwrap_or(0.0).max(0.0) as u64,
                req.num("total").unwrap_or(0.0).max(0.0) as u64,
                &req.str("label"),
                &req.str("source"),
                &req.str("activity"),
            );
            reply(op, &s)
        }
        // SOMETHING WAS CHECKED. The only claim in the runtime that means
        // "done" the way a person means it.
        "guardian_verified" => {
            let s = g.verified_note(
                &session,
                &req.str("label"),
                req.num("passed").unwrap_or(0.0).max(0.0) as u64,
                req.num("failed").unwrap_or(0.0).max(0.0) as u64,
                &req.str("detail"),
            );
            let mut d = Value::obj();
            d.set("label", Value::s(&req.str("label")));
            d.set("passed", Value::n(req.num("passed").unwrap_or(0.0) as i64));
            d.set("failed", Value::n(req.num("failed").unwrap_or(0.0) as i64));
            guardian::append_event(dir, "SESSION_VERIFIED", &session, &d);
            reply(op, &s)
        }
        // THE ATTACHED CLI HONOURED A REMOTE STOP (or found nothing to honour).
        // Node clears the flag rather than the Guardian clearing it on read: a
        // flag cleared by the reader is lost by a client that read it and then
        // died before acting.
        "guardian_stop_clear" => {
            let s = g.clear_stop(&session);
            reply(op, &s)
        }
        // The CLI applied a requested model switch, or declined to.
        "guardian_model_clear" => {
            let s = g.clear_model_request(&session);
            reply(op, &s)
        }
        "guardian_handover_arm" => {
            let s = g.handover_arm(&session, &req.str("reason"));
            let mut d = Value::obj();
            d.set("reason", Value::s(&s.handover_reason));
            guardian::append_event(dir, "HANDOVER_CREATED", &session, &d);
            reply(op, &s)
        }
        "guardian_handover_done" => {
            let s = g.handover_done(&session);
            reply(op, &s)
        }
        // WHAT THE TURN COST. `live: true` REPLACES the live fields; otherwise
        // the totals ACCUMULATE — see `usage_note`, which explains why those are
        // two different operations rather than one with a flag.
        "guardian_usage" => {
            let s = g.usage_note(&session, req);
            reply(op, &s)
        }
        "guardian_state" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            match g.get(&session) {
                Some(s) => v.set("state", s.snapshot()),
                None => v.set("state", Value::Null),
            }
            v
        }
        "guardian_list" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("sessions", Value::Arr(g.all()));
            v
        }
        // WHAT HAPPENED WHILE NOBODY WAS REASONING — the runtime's own log,
        // separate from the job log because the two have different retention.
        "guardian_events" => {
            let after = req.num("after").unwrap_or(0.0).max(0.0) as usize;
            let limit = req.num("limit").unwrap_or(50.0).max(1.0) as usize;
            let rows = guardian::events_since(dir, after, limit);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("events", Value::Arr(rows));
            v
        }
        "guardian_forget" => {
            let existed = g.forget(&session);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s(op));
            v.set("forgotten", Value::Bool(existed));
            v
        }
        other => err(other, "unknown op"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jobs::State;

    fn kernel(tag: &str) -> Arc<Kernel> {
        let dir = std::env::temp_dir().join(format!("lain-sup-{tag}-{}", providers::now_ms()));
        Arc::new(Kernel {
            jobs: Mutex::new(Registry::open(dir.clone())),
            providers: Mutex::new(Providers::open(dir.clone())),
            guardian: Mutex::new(Guardian::open(dir.clone())),
            remote: Mutex::new(Remote::open(dir.clone())),
            projects: Mutex::new(Projects::open(dir.clone())),
            dir,
        })
    }

    #[test]
    fn an_unknown_op_is_answered_not_crashed() {
        let k = kernel("op");
        let v = respond("{\"op\":\"nonsense\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(v.str("error"), "unknown op");
    }

    #[test]
    fn a_malformed_line_is_answered_not_crashed() {
        // A bad message may not poison authoritative state, and it may not take
        // the supervisor down with it.
        let k = kernel("malformed");
        let v = respond("{not json at all", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(v.str("error"), "malformed JSON line");
    }

    #[test]
    fn submit_without_a_command_is_refused() {
        let k = kernel("submit");
        let v = respond("{\"op\":\"submit\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert!(v.str("error").contains("needs a command"));
    }

    #[test]
    fn an_unknown_provider_op_is_answered_not_crashed() {
        let k = kernel("provop");
        let v = respond("{\"op\":\"provider_nonsense\",\"connection_id\":\"x\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(v.str("error"), "unknown op");
    }

    #[test]
    fn a_note_without_a_connection_id_is_refused() {
        // Recorded under a blank key, every unattributable failure on the
        // machine collects into one row that is then reported as a real closed
        // door.
        let k = kernel("noid");
        let v = respond("{\"op\":\"provider_note\",\"ok\":false}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert!(v.str("error").contains("connection_id"));
    }

    #[test]
    fn state_words_round_trip() {
        for s in [State::Queued, State::Running, State::Completed, State::Failed, State::Cancelled] {
            assert_eq!(State::from_str(s.as_str()), s, "{} did not round trip", s.as_str());
        }
    }

    #[test]
    fn a_rate_limit_goes_in_and_comes_back_out_with_its_clock() {
        let k = kernel("limit");
        let reset = providers::now_ms() + 3_600_000;
        let line = format!(
            "{{\"op\":\"provider_note\",\"connection_id\":\"lain:x\",\"ok\":false,\"kind\":\"RATE_LIMITED\",\"reset_at\":{reset}}}"
        );
        let v = respond(&line, &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(true)));
        let listed = respond("{\"op\":\"provider_list\"}", &k);
        let rows = match listed.get("providers") {
            Some(Value::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let row = rows.iter().find(|r| r.str("id") == "lain:x").expect("the route is listed");
        assert_eq!(row.get("limited_now"), Some(&Value::Bool(true)));
        assert!(row.num("resets_in_ms").unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn a_limit_with_no_stated_reset_arrives_as_null_not_zero() {
        // NOT ZERO. Zero reads as "it clears now"; this is "nobody said".
        let k = kernel("noreset");
        respond(
            "{\"op\":\"provider_note\",\"connection_id\":\"lain:y\",\"ok\":false,\"kind\":\"RATE_LIMITED\"}",
            &k,
        );
        let listed = respond("{\"op\":\"provider_list\"}", &k);
        let rows = match listed.get("providers") {
            Some(Value::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let row = rows.iter().find(|r| r.str("id") == "lain:y").expect("the route is listed");
        assert_eq!(row.get("resets_in_ms"), Some(&Value::Null));
    }

    #[test]
    fn a_zero_reset_at_is_read_as_unstated_rather_than_as_the_epoch() {
        let k = kernel("zeroreset");
        respond(
            "{\"op\":\"provider_note\",\"connection_id\":\"lain:z\",\"ok\":false,\"kind\":\"RATE_LIMITED\",\"reset_at\":0}",
            &k,
        );
        let listed = respond("{\"op\":\"provider_list\"}", &k);
        let rows = match listed.get("providers") {
            Some(Value::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let row = rows.iter().find(|r| r.str("id") == "lain:z").expect("the route is listed");
        assert_eq!(row.get("resets_in_ms"), Some(&Value::Null));
    }

    #[test]
    fn a_disabled_route_stays_disabled_through_a_successful_request() {
        // A DECISION A PERSON MADE outranks an observation a machine made. A
        // request succeeding is not permission to undo `/provider disable`.
        let k = kernel("disabled");
        respond(
            "{\"op\":\"provider_set\",\"connection_id\":\"lain:d\",\"status\":\"DISABLED\",\"reason\":\"by hand\"}",
            &k,
        );
        respond("{\"op\":\"provider_note\",\"connection_id\":\"lain:d\",\"ok\":true}", &k);
        let listed = respond("{\"op\":\"provider_list\"}", &k);
        let rows = match listed.get("providers") {
            Some(Value::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let row = rows.iter().find(|r| r.str("id") == "lain:d").expect("the route is listed");
        assert_eq!(row.str("status"), "DISABLED");
    }

    #[test]
    fn clearing_a_route_is_a_decision_and_it_takes_the_countdown_with_it() {
        let k = kernel("clear");
        let reset = providers::now_ms() + 3_600_000;
        respond(
            &format!("{{\"op\":\"provider_note\",\"connection_id\":\"lain:c\",\"ok\":false,\"kind\":\"RATE_LIMITED\",\"reset_at\":{reset}}}"),
            &k,
        );
        respond("{\"op\":\"provider_clear\",\"connection_id\":\"lain:c\"}", &k);
        let listed = respond("{\"op\":\"provider_list\"}", &k);
        let rows = match listed.get("providers") {
            Some(Value::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let row = rows.iter().find(|r| r.str("id") == "lain:c").expect("the route is listed");
        assert_eq!(row.get("limited_now"), Some(&Value::Bool(false)));
        assert_eq!(row.get("resets_in_ms"), Some(&Value::Null));
    }

    #[test]
    fn forgetting_a_route_is_reported_honestly_the_second_time() {
        let k = kernel("forget");
        respond("{\"op\":\"provider_note\",\"connection_id\":\"lain:f\",\"ok\":true}", &k);
        let first = respond("{\"op\":\"provider_clear\",\"connection_id\":\"lain:f\",\"forget\":true}", &k);
        assert_eq!(first.get("forgotten"), Some(&Value::Bool(true)));
        let second = respond("{\"op\":\"provider_clear\",\"connection_id\":\"lain:f\",\"forget\":true}", &k);
        assert_eq!(second.get("forgotten"), Some(&Value::Bool(false)));
    }

    #[test]
    fn a_project_is_new_once_and_then_the_runtime_remembers_it() {
        // The two state domains meeting: the runtime keeps identity and a
        // digest; the index itself lives in the project's own `.lain`.
        let k = kernel("proj");
        let opened = respond("{\"op\":\"project_open\",\"path\":\"/tmp/demo\",\"index_version\":1}", &k);
        assert_eq!(opened.str("verdict"), "NEW");
        respond(
            "{\"op\":\"project_synced\",\"path\":\"/tmp/demo\",\"digest\":\"d1\",\"index_version\":1,\"files\":9,\"symbols\":80,\"result\":\"full\"}",
            &k,
        );
        let again = respond("{\"op\":\"project_open\",\"path\":\"/tmp/demo\",\"digest\":\"d1\",\"index_version\":1}", &k);
        assert_eq!(again.str("verdict"), "UNCHANGED");
        let moved = respond("{\"op\":\"project_open\",\"path\":\"/tmp/demo\",\"digest\":\"d2\",\"index_version\":1}", &k);
        assert_eq!(moved.str("verdict"), "MODIFIED");
    }

    #[test]
    fn a_project_op_without_a_path_is_refused() {
        let k = kernel("projnopath");
        let v = respond("{\"op\":\"project_open\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert!(v.str("error").contains("path"));
    }
}
