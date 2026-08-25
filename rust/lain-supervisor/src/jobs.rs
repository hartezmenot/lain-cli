//! THE JOB UNIVERSE, AND IT DOES NOT BELONG TO ANY LAIN PROCESS.
//!
//! ------------------------------------------------------------------------
//! WHY THIS EXISTS. In LAIN, `app._jobs` is an in-memory `Jobs` instance hanging
//! off the App object. It is never persisted and never appears in session state,
//! so a background worker survives a failed TURN and dies with the PROCESS — and
//! a suite that finishes thirty seconds after LAIN crashed finished for nobody.
//! Two handover requirements failed on exactly that: the replacement model could
//! not be told what a worker did, because nothing outlived the application to
//! watch it.
//!
//! So the registry lives here, in a process whose entire job is to still be
//! running. A worker is this supervisor's child, which is what actually makes it
//! survive: LAIN exiting closes a socket, and closing a socket does not signal
//! anybody's children.
//!
//! ------------------------------------------------------------------------
//! WHAT IT REFUSES TO DO. It never decides that a job succeeded. It records an
//! exit status it observed, or it records that it does not know — see `Lost` and
//! `Unknown`. A supervisor that guessed would be a worse liar than the model it
//! exists to check, because its answers are the ones treated as ground truth.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{self, Value};

/// How much worker output is kept. Enough to diagnose a failure; never a build
/// log. The brief is explicit that raw streams must not become the payload.
pub const MAX_OUTPUT: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    /// The supervisor restarted and the process it was watching is gone, with no
    /// exit status ever recorded. Something happened; nobody saw what.
    Lost,
    /// The supervisor restarted and the process is STILL ALIVE but is no longer
    /// its child, so its exit can never be collected. Honest, and deliberately
    /// distinct from `Lost`.
    Unknown,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Queued => "queued",
            State::Running => "running",
            State::Completed => "completed",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
            State::Lost => "lost",
            State::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> State {
        match s {
            "queued" => State::Queued,
            "running" => State::Running,
            "completed" => State::Completed,
            "failed" => State::Failed,
            "cancelled" => State::Cancelled,
            "lost" => State::Lost,
            _ => State::Unknown,
        }
    }

    pub fn is_final(self) -> bool {
        matches!(self, State::Completed | State::Failed | State::Cancelled | State::Lost)
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    /// The caller's own id for the SUBMISSION, not the job. See `submit`: this
    /// is what stops a reconnecting client launching the work a second time.
    pub request_id: String,
    pub session: String,
    pub command: String,
    pub shell: String,
    pub cwd: String,
    pub state: State,
    pub pid: Option<u32>,
    pub created_at: u64,
    /// WHEN THE REQUESTED EXECUTION WINDOW ENDS, and it belongs to the JOB.
    /// "Run the training for two hours" is a fact about the work, not about any
    /// model request that happened to start it — so it survives the model, the
    /// provider and the Node process, and no model turn can silently move it.
    pub deadline_at: Option<u64>,
    /// When the window was observed to have ended. Set WITHOUT killing anything
    /// and without deciding whether the run succeeded — see the watcher.
    pub deadline_reached_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub output: String,
    pub error: String,
}

