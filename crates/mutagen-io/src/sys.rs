//! Paths, game detection and the game-running check.
use std::path::{Path, PathBuf};

pub const GAME_EXE: &str = "TMNTSF.exe";
const GAME_FOLDER: &str = "Teenage Mutant Ninja Turtles Splintered Fate";

fn env(k: &str) -> Option<String> { std::env::var(k).ok().filter(|v| !v.is_empty()) }
fn home() -> PathBuf { env("USERPROFILE").or_else(|| env("HOME")).map(PathBuf::from).unwrap_or_default() }

pub fn save_dir() -> String {
    env("MUTAGEN_SAVE_DIR").unwrap_or_else(|| env("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Roaming")).join("TMNTSF").to_string_lossy().into_owned())
}
pub fn data_dir() -> String {
    env("MUTAGEN_DATA_DIR").unwrap_or_else(|| env("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Local")).join("Mutagen").to_string_lossy().into_owned())
}

pub fn is_game_dir(p: &str) -> bool {
    let p = Path::new(p);
    p.join(GAME_EXE).is_file() && p.join("PackData").join("overhead.pak2").is_file()
}

/// Library roots listed in steamapps/libraryfolders.vdf ("path" "D:\\SteamLibrary").
fn steam_libraries(root: &str) -> Vec<String> {
    let mut libs = vec![root.to_string()];
    if let Ok(vdf) = std::fs::read_to_string(Path::new(root).join("steamapps").join("libraryfolders.vdf")) {
        let mut rest = vdf.as_str();
        while let Some(i) = rest.find("\"path\"") {
            rest = &rest[i + 6..];
            let Some(a) = rest.find('"') else { break };
            let Some(b) = rest[a + 1..].find('"') else { break };
            libs.push(rest[a + 1..a + 1 + b].replace("\\\\", "\\"));
            rest = &rest[a + 2 + b..];
        }
    }
    libs.dedup();
    libs
}

#[cfg(windows)]
fn steam_roots_from_registry() -> Vec<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam").and_then(|k| k.get_value::<String, _>("SteamPath"))
        .map(|p| vec![p.trim().replace('/', "\\")]).unwrap_or_default()
}
#[cfg(not(windows))]
fn steam_roots_from_registry() -> Vec<String> { vec![] }

pub fn find_game_dir(remembered: Option<&str>) -> Option<String> {
    if let Some(p) = env("MUTAGEN_GAME_DIR") { return if is_game_dir(&p) { Some(p) } else { None }; }
    if let Some(r) = remembered { if is_game_dir(r) { return Some(r.to_string()); } }
    let mut roots = steam_roots_from_registry();
    roots.push("C:\\Program Files (x86)\\Steam".into());
    roots.push("C:\\Program Files\\Steam".into());
    for r in roots {
        for lib in steam_libraries(&r) {
            let p = Path::new(&lib).join("steamapps").join("common").join(GAME_FOLDER);
            let s = p.to_string_lossy().into_owned();
            if is_game_dir(&s) { return Some(s); }
        }
    }
    None
}

pub fn game_running() -> bool {
    if let Some(v) = env("MUTAGEN_FAKE_RUNNING") { return v == "1"; }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(o) = std::process::Command::new("tasklist").args(["/FI", &format!("IMAGENAME eq {GAME_EXE}"), "/NH", "/FO", "CSV"]).creation_flags(CREATE_NO_WINDOW).output() {
            return String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&GAME_EXE.to_lowercase());
        }
        false
    }
    #[cfg(not(windows))]
    { false }
}

#[cfg(test)]
mod tests {
    #[test]
    fn vdf_paths() {
        let dir = std::env::temp_dir().join("mtg_vdf_test");
        std::fs::create_dir_all(dir.join("steamapps")).unwrap();
        std::fs::write(dir.join("steamapps/libraryfolders.vdf"), "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}").unwrap();
        let libs = super::steam_libraries(dir.to_str().unwrap());
        assert_eq!(&libs[1..], &["C:\\Program Files (x86)\\Steam".to_string(), "D:\\SteamLibrary".to_string()]);
    }
}
