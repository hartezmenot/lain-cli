//! Exclusive delivery mailbox for the existing Telegram poller. No agent here.
use crate::json::{self, Value};
use crate::{http, Kernel};
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

pub struct Mailbox {
    file: PathBuf,
    pub enabled: bool,
    owner: String,
    until: u64,
    rows: VecDeque<Value>,
    // Short-lived source-bound download permits survive mailbox ACK. They are
    // rebuilt from durable rows on poll; no private message text is retained.
    media: VecDeque<(u64, Value)>,
}
impl Mailbox {
    pub fn open(dir: PathBuf) -> Self {
        let file = dir.join("bot-mailbox.json");
        let saved = fs::read_to_string(&file).ok().and_then(|s| json::parse(&s));
        let rows = match saved.as_ref().and_then(|v| v.get("rows")) {
            Some(Value::Arr(a)) => a.iter().take(128).cloned().collect(),
            _ => VecDeque::new(),
        };
        Self {
            enabled: file.exists(),
            file,
            rows,
            owner: String::new(),
            until: 0,
            media: VecDeque::new(),
        }
    }
    fn save(&self) -> bool {
        let mut value = Value::obj();
        value.set("rows", Value::Arr(self.rows.iter().cloned().collect()));
        let tmp = self.file.with_extension("tmp");
        fs::write(&tmp, json::write(&value))
            .and_then(|_| fs::rename(tmp, &self.file))
            .is_ok()
    }
    pub fn active(&self) -> bool {
        self.until > crate::remote::now() && !self.owner.is_empty()
    }
    pub fn can_poll(&self) -> bool {
        !self.enabled || (self.active() && self.rows.len() < 128)
    }
    pub fn push(&mut self, e: Value) -> bool {
        let id = e.str("messageId");
        if self.rows.iter().any(|v| v.str("messageId") == id) {
            return true;
        }
        if self.rows.len() >= 128 {
            return false;
        }
        self.rows.push_back(e);
        if self.save() {
            true
        } else {
            self.rows.pop_back();
            false
        }
    }
    fn permit_media(&mut self, events: &[Value]) {
        let now = crate::remote::now();
        self.media.retain(|(until, _)| *until > now);
        for event in events {
            if let Some(Value::Arr(files)) = event.get("attachments") {
                for file in files.iter().take(8) {
                    let mut permit = Value::obj();
                    for key in ["messageId", "chatId", "senderId", "threadId"] { permit.set(key, Value::s(&event.str(key))); }
                    permit.set("fileId", Value::s(&file.str("id")));
                    if self.media.iter().any(|(_, p)| p == &permit) { continue; }
                    while self.media.len() >= 1024 { self.media.pop_front(); }
                    self.media.push_back((now + 10 * 60 * 1000, permit));
                }
            }
        }
    }
    fn permits(&self, req: &Value) -> bool {
        self.media.iter().any(|(until, p)| *until > crate::remote::now() && ["messageId", "chatId", "senderId", "threadId", "fileId"].iter().all(|key| p.str(key) == req.str(key)))
    }
}
fn failure(why: &str) -> Value {
    let mut v = Value::obj();
    v.set("ok", Value::Bool(false));
    v.set("error", Value::s(why));
    v
}
pub fn op(op: &str, req: &Value, kernel: &Arc<Kernel>) -> Value {
    // Doctor is observational even for an unconfigured or unattached mailbox.
    if op == "remote_gateway_status" || op == "remote_gateway_check" {
        let r = kernel.remote.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Value::obj();
        out.set("ok", Value::Bool(true));
        out.set("gatewayProtocol", Value::n(1));
        out.set("protocolVersion", Value::n(1));
        out.set("mediaProtocol", Value::n(1));
        out.set("configured", Value::Bool(r.configured()));
        out.set("botId", Value::s(&r.identity.bot_id.to_string()));
        out.set("gatewayEnabled", Value::Bool(r.gateway.enabled));
        out.set("gatewayMode", Value::Bool(r.gateway.enabled));
        out.set("gatewayOwned", Value::Bool(r.gateway.active()));
        out.set("attached", Value::Bool(r.gateway.active()));
        out.set("mailboxDepth", Value::n(r.gateway.rows.len() as i64));
        out.set("mailboxCapacity", Value::n(128));
        let healthy = !r.gateway.enabled || fs::read_to_string(&r.gateway.file).ok().and_then(|s| json::parse(&s)).and_then(|v| v.get("rows").cloned()).map(|v| matches!(v, Value::Arr(_))).unwrap_or(false);
        out.set("mailboxHealthy", Value::Bool(healthy));
        out.set("link", Value::s(r.link.as_str()));
        out.set("lastOkAt", Value::n(r.last_ok_at as i64));
        if op == "remote_gateway_status" { return out; }
        let token = r.token(); let expected = r.identity.bot_id; drop(r);
        out.set("authenticated", Value::Bool(false));
        out.set("authFailed", Value::Bool(false));
        if token.is_empty() { return out; }
        let reply = http::call(&token, "getMe", &[], 20);
        let value = json::parse(&reply.body);
        let code = value.as_ref().and_then(|v| v.num("error_code")).unwrap_or(reply.status as f64) as u16;
        out.set("authFailed", Value::Bool(code == 401 || code == 403));
        if reply.ok() && value.as_ref().and_then(|v| v.get("ok")) == Some(&Value::Bool(true)) {
            if let Some(id) = value.as_ref().and_then(|v| v.get("result")).and_then(|v| v.num("id")) {
                out.set("authenticated", Value::Bool(true));
                out.set("botId", Value::s(&(id as i64).to_string()));
                out.set("identityMatch", Value::Bool(id as i64 == expected));
            }
        }
        return out;
    }
    let owner = req.str("owner");
    if owner.len() != 48 || !owner.bytes().all(|b| b.is_ascii_hexdigit()) {
        return failure("invalid gateway owner");
    }
    let mut r = kernel.remote.lock().unwrap_or_else(|e| e.into_inner());
    let mut start_poller = false;
    if op == "remote_gateway_attach" && !r.configured() && !req.str("token").is_empty() {
        let token = req.str("token");
        drop(r);
        let identity = match crate::telegram::verify(&token) {
            Ok(v) => v,
            Err(_) => return failure("Telegram credential could not be verified"),
        };
        r = kernel.remote.lock().unwrap_or_else(|e| e.into_inner());
        if !r.configured() {
            r.connect(&token, identity);
            start_poller = true;
        }
    }
    if !r.configured() {
        return failure("Telegram is not configured");
    }
    let b = &mut r.gateway;
    if op == "remote_gateway_attach" {
        if b.active() && b.owner != owner {
            return failure("Telegram gateway already owned");
        }
        b.enabled = true;
        if !b.save() {
            return failure("cannot persist gateway mode");
        }
        b.owner = owner.clone();
        b.until = crate::remote::now() + 30000;
    } else if !b.active() || b.owner != owner {
        return failure("gateway lease expired");
    }
    let mut out = Value::obj();
    out.set("ok", Value::Bool(true));
    match op {
        "remote_gateway_attach" => {
            out.set("botId", Value::s(&r.identity.bot_id.to_string()));
            out.set("gatewayProtocol", Value::n(1));
            out.set("mediaProtocol", Value::n(1));
        }
        "remote_gateway_poll" => {
            b.until = crate::remote::now() + 30000;
            let events: Vec<Value> = b.rows.iter().take(16).cloned().collect();
            b.permit_media(&events);
            out.set("events", Value::Arr(events));
        }
        "remote_gateway_ack" => {
            let id = req.str("messageId");
            let before = b.rows.clone();
            b.rows.retain(|v| v.str("messageId") != id);
            if !b.save() {
                b.rows = before;
                return failure("cannot acknowledge mailbox");
            }
        }
        "remote_gateway_detach" => {
            b.owner.clear();
            b.until = 0;
            b.media.clear();
        }
        "remote_gateway_fetch" => {
            if !b.permits(req) { return failure("attachment does not belong to this message or has expired"); }
            let token = r.token(); drop(r);
            match crate::bot_media::fetch(&token, &req.str("fileId")) {
                Ok(bytes) => { out.set("data", Value::s(&crate::bot_media::encode(&bytes))); return out; }
                Err(why) => return failure(why),
            }
        }
        "remote_gateway_send_media" => {
            let token = r.token(); drop(r);
            match crate::bot_media::send(&token, req) {
                Ok((status, body)) => {
                    out.set("status", Value::n(status as i64));
                    out.set("accepted", body.get("ok").cloned().unwrap_or(Value::Bool(false)));
                    if let Some(value) = body.get("result") { out.set("messageId", Value::s(&value.num("message_id").unwrap_or(0.0).to_string())); }
                    if let Some(value) = body.get("parameters") { out.set("retryAfter", value.get("retry_after").cloned().unwrap_or(Value::Null)); }
                    return out;
                }
                Err(_) => return failure("Telegram media acknowledgement unavailable"),
            }
        }
        "remote_gateway_send" => {
            let method = req.str("method");
            if ![
                "sendMessage",
                "editMessageText",
                "sendChatAction",
                "answerCallbackQuery",
            ]
            .contains(&method.as_str())
            {
                return failure("unsupported gateway action");
            }
            let token = r.token();
            drop(r);
            let mut params = Vec::new();
            if let Some(Value::Obj(fields)) = req.get("params") {
                for (k, v) in fields {
                    if ![
                        "chat_id",
                        "text",
                        "message_id",
                        "message_thread_id",
                        "reply_parameters",
                        "reply_markup",
                        "action",
                        "callback_query_id",
                    ]
                    .contains(&k.as_str())
                    {
                        return failure("unsupported action field");
                    }
                    let s = match v {
                        Value::Str(s) => s.clone(),
                        _ => json::write(v),
                    };
                    if s.len() > 24000 {
                        return failure("action too large");
                    }
                    params.push((k.as_str(), s));
                }
            }
            let result = http::call(&token, &method, &params, 20);
            out.set("status", Value::n(result.status as i64));
            // No credential or error body crosses the transport boundary.
            if !result.error.is_empty() {
                return failure("Telegram acknowledgement unavailable");
            }
            if let Some(body) = json::parse(&result.body) {
                out.set(
                    "accepted",
                    body.get("ok").cloned().unwrap_or(Value::Bool(false)),
                );
                if let Some(v) = body.get("result") {
                    out.set(
                        "messageId",
                        Value::s(&v.num("message_id").unwrap_or(0.0).to_string()),
                    );
                }
                if let Some(v) = body.get("parameters") {
                    out.set(
                        "retryAfter",
                        v.get("retry_after").cloned().unwrap_or(Value::Null),
                    );
                }
            }
            return out;
        }
        _ => return failure("unknown gateway operation"),
    }
    drop(r);
    if start_poller {
        crate::telegram::supervise(kernel.clone());
    }
    out
}

