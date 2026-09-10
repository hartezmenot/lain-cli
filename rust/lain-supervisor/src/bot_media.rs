//! Bounded media transport inside the existing Telegram credential boundary.
//! The gateway exchanges bytes, never token-bearing URLs or host file paths.
use crate::{http, json::{self, Value}};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::process::Stdio;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MARK: &[u8] = b"<<<lain-media-status:";
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((c.get(1).copied().unwrap_or(0) as u32) << 8) | c.get(2).copied().unwrap_or(0) as u32;
        for (i, shift) in [18, 12, 6, 0].iter().enumerate() {
            out.push(if i > c.len() { '=' } else { ALPHABET[((n >> shift) & 63) as usize] as char });
        }
    }
    out
}
fn decode(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() > MAX_BYTES.div_ceil(3) * 4 || s.len() % 4 != 0 { return None; }
    let mut bytes = Vec::with_capacity(s.len() / 4 * 3);
    for (index, c) in s.as_bytes().chunks(4).enumerate() {
        let last = index + 1 == s.len() / 4;
        let padding = if c[2] == b'=' { 2 } else if c[3] == b'=' { 1 } else { 0 };
        if padding > 0 && (!last || c[3] != b'=') { return None; }
        let mut n = 0u32;
        for (i, v) in c.iter().enumerate() {
            n = (n << 6) | if i >= 4 - padding { 0 } else { ALPHABET.iter().position(|a| a == v)? as u32 };
        }
        bytes.push((n >> 16) as u8);
        if padding < 2 { bytes.push((n >> 8) as u8); }
        if padding < 1 { bytes.push(n as u8); }
    }
    if bytes.len() > MAX_BYTES || encode(&bytes) != s { None } else { Some(bytes) }
}
fn base() -> Option<String> {
    let base = http::api_base().trim_end_matches('/').to_string();
    if base == "https://api.telegram.org" { return Some(base); }
    // The existing local fixture override stays available, without permitting
    // credentials to be redirected to arbitrary production hosts.
    let rest = base.strip_prefix("http://127.0.0.1:")?;
    if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) { Some(base) } else { None }
}
fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 512 && !path.starts_with('/')
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        && path.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}
// stdout is capped while it is read, including a dishonest/missing length.
// curl's own limit and timeout are additional bounds. Redirects are disabled.
fn transfer(config: &str, limit: usize) -> Result<(u16, Vec<u8>), &'static str> {
    let mut child = http::curl_command().args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "media transport unavailable")?;
    let wrote = child.stdin.take().map(|mut input| input.write_all(config.as_bytes()).is_ok()).unwrap_or(false);
    if !wrote { let _ = child.kill(); let _ = child.wait(); return Err("media transport unavailable"); }
    let mut body = Vec::new();
    let read = child.stdout.take().unwrap().take((limit + MARK.len() + 4) as u64).read_to_end(&mut body);
    if read.is_err() || body.len() > limit + MARK.len() + 3 {
        let _ = child.kill(); let _ = child.wait(); return Err("media exceeds artifact limit");
    }
    let success = child.wait().map(|s| s.success()).unwrap_or(false);
    if !success { return Err("media transport unavailable"); }
    let split = body.windows(MARK.len()).rposition(|s| s == MARK).ok_or("media acknowledgement unavailable")?;
    let status = std::str::from_utf8(&body[split + MARK.len()..]).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    body.truncate(split);
    if body.len() > limit { return Err("media exceeds artifact limit"); }
    Ok((status, body))
}
fn config(url: &str, limit: usize) -> String {
    format!("url = \"{url}\"\nsilent\nmax-time = 20\nconnect-timeout = 10\nmax-filesize = {limit}\nwrite-out = \"<<<lain-media-status:%{{http_code}}\"\n")
}
pub fn fetch(token: &str, file_id: &str) -> Result<Vec<u8>, &'static str> {
    if !http::valid_token(token) { return Err("Telegram is not configured"); }
    let base = base().ok_or("unsupported media endpoint")?;
    let response = http::call(token, "getFile", &[("file_id", file_id.to_string())], 20);
    if !response.ok() { return Err("attachment metadata unavailable"); }
    let value = json::parse(&response.body).ok_or("attachment metadata unavailable")?;
    if value.get("ok") != Some(&Value::Bool(true)) { return Err("attachment metadata unavailable"); }
    let file = value.get("result").ok_or("attachment metadata unavailable")?;
    let path = file.str("file_path");
    if !safe_path(&path) || file.num("file_size").unwrap_or(0.0) > MAX_BYTES as f64 { return Err("attachment path invalid or too large"); }
    let (status, bytes) = transfer(&config(&format!("{base}/file/bot{token}/{path}"), MAX_BYTES), MAX_BYTES)?;
    if status != 200 { return Err("attachment unavailable"); }
    Ok(bytes)
}
pub fn send(token: &str, req: &Value) -> Result<(u16, Value), &'static str> {
    if !http::valid_token(token) { return Err("Telegram is not configured"); }
    let base = base().ok_or("unsupported media endpoint")?;
    let bytes = decode(&req.str("data")).ok_or("invalid media bytes")?;
    let name: String = req.str("name").chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).take(100).collect();
    let name = if name.is_empty() { "attachment" } else { &name };
    let mime = req.str("mime");
    if mime.len() > 100 || !mime.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._+-".contains(&b)) { return Err("invalid media type"); }
    let image = matches!(mime.as_str(), "image/png" | "image/jpeg");
    let (method, field) = if image { ("sendPhoto", "photo") } else { ("sendDocument", "document") };
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let boundary = format!("lain-{}-{nonce}", std::process::id());
    let mut body = Vec::new();
    if let Some(Value::Obj(fields)) = req.get("params") {
        for (key, value) in fields {
            if !["chat_id", "message_thread_id", "reply_parameters"].contains(&key.as_str()) { return Err("unsupported media field"); }
            let value = match value { Value::Str(s) => s.clone(), _ => json::write(value) };
            if value.len() > 500 || value.contains(['\r', '\n']) { return Err("invalid media field"); }
            write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n").map_err(|_| "media staging failed")?;
        }
    }
    write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").map_err(|_| "media staging failed")?;
    body.extend_from_slice(&bytes);
    write!(body, "\r\n--{boundary}--\r\n").map_err(|_| "media staging failed")?;
    let path = std::env::temp_dir().join(format!("{boundary}.upload"));
    let path_text = path.to_string_lossy().replace('\\', "/");
    if path_text.contains(['"', '\r', '\n']) { return Err("media staging unavailable"); }
    let mut options = OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&path).map_err(|_| "media staging unavailable")?;
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
    let cleanup = Cleanup(path);
    file.write_all(&body).map_err(|_| "media staging failed")?; drop(file);
    let mut settings = config(&format!("{base}/bot{token}/{method}"), 65536);
    settings.push_str(&format!("header = \"Content-Type: multipart/form-data; boundary={boundary}\"\ndata-binary = \"@{path_text}\"\n"));
    let response = transfer(&settings, 65536);
    drop(cleanup);
    let (status, response) = response?;
    let value = json::parse(&String::from_utf8_lossy(&response)).ok_or("media acknowledgement unavailable")?;
    Ok((status, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_base64_is_canonical_and_round_trips_binary() {
        for bytes in [b"f".as_slice(), b"fo", b"foo", &[0, 255, 128, 17]] { assert_eq!(decode(&encode(bytes)).unwrap(), bytes); }
        for invalid in ["", "Zg=", "Zg==AAAA", "Z===", "Zm9v\n", "Zh=="] { assert!(decode(invalid).is_none()); }
        assert!(decode(&encode(&vec![1; MAX_BYTES + 1])).is_none());
    }
    #[test]
    fn telegram_file_paths_cannot_escape_origin_or_inject_curl_options() {
        assert!(safe_path("photos/file_77.jpg"));
        for bad in ["../secret", "a/../b", "https://evil/x", "/file", "a?token=x", "a\noutput=secret", "a\\b", "a//b"] { assert!(!safe_path(bad)); }
    }
}
