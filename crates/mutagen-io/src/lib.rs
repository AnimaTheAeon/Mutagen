//! Mutagen's native layer. Everything the UI can't do in the window: files, the 400 MB game archive,
//! icon decoding, finding the game and checking whether it runs. One JSON dispatcher is shared by the
//! Tauri app and the test CLI, so tests exercise exactly the code the app ships.
pub mod icons;
pub mod pak;
pub mod sys;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::{Read, Write};

#[derive(Debug)]
pub struct IoErr { pub message: String, pub code: String }
pub type Res<T> = Result<T, IoErr>;
pub fn err(m: &str, code: &str) -> IoErr { IoErr { message: m.to_string(), code: code.to_string() } }
impl From<std::io::Error> for IoErr {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let code = match e.kind() { NotFound => "ENOENT", PermissionDenied => "EPERM", AlreadyExists => "EEXIST", _ => match e.raw_os_error() { Some(32) | Some(33) => "EBUSY", _ => "IO" } };
        IoErr { message: e.to_string(), code: code.into() }
    }
}
impl IoErr { pub fn to_json(&self) -> String { json!({ "message": self.message, "code": self.code }).to_string() } }

/// Result of a call: JSON, or raw bytes (file contents).
pub enum Out { Json(Value), Bytes(Vec<u8>) }

fn s<'a>(a: &'a Value, k: &str) -> Res<&'a str> { a.get(k).and_then(|v| v.as_str()).ok_or_else(|| err(&format!("missing argument {k}"), "ARG")) }
fn b64(a: &Value, k: &str) -> Res<Vec<u8>> { B64.decode(s(a, k)?).map_err(|_| err("bad base64", "ARG")) }

pub fn sha1_hex_file(path: &str) -> Res<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha1::new();
    let mut buf = vec![0u8; 4 << 20];
    loop { let n = f.read(&mut buf)?; if n == 0 { break; } h.update(&buf[..n]); }
    Ok(hex_upper(&h.finalize()))
}
fn hex_upper(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02X}")).collect() }

fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn call(cmd: &str, a: &Value) -> Res<Out> {
    use Out::*;
    Ok(match cmd {
        "env" => Json(json!({ "saveDir": sys::save_dir(), "dataDir": sys::data_dir(), "platform": std::env::consts::OS, "sep": std::path::MAIN_SEPARATOR.to_string() })),
        "read" => Bytes(fs::read(s(a, "path")?)?),
        "readText" => match fs::read_to_string(s(a, "path")?) { Ok(t) => Json(Value::String(t)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Json(Value::Null), Err(e) => return Err(e.into()) },
        "write" => {
            let path = s(a, "path")?;
            let data = if a.get("text").is_some() { s(a, "text")?.as_bytes().to_vec() } else { b64(a, "b64")? };
            let mut f = fs::File::create(path)?; f.write_all(&data)?; f.sync_all()?;
            Json(Value::Null)
        }
        "rename" => { fs::rename(s(a, "from")?, s(a, "to")?)?; Json(Value::Null) }
        "remove" => { let p = s(a, "path")?; match fs::metadata(p) { Ok(m) if m.is_dir() => fs::remove_dir_all(p)?, Ok(_) => fs::remove_file(p)?, Err(_) => {} } Json(Value::Null) }
        "mkdir" => { fs::create_dir_all(s(a, "path")?)?; Json(Value::Null) }
        "stat" => match fs::metadata(s(a, "path")?) {
            Ok(m) => Json(json!({ "size": m.len(), "mtimeMs": mtime_ms(&m), "isFile": m.is_file(), "isDir": m.is_dir() })),
            Err(_) => Json(Value::Null),
        },
        "readdir" => {
            let mut v: Vec<String> = match fs::read_dir(s(a, "path")?) { Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect(), Err(_) => vec![] };
            v.sort(); Json(json!(v))
        }
        "copy" => { let (from, to) = (s(a, "from")?, s(a, "to")?); let mut f = fs::File::open(from)?; let mut t = fs::File::create(to)?; std::io::copy(&mut f, &mut t)?; t.sync_all()?; Json(Value::Null) }
        "sha1" => Json(Value::String(sha1_hex_file(s(a, "path")?)?)),
        "free" => Json(fs4::available_space(s(a, "path")?).map(|b| json!(b as f64)).unwrap_or(Value::Null)),
        "isGameDir" => Json(json!(sys::is_game_dir(s(a, "path")?))),
        "findGameDir" => Json(json!(sys::find_game_dir(a.get("remembered").and_then(|v| v.as_str())))),
        "gameRunning" => Json(json!(sys::game_running())),
        "pakDir" => {
            let d = pak::read_dir(s(a, "path")?)?;
            let entries: Vec<Value> = d.order.iter().map(|h| { let e = &d.entries[h]; json!([e.hash, e.off, e.csize, e.aligned, e.usize_, e.flags]) }).collect();
            Json(json!({ "count": d.count, "dirOff": d.dir_off, "size": d.size, "entries": entries }))
        }
        "pakRead" => Bytes(pak::read_entry(s(a, "path")?, s(a, "hash")?)?),
        "pakPatch" => {
            let items = a.get("items").and_then(|v| v.as_array()).ok_or_else(|| err("missing items", "ARG"))?;
            let mut reps = Vec::new();
            for it in items { reps.push((s(it, "hash")?.to_string(), b64(it, "b64")?)); }
            let r = pak::patch_in_place(s(a, "path")?, &reps)?;
            Json(json!(r.iter().map(|x| json!({ "hash": x.hash, "mode": x.mode, "csize": x.csize })).collect::<Vec<_>>()))
        }
        "icons" => {
            let max_side = a.get("maxSide").and_then(|v| v.as_u64()).unwrap_or(256) as u32;
            let mut jobs = Vec::new();
            for j in a.get("jobs").and_then(|v| v.as_array()).ok_or_else(|| err("missing jobs", "ARG"))? {
                let mut items = Vec::new();
                for it in j.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    items.push(icons::Item { sprite: it.get("sprite").and_then(|v| v.as_u64()).unwrap_or(0) as u32, file: s(&it, "file")?.to_string() });
                }
                jobs.push(icons::Job { pak: s(j, "pak")?.to_string(), hash: s(j, "hash")?.to_string(), items });
            }
            Json(json!(icons::extract(&jobs, max_side)?))
        }
        _ => return Err(err(&format!("unknown command {cmd}"), "ARG")),
    })
}
