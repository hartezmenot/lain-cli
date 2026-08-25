//! WHO MAY DRIVE LAIN FROM SOMEWHERE ELSE, AND WITH WHAT.
//!
//! ------------------------------------------------------------------------
//! THIS FILE HOLDS STATE AND ANSWERS QUESTIONS ABOUT AUTHORITY. It does not
//! speak HTTP, it does not poll, and it does not format a message. That is
//! `telegram.rs`, and the split is the same one §11 draws between a state
//! authority and a rendering adapter — here because there will be a second
//! adapter one day, and the first one must not have taken the authority with it.
//!
//! ------------------------------------------------------------------------
//! THE CREDENTIAL BELONGS TO THE MACHINE, NOT TO THE CONVERSATION.
//!
//! A bot token is not a fact about a session, so it is not in a session file. It
//! is not a fact about the work, so it is not in the transcript, the handover
//! packet, the evidence ledger or the model's context. It is a fact about THIS
//! COMPUTER — the same category as an SSH key — and it lives here, next to the
//! other things the runtime holds on the user's behalf and never says out loud.
//!
//! `snapshot()` IS THE ONLY WAY OUT, and it cannot carry the token: there is no
//! branch, no `include_secret` flag and no debug mode that emits it. What a
//! caller gets is the bot's IDENTITY — the name the user chose, which is not
//! secret and is exactly what they need to recognise the connection — and a
//! COUNT of authorized chats. Never the token, never a chat id.
//!
//! ------------------------------------------------------------------------
//! A TOKEN IS NOT AN AUTHORIZATION, and conflating them is how remote control
//! becomes a remote shell for a stranger.
//!
//! Anybody who finds the bot can message it. The token proves LAIN may act AS
//! the bot; it proves nothing about who is typing. So a chat is authorized only
//! by a PAIRING CODE shown in the local terminal — which is to say, by somebody
//! who already had the machine. The code expires, survives a limited number of
//! wrong guesses, and is single-use.
//!
//! Until a chat is paired it gets one sentence telling it to pair, and no
//! runtime information of any kind — not a job name, not a model name, not
//! whether LAIN is even doing anything.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::PathBuf;

use crate::json::{self, Value};

/// How long a pairing code is worth typing. Long enough to walk to a phone,
/// short enough that a code left on a screen overnight is not a key.
pub const PAIR_TTL_MS: u64 = 10 * 60 * 1000;

/// Wrong guesses before the code is burned. A code that could be guessed all
/// day is a code with no entropy requirement at all.
pub const PAIR_ATTEMPTS: u32 = 5;

/// Update ids kept for the duplicate check. Telegram's offset already prevents
/// redelivery in the normal case; this covers the abnormal one — see `seen`.
const SEEN_MAX: usize = 64;

/// The bot, as Telegram describes it. NO TOKEN IS PART OF IDENTITY.
#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub bot_id: i64,
    pub username: String,
    pub name: String,
}

/// A chat that has proved it belongs to the person at this machine.
#[derive(Debug, Clone)]
pub struct Chat {
    pub id: i64,
    /// For the terminal to say WHICH chat, when there is more than one. Held
    /// because a bare number is unrecognisable, and never sent anywhere.
    pub label: String,
    pub paired_at: u64,
}

/// The one-time code, while it is live.
#[derive(Debug, Clone)]
pub struct Pairing {
    pub code: String,
    pub expires_at: u64,
    pub attempts: u32,
}

/// WHAT THE ADAPTER IS ACTUALLY DOING. Reported as-is; never rounded up to
/// "connected" because a credential exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    /// No credential, or an explicit disconnect.
    Stopped,
    /// A credential exists and the poller has not yet completed a round trip.
    Starting,
    /// Long polling, with a successful round trip behind it.
    Listening,
    /// Was working, is retrying. The user is told, and told why.
    Degraded,
    /// Nothing on this machine can speak HTTPS. Not a failure to retry.
    Unavailable,
}

impl Link {
    pub fn as_str(self) -> &'static str {
        match self {
            Link::Stopped => "STOPPED",
            Link::Starting => "STARTING",
            Link::Listening => "LISTENING",
            Link::Degraded => "DEGRADED",
            Link::Unavailable => "UNAVAILABLE",
        }
    }
}

