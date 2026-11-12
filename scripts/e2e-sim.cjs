// End-to-end run of the real Electron app in simulated mode (no camera, no SDK, no credits), with a throw-away
// user-data folder. Clicks through consent → calibration → rehearsal → report → history → privacy → delete all,
// asserts on what each screen shows and saves screenshots to results/e2e/.
// Usage: npx electron scripts/e2e-sim.cjs [rehearsalSeconds=40]
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const SECONDS = Math.max(16, Number(process.argv.find((a) => /^\d+$/.test(a)) || 40));
const OUT = path.join(__dirname, '..', 'results', 'e2e');
// Chromium may still hold the previous run's profile when it exits, so stale folders are removed on the next run
for (const n of fs.readdirSync(os.tmpdir())) if (n.startsWith('rehearse-e2e-')) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-e2e-'));
process.argv.push('--simulate');
app.setPath('userData', DATA);
app.disableHardwareAcceleration();   // stable page captures on any machine
fs.mkdirSync(OUT, { recursive: true });
require('../electron/main.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);
let failures = 0;
function check(cond, what) { if (cond) log('ok  ', what); else { failures++; log('FAIL', what); } }

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const text = () => js('document.body.innerText');
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG()); };
  const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const waitFor = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(pred)) return true; await sleep(200); }
    check(false, `timeout waiting for ${what}`);
    return false;
  };

  for (let i = 0; i < 50 && !win.isVisible(); i++) await sleep(100);
  await sleep(600);
  await waitFor(`!!document.querySelector('.consent')`, 10000, 'consent screen');
  await shot('01-consent');
  await js(`document.querySelector('.consent-choices').scrollIntoView()`);
  await sleep(200);
  await shot('01b-consent-bottom');
  check(/Camera only\. No microphone\. No recording\./.test(await text()), 'consent explains camera/microphone');
  check(await js(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Agree and continue').disabled`), 'agree disabled before ticking');
  await js(`document.querySelector('.consent .check input').click()`);
  await js(`document.querySelector('#consent-pulse').click()`);   // opt in to the pulse reading
  check(await click('Agree and continue'), 'agree');

  await waitFor(`!!document.querySelector('#title')`, 5000, 'home screen');
  await js(`(() => { const i = document.querySelector('#title'); i.value = 'Thesis defence'; i.dispatchEvent(new Event('input')); })()`);
  await js(`(() => { const s = document.querySelector('#target'); s.value = '60'; s.dispatchEvent(new Event('change')); })()`);
  await shot('02-home');
  check(await click('Start calibration'), 'start calibration');

  await waitFor(`!!document.querySelector('.checklist')`, 5000, 'calibration screen');
  await sleep(4000);
  await shot('03-calibration-early');
  await waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary')); return b && !b.disabled; })()`, 30000, 'calibration ready');
  await sleep(1500);
  await shot('04-calibration-ready');
  check(await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary')); b.click(); return true; })()`), 'start rehearsal');

  await waitFor(`!!document.querySelector('.timer')`, 5000, 'rehearsal screen');
  await sleep(Math.min(SECONDS, 20) * 1000);
  await shot('05-rehearsal');
  check(/Speaking|Pause/.test(await js(`document.querySelector('.state-chip').textContent`)), 'live speaking/pause state shown');
  await sleep(Math.max(0, SECONDS - 20) * 1000);
  check(await click('Finish rehearsal'), 'finish');

  await waitFor(`!!document.querySelector('.timeline')`, 15000, 'report');
  await sleep(500);
  await shot('06-report');
  await js(`document.querySelector('.chart-card').scrollIntoView()`);
  await sleep(300);
  await shot('06b-report-timeline');
  const rep = await text();
  check(/Thesis defence/.test(rep), 'report shows title');
  check(/Breaths in pauses/.test(rep) && /Longest stretch/.test(rep), 'report shows key stats');
  check(/information only/.test(rep), 'pulse labelled information only');
  check(await js(`document.querySelectorAll('.timeline .speak').length >= 2`), 'timeline has speaking blocks');
  check(await js(`document.querySelectorAll('.timeline .pause-mark').length >= 1`), 'timeline has pauses');

  // a second run of the same talk, so history has a trend
  check(await click('Rehearse again'), 'rehearse again');
  await waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary')); return b && !b.disabled; })()`, 30000, 'calibration ready (2)');
  await js(`[...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary')).click()`);
  await sleep(Math.max(16, Math.round(SECONDS / 2)) * 1000 + 500);
  await click('Finish rehearsal');
  await waitFor(`!!document.querySelector('.timeline')`, 15000, 'report (2)');
  await sleep(500);
  await shot('07-report-second');
  check(/Since your previous run of this talk/.test(await text()), 'report compares with previous run');

  await click('History');
  await waitFor(`!!document.querySelector('table')`, 5000, 'history');
  await sleep(300);
  await shot('08-history');
  check(await js(`document.querySelectorAll('tbody tr').length === 2`), 'history lists 2 rehearsals');
  check(await js(`document.querySelectorAll('.trend-card').length === 3 && document.querySelectorAll('.trend .trace').length >= 2`), 'history shows trend cards');

  await click('Privacy & data');
  await waitFor(`!!document.querySelector('.danger-zone')`, 5000, 'privacy');
  await sleep(300);
  await shot('09-privacy');
  const priv = await text();
  check(/Switched off by Rehearse/.test(priv), 'telemetry off disclosed');
  check(/Blocked by the app \(0 attempts/.test(priv), 'no network attempts from the window');

  const files = fs.readdirSync(path.join(DATA, 'rehearse-data', 'rehearsals'));
  check(files.length === 2, `2 rehearsal files on disk (${files.length})`);
  const rec = JSON.parse(fs.readFileSync(path.join(DATA, 'rehearse-data', 'rehearsals', files[0]), 'utf8'));
  check(rec.schema === 1 && rec.mode === 'simulated' && Array.isArray(rec.timeline.segments), 'record shape');
  check(!JSON.stringify(rec).includes('apiKey'), 'no key field in the record');

  await click('Delete all my data');
  await sleep(200);
  await js(`[...document.querySelectorAll('button')].find((x) => x.classList.contains('armed')).click()`);
  await waitFor(`!!document.querySelector('.consent')`, 5000, 'back to consent after delete');
  check(!fs.existsSync(path.join(DATA, 'rehearse-data', 'rehearsals')), 'rehearsal files deleted');
  check(!fs.existsSync(path.join(DATA, 'rehearse-data', 'settings.json')), 'consent record deleted');
  await shot('10-after-delete');
}

app.on('browser-window-created', (_e, win) => {
  win.setPosition(20, 20);
  win.webContents.once('did-finish-load', async () => {
    const t0 = Date.now();
    try { await run(win); } catch (e) { failures++; log('FAIL exception', e && e.stack || e); }
    log(`${failures ? 'FAILED' : 'PASSED'} with ${failures} failure(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s; screenshots in ${OUT}`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
});
