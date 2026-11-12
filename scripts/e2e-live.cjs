// Short guided LIVE check of the real app (camera + SmartSpectra SDK; uses free-trial credits, about 2 per minute).
// The person in front of the camera should talk naturally with some pauses. No screenshot is taken while the camera
// is on; only the report (after the camera is off) is captured. A throw-away data folder is used and deleted.
// Usage (key in SMARTSPECTRA_API_KEY): npx electron scripts/e2e-live.cjs [rehearsalSeconds=45] [--pulse]
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const SECONDS = Math.min(180, Math.max(16, Number(process.argv.find((a) => /^\d+$/.test(a)) || 45)));
const PULSE = process.argv.includes('--pulse');
const OUT = path.join(__dirname, '..', 'results', 'live');
// Chromium may still hold the previous run's profile when it exits, so stale folders are removed on the next run
for (const n of fs.readdirSync(os.tmpdir())) if (n.startsWith('rehearse-live-')) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-live-'));
process.env.REHEARSE_DIAGNOSTICS = '1';
app.setPath('userData', DATA);
fs.mkdirSync(OUT, { recursive: true });
require('../electron/main.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[live ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const report = { seconds: SECONDS, pulse: PULSE, calibration: [], rehearsal: [], result: null, problems: [] };

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const diag = () => js('window.__rehearseDiag ? window.__rehearseDiag() : null');
  const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const waitFor = async (pred, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await js(pred)) return true; await sleep(250); } return false; };

  if ((await diag())?.mode !== 'live') { report.problems.push('not in live mode (is SMARTSPECTRA_API_KEY set?)'); return; }
  await waitFor(`!!document.querySelector('.consent')`, 10000);
  await js(`document.querySelector('.consent .check input').click()`);
  if (PULSE) await js(`document.querySelector('#consent-pulse').click()`);
  await click('Agree and continue');
  await waitFor(`!!document.querySelector('#title')`, 5000);
  await js(`(() => { const i = document.querySelector('#title'); i.value = 'Live check'; i.dispatchEvent(new Event('input')); })()`);
  await click('Start calibration');
  log('calibration started: sit in front of the camera, say a sentence, pause, breathe');

  const startSel = `[...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary'))`;
  let ready = false;
  for (let i = 0; i < 70 && !ready; i++) {
    await sleep(1000);
    const d = (await diag())?.session;
    const rows = await js(`[...document.querySelectorAll('.check-row')].map((r) => r.querySelector('.check-label').textContent + ': ' + r.querySelector('.check-icon').className.split(' ')[1] + ' (' + r.querySelector('.check-detail').textContent + ')').join(' | ')`);
    report.calibration.push({ t: (Date.now() - t0) / 1000, status: d?.status, validation: d?.validation?.name, counts: d?.counts, errors: d?.errors });
    if (i % 3 === 0) log(rows);
    ready = await js(`(() => { const b = ${startSel}; return !!b && !b.disabled; })()`);
    if (PULSE && ready && i < 40) ready = /Pulse reading \(optional\): ok/.test(rows);   // give the pulse a chance
  }
  if (!ready) { report.problems.push('calibration never became ready'); log('calibration not ready'); await click('Cancel'); return; }
  report.calibrationReadyS = (Date.now() - t0) / 1000;
  await js(`${startSel}.click()`);
  log(`REHEARSAL started for ${SECONDS} s: talk naturally, with pauses`);

  const end = Date.now() + SECONDS * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(5000, Math.max(0, end - Date.now())));
    const d = (await diag())?.session;
    const chip = await js(`document.querySelector('.state-chip')?.textContent`);
    report.rehearsal.push({ t: (Date.now() - t0) / 1000, chip, counts: d?.counts, lagMs: d?.lagMs, insight: d?.insightPackets, errors: d?.errors });
    log(`chip=${chip} talking=${d?.counts?.talking} chest=${d?.counts?.chest} pulse=${d?.counts?.pulse} lag=${Math.round(d?.lagMs?.last ?? -1)}ms insight=${d?.insightPackets}`);
  }
  await click('Finish rehearsal');
  const ok = await waitFor(`!!document.querySelector('.timeline') || /Not enough to analyse/.test(document.body.innerText)`, 20000);
  log('camera off; report', ok ? 'shown' : 'NOT shown');
  await sleep(600);
  const last = (await diag())?.last;
  report.lastSession = last;
  const dir = path.join(DATA, 'rehearse-data', 'rehearsals');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (files.length) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    const { summary, durationS } = rec;
    report.result = { durationS, summary, pauses: rec.timeline.pauses, segments: rec.timeline.segments.length, chestPoints: rec.timeline.chest.length, pulsePoints: rec.timeline.pulse.length, blinks: rec.timeline.blinks.length };
    log('summary', JSON.stringify(summary));
  } else {
    report.problems.push('no rehearsal saved');
    report.reportText = (await js('document.body.innerText')).slice(0, 600);
  }
  // report screenshots (camera is off by now)
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `report${PULSE ? '-pulse' : ''}.png`), img.toPNG());
  if (await js(`!!document.querySelector('.chart-card')`)) {
    await js(`document.querySelector('.chart-card').scrollIntoView()`);
    await sleep(300);
    fs.writeFileSync(path.join(OUT, `timeline${PULSE ? '-pulse' : ''}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await click('Privacy & data');
  await waitFor(`!!document.querySelector('.danger-zone')`, 5000);
  report.privacyText = await js(`[...document.querySelectorAll('.kv')].slice(0, 6).map((r) => r.innerText.replace(/\\n/g, ': ')).join('\\n')`);
  log(report.privacyText);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 50 && !win.isVisible(); i++) await sleep(100);
    try { await run(win); } catch (e) { report.problems.push(String(e && e.stack || e).slice(0, 400)); }
    fs.writeFileSync(path.join(OUT, `live_check${PULSE ? '_pulse' : ''}.json`), JSON.stringify(report, null, 2));
    log(`done; problems: ${report.problems.length ? report.problems.join('; ') : 'none'}; details in results/live/`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    app.exit(report.problems.length ? 1 : 0);
  });
});