pub fn normalize(u: &Value, r: &crate::remote::Remote) -> Option<Value> {
    let cb = u.get("callback_query");
    let msg = u
        .get("message")
        .or_else(|| cb.and_then(|c| c.get("message")))?;
    let chat = msg.get("chat")?;
    let sender = cb.and_then(|c| c.get("from")).or_else(|| msg.get("from"))?;
    let chat_id = chat.num("id")? as i64;
    let sender_id = sender.num("id")? as i64;
    let dm = chat.str("type") == "private";
    let mut e = Value::obj();
    e.set("platform", Value::s("telegram"));
    e.set("chatId", Value::s(&chat_id.to_string()));
    e.set("senderId", Value::s(&sender_id.to_string()));
    e.set(
        "messageId",
        Value::s(&format!("u:{}", u.num("update_id")? as i64)),
    );
    e.set(
        "replyTo",
        Value::s(&(msg.num("message_id")? as i64).to_string()),
    );
    if let Some(id) = msg.num("message_thread_id") {
        e.set("threadId", Value::s(&(id as i64).to_string()));
    }
    e.set("kind", Value::s(if dm { "dm" } else { "group" }));
    e.set(
        "bot",
        sender.get("is_bot").cloned().unwrap_or(Value::Bool(false)),
    );
    e.set(
        "paired",
        Value::Bool(dm && chat_id == sender_id && r.authorized(chat_id)),
    );
    let text = msg.str("text");
    let text = if text.is_empty() {
        msg.str("caption")
    } else {
        text
    };
    let mentioned = !r.identity.username.is_empty()
        && text.split_whitespace().any(|w| {
            w == format!("@{}", r.identity.username)
                || w.ends_with(&format!("@{}", r.identity.username)) && w.starts_with('/')
        });
    let reply = msg.get("reply_to_message");
    let replied = reply
        .and_then(|v| v.get("from"))
        .and_then(|v| v.num("id"))
        .map(|id| id as i64 == r.identity.bot_id)
        .unwrap_or(false);
    e.set(
        "addressed",
        Value::Bool(dm || mentioned || replied || cb.is_some()),
    );
    e.set(
        "text",
        Value::s(&http::scrub(
            &text.chars().take(16000).collect::<String>(),
            &r.token(),
        )),
    );
    e.set(
        "timestamp",
        Value::n(msg.num("date").unwrap_or(0.0) as i64 * 1000),
    );
    if let Some(v) = reply {
        e.set(
            "replyText",
            Value::s(&http::scrub(
                &v.str("text").chars().take(1000).collect::<String>(),
                &r.token(),
            )),
        );
    }
    let photo = match msg.get("photo") {
        Some(Value::Arr(a)) => a.last(),
        _ => None,
    };
    if let Some(a) = msg
        .get("document")
        .or_else(|| msg.get("audio"))
        .or_else(|| msg.get("voice"))
        .or_else(|| msg.get("video"))
        .or(photo)
    {
        let mut item = Value::obj();
        item.set("id", Value::s(&a.str("file_id")));
        let name = a.str("file_name");
        item.set(
            "name",
            Value::s(if name.is_empty() {
                if photo.is_some() { "telegram-photo.jpg" } else { "telegram-attachment" }
            } else {
                &name
            }),
        );
        let mime = a.str("mime_type");
        item.set("mime", Value::s(if photo.is_some() { "image/jpeg" } else { &mime }));
        item.set("size", a.get("file_size").cloned().unwrap_or(Value::n(0)));
        e.set("attachments", Value::Arr(vec![item]));
    }
    if let Some(c) = cb {
        let data = c.str("data");
        let bits: Vec<&str> = data.split(':').collect();
        if bits.len() == 3 && bits[0] == "lain" {
            let mut p = Value::obj();
            p.set("id", Value::s(bits[1]));
            p.set("value", Value::s(bits[2]));
            e.set("promptResponse", p);
        }
        e.set("callbackId", Value::s(&c.str("id")));
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lain-bot-rust-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn gateway_mode_survives_restart_without_inheriting_a_live_lease() {
        let dir = dir();
        let mut b = Mailbox::open(dir.clone());
        assert!(b.can_poll());
        b.enabled = true;
        b.owner = "a".repeat(48);
        b.until = crate::remote::now() + 30000;
        assert!(b.save());
        assert!(b.can_poll());
        let after = Mailbox::open(dir.clone());
        assert!(after.enabled);
        assert!(!after.active());
        assert!(!after.can_poll());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn mailbox_is_bounded_durable_and_deduplicated_before_cursor_ack() {
        let dir = dir();
        let mut b = Mailbox::open(dir.clone());
        for i in 0..128 {
            let mut e = Value::obj();
            e.set("messageId", Value::s(&i.to_string()));
            assert!(b.push(e.clone()));
            assert!(b.push(e));
        }
        let mut extra = Value::obj();
        extra.set("messageId", Value::s("overflow"));
        assert!(!b.push(extra));
        assert_eq!(b.rows.len(), 128);
        assert_eq!(Mailbox::open(dir.clone()).rows.len(), 128);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn paired_authority_is_only_for_the_same_private_sender_and_secrets_are_scrubbed() {
        let dir = dir();
        let mut r = crate::remote::Remote::open(dir.clone());
        let token = "123456789:fixture_telegram_secret_1234567890";
        r.connect(
            token,
            crate::remote::Identity {
                bot_id: 77,
                username: "lain_fixture".to_string(),
                name: String::new(),
            },
        );
        r.chats.insert(
            555,
            crate::remote::Chat {
                id: 555,
                label: String::new(),
                paired_at: 1,
            },
        );
        let mut u = json::parse(r#"{"update_id":1,"message":{"message_id":2,"from":{"id":555},"chat":{"id":555,"type":"private"},"text":"hello"}}"#).unwrap();
        let e = normalize(&u, &r).unwrap();
        assert_eq!(e.get("paired"), Some(&Value::Bool(true)));
        let mut msg = u.get("message").unwrap().clone();
        msg.set("text", Value::s(token));
        let mut sender = Value::obj();
        sender.set("id", Value::n(999));
        msg.set("from", sender);
        u.set("message", msg);
        let other = normalize(&u, &r).unwrap();
        assert_eq!(other.get("paired"), Some(&Value::Bool(false)));
        assert!(!json::write(&other).contains(token));
        assert!(other.get("raw_message").is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