impl Job {
    pub fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("id", Value::s(&self.id));
        v.set("request_id", Value::s(&self.request_id));
        v.set("session", Value::s(&self.session));
        v.set("command", Value::s(&self.command));
        v.set("shell", Value::s(&self.shell));
        v.set("cwd", Value::s(&self.cwd));
        v.set("state", Value::s(self.state.as_str()));
        v.set("pid", self.pid.map(|p| Value::n(p as i64)).unwrap_or(Value::Null));
        v.set("created_at", Value::n(self.created_at as i64));
        v.set("deadline_at", self.deadline_at.map(|t| Value::n(t as i64)).unwrap_or(Value::Null));
        v.set("deadline_reached_at", self.deadline_reached_at.map(|t| Value::n(t as i64)).unwrap_or(Value::Null));
        v.set("finished_at", self.finished_at.map(|t| Value::n(t as i64)).unwrap_or(Value::Null));
        v.set("exit_code", self.exit_code.map(|c| Value::n(c as i64)).unwrap_or(Value::Null));
        v.set("output", Value::s(&self.output));
        v.set("error", Value::s(&self.error));
        v
    }

    pub fn from_value(v: &Value) -> Option<Job> {
        let id = v.str("id");
        if id.is_empty() {
            return None;
        }
        Some(Job {
            id,
            request_id: v.str("request_id"),
            session: v.str("session"),
            command: v.str("command"),
            shell: v.str("shell"),
            cwd: v.str("cwd"),
            state: State::from_str(&v.str("state")),
            pid: v.num("pid").map(|n| n as u32),
            created_at: v.num("created_at").unwrap_or(0.0) as u64,
            deadline_at: v.num("deadline_at").map(|n| n as u64),
            deadline_reached_at: v.num("deadline_reached_at").map(|n| n as u64),
            finished_at: v.num("finished_at").map(|n| n as u64),
            exit_code: v.num("exit_code").map(|n| n as i32),
            output: v.str("output"),
            error: v.str("error"),
        })
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Is this process alive? The same question `instances.js` asks with
/// `kill(pid, 0)`, and the same reason: a record is a hint, the process is the
/// truth.
/// ------------------------------------------------------------------------
/// MEASURED, AND IT IS WHY THIS IS NOT `tasklist` ANY MORE.
///
/// The first version shelled out to `tasklist /FI "PID eq N"`. It is always
/// present and needs nothing linked, which is why it was chosen — and on a
/// developer machine with a real process table and a virus scanner in the path
/// it costs **about three seconds per call**. Timed here: `guardian_turn_begin`
/// took 3,066 ms, of which essentially all was the process scan.
///
/// That is survivable for a job list somebody asked for. It is fatal for the
/// input gateway, which answers a person's Enter key and times out at four
/// seconds — and a gateway that times out answers DELIVER, so the cost of the
/// slow probe was, precisely, the feature not working.
///
/// So: `OpenProcess` and one wait with a zero timeout. No crate, no spawn, no
/// output to parse — kernel32 is linked by every Windows program already.
///
/// `WaitForSingleObject` RATHER THAN `GetExitCodeProcess`, which is the usual
/// way to write this and is subtly wrong: a process that exits with code 259
/// is indistinguishable from `STILL_ACTIVE`, and 259 is a code a build tool can
/// genuinely return. The wait has no such ambiguity — the handle is signalled
/// when the process ends, and only then.
#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        pub fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
        pub fn CloseHandle(handle: isize) -> i32;
        pub fn GetLastError() -> u32;
    }
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const WAIT_TIMEOUT: u32 = 0x0000_0102;
    /// The process exists but this account may not touch it. Still alive.
    pub const ERROR_ACCESS_DENIED: u32 = 5;
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let h = win::OpenProcess(win::SYNCHRONIZE, 0, pid);
        if h == 0 {
            // A REFUSAL IS NOT AN ABSENCE. Denied means the process is there and
            // belongs to somebody else; every other error means there is no such
            // process. Reading the first as "dead" would declare a turn LOST
            // because of a permission boundary, which is the one wrong answer
            // this function must not give.
            return win::GetLastError() == win::ERROR_ACCESS_DENIED;
        }
        // Zero timeout: this asks, it never waits.
        let signalled = win::WaitForSingleObject(h, 0);
        win::CloseHandle(h);
        signalled == win::WAIT_TIMEOUT
    }
}

#[cfg(not(windows))]
pub fn alive(pid: u32) -> bool {
    // Signal 0 tests for existence without delivering anything.
    unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(not(windows))]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

