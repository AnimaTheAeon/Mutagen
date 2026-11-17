//! Test harness: one JSON request per line on stdin → one JSON reply per line on stdout.
//! {"id":1,"cmd":"sha1","args":{...}} → {"id":1,"ok":...} | {"id":1,"bytes":"<b64>"} | {"id":1,"err":{message,code}}
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use mutagen_io::{call, Out};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let req: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { writeln!(out, "{}", json!({"id": null, "err": {"message": e.to_string(), "code": "ARG"}})).ok(); continue; } };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let cmd = req.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
        let args = req.get("args").cloned().unwrap_or(json!({}));
        let reply = match call(cmd, &args) {
            Ok(Out::Json(v)) => json!({ "id": id, "ok": v }),
            Ok(Out::Bytes(b)) => json!({ "id": id, "bytes": B64.encode(b) }),
            Err(e) => json!({ "id": id, "err": { "message": e.message, "code": e.code } }),
        };
        writeln!(out, "{reply}").ok();
        out.flush().ok();
    }
}
