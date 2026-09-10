//! HTTPS, FOR A PROCESS THAT HAS NO DEPENDENCIES.
//!
//! ------------------------------------------------------------------------
//! THE PROBLEM, STATED PLAINLY. This crate has no crates. That is deliberate
//! and it is stated at the top of json.rs: the supervisor is the part of LAIN
//! that must still be running when everything else has died, and a process with
//! no dependency tree builds anywhere and starts every time.
//!
//! Telegram is HTTPS only. A TLS 1.3 client is somewhere north of ten thousand
//! lines of cryptography that must be right, and writing one by hand to avoid
//! adding `rustls` would be the single worst decision in this repository.
//!
//! So neither. THE TLS IS BORROWED FROM A PROGRAM THAT ALREADY SHIPS ON EVERY
//! MACHINE THIS RUNS ON — `curl`, present in Windows since 1803, in macOS
//! since forever, and in every Linux LAIN has ever been started on. It is used
//! as a transport and nothing else: this file builds a request, hands it over,
//! and parses what comes back.
//!
//! WHAT IS HONESTLY GIVEN UP by doing it this way, so nobody discovers it later:
//!
//!   * a process spawn per request — about 20ms, against a 25-SECOND long poll,
//!     which is the only thing this is used for
//!   * no connection reuse
//!   * `curl` missing is a REPORTED, VISIBLE state (`Link::Unavailable`) and
//!     never a silent failure or a pretend success
//!
//! ------------------------------------------------------------------------
//! THE TOKEN NEVER APPEARS IN A COMMAND LINE. This is the whole reason the
//! request is built the way it is.
//!
//! A bot token belongs in the URL — `api.telegram.org/bot<TOKEN>/getMe` — and a
//! URL belongs in argv, and argv is WORLD-READABLE. Any process on the machine
//! running `ps`, `tasklist /v`, or reading `/proc/<pid>/cmdline` would have the
//! credential, and it would sit in shell history and in any process accounting
//! the machine happens to keep.
//!
//! So the request is written to `curl --config -` ON STDIN. The command line is
//! exactly `curl --config -` on every call, whatever the token is, and the
//! credential exists only in a pipe between two processes that are both ours.
//!
//! ------------------------------------------------------------------------
//! AND IT IS SCRUBBED ON THE WAY BACK. `curl` quotes the URL it failed to reach
//! in several of its error messages, so any text this returns has the token
//! replaced first — see `scrub`. A credential that leaks through an error
//! message has leaked, and "it was only the failure path" is not a defence.

use std::io::Write;
use std::process::{Command, Stdio};

