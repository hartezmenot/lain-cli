//! A MINIMAL JSON VALUE, PARSER AND WRITER.
//!
//! Hand-written, and deliberately so. This crate has NO dependencies: the whole
//! point of the supervisor is that it is the one part of LAIN that must still be
//! running when everything else has died, and a process with no dependency tree
//! is a process that builds anywhere and starts every time. The wire format is
//! also not arbitrary JSON — both ends of it are in this repository, the
//! messages are flat objects of strings, numbers and booleans with one array of
//! objects — so a complete parser would be more code than the thing it serves.
//!
//! WHAT IT ACCEPTS is ordinary JSON: objects, arrays, strings with the standard
//! escapes (including `\uXXXX`), numbers, `true`, `false`, `null`. What it does
//! NOT do is preserve number precision beyond `f64`, or key order.
//!
//! WHAT IT REFUSES, it refuses by returning `None` rather than panicking. A
//! malformed line arriving on the socket must never take the supervisor down —
//! see §12 of the brief: a bad message may not poison authoritative state.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

impl Value {
    pub fn obj() -> Value {
        Value::Obj(BTreeMap::new())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(m) => m.get(key),
            _ => None,
        }
    }

    /// The string at `key`, or "" — the shape every caller here actually wants.
    pub fn str(&self, key: &str) -> String {
        match self.get(key) {
            Some(Value::Str(s)) => s.clone(),
            _ => String::new(),
        }
    }

    pub fn num(&self, key: &str) -> Option<f64> {
        match self.get(key) {
            Some(Value::Num(n)) => Some(*n),
            _ => None,
        }
    }

    pub fn set(&mut self, key: &str, v: Value) {
        if let Value::Obj(m) = self {
            m.insert(key.to_string(), v);
        }
    }

    pub fn s(v: &str) -> Value {
        Value::Str(v.to_string())
    }

    pub fn n(v: i64) -> Value {
        Value::Num(v as f64)
    }
}

// ---------------------------------------------------------------- writing ----

pub fn write(v: &Value) -> String {
    let mut out = String::new();
    put(v, &mut out);
    out
}

fn put(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            // Integers are written as integers. A job's exit code rendering as
            // `0.0` is the kind of thing that makes a JSON consumer on the other
            // side do something silly with it.
            if n.fract() == 0.0 && n.abs() < 9e15 {
                let _ = write!(out, "{}", *n as i64);
            } else {
                let _ = write!(out, "{}", n);
            }
        }
        Value::Str(s) => put_str(s, out),
        Value::Arr(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                put(item, out);
            }
            out.push(']');
        }
        Value::Obj(m) => {
            out.push('{');
            for (i, (k, val)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                put_str(k, out);
                out.push(':');
                put(val, out);
            }
            out.push('}');
        }
    }
}

fn put_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Control characters must be escaped or the line is not JSON. This
            // matters here: worker output is captured verbatim and a stray
            // 0x07 from a build tool would otherwise produce an unparseable
            // response and lose a completed job's result.
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------- parsing ----

pub fn parse(src: &str) -> Option<Value> {
    let b: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    let v = parse_value(&b, &mut i)?;
    skip_ws(&b, &mut i);
    // Trailing content means the sender and this parser disagree about the
    // message; better to refuse it than to act on the first half.
    if i != b.len() {
        return None;
    }
    Some(v)
}

fn skip_ws(b: &[char], i: &mut usize) {
    while *i < b.len() && (b[*i] == ' ' || b[*i] == '\t' || b[*i] == '\n' || b[*i] == '\r') {
        *i += 1;
    }
}

fn parse_value(b: &[char], i: &mut usize) -> Option<Value> {
    skip_ws(b, i);
    match b.get(*i)? {
        '{' => parse_obj(b, i),
        '[' => parse_arr(b, i),
        '"' => parse_str(b, i).map(Value::Str),
        't' => lit(b, i, "true", Value::Bool(true)),
        'f' => lit(b, i, "false", Value::Bool(false)),
        'n' => lit(b, i, "null", Value::Null),
        _ => parse_num(b, i),
    }
}

fn lit(b: &[char], i: &mut usize, word: &str, v: Value) -> Option<Value> {
    for (k, c) in word.chars().enumerate() {
        if *b.get(*i + k)? != c {
            return None;
        }
    }
    *i += word.len();
    Some(v)
}

