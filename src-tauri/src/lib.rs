//! Tauri shell: one generic `io` command (shared with the test CLI) plus folder picker and "open folder".
use mutagen_io::{call, sys, Out};
use serde_json::Value;
use tauri::{ipc::Response, AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn io(app: AppHandle, cmd: String, args: Value) -> Result<Response, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || match call(&cmd, &args) {
        Ok(Out::Bytes(b)) => Ok(Response::new(b)),
        Ok(Out::Json(mut v)) => {
            if cmd == "env" { v["version"] = Value::String(version); }
            Ok(Response::new(serde_json::to_vec(&v).unwrap_or_default()))
        }
        Err(e) => Err(e.to_json()),
    })
    .await
    .map_err(|e| format!("{{\"message\":\"{e}\",\"code\":\"IO\"}}"))?
}

#[tauri::command]
async fn choose_folder(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Find your TMNT: Splintered Fate folder").blocking_pick_folder()
            .and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
    }).await.ok().flatten()
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // icons are cached as PNGs under the data folder; let the window load them (and nothing else)
            let icons = std::path::Path::new(&sys::data_dir()).join("icons");
            let _ = std::fs::create_dir_all(&icons);
            let _ = app.asset_protocol_scope().allow_directory(&icons, true);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![io, choose_folder, open_path])
        .run(tauri::generate_context!())
        .expect("error while running Mutagen");
}