/// ------------------------------------------------------------------------
/// EXECUTION EVENTS — deterministic facts, in the order they were observed.
///
/// The supervisor watches; the model reasons. So an event says what happened
/// and nothing about what it MEANS: "exited 1 at 01:17:32, deadline had 42
/// minutes left" is an observation, and "CUDA ran out of memory, reduce the
/// batch size" is a conclusion that belongs to the model reading it.
///
/// Appended to a file rather than held in memory, because the whole point is
/// that they outlive the process that will eventually read them — a job can
/// finish, or blow its deadline, at a moment when no LAIN is running at all.
///
/// COMPACT. An event carries identifiers and measurements; the log itself stays
/// on disk and is fetched deliberately by a tool if the model wants it.
pub fn emit(dir: &Path, kind: &str, job: &Job, detail: &str) {
    let mut v = Value::obj();
    v.set("at", Value::n(now() as i64));
    v.set("kind", Value::s(kind));
    v.set("job_id", Value::s(&job.id));
    v.set("session", Value::s(&job.session));
    v.set("state", Value::s(job.state.as_str()));
    v.set("command", Value::s(&job.command));
    v.set("exit_code", job.exit_code.map(|c| Value::n(c as i64)).unwrap_or(Value::Null));
    v.set("elapsed", Value::n((now().saturating_sub(job.created_at)) as i64));
    v.set(
        "deadline_remaining",
        job.deadline_at
            .map(|d| Value::n(d.saturating_sub(now()) as i64))
            .unwrap_or(Value::Null),
    );
    if !detail.is_empty() {
        v.set("detail", Value::s(detail));
    }
    let line = format!("{}
", json::write(&v));
    let _ = fs::create_dir_all(dir);
    // O_APPEND: several threads may be reporting at once and a torn line would
    // cost an event, which is the one thing this file exists not to do.
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) {
        use std::io::Write as _;
        let _ = f.write_all(line.as_bytes());
    }
}

