const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
app.disableHardwareAcceleration();
const [file, w, h] = [process.argv.at(-3), +process.argv.at(-2), +process.argv.at(-1)];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  await win.loadURL('file://' + path.join(__dirname, file));
  await new Promise((r) => setTimeout(r, 1500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  fs.writeFileSync(path.join(__dirname, file.replace('.html', '.png')), img.toPNG()); console.log(file, JSON.stringify(img.getSize()));
  app.quit();
});
