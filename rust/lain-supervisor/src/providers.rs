//! PROVIDER HEALTH — the part of "can I call this route" that outlives LAIN.
//!
//! ------------------------------------------------------------------------
//! THE MEASUREMENT THIS EXISTS FOR. `availability.js` keys provider health by
//! connection id in a `Map` on the App object, under a comment that says it is
//! "in-memory by design: it describes right now, and a restart legitimately
//! knows nothing".
//!
//! That is true of a breaker and false of a rate limit, and the difference is
//! the entire reason this file exists. A breaker is a guess about a server that
//! stopped answering, and a fresh process is right to re-guess. A rate limit is
//! not a guess: the provider STATED a time, hours away, and it will refuse every
//! request until then. Observed live against a real router: `retry in 4 hours`.
//! Restart LAIN five minutes later and the Map is empty, so the next turn calls
//! the limited route, is refused, and pays for the same discovery again — and
//! the model picker, which is exactly where "which of these can I use right
//! now" is asked, shows a closed door as untried.
//!
//! So a limit with a stated reset is persisted here, in the process whose one
//! job is to still be running, and it is read back by whichever LAIN comes next.
//!
//! ------------------------------------------------------------------------
//! WHAT IT REFUSES TO DO — the same refusal as jobs.rs, on a different subject.
//!
//! It never invents a reset time. A provider that rate-limits without saying
//! when is recorded as limited with `reset_at: null`, and the caller is expected
//! to say "UNKNOWN RESET" rather than draw a countdown to a number nobody
//! supplied. A fabricated clock is worse than no clock: it is believed.
//!
//! It also never decides that a limit has cleared BECAUSE TIME PASSED and
//! nothing else. Expiry is computed at read time from `reset_at` — a stated
//! reset in the past means the door should be open — but the flag is only
//! actually dropped when a request SUCCEEDS (`note` with ok:true) or a person
//! clears it. The distinction matters at the boundary: "the stated reset has
//! passed" is a prediction, "a request just worked" is an observation.
//!
//! ------------------------------------------------------------------------
//! KEYED BY CONNECTION, NOT BY PROVIDER, because that is what is already true
//! in LAIN and it is true for a reason: the same provider reached two ways can
//! be limited on one route and fine on the other, which is the whole reason
//! connections exist. `model` rides along for display only and is never part of
//! the key — one route carries many models and they share its limit.
//!
//! ------------------------------------------------------------------------
//! MILLISECONDS, unlike jobs.rs, which counts whole seconds. Deliberate, and
//! the boundary is the reason: every number here is compared against, or
//! rendered from, a JavaScript `Date.now()` — `resumeAt`, the countdown in
//! `ratelimit.human()`, the row in the model picker. Converting units twice per
//! round trip to match a neighbouring file would put rounding drift into a
//! clock a person reads.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{self, Value};

/// Milliseconds since the epoch — the unit JavaScript hands us. See the note.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// How many consecutive failures close the breaker. The same default
/// `availability.js` uses; the Node side may override it per note.
pub const FAILURE_THRESHOLD: u32 = 2;

/// The words are `availability.js`'s STATUS, unchanged, so that a row read back
/// out of here can be handed to the existing renderer without translation. A
/// second vocabulary for the same six states would be a bug generator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Available,
    Degraded,
    Unavailable,
    Maintenance,
    Disabled,
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Available => "AVAILABLE",
            Status::Degraded => "DEGRADED",
            Status::Unavailable => "UNAVAILABLE",
            Status::Maintenance => "MAINTENANCE",
            Status::Disabled => "DISABLED",
            Status::Unknown => "UNKNOWN",
        }
    }

    pub fn from_str(s: &str) -> Status {
        match s {
            "AVAILABLE" => Status::Available,
            "DEGRADED" => Status::Degraded,
            "UNAVAILABLE" => Status::Unavailable,
            "MAINTENANCE" => Status::Maintenance,
            "DISABLED" => Status::Disabled,
            _ => Status::Unknown,
        }
    }

    /// A state a PERSON put the route in. Never cleared by a request going
    /// through — `availability.js` calls this USER_SET and the rule is the
    /// same here: a machine observation does not get to overrule a decision.
    pub fn is_user_set(self) -> bool {
        matches!(self, Status::Maintenance | Status::Disabled)
    }
}