pub struct Remote {
    dir: PathBuf,
    /// THE SECRET. Private, and there is no accessor that returns it to a
    /// client — `telegram.rs` takes a copy to make a request with and that is
    /// the only reader.
    token: String,
    pub identity: Identity,
    pub connected_at: u64,
    pub chats: BTreeMap<i64, Chat>,
    pub pairing: Option<Pairing>,
    pub link: Link,
    /// Already scrubbed of the token by `http::scrub` before it arrives here.
    pub last_error: String,
    pub last_ok_at: u64,
    /// Telegram's cursor. Persisted, so a supervisor restart does not replay
    /// every command the user sent while it was down.
    pub offset: i64,
    seen: VecDeque<i64>,
    /// ---- THE REMOTE VOICE ------------------------------------------------
    ///
    /// A place a model lives, in the shape LAIN already uses for one: a base
    /// URL and a model name. NOT A NEW PROVIDER SYSTEM - `/rc` picks one of the
    /// connections the user already has, and only a local one, so the
    /// conversational layer of remote control runs on the user's own machine.
    ///
    /// `brain_key` is private for the same reason `token` is. It is normally
    /// empty: a local endpoint wants no credential.
    pub brain_base: String,
    pub brain_model: String,
    brain_key: String,
    /// How far the notifier has read. Persisted so a supervisor restart does
    /// not replay yesterday's events into somebody's phone at breakfast.
    pub notified_runtime: usize,
    pub notified_jobs: usize,
    /// Bumped by disconnect and reconnect. A poll thread whose generation no
    /// longer matches exits on its next turn of the loop, which is how a thread
    /// blocked in a 25-second long poll is retired without being killed.
    pub generation: u64,
}

pub fn now() -> u64 {
    crate::jobs::now()
}

impl Remote {
    pub fn open(dir: PathBuf) -> Remote {
        let mut r = Remote {
            dir,
            token: String::new(),
            identity: Identity::default(),
            connected_at: 0,
            chats: BTreeMap::new(),
            pairing: None,
            link: Link::Stopped,
            last_error: String::new(),
            last_ok_at: 0,
            offset: 0,
            seen: VecDeque::new(),
            brain_base: String::new(),
            brain_model: String::new(),
            brain_key: String::new(),
            notified_runtime: 0,
            notified_jobs: 0,
            generation: 0,
        };
        let _ = fs::create_dir_all(r.store_dir());
        r.load();
        r
    }

    pub fn store_dir(&self) -> PathBuf {
        self.dir.join("remote")
    }

    fn cred_file(&self) -> PathBuf {
        self.store_dir().join("telegram.json")
    }

    /// AUTHORIZATION IS A SEPARATE FILE from the credential, and deliberately.
    /// `/rc disconnect` removes both, but the two answer different questions —
    /// "may LAIN act as this bot" and "whose messages count" — and a future
    /// second adapter will share the second without sharing the first.
    fn chats_file(&self) -> PathBuf {
        self.store_dir().join("authorized.json")
    }

    /// A THIRD FILE, because it is a third subject. The bot credential says who
    /// LAIN may speak as; the authorizations say whose messages count; this says
    /// which local model does the talking. Deleting one must not delete another.
    fn brain_file(&self) -> PathBuf {
        self.store_dir().join("brain.json")
    }

    fn read(path: &PathBuf) -> Option<Value> {
        let mut s = String::new();
        fs::File::open(path).and_then(|mut f| f.read_to_string(&mut s)).ok()?;
        json::parse(&s)
    }

    /// Write-then-rename, and as close to owner-only as the platform allows.
    fn write(path: &PathBuf, v: &Value) {
        let dir = match path.parent() {
            Some(d) => d.to_path_buf(),
            None => return,
        };
        let _ = fs::create_dir_all(&dir);
        let tmp = dir.join(format!(
            "{}.tmp",
            path.file_name().and_then(|s| s.to_str()).unwrap_or("x")
        ));
        if fs::write(&tmp, json::write(v).as_bytes()).is_err() {
            return;
        }
        restrict(&tmp);
        let _ = fs::rename(&tmp, path);
        restrict(path);
    }