/// Every event after `after` (a 1-based index), oldest first.
pub fn events_since(dir: &Path, after: usize, limit: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let text = match fs::read_to_string(dir.join("events.jsonl")) {
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
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

pub struct Registry {
    pub dir: PathBuf,
    pub jobs: BTreeMap<String, Job>,
    seq: u64,
}

impl Registry {
    pub fn open(dir: PathBuf) -> Registry {
        let _ = fs::create_dir_all(&dir);
        let mut r = Registry { dir, jobs: BTreeMap::new(), seq: 0 };
        r.load();
        r.reconcile();
        r
    }

    fn jobs_dir(&self) -> PathBuf {
        self.dir.join("jobs")
    }

    fn load(&mut self) {
        let d = self.jobs_dir();
        let _ = fs::create_dir_all(&d);
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            let mut s = String::new();
            if fs::File::open(&p).and_then(|mut f| f.read_to_string(&mut s)).is_err() {
                continue;
            }
            if let Some(job) = json::parse(&s).as_ref().and_then(Job::from_value) {
                self.jobs.insert(job.id.clone(), job);
            }
        }
    }

    /// ------------------------------------------------------------------
    /// WHAT HAPPENED WHILE WE WERE NOT RUNNING.
    ///
    /// A supervisor restart is not a fresh universe, and the brief is explicit
    /// that it must not invent completion. Every job the store says was RUNNING
    /// is now in one of two honest positions: its process is still alive but is
    /// no longer our child, so its exit is uncollectable (`Unknown`); or it is
    /// gone and we never saw how it went (`Lost`).
    fn reconcile(&mut self) {
        let mut changed = Vec::new();
        for job in self.jobs.values_mut() {
            if job.state != State::Running && job.state != State::Queued {
                continue;
            }
            let still = job.pid.map(alive).unwrap_or(false);
            job.state = if still { State::Unknown } else { State::Lost };
            if job.state == State::Lost && job.finished_at.is_none() {
                job.finished_at = Some(now());
            }
            job.error = if still {
                "the supervisor restarted; this process is alive but is no longer its child, so its exit cannot be collected".into()
            } else {
                "the supervisor restarted and this process was already gone; no exit status was ever observed".into()
            };
            changed.push(job.id.clone());
        }
        for id in changed {
            self.persist(&id);
        }
    }

    fn persist(&self, id: &str) {
        let job = match self.jobs.get(id) {
            Some(j) => j,
            None => return,
        };
        let d = self.jobs_dir();
        let _ = fs::create_dir_all(&d);
        let text = json::write(&job.to_value());
        // Write-then-rename, so a reader never sees half a record — the same
        // discipline the checkpoint manifests use.
        let tmp = d.join(format!("{id}.tmp"));
        let final_path = d.join(format!("{id}.json"));
        if fs::write(&tmp, text.as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &final_path);
        }
    }

    /// An existing job for this submission, if the caller has asked before.
    ///
    /// §14: a client that lost its connection between sending `submit` and
    /// reading the reply does not know whether the work started. It retries with
    /// the same `request_id`, and gets the SAME job rather than a second copy of
    /// a build.
    pub fn by_request(&self, request_id: &str) -> Option<&Job> {
        if request_id.is_empty() {
            return None;
        }
        self.jobs.values().find(|j| j.request_id == request_id)
    }

    pub fn submit(
        &mut self,
        request_id: &str,
        session: &str,
        command: &str,
        shell: &str,
        cwd: &str,
        deadline_secs: u64,
    ) -> Job {
        if let Some(existing) = self.by_request(request_id) {
            return existing.clone();
        }
        self.seq += 1;
        let id = format!("j{}-{}", now(), self.seq);
        let mut job = Job {
            id: id.clone(),
            request_id: request_id.to_string(),
            session: session.to_string(),
            command: command.to_string(),
            shell: shell.to_string(),
            cwd: cwd.to_string(),
            state: State::Queued,
            pid: None,
            created_at: now(),
            deadline_at: if deadline_secs > 0 { Some(now() + deadline_secs) } else { None },
            deadline_reached_at: None,
            finished_at: None,
            exit_code: None,
            output: String::new(),
            error: String::new(),
        };

        let spawned = spawn(command, shell, cwd);
        match spawned {
            Ok((child, rx)) => {
                job.pid = Some(child.id());
                job.state = State::Running;
                self.jobs.insert(id.clone(), job.clone());
                self.persist(&id);
                let started = self.jobs.get(&id).cloned().unwrap_or_else(|| job.clone());
                emit(&self.dir, "JOB_STARTED", &started, "");
                self.watch_deadline(&started);
                self.reap(id.clone(), child, rx);
            }
            Err(e) => {
                job.state = State::Failed;
                job.error = format!("could not start: {e}");
                job.finished_at = Some(now());
                self.jobs.insert(id.clone(), job.clone());
                self.persist(&id);
                emit(&self.dir, "JOB_ERROR", &job, "the worker could not be started");
            }
        }
        self.jobs.get(&id).cloned().unwrap_or(job)
    }

    /// ------------------------------------------------------------------
    /// THE EXECUTION WINDOW ENDING IS NOT A VERDICT.
    ///
    /// At the deadline the supervisor reports what it can see — the job is still
    /// running, this much time has passed, the window is over — and does NOT
    /// kill it, fail it, or call it done. "Run the training for two hours" says
    /// when to come back and look; whether two hours of training succeeded is a
    /// question about loss curves that only the model can answer.
    ///
    /// The deadline itself stays authoritative: it is recorded on the job, so a
    /// later model cannot quietly decide the window was really three hours.
    fn watch_deadline(&self, job: &Job) {
        let deadline = match job.deadline_at {
            Some(d) => d,
            None => return,
        };
        let dir = self.dir.clone();
        let id = job.id.clone();
        thread::spawn(move || {
            loop {
                let left = deadline.saturating_sub(now());
                if left == 0 {
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(std::cmp::min(left * 1000, 1000)));
            }
            // Re-read: the job may well have finished on its own, in which case
            // the window ending is not news.
            let p = dir.join("jobs").join(format!("{id}.json"));
            let mut text = String::new();
            let current = fs::File::open(&p)
                .and_then(|mut f| f.read_to_string(&mut text))
                .ok()
                .and_then(|_| json::parse(&text))
                .and_then(|v| Job::from_value(&v));
            let mut job = match current {
                Some(j) => j,
                None => return,
            };
            if job.state.is_final() || job.deadline_reached_at.is_some() {
                return;
            }
            job.deadline_reached_at = Some(now());
            let tmp = dir.join("jobs").join(format!("{id}.tmp"));
            if fs::write(&tmp, json::write(&job.to_value()).as_bytes()).is_ok() {
                let _ = fs::rename(&tmp, &p);
            }
            emit(&dir, "JOB_DEADLINE_REACHED", &job,
                 "the requested execution window has ended; the worker is still running and nothing has been assumed about it");
        });
    }

    /// Wait for a child on its own thread and record what actually happened.
    ///
    /// The result is written to disk the moment it is known, which is the whole
    /// reason a worker can finish while LAIN is dead and still be reportable.
    fn reap(&mut self, id: String, mut child: Child, rx: Receiver<String>) {
        let dir = self.dir.clone();
        let jobs_snapshot = self.jobs.get(&id).cloned();
        thread::spawn(move || {
            // NOTHING IS LOCKED HERE. An earlier version held the child behind a
            // Mutex so `cancel` could reach it, which meant `cancel` blocked on a
            // lock the reaper held for the entire life of the job — a cancel that
            // could only succeed once the work had finished on its own. The
            // reaper owns the child outright; cancellation goes through the pid.
            let status = child.wait();
            let output: String = rx.iter().collect();
            let mut job = match jobs_snapshot {
                Some(j) => j,
                None => return,
            };
            job.output = cap(&output);
            job.finished_at = Some(now());
            match status {
                Ok(st) => {
                    let code = st.code();
                    job.exit_code = code;
                    // An exit code is a fact about the process, not a verdict
                    // about the work. Non-zero is recorded as Failed and the
                    // reader decides what that means — testing.js already knows
                    // that a rate-limited suite exits non-zero too.
                    job.state = if code == Some(0) { State::Completed } else { State::Failed };
                }
                Err(e) => {
                    job.state = State::Lost;
                    job.error = format!("could not collect the exit status: {e}");
                }
            }
            // A JOB THAT WAS CANCELLED STAYS CANCELLED. The reaper is about to
            // observe the exit of a process somebody killed on purpose, and
            // "failed, exit 1" would describe that correctly and report it
            // uselessly. Re-read what is on disk before overwriting it.
            let existing = {
                let p = dir.join("jobs").join(format!("{}.json", job.id));
                let mut s = String::new();
                fs::File::open(&p)
                    .and_then(|mut f| f.read_to_string(&mut s))
                    .ok()
                    .and_then(|_| json::parse(&s))
                    .and_then(|v| Job::from_value(&v))
            };
            if let Some(prev) = existing {
                if prev.state == State::Cancelled {
                    job.state = State::Cancelled;
                }
            }

            // Written straight to disk: this thread may well be running when no
            // client is connected at all.
            let d = dir.join("jobs");
            let kind = match job.state {
                State::Completed => "JOB_COMPLETED",
                State::Cancelled => "JOB_CANCELLED",
                _ => "JOB_ERROR",
            };
            let _ = fs::create_dir_all(&d);
            let text = json::write(&job.to_value());
            let tmp = d.join(format!("{}.tmp", job.id));
            let final_path = d.join(format!("{}.json", job.id));
            if fs::write(&tmp, text.as_bytes()).is_ok() {
                let _ = fs::rename(&tmp, &final_path);
            }
            // AFTER the record is durable, so an event can never point at a
            // result a reader cannot yet see.
            emit(&dir, kind, &job, "");
        });
    }

    /// Re-read one job from disk, because the reaper thread owns the truth once
    /// a child has been waited on.
    pub fn refresh(&mut self, id: &str) {
        let p = self.jobs_dir().join(format!("{id}.json"));
        let mut s = String::new();
        if fs::File::open(&p).and_then(|mut f| f.read_to_string(&mut s)).is_ok() {
            if let Some(job) = json::parse(&s).as_ref().and_then(Job::from_value) {
                self.jobs.insert(job.id.clone(), job);
            }
        }
    }

    pub fn refresh_all(&mut self) {
        let ids: Vec<String> = self.jobs.keys().cloned().collect();
        for id in ids {
            self.refresh(&id);
        }
    }

    pub fn cancel(&mut self, id: &str) -> Option<Job> {
        // BY PID, AND THE WHOLE TREE. The direct child is usually a shell; the
        // thing actually doing the work is its child, and killing only the shell
        // leaves the work running while reporting it cancelled.
        if let Some(pid) = self.jobs.get(id).and_then(|j| j.pid) {
            if !self.jobs.get(id).map(|j| j.state.is_final()).unwrap_or(true) {
                kill_tree(pid);
            }
        }
        let job = self.jobs.get_mut(id)?;
        if !job.state.is_final() {
            job.state = State::Cancelled;
            job.finished_at = Some(now());
        }
        let out = job.clone();
        self.persist(id);
        Some(out)
    }
}