/// What is currently true about one route.
#[derive(Debug, Clone)]
pub struct Health {
    /// The key. A connection id, e.g. `omniroute-main`.
    pub id: String,
    /// For display and for grouping. Never part of the key.
    pub provider: String,
    /// The model in play when this was last observed. Display only — a route
    /// carries many models and a limit on it belongs to all of them.
    pub model: String,
    pub status: Status,
    pub reason: String,
    pub consecutive_failures: u32,
    /// Is the route rate limited, as last observed?
    pub rate_limited: bool,
    /// WHEN THE PROVIDER SAID IT CLEARS. `None` means it did not say, and that
    /// is reported as unknown rather than guessed. See the module note.
    pub reset_at: Option<u64>,
    /// When the current status was first entered.
    pub detected_at: u64,
    pub last_success: Option<u64>,
    pub last_failure: Option<u64>,
}

impl Health {
    fn new(id: &str) -> Health {
        Health {
            id: id.to_string(),
            provider: String::new(),
            model: String::new(),
            status: Status::Unknown,
            reason: String::new(),
            consecutive_failures: 0,
            rate_limited: false,
            reset_at: None,
            detected_at: now_ms(),
            last_success: None,
            last_failure: None,
        }
    }

    /// IS THE DOOR SHUT RIGHT NOW — the one question the gate asks.
    ///
    /// A limit with a stated reset in the past is NOT blocking: the provider's
    /// own number says it is over. A limit with no stated reset blocks until
    /// something observes otherwise, because guessing that it has probably
    /// cleared by now is exactly the invented clock this refuses to draw.
    pub fn limited_now(&self, now: u64) -> bool {
        if !self.rate_limited {
            return false;
        }
        match self.reset_at {
            Some(t) => t > now,
            None => true,
        }
    }

    pub fn to_value(&self, now: u64) -> Value {
        let mut v = Value::obj();
        v.set("id", Value::s(&self.id));
        v.set("provider", Value::s(&self.provider));
        v.set("model", Value::s(&self.model));
        v.set("status", Value::s(self.status.as_str()));
        v.set("reason", Value::s(&self.reason));
        v.set("consecutive_failures", Value::n(self.consecutive_failures as i64));
        v.set("rate_limited", Value::Bool(self.rate_limited));
        v.set(
            "reset_at",
            self.reset_at.map(|t| Value::n(t as i64)).unwrap_or(Value::Null),
        );
        // DERIVED, AND SENT ANYWAY, because the caller is on the other side of a
        // socket and the two clocks are the same clock. Sending only `reset_at`
        // would make every reader recompute this, and one of them would do it
        // differently.
        v.set("limited_now", Value::Bool(self.limited_now(now)));
        v.set(
            "resets_in_ms",
            match self.reset_at {
                Some(t) if t > now => Value::n((t - now) as i64),
                Some(_) => Value::n(0),
                // NOT ZERO. Zero reads as "it clears now"; this is "nobody said".
                None => Value::Null,
            },
        );
        v.set("detected_at", Value::n(self.detected_at as i64));
        v.set("last_success", self.last_success.map(|t| Value::n(t as i64)).unwrap_or(Value::Null));
        v.set("last_failure", self.last_failure.map(|t| Value::n(t as i64)).unwrap_or(Value::Null));
        v
    }

    pub fn from_value(v: &Value) -> Option<Health> {
        let id = v.str("id");
        if id.is_empty() {
            return None;
        }
        let opt = |k: &str| -> Option<u64> {
            match v.get(k) {
                Some(Value::Num(n)) if *n >= 0.0 => Some(*n as u64),
                _ => None,
            }
        };
        Some(Health {
            id,
            provider: v.str("provider"),
            model: v.str("model"),
            status: Status::from_str(&v.str("status")),
            reason: v.str("reason"),
            consecutive_failures: v.num("consecutive_failures").unwrap_or(0.0).max(0.0) as u32,
            rate_limited: matches!(v.get("rate_limited"), Some(Value::Bool(true))),
            reset_at: opt("reset_at"),
            detected_at: opt("detected_at").unwrap_or_else(now_ms),
            last_success: opt("last_success"),
            last_failure: opt("last_failure"),
        })
    }
}

/// Every route's health, persisted one file per route.
///
/// A FILE PER ROUTE, not one document, for the same reason `jobs.rs` does it:
/// two writers touching two routes never contend, and a torn write can only
/// ever cost the one row that was being written rather than the whole store.
pub struct Providers {
    pub dir: PathBuf,
    pub health: BTreeMap<String, Health>,
}

