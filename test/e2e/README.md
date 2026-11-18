# End-to-end tests (real Tauri app, Linux build)

Drives the real app through `tauri-driver` + `WebKitWebDriver` with Selenium.
Paths are the ones used in the original sandbox (`/home/claude/...`); adjust them at the top of each file.

Setup (Debian/Ubuntu):
```
apt-get install libwebkit2gtk-4.1-dev webkit2gtk-driver xvfb
cargo install tauri-driver --locked
cargo build -p mutagen --release          # Linux build of the same app
npm i selenium-webdriver                  # in this folder
xvfb-run -a -s "-screen 0 1400x940x24" node e2e.js
```
Fixtures are COPIES of the user's saves (never commit them):
- `/home/claude/fixtures_norun` - current save (no run), stats: Dragon 220, Blades 18, Pauldrons 24
- `/home/claude/fixtures` - older save with a Shredder run in progress
- a game folder copy with `PackData/overhead.pak2` (the "Both" mod version) + TMNTSF.exe

`shots.js` takes the Nexus screenshots and blurs the player name ("Anima The Aeon").