pub(crate) fn curl_command() -> Command {
    #[allow(unused_mut)] // mutated only by the Windows extension below
    let mut command = Command::new(curl());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A detached supervisor has no console to inherit. Each HTTP request
        // must remain a background operation, without allocating a new window.
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

/// What came back. `status` is 0 when nothing was reached at all, which is a
/// different thing from a server that answered 500 and is kept different.
pub struct Reply {
    pub status: u16,
    pub body: String,
    /// Transport-level failure, already scrubbed. Empty when the request was
    /// made at all, whatever the server thought of it.
    pub error: String,
}

impl Reply {
    pub fn ok(&self) -> bool {
        self.error.is_empty() && self.status >= 200 && self.status < 300
    }
}

/// The marker `--write-out` appends so the status code can be split off the
/// body. Chosen to be something no JSON document contains.
///
/// IT CONTAINS NO NEWLINE, and that is not a style choice. A curl config file is
/// parsed LINE BY LINE, so a value carrying a real newline ends the option and
/// the remainder is read as a second, unknown one. It did: every request failed
/// with `config file option '<<<lain-status' is unknown` — which reads like a
/// network problem and is a quoting problem.
const MARK: &str = "<<<lain-status:";

/// A bot token, before it is ever used for anything.
///
/// Telegram's shape is `<digits>:<35 url-safe characters>`, and checking it here
/// is not politeness — it is what makes the config-file quoting below safe. A
/// value containing a quote or a backslash could otherwise end the `url = "…"`
/// line early and turn the rest of the credential into curl options.
///
/// REFUSED, NOT ESCAPED. Escaping would work and would leave the safety of the
/// whole file resting on one function being right forever; refusing anything
/// unexpected costs a user with a malformed token one clear sentence.
pub fn valid_token(token: &str) -> bool {
    let t = token.trim();
    if t.len() < 20 || t.len() > 120 {
        return false;
    }
    let mut parts = t.splitn(2, ':');
    let id = parts.next().unwrap_or("");
    let secret = parts.next().unwrap_or("");
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if secret.len() < 10 {
        return false;
    }
    secret
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Hold the credential out of any text that is about to be shown or logged.
///
/// Called on every string this module returns. It is cheap and it is the last
/// line of defence — `remote.rs` also refuses to log bodies, and both are true
/// at once on purpose.
pub fn scrub(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    let mut out = text.replace(token, "<token>");
    // The secret half alone is still the secret half.
    if let Some((_, secret)) = token.split_once(':') {
        if secret.len() >= 10 {
            out = out.replace(secret, "<token>");
        }
    }
    out
}

/// Percent-encode a query value. Everything outside the unreserved set goes,
/// which keeps quotes and backslashes out of the config line by construction.
pub fn q(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Is there a transport at all? Cached for the life of the process — a machine
/// does not grow a `curl` while the supervisor is running, and asking on every
/// poll would be a process spawn to answer a question with a constant answer.
pub fn available() -> bool {
    use std::sync::OnceLock;
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| {
        curl_command()
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

fn curl() -> String {
    // Overridable for a machine that keeps it somewhere unusual. Not a secret
    // and not a URL, so it may live in the environment.
    std::env::var("LAIN_CURL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "curl".to_string())
}

/// Where the Bot API lives.
///
/// OVERRIDABLE, and that override is what makes this testable without ever
/// touching Telegram: the integration tier points it at a local HTTP server and
/// exercises the real polling loop, the real dedupe and the real command
/// dispatch against a fake that answers in Telegram's shape. See
/// tests/integration/remote.test.js.
pub fn api_base() -> String {
    std::env::var("LAIN_TELEGRAM_API")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.telegram.org".to_string())
}

/// ONE REQUEST.
///
/// `method` is a Bot API method name (`getMe`, `getUpdates`, `sendMessage`) and
/// `params` are its query arguments. Everything is GET: the three methods this
/// needs accept query parameters, and a GET with an encoded query is one less
/// shape to get wrong than a POST body.
pub fn call(token: &str, method: &str, params: &[(&str, String)], timeout_secs: u32) -> Reply {
    let fail = |why: &str| Reply { status: 0, body: String::new(), error: scrub(why, token) };

    if !valid_token(token) {
        // Never says what was wrong with it beyond the shape, and never quotes it.
        return fail("the stored bot token is not in Telegram's format");
    }
    if !available() {
        return fail("no HTTPS transport: curl was not found on this machine");
    }

    let mut url = format!("{}/bot{}/{}", api_base().trim_end_matches('/'), token, method);
    if !params.is_empty() {
        url.push('?');
        let mut first = true;
        for (k, v) in params {
            if !first {
                url.push('&');
            }
            first = false;
            url.push_str(k);
            url.push('=');
            url.push_str(&q(v));
        }
    }

    // ---- THE CONFIG, WHICH IS THE PART THAT MATTERS -------------------------
    //
    // Every value here is either a constant or has been percent-encoded above,
    // so no quote or backslash can reach a config line and end it early.
    let config = format!(
        "url = \"{url}\"\n\
         silent\n\
         show-error\n\
         max-time = {timeout}\n\
         connect-timeout = 15\n\
         write-out = \"{MARK}%{{http_code}}\"\n",
        url = url,
        timeout = timeout_secs.max(1),
        MARK = MARK,
    );

    let mut child = match curl_command()
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return fail(&format!("could not run curl: {e}")),
    };

    if let Some(mut sink) = child.stdin.take() {
        // A WRITE THAT FAILS IS NOT IGNORED. curl exiting before it read the
        // config would otherwise look like an empty request rather than a
        // broken one.
        if sink.write_all(config.as_bytes()).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return fail("the request could not be handed to curl");
        }
        drop(sink);
    }

    let out = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return fail(&format!("curl did not complete: {e}")),
    };

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    match stdout.rsplit_once(MARK) {
        Some((body, code)) => Reply {
            status: code.trim().parse::<u16>().unwrap_or(0),
            body: body.to_string(),
            error: String::new(),
        },
        None => {
            // No marker means curl never got as far as a response.
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let why = stderr.trim();
            fail(if why.is_empty() { "the request did not reach Telegram" } else { why })
        }
    }
}

/// ---------------------------------------------------------------------------
/// A JSON POST, for the local model.
///
/// SAME RULE AS ABOVE AND FOR THE SAME REASON: nothing sensitive reaches argv.
/// The URL, the body and any Authorization header all travel in the config on
/// stdin, and the body itself goes through a temporary file because a curl
/// config can carry `data = "@path"` but cannot carry a multi-line JSON
/// document safely inline.
///
/// THE TEMPORARY FILE IS REMOVED WHETHER OR NOT THE REQUEST WORKED. It holds a
/// prompt, which is the user's business.
pub fn post_json(url: &str, bearer: &str, body: &str, timeout_secs: u32) -> Reply {
    let fail = |why: &str| Reply { status: 0, body: String::new(), error: scrub(why, bearer) };
    if !available() {
        return fail("no HTTP transport: curl was not found on this machine");
    }
    // A URL OR A HEADER THAT COULD END THE CONFIG LINE IS REFUSED, not escaped.
    // See `valid_token` for why refusing is the safer half of that choice.
    if url.contains('"') || url.contains('\\') || url.contains('\n') || url.trim().is_empty() {
        return fail("that endpoint URL cannot be used safely");
    }
    if bearer.contains('"') || bearer.contains('\\') || bearer.contains('\n') {
        return fail("that credential cannot be sent safely");
    }

    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "lain-rc-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if std::fs::write(&path, body.as_bytes()).is_err() {
        return fail("the request body could not be staged");
    }
    let body_path = path.to_string_lossy().replace('\\', "/");

    let mut config = format!(
        "url = \"{url}\"\n\
         silent\n\
         show-error\n\
         max-time = {timeout}\n\
         connect-timeout = 10\n\
         header = \"Content-Type: application/json\"\n\
         data = \"@{body_path}\"\n\
         write-out = \"{MARK}%{{http_code}}\"\n",
        url = url,
        timeout = timeout_secs.max(1),
        body_path = body_path,
        MARK = MARK,
    );
    if !bearer.is_empty() {
        config.push_str(&format!("header = \"Authorization: Bearer {bearer}\"\n"));
    }

    let out = run_curl(&config);
    let _ = std::fs::remove_file(&path);
    match out {
        Ok((stdout, stderr)) => match stdout.rsplit_once(MARK) {
            Some((b, code)) => Reply {
                status: code.trim().parse::<u16>().unwrap_or(0),
                body: b.to_string(),
                error: String::new(),
            },
            None => {
                let why = stderr.trim().to_string();
                fail(if why.is_empty() { "the request did not reach the endpoint" } else { &why })
            }
        },
        Err(e) => fail(&e),
    }
}

/// One curl invocation with a config on stdin. Shared so there is exactly one
/// place where the credential-bearing config is handed over.
fn run_curl(config: &str) -> Result<(String, String), String> {
    let mut child = curl_command()
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if let Some(mut sink) = child.stdin.take() {
        if sink.write_all(config.as_bytes()).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the request could not be handed to curl".to_string());
        }
        drop(sink);
    }
    let out = child.wait_with_output().map_err(|e| format!("curl did not complete: {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_that_could_break_out_of_the_config_is_refused() {
        let r = post_json("http://x/\"\nupload-file = \"/etc/passwd", "", "{}", 5);
        assert_eq!(r.status, 0);
        assert!(r.error.contains("cannot be used safely"));
    }

    #[test]
    fn a_token_is_checked_for_shape_before_it_is_ever_used() {
        assert!(valid_token("000000000:AAAAAAAAAAAA"));
        assert!(!valid_token(""));
        assert!(!valid_token("no-colon-at-all-but-long-enough-here"));
        assert!(!valid_token("123:short"));
        // The ones that matter: anything that could break out of the config line.
        assert!(!valid_token("123:AAA\"\nurl = \"http://evil.example/x"));
        assert!(!valid_token("123:AAA\\BBBBBBBBBB"));
        assert!(!valid_token("123:AAA BBBBBBBBBB"));
    }

    #[test]
    fn a_token_never_survives_into_text_that_could_be_shown() {
        let t = "000000000:AAAAAAAAAAAA";
        let said = format!("curl: (6) Could not resolve host for {t}");
        let clean = scrub(&said, t);
        assert!(!clean.contains(t));
        assert!(clean.contains("<token>"));
        // And the secret half on its own, which is what an echoed header holds.
        let half = scrub("Authorization: AAAAAAAAAAAA", t);
        assert!(!half.contains("AAAAAAAAAAAA"));
    }

    #[test]
    fn query_values_cannot_carry_a_quote_into_the_config() {
        let encoded = q("a\"b\\c\nd e");
        assert!(!encoded.contains('"'));
        assert!(!encoded.contains('\\'));
        assert!(!encoded.contains('\n'));
        assert!(!encoded.contains(' '));
        assert_eq!(q("plain-Text_1.0~"), "plain-Text_1.0~");
    }

    #[test]
    fn a_malformed_token_is_refused_without_spawning_anything() {
        let r = call("not a token", "getMe", &[], 5);
        assert_eq!(r.status, 0);
        assert!(r.error.contains("format"));
    }
}
