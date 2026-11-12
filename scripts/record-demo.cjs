// Records a ~75 s demo of the real app to results/demo/rehearse-demo.webm (window capture, no audio).
// The script does the clicking; the person in front of the camera only talks while the rehearsal timer runs.
//   npx electron scripts/record-demo.cjs              LIVE (SMARTSPECTRA_API_KEY needed; ~1.5 min of credits)
//   npx electron scripts/record-demo.cjs --simulate   dry run with simulated signals
// Uses a throw-away data folder and turns on the blurred camera preview before anything is shown.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, session } = require('electron');

const SIM = process.argv.includes('--simulate');
const REHEARSAL_S = Math.max(15, Number(process.argv.find((a) => /^\d+$/.test(a)) || 30));
const OUT = path.join(__dirname, '..', 'results', 'demo');
for (const n of fs.readdirSync(os.tmpdir())) if (n.startsWith('rehearse-demo-')) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-demo-'));
if (SIM) process.argv.push('--simulate');
process.env.REHEARSE_DIAGNOSTICS = '1';
app.setPath('userData', DATA);
fs.mkdirSync(OUT, { recursive: true });
require('../electron/main.cjs');

// The app grants only the camera; this script also needs to capture its own window.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const media = (details && details.mediaTypes) || [];
    if (process.env.DEMO_DEBUG) console.log('[demo] permission', permission, JSON.stringify(details));
    // camera (['video']) or window capture ([]); never the microphone
    cb(permission === 'media' && !media.includes('audio') && String((details && details.requestingUrl) || '').startsWith('file://'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (process.env.DEMO_DEBUG) console.log('[demo] check', permission, origin, JSON.stringify(details));
    return permission === 'media';
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[demo ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const problems = [];

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const waitFor = async (pred, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await js(pred)) return true; await sleep(200); } return false; };
  const scrollTo = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ behavior: 'smooth', block: 'start' })`);

  await waitFor(`!!document.querySelector('.consent')`, 10000);
  await js(`window.rehearse.updateSettings({ blurPreview: true })`);

  // start recording the app window
  const sourceId = win.getMediaSourceId();
  const mime = await js(`(async () => { try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)}, maxFrameRate: 15, maxWidth: 1600, maxHeight: 1100 } } });
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    window.__demo = { chunks: [], rec, stream, mime };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) window.__demo.chunks.push(e.data); };
    rec.start(1000);
    return mime;
  } catch (e) { return 'ERROR ' + (e && e.name) + ': ' + (e && e.message); } })()`);
  log('recording', mime);
  if (!mime || String(mime).startsWith('ERROR')) { problems.push(`recorder: ${mime}`); return; }

  // consent
  await sleep(2500);
  await scrollTo('.consent-choices');
  await sleep(1500);
  await js(`document.querySelector('.consent .check input').click()`);
  await sleep(700);
  await click('Agree and continue');

  // home
  await waitFor(`!!document.querySelector('#title')`, 5000);
  await sleep(800);
  const title = 'Quarterly update';
  for (let i = 1; i <= title.length; i++) {
    await js(`(() => { const el = document.querySelector('#title'); el.value = ${JSON.stringify(title)}.slice(0, ${i}); el.dispatchEvent(new Event('input')); })()`);
    await sleep(60);
  }
  await js(`(() => { const s = document.querySelector('#target'); s.value = '60'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  await click('Start calibration');
  log('calibration: look at the screen, say a sentence, pause, breathe');

  // calibration until ready
  const startSel = `[...document.querySelectorAll('button')].find((x) => /^Start/.test(x.textContent) && x.classList.contains('primary'))`;
  if (!(await waitFor(`(() => { const b = ${startSel}; return !!b && !b.disabled; })()`, 60000))) { problems.push('calibration not ready in 60 s'); }
  await sleep(1500);
  const rows = () => js(`[...document.querySelectorAll('.check-row')].map((r) => r.querySelector('.check-label').textContent + ': ' + r.querySelector('.check-icon').className.split(' ')[1] + ' (' + r.querySelector('.check-detail').textContent + ')').join(' | ')`);
  let started = false;
  for (let i = 0; i < 180 && !started; i++) {          // up to ~45 s: positioning feedback can flicker
    await js(`(() => { const b = ${startSel}; if (b && !b.disabled) b.click(); })()`);
    await sleep(250);
    started = await js(`!!document.querySelector('.timer')`);
    if (!started && i % 20 === 19) log('waiting:', await rows());
  }
  if (!started) { problems.push(`rehearsal did not start; checklist: ${await rows()}`); await click('Cancel'); await sleep(3000); return; }
  log(`REHEARSAL: talk for ${REHEARSAL_S} s with a few real pauses`);
  await sleep(REHEARSAL_S * 1000);
  await click('Finish rehearsal');
  log('finished; camera off');

  // report
  await waitFor(`!!document.querySelector('.timeline') || /Not enough to analyse/.test(document.body.innerText)`, 20000);
  await sleep(4500);
  fs.writeFileSync(path.join(OUT, `report${SIM ? '-sim' : ''}.png`), (await win.webContents.capturePage()).toPNG());
  await scrollTo('.chart-card');
  await sleep(5500);
  fs.writeFileSync(path.join(OUT, `timeline${SIM ? '-sim' : ''}.png`), (await win.webContents.capturePage()).toPNG());

  // privacy
  await click('Privacy & data');
  await sleep(4500);

  // stop and save
  const size = await js(`(async () => {
    const d = window.__demo;
    await new Promise((r) => { d.rec.onstop = r; d.rec.stop(); });
    d.stream.getTracks().forEach((t) => t.stop());
    d.buf = new Uint8Array(await new Blob(d.chunks, { type: d.mime }).arrayBuffer());
    return d.buf.length;
  })()`);
  const CH = 2 * 1024 * 1024;
  const parts = [];
  for (let off = 0; off < size; off += CH) {
    const b64 = await js(`(() => { const u = window.__demo.buf.subarray(${off}, ${off + CH}); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })()`);
    parts.push(Buffer.from(b64, 'base64'));
  }
  const file = path.join(OUT, `rehearse-demo${SIM ? '-sim' : ''}.webm`);
  fs.writeFileSync(file, Buffer.concat(parts));
  const diag = await js('window.__rehearseDiag ? window.__rehearseDiag() : null');
  if (diag && diag.series) fs.writeFileSync(path.join(OUT, `session${SIM ? '-sim' : ''}.json`), JSON.stringify(diag.series));
  log(`saved ${file} (${(size / 1e6).toFixed(1)} MB); errors: ${JSON.stringify(diag?.last?.errors || [])}; insight packets: ${diag?.lastInsightPackets}`);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const ev = args[0] || {};
    const level = typeof args[1] === 'number' ? args[1] : ev.level;
    const message = typeof args[2] === 'string' ? args[2] : ev.message;
    if (level === 'error' || level >= 3) log(`console error: ${String(message).slice(0, 200)}`);
  });
  win.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 50 && !win.isVisible(); i++) await sleep(100);
    await sleep(500);
    try { await run(win); } catch (e) { problems.push(String((e && (e.stack || e.message)) || JSON.stringify(e)).slice(0, 400) + ' ' + JSON.stringify(e).slice(0, 200)); }
    log(`done; problems: ${problems.length ? problems.join('; ') : 'none'}`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    app.exit(problems.length ? 1 : 0);
  });
});