fn parse_obj(b: &[char], i: &mut usize) -> Option<Value> {
    *i += 1; // {
    let mut m = BTreeMap::new();
    skip_ws(b, i);
    if *b.get(*i)? == '}' {
        *i += 1;
        return Some(Value::Obj(m));
    }
    loop {
        skip_ws(b, i);
        let k = parse_str(b, i)?;
        skip_ws(b, i);
        if *b.get(*i)? != ':' {
            return None;
        }
        *i += 1;
        let v = parse_value(b, i)?;
        m.insert(k, v);
        skip_ws(b, i);
        match *b.get(*i)? {
            ',' => *i += 1,
            '}' => {
                *i += 1;
                return Some(Value::Obj(m));
            }
            _ => return None,
        }
    }
}

fn parse_arr(b: &[char], i: &mut usize) -> Option<Value> {
    *i += 1; // [
    let mut a = Vec::new();
    skip_ws(b, i);
    if *b.get(*i)? == ']' {
        *i += 1;
        return Some(Value::Arr(a));
    }
    loop {
        let v = parse_value(b, i)?;
        a.push(v);
        skip_ws(b, i);
        match *b.get(*i)? {
            ',' => *i += 1,
            ']' => {
                *i += 1;
                return Some(Value::Arr(a));
            }
            _ => return None,
        }
    }
}

fn parse_str(b: &[char], i: &mut usize) -> Option<String> {
    if *b.get(*i)? != '"' {
        return None;
    }
    *i += 1;
    let mut s = String::new();
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        match c {
            '"' => return Some(s),
            '\\' => {
                let e = *b.get(*i)?;
                *i += 1;
                match e {
                    '"' => s.push('"'),
                    '\\' => s.push('\\'),
                    '/' => s.push('/'),
                    'b' => s.push('\u{8}'),
                    'f' => s.push('\u{c}'),
                    'n' => s.push('\n'),
                    'r' => s.push('\r'),
                    't' => s.push('\t'),
                    'u' => {
                        let mut code = 0u32;
                        for _ in 0..4 {
                            let h = *b.get(*i)?;
                            *i += 1;
                            code = code * 16 + h.to_digit(16)?;
                        }
                        // A lone surrogate is not a character. Substituting the
                        // replacement char keeps a weird byte in a build log
                        // from discarding the whole message.
                        s.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    _ => return None,
                }
            }
            c => s.push(c),
        }
    }
}

fn parse_num(b: &[char], i: &mut usize) -> Option<Value> {
    let start = *i;
    if *b.get(*i)? == '-' {
        *i += 1;
    }
    while *i < b.len() && (b[*i].is_ascii_digit() || b[*i] == '.' || b[*i] == 'e' || b[*i] == 'E' || b[*i] == '+' || b[*i] == '-') {
        *i += 1;
    }
    let text: String = b[start..*i].iter().collect();
    text.parse::<f64>().ok().map(Value::Num)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_shapes_the_wire_actually_uses() {
        let mut v = Value::obj();
        v.set("op", Value::s("submit"));
        v.set("exit_code", Value::n(0));
        v.set("ok", Value::Bool(true));
        v.set("nothing", Value::Null);
        let text = write(&v);
        let back = parse(&text).expect("must round trip");
        assert_eq!(v, back);
    }

    #[test]
    fn survives_control_characters_in_worker_output() {
        // A build tool emitting a bell character must not cost us the result.
        let mut v = Value::obj();
        v.set("output", Value::s("done\u{7}\nnext\tline"));
        let text = write(&v);
        assert!(!text.contains('\u{7}'), "control chars must be escaped");
        let back = parse(&text).expect("must round trip");
        assert_eq!(back.str("output"), "done\u{7}\nnext\tline");
    }

    #[test]
    fn malformed_input_is_refused_rather_than_panicking() {
        for bad in ["{", "{\"a\":}", "nope", "", "{\"a\":1}trailing", "[1,"] {
            assert_eq!(parse(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn nested_arrays_of_objects_parse() {
        let v = parse(r#"{"jobs":[{"id":"a"},{"id":"b"}]}"#).unwrap();
        match v.get("jobs") {
            Some(Value::Arr(a)) => {
                assert_eq!(a.len(), 2);
                assert_eq!(a[1].str("id"), "b");
            }
            _ => panic!("expected an array"),
        }
    }
}
