Nexus page sources. Render the images with Electron (any version) under xvfb:
`xvfb-run -a -s "-screen 0 2000x1200x24" electron --no-sandbox render.js card.html 1920 1080`
`... render.js header.html 1920 480`
They expect `icon.png` (1024 px app icon) and screenshots `01_overview.png`, `02_run.png`, `03_swap_plan.png`, `05_upgrades.png` next to them (from test/e2e/shots.js).
