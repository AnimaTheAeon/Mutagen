# Mutagen

*Mutate your save.* A fan-made save editor for **TMNT: Splintered Fate** (Steam, Windows).

- Edit Dragon/Dreamer coins, upgrade materials, talismans and astral wraps
- Swap the hero in your current run (drag a portrait onto *Current character*)
- Add, remove and level run powers; set run Scrap, Lucky Dice and revives
- Shop upgrades and artifacts (click a bar to set the level)
- **Advanced:** hero base stats and power values in the game files, as a reversible, verified patch

## Safety
- Won't save while the game is running; detects if the game saved after you opened the file
- Every save is backed up first (last 25 kept in `%LOCALAPPDATA%\Mutagen\backups`) and verified after writing
- Game-file edits are always built from a verified backup of the unpatched file; *Restore original files* puts back the exact original (SHA1-checked)

## Build
Tauri 2 (Rust + the system WebView2). `crates/mutagen-io` holds the native file/archive/icon code, `js/` the save logic, `ui/` the window.

```
npm ci && npm ci --prefix js
node js/build.js
npx tauri build
```

Fan-made tool. Not affiliated with Super Evil Megacorp, Paramount or Nickelodeon. No game files or art are included — icons are read from your own installation.