    fn load(&mut self) {
        if let Some(v) = Self::read(&self.cred_file()) {
            let t = v.str("token");
            if crate::http::valid_token(&t) {
                self.token = t;
                self.identity = Identity {
                    bot_id: v.num("bot_id").unwrap_or(0.0) as i64,
                    username: v.str("username"),
                    name: v.str("name"),
                };
                self.connected_at = v.num("connected_at").unwrap_or(0.0).max(0.0) as u64;
                self.offset = v.num("offset").unwrap_or(0.0) as i64;
                // A CREDENTIAL ON DISK IS NOT A LIVE CONNECTION. It becomes
                // LISTENING when a round trip proves it, and not before.
                self.link = Link::Starting;
            }
        }
        if let Some(v) = Self::read(&self.brain_file()) {
            self.brain_base = v.str("base_url");
            self.brain_model = v.str("model");
            self.brain_key = v.str("key");
            self.notified_runtime = v.num("notified_runtime").unwrap_or(0.0).max(0.0) as usize;
            self.notified_jobs = v.num("notified_jobs").unwrap_or(0.0).max(0.0) as usize;
        }
        if let Some(v) = Self::read(&self.chats_file()) {
            if let Some(Value::Arr(rows)) = v.get("chats") {
                for row in rows {
                    let id = row.num("id").unwrap_or(0.0) as i64;
                    if id == 0 {
                        continue;
                    }
                    self.chats.insert(
                        id,
                        Chat {
                            id,
                            label: row.str("label"),
                            paired_at: row.num("paired_at").unwrap_or(0.0).max(0.0) as u64,
                        },
                    );
                }
            }
            if let Some(p) = v.get("pairing") {
                let code = p.str("code");
                let expires_at = p.num("expires_at").unwrap_or(0.0).max(0.0) as u64;
                if !code.is_empty() && expires_at > now() {
                    self.pairing = Some(Pairing {
                        code,
                        expires_at,
                        attempts: p.num("attempts").unwrap_or(0.0).max(0.0) as u32,
                    });
                }
            }
        }
    }

    fn save_cred(&self) {
        if self.token.is_empty() {
            return;
        }
        let mut v = Value::obj();
        v.set("token", Value::s(&self.token));
        v.set("bot_id", Value::n(self.identity.bot_id));
        v.set("username", Value::s(&self.identity.username));
        v.set("name", Value::s(&self.identity.name));
        v.set("connected_at", Value::n(self.connected_at as i64));
        v.set("offset", Value::n(self.offset));
        Self::write(&self.cred_file(), &v);
    }

    fn save_chats(&self) {
        let mut v = Value::obj();
        let rows: Vec<Value> = self
            .chats
            .values()
            .map(|c| {
                let mut r = Value::obj();
                r.set("id", Value::n(c.id));
                r.set("label", Value::s(&c.label));
                r.set("paired_at", Value::n(c.paired_at as i64));
                r
            })
            .collect();
        v.set("chats", Value::Arr(rows));
        if let Some(p) = &self.pairing {
            let mut pv = Value::obj();
            pv.set("code", Value::s(&p.code));
            pv.set("expires_at", Value::n(p.expires_at as i64));
            pv.set("attempts", Value::n(p.attempts as i64));
            v.set("pairing", pv);
        }
        Self::write(&self.chats_file(), &v);
    }

    fn save_brain(&self) {
        let mut v = Value::obj();
        v.set("base_url", Value::s(&self.brain_base));
        v.set("model", Value::s(&self.brain_model));
        v.set("key", Value::s(&self.brain_key));
        v.set("notified_runtime", Value::n(self.notified_runtime as i64));
        v.set("notified_jobs", Value::n(self.notified_jobs as i64));
        Self::write(&self.brain_file(), &v);
    }

    /// WHICH LOCAL MODEL SPEAKS FOR LAIN. Chosen by `/rc` from the connections
    /// the user already has.
    pub fn set_brain(&mut self, base_url: &str, model: &str, key: &str) {
        self.brain_base = base_url.trim().to_string();
        self.brain_model = model.trim().to_string();
        self.brain_key = key.trim().to_string();
        self.save_brain();
    }