/// Terminate a process and everything it started.
#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    // Negative pid signals the process group, which is the tree here.
    unsafe {
        libc_kill(-(pid as i32), 9);
        libc_kill(pid as i32, 9);
    }
}

fn cap(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    // Keep the TAIL. A failing run puts its reason at the end.
    let start = s.len() - MAX_OUTPUT;
    let mut idx = start;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    format!("[output truncated]\n{}", &s[idx..])
}

/// Start the worker, and stream its output into a channel.
///
/// stdout and stderr are merged deliberately: a job's output is read by a person
/// or handed to a model as one stream, and interleaving is how the failure lines
/// up with what preceded it.
fn spawn(command: &str, shell: &str, cwd: &str) -> std::io::Result<(Child, Receiver<String>)> {
    let mut cmd = shell_command(command, shell);
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    let (tx, rx) = channel::<String>();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || pump(out, tx));
    }
    if let Some(err) = child.stderr.take() {
        thread::spawn(move || pump(err, tx));
    }
    Ok((child, rx))
}

fn pump<R: Read + Send + 'static>(mut r: R, tx: std::sync::mpsc::Sender<String>) {
    let mut buf = [0u8; 4096];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            }
        }
    }
}

/// ------------------------------------------------------------------------
/// THE COMMAND LINE IS PASSED VERBATIM, AND IT HAS TO BE.
///
/// `Command::arg` quotes for the C runtime's rules: an argument containing a
/// double quote arrives as `\"`. `cmd.exe` does not parse that way and never
/// has, so a perfectly ordinary command —
///
///     echo DONE> "C:\path with spaces\mark.txt"
///
/// reached the shell as `\"C:\path...\"`, which is not a filename, and the
/// worker exited 1 with "The filename, directory name, or volume label syntax
/// is incorrect". Every command carrying a quoted path was affected; it was
/// found by a job that should have taken three seconds and instead failed
/// instantly.
///
/// `raw_arg` appends the text to the command line untouched, which is what a
/// shell wants: the caller already wrote a shell command, and escaping it a
/// second time on its behalf is the whole defect. LAIN's own shell.js makes the
/// same choice for the same reason — "the command string is never rewritten".
#[cfg(windows)]
fn shell_command(command: &str, shell: &str) -> Command {
    use std::os::windows::process::CommandExt;
    match shell {
        "powershell" => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command"]);
            c.raw_arg(command);
            c
        }
        "bash" => {
            // bash is given a normal argv: it is not cmd.exe and its arguments
            // go through the ordinary C-runtime rules correctly.
            let mut c = Command::new("bash");
            c.args(["-lc", command]);
            c
        }
        _ => {
            let mut c = Command::new("cmd");
            c.arg("/C");
            c.raw_arg(command);
            c
        }
    }
}

