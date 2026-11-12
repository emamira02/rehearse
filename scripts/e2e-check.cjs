// Drives the in-app accuracy check end to end and saves the outcome.
//   npx electron scripts/e2e-check.cjs --simulate   simulated speaker follows the cards (no camera, no credits)
//   npx electron scripts/e2e-check.cjs              LIVE: the person in front of the camera follows the cards
//                                                    (needs SMARTSPECTRA_API_KEY; about 2.5 min ≈ 5 credits)
// Output: results/check/check-<mode>.json (summary, per-pause rows, derived signal series; no images, no
// landmarks) and a screenshot of the results screen (taken after the camera is off). Throw-away data folder.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const SIM = process.argv.includes('--simulate');
const OUT = path.join(__dirname, '..', 'results', 'check');
for (const n of fs.readdirSync(os.tmpdir())) if (n.startsWith('rehearse-check-')) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-check-'));
process.env.REHEARSE_DIAGNOSTICS = '1';
app.setPath('userData', DATA);
if (SIM) app.disableHardwareAcceleration();
fs.mkdirSync(OUT, { recursive: true });
require('../electron/main.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[check ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const out = { mode: SIM ? 'simulated' : 'live', problems: [], calibration: [] };

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const waitFor = async (pred, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await js(pred)) return true; await sleep(250); } return false; };
  const diag = () => js('window.__rehearseDiag ? window.__rehearseDiag() : null');

  const mode = (await diag())?.mode;
  if (mode !== (SIM ? 'simulated' : 'live')) { out.problems.push(`unexpected mode ${mode}`); return; }
  await waitFor(`!!document.querySelector('.consent')`, 10000);
  await js(`document.querySelector('.consent .check input').click()`);
  await click('Agree and continue');
  await waitFor(`!!document.querySelector('.check-card')`, 5000);
  await click('Run the check');
  log('calibration: look at the screen; say a sentence, pause, breathe');
  const startSel = `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start the check')`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await sleep(1000);
    const rows = await js(`[...document.querySelectorAll('.check-row')].map((r) => r.querySelector('.check-label').textContent + ': ' + r.querySelector('.check-icon').className.split(' ')[1] + ' (' + r.querySelector('.check-detail').textContent + ')').join(' | ')`);
    const d = (await diag())?.session;
    out.calibration.push({ t: (Date.now() - t0) / 1000, rows, breathing: d?.requested?.breathing, counts: d?.counts, faceInfo: d?.faceInfo, errors: d?.errors });
    if (i % 4 === 0) log(rows, '| breathing =', d?.requested?.breathing, '| face', JSON.stringify(d?.faceInfo));
    ready = await js(`(() => { const b = ${startSel}; return !!b && !b.disabled; })()`);
  }
  if (!ready) { out.problems.push('calibration never became ready'); await click('Cancel'); return; }
  out.readyAtS = (Date.now() - t0) / 1000;
  await sleep(SIM ? 500 : 2000);        // a little more baseline while looking at the screen
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await js(`(() => { const b = ${startSel}; if (b && !b.disabled) b.click(); })()`);
    await sleep(250);
    started = await js(`!!document.querySelector('.cue-card')`);
  }
  if (!started) { out.problems.push('could not start the check'); return; }
  log('CHECK started: follow the cards on screen');
  let lastCard = '';
  const ok = await (async () => {
    const s = Date.now();
    while (Date.now() - s < 200000) {
      if (await js(`!!document.querySelector('.check-results')`)) return true;
      const card = await js(`(document.querySelector('.cue-card .eyebrow')?.textContent || '') + ' ' + (document.querySelector('.cue-title')?.textContent || '')`);
      if (card && card !== lastCard && card.trim()) { lastCard = card; log(card); }
      await sleep(500);
    }
    return false;
  })();
  if (!ok) { out.problems.push('results screen not shown'); return; }
  await sleep(500);
  const d = await diag();
  out.check = d?.check || null;
  out.summaryText = await js(`document.querySelector('.check-results').innerText`);
  log('\n' + out.summaryText);
  fs.writeFileSync(path.join(OUT, `results-${out.mode}.png`), (await win.webContents.capturePage()).toPNG());
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const ev = args[0] || {};
    const level = typeof args[1] === 'number' ? args[1] : ev.level;
    const message = typeof args[2] === 'string' ? args[2] : ev.message;
    if (level === 'error' || level === 'warning' || level >= 2) { log(`console ${level}: ${String(message).slice(0, 300)}`); out.problems.push(`console: ${String(message).slice(0, 200)}`); }
  });
  win.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 50 && !win.isVisible(); i++) await sleep(100);
    await sleep(500);
    try { await run(win); } catch (e) { out.problems.push(String(e && e.stack || e).slice(0, 400)); }
    fs.writeFileSync(path.join(OUT, `check-${out.mode}.json`), JSON.stringify(out));
    log(`done; problems: ${out.problems.length ? out.problems.join('; ') : 'none'}`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    app.exit(out.problems.length ? 1 : 0);
  });
});
