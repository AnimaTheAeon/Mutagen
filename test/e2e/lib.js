// Drive the REAL Tauri app (Linux build of the same code) through tauri-driver + WebKitWebDriver.
const { Builder, By, until, Key } = require('selenium-webdriver');
const { spawn } = require('child_process');
const APP = '/home/claude/mt/target/release/mutagen';
let driverProc = null;
async function launch(env) {
  driverProc = spawn(process.env.HOME + '/.cargo/bin/tauri-driver', ['--port', '4444'], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((r) => setTimeout(r, 1500));
  const d = await new Builder().usingServer('http://127.0.0.1:4444/').withCapabilities({ browserName: 'wry', 'tauri:options': { application: APP } }).build();
  await d.wait(async () => (await d.executeScript("const m=document.querySelector('#main');return !!(m && (m.querySelector('h1') || /saves found|couldn/i.test(m.textContent)));")), 30000);
  await d.executeScript("window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__errs.push('rej '+String(e.reason)));");
  return wrap(d);
}
function wrap(d) {
  const $ = (css) => d.findElement(By.css(css));
  const p = {
    d,
    $, $$: (css) => d.findElements(By.css(css)),
    async click(css, tries = 4) { try { const e = await d.wait(until.elementLocated(By.css(css)), 15000); await d.executeScript('arguments[0].scrollIntoView({block:"center"})', e); await e.click(); await p.sleep(150); } catch (e) { if (tries > 0 && /Stale/.test(e.name + e.message)) { await p.sleep(400); return p.click(css, tries - 1); } throw e; } },
    async fill(css, v, tries = 4) { try { return await p.fill1(css, v); } catch (e) { if (tries > 0 && /Stale/.test(e.name + e.message)) { await p.sleep(500); return p.fill(css, v, tries - 1); } throw e; } },
    async fill1(css, v) { const e = await $(css); await d.executeScript('arguments[0].scrollIntoView({block:"center"});arguments[0].focus();arguments[0].select()', e); await e.sendKeys(String(v), Key.TAB); await p.sleep(300); },
    val: (css) => d.executeScript('return document.querySelector(arguments[0]).value', css),
    text: (css) => d.executeScript('const e=document.querySelector(arguments[0]);return e?e.textContent:null', css),
    has: async (css) => (await d.findElements(By.css(css))).length > 0,
    waitFor: (css, ms = 20000) => d.wait(until.elementLocated(By.css(css)), ms),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    js: (code, ...a) => d.executeScript(code, ...a),
    async shot(name) { require('fs').writeFileSync(`/tmp/wd_${name}.png`, await d.takeScreenshot(), 'base64'); },
    // HTML5 drag & drop by dispatching the same events a mouse drag fires
    drag: (from, to) => d.executeScript(`const s=document.querySelector(arguments[0]),t=document.querySelector(arguments[1]);const dt=new DataTransfer();
      const f=(el,type)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));
      f(s,'dragstart');f(t,'dragenter');f(t,'dragover');f(t,'drop');f(s,'dragend');`, from, to),
    errors: () => d.executeScript('return window.__errs'),
    async save() { await p.click('button[data-act="save"]'); await p.waitFor('#r-t', 30000); const t = await p.text('#r-t'); await p.click('[data-act="closeModal"]'); return t; },
    async quit() { try { await d.quit(); } catch {} if (driverProc) driverProc.kill(); await p.sleep(500); },
  };
  return p;
}
module.exports = { launch };