#[cfg(not(windows))]
fn shell_command(command: &str, _shell: &str) -> Command {
    let mut c = Command::new("sh");
    c.args(["-c", command]);
    c
}

#[cfg(test)]
mod tests {

    /// ------------------------------------------------------------------------
    /// THE LIVENESS PROBE, which is on the input gateway's critical path.
    ///
    /// It answers a person's Enter key, so its COST is part of its correctness:
    /// the `tasklist` version took about three seconds per call on a real
    /// machine, which is longer than the gateway's own timeout — and a gateway
    /// that times out delivers, so the slow probe meant the feature silently
    /// did not work. These assert both halves.
    #[test]
    fn a_live_process_is_alive_and_a_dead_one_is_not() {
        assert!(alive(std::process::id()), "this very process is running");
        // Not 0 — that is "no process", tested separately — but a pid high
        // enough that nothing on a normal machine holds it.
        assert!(!alive(999_999_990));
        // PID 0 IS NEVER A USER PROCESS. On Windows it is the idle process and
        // on Unix it means "this process group" to `kill`, which would report a
        // nonexistent job as running.
        assert!(!alive(0));
    }

    #[test]
    fn the_probe_is_cheap_enough_to_sit_on_a_keystroke() {
        // A BUDGET, not a benchmark: this is asserting that the implementation
        // is not a process spawn, and it holds by three orders of magnitude on
        // the machine where the spawn version took 3,066 ms.
        let pid = std::process::id();
        let t = std::time::Instant::now();
        for _ in 0..50 {
            let _ = alive(pid);
        }
        let ms = t.elapsed().as_millis();
        assert!(ms < 500, "50 liveness checks took {ms}ms — this is back on a subprocess");
    }
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lain-sup-{}-{}", tag, now_nanos()));
        let _ = fs::create_dir_all(&d);
        d
    }

    fn now_nanos() -> u128 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    }

    fn settle(reg: &mut Registry, id: &str) -> Job {
        for _ in 0..200 {
            reg.refresh(id);
            let j = reg.jobs.get(id).cloned().unwrap();
            if j.state.is_final() {
                return j;
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        reg.jobs.get(id).cloned().unwrap()
    }

    #[test]
    fn a_job_runs_and_its_real_exit_is_recorded() {
        let mut reg = Registry::open(tmp("run"));
        let j = reg.submit("r1", "s1", "exit 0", default_shell(), "", 0);
        let done = settle(&mut reg, &j.id);
        assert_eq!(done.state, State::Completed);
        assert_eq!(done.exit_code, Some(0));
    }

    #[test]
    fn a_failing_job_is_failed_with_its_code_not_guessed() {
        let mut reg = Registry::open(tmp("fail"));
        let j = reg.submit("r1", "s1", "exit 3", default_shell(), "", 0);
        let done = settle(&mut reg, &j.id);
        assert_eq!(done.state, State::Failed);
        assert_eq!(done.exit_code, Some(3));
    }

    #[test]
    fn the_same_request_id_never_starts_a_second_worker() {
        let mut reg = Registry::open(tmp("idem"));
        let a = reg.submit("same", "s1", "exit 0", default_shell(), "", 0);
        let b = reg.submit("same", "s1", "exit 0", default_shell(), "", 0);
        assert_eq!(a.id, b.id, "a retried submission must return the SAME job");
        assert_eq!(reg.jobs.len(), 1, "and must not have launched twice");
    }

    #[test]
    fn results_survive_a_supervisor_restart() {
        let dir = tmp("persist");
        let id = {
            let mut reg = Registry::open(dir.clone());
            let j = reg.submit("r1", "s1", "exit 0", default_shell(), "", 0);
            settle(&mut reg, &j.id).id
        };
        // A brand-new Registry over the same directory is the restart.
        let reg2 = Registry::open(dir);
        let j = reg2.jobs.get(&id).expect("the job must come back");
        assert_eq!(j.state, State::Completed, "a finished job stays finished across a restart");
        assert_eq!(j.exit_code, Some(0));
    }

    #[test]
    fn a_restart_never_invents_completion_for_work_it_did_not_watch() {
        let dir = tmp("recon");
        let d = dir.join("jobs");
        let _ = fs::create_dir_all(&d);
        // A record left behind by a supervisor that died mid-job, naming a pid
        // that is certainly not running.
        let mut v = Value::obj();
        v.set("id", Value::s("j-orphan"));
        v.set("state", Value::s("running"));
        v.set("pid", Value::n(999_999_999));
        v.set("command", Value::s("sleep 1"));
        let _ = fs::write(d.join("j-orphan.json"), json::write(&v));

        let reg = Registry::open(dir);
        let j = reg.jobs.get("j-orphan").expect("the orphan must be loaded");
        assert_eq!(j.state, State::Lost, "an unwatched job is LOST, never completed");
        assert_eq!(j.exit_code, None, "and it must not acquire an exit status nobody saw");
    }

    #[test]
    fn cancelling_terminates_the_worker_and_records_it() {
        let mut reg = Registry::open(tmp("cancel"));
        let j = reg.submit("r1", "s1", long_running(), default_shell(), "", 0);
        let pid = j.pid.expect("a running job has a pid");
        let out = reg.cancel(&j.id).expect("cancel returns the job");
        assert_eq!(out.state, State::Cancelled);
        // Give the OS a moment to actually tear it down.
        for _ in 0..40 {
            if !alive(pid) {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the worker was still alive after cancellation");
    }

    // ---- THE WINDOW ENDING IS NOT A VERDICT -----------------------------
    //
    // "Run the training for two hours" says when to come back and look. Whether
    // two hours of training SUCCEEDED is a question about loss curves, and the
    // supervisor is required not to answer it.
    #[test]
    fn a_reached_deadline_reports_and_does_not_kill_or_judge() {
        let dir = tmp("deadline");
        let mut reg = Registry::open(dir.clone());
        // One second of window against a worker that runs far longer.
        let j = reg.submit("r1", "s1", long_running(), default_shell(), "", 1);
        let pid = j.pid.expect("a running job has a pid");
        assert!(j.deadline_at.is_some(), "the deadline belongs to the job");

        let mut seen = None;
        for _ in 0..80 {
            thread::sleep(std::time::Duration::from_millis(100));
            reg.refresh(&j.id);
            let cur = reg.jobs.get(&j.id).cloned().unwrap();
            if cur.deadline_reached_at.is_some() {
                seen = Some(cur);
                break;
            }
        }
        let cur = seen.expect("the deadline must be observed");
        assert_eq!(cur.state, State::Running, "the window ending must not change the state");
        assert_eq!(cur.exit_code, None, "and must not invent an exit status");
        assert!(alive(pid), "and must not kill the worker");

        let evs = events_since(&dir, 0, 50);
        assert!(
            evs.iter().any(|e| e.str("kind") == "JOB_DEADLINE_REACHED"),
            "an event must be emitted for the model to reason about"
        );
        reg.cancel(&j.id);
    }

    #[test]
    fn a_job_that_finishes_early_never_reports_a_deadline() {
        let dir = tmp("early");
        let mut reg = Registry::open(dir.clone());
        let j = reg.submit("r1", "s1", "exit 0", default_shell(), "", 30);
        let done = settle(&mut reg, &j.id);
        assert_eq!(done.state, State::Completed);
        assert!(done.deadline_reached_at.is_none(), "the window never ended");
        let evs = events_since(&dir, 0, 50);
        assert!(evs.iter().any(|e| e.str("kind") == "JOB_COMPLETED"));
        assert!(!evs.iter().any(|e| e.str("kind") == "JOB_DEADLINE_REACHED"));
    }

    // The other half of the contract: failing BEFORE the window ends is its own
    // event, and it carries how much of the window was left.
    #[test]
    fn a_failure_before_the_deadline_is_an_event_with_time_remaining() {
        let dir = tmp("earlyfail");
        let mut reg = Registry::open(dir.clone());
        let j = reg.submit("r1", "s1", "exit 4", default_shell(), "", 600);
        let done = settle(&mut reg, &j.id);
        assert_eq!(done.state, State::Failed);
        assert_eq!(done.exit_code, Some(4));
        let evs = events_since(&dir, 0, 50);
        let e = evs.iter().find(|e| e.str("kind") == "JOB_ERROR").expect("an error event");
        assert_eq!(e.str("job_id"), j.id);
        let left = e.num("deadline_remaining").unwrap_or(0.0);
        assert!(left > 0.0, "the model must be told the window had not run out");
    }

    #[test]
    fn events_are_read_back_in_order_and_can_be_resumed_from() {
        let dir = tmp("evseq");
        let mut reg = Registry::open(dir.clone());
        let a = reg.submit("r1", "s1", "exit 0", default_shell(), "", 0);
        settle(&mut reg, &a.id);
        let b = reg.submit("r2", "s1", "exit 0", default_shell(), "", 0);
        settle(&mut reg, &b.id);
        let all = events_since(&dir, 0, 100);
        assert!(all.len() >= 4, "started and finished, twice");
        assert_eq!(all[0].num("seq"), Some(1.0));
        // A reader that has already seen the first two gets only what is new.
        let rest = events_since(&dir, 2, 100);
        assert_eq!(rest.len(), all.len() - 2);
        assert_eq!(rest[0].num("seq"), Some(3.0));
    }

    #[cfg(windows)]
    fn default_shell() -> &'static str {
        "cmd"
    }
    #[cfg(not(windows))]
    fn default_shell() -> &'static str {
        "sh"
    }

    #[cfg(windows)]
    fn long_running() -> &'static str {
        "ping -n 60 127.0.0.1 > NUL"
    }
    #[cfg(not(windows))]
    fn long_running() -> &'static str {
        "sleep 60"
    }
}