    /// The configuration the conversational layer needs, credential included.
    /// Not reachable over the socket - see `snapshot`.
    pub fn brain(&self) -> crate::brain::Cfg {
        crate::brain::Cfg {
            base_url: self.brain_base.clone(),
            model: self.brain_model.clone(),
            key: self.brain_key.clone(),
        }
    }

    pub fn note_notified(&mut self, runtime_seq: usize, jobs_seq: usize) {
        if runtime_seq > self.notified_runtime {
            self.notified_runtime = runtime_seq;
        }
        if jobs_seq > self.notified_jobs {
            self.notified_jobs = jobs_seq;
        }
        self.save_brain();
    }

    pub fn configured(&self) -> bool {
        !self.token.is_empty()
    }

    /// The one reader of the credential. Used by the adapter to make a request
    /// and by nothing else; it is not reachable over the socket.
    pub fn token(&self) -> String {
        self.token.clone()
    }

    /// A VALIDATED credential arrives. The caller has already proved it against
    /// `getMe` — this stores what that proved, and nothing is stored on the
    /// strength of a token that was merely typed.
    pub fn connect(&mut self, token: &str, identity: Identity) {
        self.token = token.trim().to_string();
        self.identity = identity;
        self.connected_at = now();
        self.link = Link::Starting;
        self.last_error.clear();
        self.generation += 1;
        // A NEW CREDENTIAL IS A NEW BOT until proved otherwise, so the cursor
        // starts clean. Replaying another bot's backlog would be worse than
        // missing a message.
        self.offset = 0;
        self.seen.clear();
        self.save_cred();
        self.save_chats();
    }

    /// GONE MEANS GONE — §14. The files are removed, not blanked; the state is
    /// cleared, not hidden; and the generation bump retires the poll thread.
    ///
    /// A RESTART MUST NOT SILENTLY RECONNECT, which is exactly what would happen
    /// if this only stopped the adapter and left the credential on disk.
    pub fn disconnect(&mut self) -> bool {
        let had = self.configured() || !self.chats.is_empty();
        self.token.clear();
        self.identity = Identity::default();
        self.connected_at = 0;
        self.chats.clear();
        self.pairing = None;
        self.link = Link::Stopped;
        self.last_error.clear();
        self.last_ok_at = 0;
        self.offset = 0;
        self.seen.clear();
        self.generation += 1;
        let _ = fs::remove_file(self.cred_file());
        let _ = fs::remove_file(self.chats_file());
        // THE LOCAL MODEL CHOICE SURVIVES A DISCONNECT, deliberately. It is not
        // a Telegram credential and it authorizes nobody - it is the user's own
        // note of which model on their own machine does the talking. Throwing it
        // away would make reconnecting a two-step chore for no security gain.
        had
    }

    /// Restart the adapter, keeping the credential and the authorizations.
    pub fn reconnect(&mut self) {
        if !self.configured() {
            return;
        }
        self.generation += 1;
        self.link = Link::Starting;
        self.last_error.clear();
    }

    pub fn note_ok(&mut self) {
        self.link = Link::Listening;
        self.last_ok_at = now();
        self.last_error.clear();
    }

    pub fn note_error(&mut self, why: &str) {
        // Only DEGRADED once there was something to degrade from; a first
        // attempt that fails is still starting up.
        self.link = if self.link == Link::Listening || self.last_ok_at > 0 {
            Link::Degraded
        } else {
            Link::Starting
        };
        self.last_error = why.chars().take(200).collect();
    }

    pub fn note_unavailable(&mut self, why: &str) {
        self.link = Link::Unavailable;
        self.last_error = why.chars().take(200).collect();
    }

    pub fn set_offset(&mut self, offset: i64) {
        if offset > self.offset {
            self.offset = offset;
            self.save_cred();
        }
    }

    /// HAS THIS UPDATE ALREADY BEEN ACTED ON?
    ///
    /// The offset alone is nearly enough: Telegram stops redelivering an update
    /// once a higher offset is confirmed. NEARLY is the problem — the confirming
    /// request can itself fail, and a supervisor that dies between executing a
    /// command and persisting the cursor will be handed the same update again.
    /// Running `/stop` twice because a socket blinked is not acceptable, so the
    /// ids are remembered too.
    pub fn seen(&mut self, update_id: i64) -> bool {
        if self.seen.contains(&update_id) {
            return true;
        }
        self.seen.push_back(update_id);
        while self.seen.len() > SEEN_MAX {
            self.seen.pop_front();
        }
        false
    }