/// A file name that is definitely a file name. Connection ids come from a user's
/// config and may contain anything at all; `../../etc/passwd` as an id must
/// produce a file called `.._.._etc_passwd`, not a write outside the store.
fn safe_name(id: &str) -> String {
    let mut s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    // A name that is only dots is still a traversal on some filesystems.
    if !s.is_empty() && s.chars().all(|c| c == '.') {
        s = format!("_{s}");
    }
    s.truncate(120);
    if s.is_empty() { "_".to_string() } else { s }
}

impl Providers {
    pub fn open(dir: PathBuf) -> Providers {
        let mut p = Providers { dir, health: BTreeMap::new() };
        let _ = fs::create_dir_all(p.store_dir());
        p.load();
        p
    }

    fn store_dir(&self) -> PathBuf {
        self.dir.join("providers")
    }

    fn load(&mut self) {
        let d = self.store_dir();
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
            if let Some(h) = json::parse(&s).as_ref().and_then(Health::from_value) {
                self.health.insert(h.id.clone(), h);
            }
        }
    }

    fn persist(&self, id: &str) {
        let h = match self.health.get(id) {
            Some(h) => h,
            None => return,
        };
        let d = self.store_dir();
        let _ = fs::create_dir_all(&d);
        let name = safe_name(id);
        let text = json::write(&h.to_value(now_ms()));
        // Write-then-rename: a reader never sees half a record.
        let tmp = d.join(format!("{name}.tmp"));
        let final_path = d.join(format!("{name}.json"));
        if fs::write(&tmp, text.as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &final_path);
        }
    }

    fn entry(&mut self, id: &str) -> &mut Health {
        self.health.entry(id.to_string()).or_insert_with(|| Health::new(id))
    }

    /// A REQUEST HAPPENED AND THIS IS HOW IT WENT.
    ///
    /// The whole learning surface, and it is deliberately the only one: health
    /// is learned from requests that were going to happen anyway, exactly as in
    /// `availability.js`. There is no ping loop here either, so a supervisor
    /// that nobody is using generates no traffic.
    ///
    /// `kind` is the classified failure — `RATE_LIMITED`, `AUTH`, or anything
    /// else — and it decides which of three quite different things happened.
    #[allow(clippy::too_many_arguments)]
    pub fn note(
        &mut self,
        id: &str,
        ok: bool,
        kind: &str,
        reason: &str,
        provider: &str,
        model: &str,
        reset_at: Option<u64>,
        threshold: u32,
    ) -> Health {
        let now = now_ms();
        let threshold = threshold.max(1);
        let h = self.entry(id);
        if !provider.is_empty() {
            h.provider = provider.to_string();
        }
        if !model.is_empty() {
            h.model = model.to_string();
        }

        // A DECISION A PERSON MADE IS NOT OVERRULED BY A REQUEST. Same rule as
        // USER_SET in availability.js.
        if h.status.is_user_set() {
            let out = h.clone();
            self.persist(id);
            return out;
        }

        if ok {
            // A REQUEST THAT WORKED IS THE PROOF A LIMIT HAS CLEARED, and it is
            // the only proof this file accepts. Time passing is a prediction;
            // a 200 is an observation.
            h.status = Status::Available;
            h.reason = String::new();
            h.consecutive_failures = 0;
            h.rate_limited = false;
            h.reset_at = None;
            h.last_success = Some(now);
            h.detected_at = now;
            let out = h.clone();
            self.persist(id);
            return out;
        }

        h.last_failure = Some(now);
        if !reason.is_empty() {
            h.reason = reason.to_string();
        }

        // AUTH IS NOT AN AVAILABILITY PROBLEM — the server answered, and it
        // answered about the credential. Counting it toward the breaker would
        // take a perfectly reachable route out of service for a reason the
        // breaker cannot fix.
        if kind == "AUTH" {
            if h.reason.is_empty() {
                h.reason = "authentication failed".to_string();
            }
            let out = h.clone();
            self.persist(id);
            return out;
        }

        h.consecutive_failures = h.consecutive_failures.saturating_add(1);

        if kind == "RATE_LIMITED" {
            h.rate_limited = true;
            // NOTHING IS INVENTED HERE. If the provider stated a reset we keep
            // it; if it did not, `reset_at` stays `None` and every reader is
            // expected to say so in words rather than draw a clock.
            h.reset_at = reset_at;
            if h.reason.is_empty() {
                h.reason = "rate limited".to_string();
            }
            // A RATE LIMIT IS NOT THE BREAKER, and conflating them loses the one
            // distinction that decides what to do: UNAVAILABLE means "we do not
            // know if it is up", rate limited means "it is up and will say no
            // until a stated time". Only the second has waiting as a fix.
            h.status = Status::Degraded;
            h.detected_at = now;
            let out = h.clone();
            self.persist(id);
            return out;
        }

        h.status = if h.consecutive_failures >= threshold {
            Status::Unavailable
        } else {
            Status::Degraded
        };
        h.detected_at = now;
        let out = h.clone();
        self.persist(id);
        out
    }

    /// A state a person set deliberately. Survives restarts on purpose: "I
    /// turned this route off" is not something a new process should forget.
    pub fn set(&mut self, id: &str, status: Status, reason: &str) -> Health {
        let now = now_ms();
        let h = self.entry(id);
        h.status = status;
        h.reason = reason.to_string();
        h.detected_at = now;
        if !status.is_user_set() {
            // Anything that is not MAINTENANCE/DISABLED is a reset to "we know
            // nothing", which is what `/provider retry` means.
            h.consecutive_failures = 0;
            h.rate_limited = false;
            h.reset_at = None;
        }
        let out = h.clone();
        self.persist(id);
        out
    }

    /// Back to knowing nothing — `/provider retry`, `/provider enable`.
    ///
    /// THE RATE-LIMIT FLAGS GO TOO. `availability.js` learned this the hard
    /// way: closing the breaker while leaving `rateLimited` set with a reset
    /// hours away is a control that appears to work and does nothing.
    pub fn clear(&mut self, id: &str) -> Health {
        self.set(id, Status::Unknown, "")
    }

    /// Forget a route entirely — used when a connection is removed from the
    /// config, so the store does not accumulate rows for routes that no longer
    /// exist.
    pub fn forget(&mut self, id: &str) -> bool {
        if self.health.remove(id).is_none() {
            return false;
        }
        let p = self.store_dir().join(format!("{}.json", safe_name(id)));
        let _ = fs::remove_file(p);
        true
    }

    pub fn all(&self, now: u64) -> Vec<Value> {
        self.health.values().map(|h| h.to_value(now)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lain-prov-{tag}-{}", now_ms()));
        let _ = fs::create_dir_all(&d);
        d
    }

    fn note_limit(p: &mut Providers, id: &str, reset_at: Option<u64>) -> Health {
        p.note(id, false, "RATE_LIMITED", "429 too many requests", "omniroute", "gemini", reset_at, FAILURE_THRESHOLD)
    }

    #[test]
    fn a_rate_limit_with_a_stated_reset_survives_a_restart() {
        // THE WHOLE POINT OF THE FILE, as a test. A four-hour limit learned by
        // one process is still known to the next one.
        let dir = tmp("restart");
        let reset = now_ms() + 4 * 3600 * 1000;
        {
            let mut p = Providers::open(dir.clone());
            note_limit(&mut p, "omniroute-main", Some(reset));
        }
        let p = Providers::open(dir);
        let h = p.health.get("omniroute-main").expect("the row survived");
        assert!(h.rate_limited, "still limited after a restart");
        assert_eq!(h.reset_at, Some(reset), "and it remembers WHEN, to the millisecond");
        assert!(h.limited_now(now_ms()), "so the door is still shut");
    }

    #[test]
    fn a_rate_limit_without_a_reset_time_never_invents_one() {
        // §9: "Do not invent a countdown." An unknown reset must stay unknown
        // all the way to the wire, and must not arrive as a zero that renders
        // as "clears now".
        let dir = tmp("noreset");
        let mut p = Providers::open(dir);
        let h = note_limit(&mut p, "provider-c", None);
        assert!(h.rate_limited);
        assert_eq!(h.reset_at, None, "nobody said when");
        let v = h.to_value(now_ms());
        assert_eq!(v.get("reset_at"), Some(&Value::Null));
        assert_eq!(v.get("resets_in_ms"), Some(&Value::Null), "null, never 0");
        assert!(h.limited_now(now_ms()), "and it blocks until something says otherwise");
    }

    #[test]
    fn a_stated_reset_in_the_past_stops_blocking() {
        let dir = tmp("expired");
        let mut p = Providers::open(dir);
        let past = now_ms().saturating_sub(60_000);
        let h = note_limit(&mut p, "provider-a", Some(past));
        assert!(h.rate_limited, "the flag is still on the record");
        assert!(!h.limited_now(now_ms()), "but the provider's own number says it is over");
    }

    #[test]
    fn only_a_successful_request_clears_the_flag() {
        // Time passing is a prediction; a request going through is an
        // observation. Only the second one is allowed to change the record.
        let dir = tmp("cleared");
        let mut p = Providers::open(dir);
        note_limit(&mut p, "r", Some(now_ms() + 3_600_000));
        let h = p.note("r", true, "", "", "omniroute", "gemini", None, FAILURE_THRESHOLD);
        assert!(!h.rate_limited);
        assert_eq!(h.reset_at, None, "and the countdown goes with it");
        assert_eq!(h.status, Status::Available);
    }

    #[test]
    fn an_auth_failure_never_opens_the_breaker() {
        let dir = tmp("auth");
        let mut p = Providers::open(dir);
        for _ in 0..5 {
            p.note("r", false, "AUTH", "401 unauthorized", "", "", None, FAILURE_THRESHOLD);
        }
        let h = p.health.get("r").unwrap();
        assert_eq!(h.status, Status::Unknown, "the server answered; it is reachable");
        assert_eq!(h.consecutive_failures, 0);
    }

    #[test]
    fn the_breaker_opens_on_the_threshold_and_a_rate_limit_is_not_the_breaker() {
        let dir = tmp("breaker");
        let mut p = Providers::open(dir);
        p.note("r", false, "NETWORK", "ECONNREFUSED", "", "", None, 2);
        assert_eq!(p.health.get("r").unwrap().status, Status::Degraded);
        p.note("r", false, "NETWORK", "ECONNREFUSED", "", "", None, 2);
        assert_eq!(p.health.get("r").unwrap().status, Status::Unavailable);

        // A rate limit on a different route must NOT read as unreachable — the
        // fix for one is to wait and the fix for the other is not.
        note_limit(&mut p, "s", Some(now_ms() + 1000));
        note_limit(&mut p, "s", Some(now_ms() + 1000));
        assert_eq!(p.health.get("s").unwrap().status, Status::Degraded);
    }

    #[test]
    fn a_state_a_person_set_is_not_overruled_by_a_request() {
        let dir = tmp("userset");
        let mut p = Providers::open(dir);
        p.set("r", Status::Disabled, "disabled by you");
        p.note("r", true, "", "", "", "", None, FAILURE_THRESHOLD);
        assert_eq!(p.health.get("r").unwrap().status, Status::Disabled, "a 200 does not re-enable it");
        note_limit(&mut p, "r", Some(now_ms() + 1000));
        assert!(!p.health.get("r").unwrap().rate_limited, "nor does a 429 rewrite it");
    }

    #[test]
    fn clearing_drops_the_countdown_as_well_as_the_breaker() {
        let dir = tmp("clear");
        let mut p = Providers::open(dir);
        note_limit(&mut p, "r", Some(now_ms() + 4 * 3600 * 1000));
        p.note("r", false, "NETWORK", "down", "", "", None, 1);
        let h = p.clear("r");
        assert_eq!(h.status, Status::Unknown);
        assert!(!h.rate_limited, "or the control does nothing at all");
        assert_eq!(h.reset_at, None);
        assert_eq!(h.consecutive_failures, 0);
    }

    #[test]
    fn a_hostile_connection_id_cannot_escape_the_store() {
        // §19: an id comes from a config file and is untrusted input.
        let dir = tmp("traversal");
        let mut p = Providers::open(dir.clone());
        p.note("../../pwned", false, "NETWORK", "x", "", "", None, 2);
        assert!(!dir.parent().map(|q| q.join("pwned.json").exists()).unwrap_or(false));
        assert!(dir.join("providers").join(".._.._pwned.json").exists(), "it lands inside the store");
        // And it still round-trips under its real id.
        let p2 = Providers::open(dir);
        assert!(p2.health.contains_key("../../pwned"));
    }

    #[test]
    fn user_set_state_survives_a_restart() {
        let dir = tmp("usersave");
        {
            let mut p = Providers::open(dir.clone());
            p.set("r", Status::Maintenance, "planned");
        }
        let p = Providers::open(dir);
        assert_eq!(p.health.get("r").unwrap().status, Status::Maintenance);
    }

    #[test]
    fn forgetting_a_route_removes_its_file() {
        let dir = tmp("forget");
        let mut p = Providers::open(dir.clone());
        p.note("gone", false, "NETWORK", "x", "", "", None, 2);
        assert!(dir.join("providers").join("gone.json").exists());
        assert!(p.forget("gone"));
        assert!(!dir.join("providers").join("gone.json").exists());
        assert!(!p.forget("gone"), "and saying so the second time");
    }
}