    // ---- AUTHORIZATION ----------------------------------------------------

    pub fn authorized(&self, chat_id: i64) -> bool {
        self.chats.contains_key(&chat_id)
    }

    /// Mint a one-time code. Any previous code is replaced — two live codes
    /// would double the guessing surface for no benefit.
    pub fn new_pairing(&mut self) -> String {
        let code = mint_code();
        self.pairing = Some(Pairing { code: code.clone(), expires_at: now() + PAIR_TTL_MS, attempts: 0 });
        self.save_chats();
        code
    }

    /// Someone typed a code at the bot.
    ///
    /// Returns the reason it failed, or `None` on success. The reasons are
    /// deliberately generic to the sender: an attacker learns only that they
    /// were wrong, never how close they were or whether a code exists.
    pub fn try_pair(&mut self, code: &str, chat_id: i64, label: &str) -> Option<&'static str> {
        let want = match &mut self.pairing {
            Some(p) => p,
            None => return Some("no pairing is open"),
        };
        if now() > want.expires_at {
            self.pairing = None;
            self.save_chats();
            return Some("that code has expired");
        }
        if want.attempts >= PAIR_ATTEMPTS {
            self.pairing = None;
            self.save_chats();
            return Some("too many attempts — run /rc reconnect for a new code");
        }
        // Case-insensitive and dash-insensitive: the code is read off a screen
        // and typed on a phone, and rejecting `a7k2x91q` would be pedantry.
        let norm = |s: &str| -> String {
            s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
        };
        if norm(code) != norm(&want.code) {
            want.attempts += 1;
            self.save_chats();
            return Some("that code is not right");
        }
        // SINGLE USE. The code is spent whether or not another chat wanted it.
        self.pairing = None;
        self.chats.insert(
            chat_id,
            Chat { id: chat_id, label: label.chars().take(60).collect(), paired_at: now() },
        );
        self.save_chats();
        None
    }

    pub fn pairing_open(&self) -> Option<&Pairing> {
        match &self.pairing {
            Some(p) if now() <= p.expires_at => Some(p),
            _ => None,
        }
    }

    /// WHAT A CLIENT IS ALLOWED TO KNOW. No token, no chat ids, no exceptions.
    pub fn snapshot(&self) -> Value {
        let mut v = Value::obj();
        v.set("configured", Value::Bool(self.configured()));
        v.set("link", Value::s(self.link.as_str()));
        v.set("bot_username", Value::s(&self.identity.username));
        v.set("bot_name", Value::s(&self.identity.name));
        v.set("authorized_chats", Value::n(self.chats.len() as i64));
        v.set("connected_at", Value::n(self.connected_at as i64));
        v.set("last_ok_at", Value::n(self.last_ok_at as i64));
        v.set("last_error", Value::s(&self.last_error));
        v.set("transport", Value::Bool(crate::http::available()));
        // ---- THE VOICE, WITHOUT ITS CREDENTIAL -----------------------------
        //
        // The endpoint and the model name are shown because a person needs to
        // recognise which model is answering for them. `brain_key` has no
        // projection here and no op that returns it.
        v.set("brain_configured", Value::Bool(!self.brain_base.is_empty() && !self.brain_model.is_empty()));
        v.set("brain_endpoint", Value::s(&self.brain_base));
        v.set("brain_model", Value::s(&self.brain_model));
        match self.pairing_open() {
            // The code IS shown — it is meant to be read off this screen, and it
            // travels only over the loopback socket to the terminal that asked.
            // It is never written to the event log; see `remote_op` in main.rs.
            Some(p) => {
                v.set("pairing_code", Value::s(&p.code));
                v.set("pairing_expires_at", Value::n(p.expires_at as i64));
            }
            None => {
                v.set("pairing_code", Value::Null);
            }
        }
        v
    }
}

/// Owner-only where the platform has a concept of it.
///
/// WINDOWS IS NOT HANDLED HERE AND THAT IS STATED RATHER THAN PAPERED OVER.
/// `std::fs` has no ACL API, and a hand-rolled `icacls` call would be a process
/// spawn whose failure nobody would notice. On Windows the file inherits the
/// protection of the user profile directory it sits in, which is the same
/// protection `config.json` — holding every model API key — already relies on.
fn restrict(path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Unambiguous on a screen: no O/0, no I/1/L.
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// A ONE-TIME CODE, WITHOUT A RANDOM CRATE.
///
/// splitmix64 over the nanosecond clock, this process's id and a counter that
/// makes two codes minted in the same nanosecond differ. Eight symbols from a
/// 31-symbol alphabet is a shade under 40 bits.
///
/// THIS IS NOT A CRYPTOGRAPHIC KEY and is not asked to be one. It is guarded by
/// a ten-minute expiry and five attempts, over a channel where each guess is a
/// round trip to Telegram — which puts a brute force at some 10^10 years. What
/// it must resist is a person guessing, and it does.
fn mint_code() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = nanos
        ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0xD1B5_4A32_D192_ED03);
    let mut next = || -> u64 {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    let mut out = String::with_capacity(9);
    for i in 0..8 {
        if i == 4 {
            out.push('-');
        }
        out.push(ALPHABET[(next() % ALPHABET.len() as u64) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> Remote {
        let d = std::env::temp_dir().join(format!("lain-remote-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        Remote::open(d)
    }

    fn ident() -> Identity {
        Identity { bot_id: 77, username: "lain_remote_bot".into(), name: "Lain Remote".into() }
    }

    const TOKEN: &str = "000000000:AAAAAAAAAAAA";

    #[test]
    fn what_a_client_can_see_never_contains_the_token() {
        let mut r = store("snapshot");
        r.connect(TOKEN, ident());
        let text = json::write(&r.snapshot());
        assert!(!text.contains(TOKEN), "the snapshot leaked the credential");
        assert!(!text.contains("AAAAAAAAAAAA"));
        // What it DOES carry is the identity, which is the part a person needs.
        assert!(text.contains("Lain Remote"));
        assert!(text.contains("\"configured\":true"));
    }

    #[test]
    fn the_local_model_credential_is_no_more_visible_than_the_bot_token() {
        let mut r = store("brainsecret");
        r.connect(TOKEN, ident());
        r.set_brain("http://127.0.0.1:11434/v1", "qwen2.5:3b", "sk-local-secret-value-12345");
        let text = json::write(&r.snapshot());
        assert!(!text.contains("sk-local-secret-value-12345"), "the model key leaked");
        // The endpoint and model name ARE shown - a person must be able to see
        // which model is answering for them.
        assert!(text.contains("11434"));
        assert!(text.contains("qwen2.5:3b"));
        assert!(text.contains("\"brain_configured\":true"));
    }

    #[test]
    fn disconnecting_telegram_keeps_the_local_model_choice() {
        let mut r = store("brainkeep");
        r.connect(TOKEN, ident());
        r.set_brain("http://127.0.0.1:11434/v1", "qwen2.5:3b", "");
        r.disconnect();
        assert!(!r.configured(), "the bot credential is gone");
        assert_eq!(r.brain_model, "qwen2.5:3b", "the model choice is not a Telegram credential");
    }

    #[test]
    fn a_credential_outlives_the_process_that_stored_it() {
        let mut r = store("persist");
        r.connect(TOKEN, ident());
        r.set_offset(42);
        let dir = r.store_dir().parent().unwrap().to_path_buf();
        let again = Remote::open(dir);
        assert!(again.configured());
        assert_eq!(again.token(), TOKEN);
        assert_eq!(again.identity.username, "lain_remote_bot");
        assert_eq!(again.offset, 42);
        // AND IT IS NOT LISTENING UNTIL SOMETHING PROVES IT IS.
        assert_eq!(again.link, Link::Starting);
    }

    #[test]
    fn disconnect_removes_the_credential_rather_than_hiding_it() {
        let mut r = store("disconnect");
        r.connect(TOKEN, ident());
        r.new_pairing();
        let code = r.pairing_open().unwrap().code.clone();
        assert!(r.try_pair(&code, 500, "someone").is_none());
        let dir = r.store_dir().parent().unwrap().to_path_buf();
        let gen_before = r.generation;

        assert!(r.disconnect());
        assert!(!r.configured());
        assert!(r.chats.is_empty());
        assert!(r.generation > gen_before, "the poller must be retired");
        assert!(!r.store_dir().join("telegram.json").exists());
        assert!(!r.store_dir().join("authorized.json").exists());

        // AND A RESTART MUST NOT QUIETLY BRING IT BACK — §14.
        let again = Remote::open(dir);
        assert!(!again.configured());
        assert!(again.chats.is_empty());
        assert_eq!(again.link, Link::Stopped);
    }

    #[test]
    fn a_chat_is_authorized_by_a_code_and_by_nothing_else() {
        let mut r = store("pair");
        r.connect(TOKEN, ident());
        assert!(!r.authorized(900), "a stranger who found the bot is not authorized");
        let code = r.new_pairing();
        assert!(r.try_pair("WRONG-CODE", 900, "stranger").is_some());
        assert!(!r.authorized(900));
        // Typed off a screen onto a phone: case and dashes must not matter.
        let sloppy = code.replace('-', "").to_ascii_lowercase();
        assert!(r.try_pair(&sloppy, 900, "the user").is_none());
        assert!(r.authorized(900));
        // SINGLE USE.
        assert!(r.try_pair(&code, 901, "second phone").is_some());
        assert!(!r.authorized(901));
    }

    #[test]
    fn a_code_is_guessed_only_so_many_times_and_then_it_is_gone() {
        let mut r = store("attempts");
        r.connect(TOKEN, ident());
        let code = r.new_pairing();
        for _ in 0..PAIR_ATTEMPTS {
            assert!(r.try_pair("AAAA-AAAA", 900, "x").is_some());
        }
        // The right code no longer works either — the code is burned, not the
        // guesser, because the guesser can change chats and the code cannot.
        assert!(r.try_pair(&code, 900, "x").is_some());
        assert!(!r.authorized(900));
        assert!(r.pairing_open().is_none());
    }

    #[test]
    fn an_expired_code_authorizes_nobody() {
        let mut r = store("expiry");
        r.connect(TOKEN, ident());
        r.new_pairing();
        let code = r.pairing.as_ref().unwrap().code.clone();
        if let Some(p) = &mut r.pairing {
            p.expires_at = now().saturating_sub(1);
        }
        assert!(r.pairing_open().is_none());
        assert_eq!(r.try_pair(&code, 900, "x"), Some("that code has expired"));
        assert!(!r.authorized(900));
    }

    #[test]
    fn the_same_update_is_never_acted_on_twice() {
        let mut r = store("dedupe");
        assert!(!r.seen(10));
        assert!(r.seen(10), "the second sighting of one update id is a duplicate");
        assert!(!r.seen(11));
        // And the window does not grow without bound.
        for i in 100..(100 + SEEN_MAX as i64 + 10) {
            r.seen(i);
        }
        assert!(r.seen.len() <= SEEN_MAX);
    }

    #[test]
    fn a_failure_degrades_and_a_success_recovers_without_losing_the_reason() {
        let mut r = store("degrade");
        r.connect(TOKEN, ident());
        r.note_error("connection reset");
        // Nothing had worked yet, so this is still coming up, not degraded.
        assert_eq!(r.link, Link::Starting);
        r.note_ok();
        assert_eq!(r.link, Link::Listening);
        r.note_error("connection reset");
        assert_eq!(r.link, Link::Degraded);
        assert!(r.snapshot().str("last_error").contains("reset"));
        r.note_ok();
        assert_eq!(r.link, Link::Listening);
        assert!(r.snapshot().str("last_error").is_empty());
    }

    #[test]
    fn codes_differ_and_read_cleanly() {
        let a = mint_code();
        let b = mint_code();
        assert_ne!(a, b);
        assert_eq!(a.len(), 9);
        assert!(a.contains('-'));
        for c in a.chars().filter(|c| *c != '-') {
            assert!(ALPHABET.contains(&(c as u8)), "{c} is ambiguous on a screen");
        }
    }
}
