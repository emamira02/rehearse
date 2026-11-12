// Rehearse renderer: screens and navigation.
import { h, mount, setText, confirmButton } from './dom.js';
import { Session } from './session.js';
import { VALIDATION_TEXT } from './sources.js';
import { timelineChart, sparkline, trendChart } from './charts.js';
import { rehearsalNotes, fmtClock, fmtSeconds } from '../notes.js';
import { MIN_REHEARSAL_S } from '../rehearsal.js';
import { RELIABLE, USE_WITH_CARE } from '../config.js';
import { CHECK_SCRIPT, CHECK_DURATION_S, stepAt, evaluateCheck } from '../check.js';
import { poseBaseline } from '../face.js';
import { speechSeries } from '../speech.js';

const api = window.rehearse;
const app = {
  cfg: null,
  screen: null,
  session: null,
  draft: { title: '', targetS: null },
  current: null,
  historyFilter: '',
  timers: [],
  lastInsightPackets: 0,
};
const view = () => document.getElementById('view');
const NUDGE_RUN_S = 45;
const TARGETS = [null, 60, 120, 180, 300, 420, 600, 900, 1200];

// ---------------------------------------------------------------------------------------------------------------
// shell

function clearTimers() { for (const t of app.timers) clearInterval(t); app.timers = []; }
function every(ms, fn) { fn(); app.timers.push(setInterval(fn, ms)); }

const sessionActive = () => !!app.session && ['calibrating', 'rehearsing', 'checking', 'finishing'].includes(app.session.phase);

function modeChip() {
  const m = app.cfg.mode;
  if (m === 'live') return h('span', { class: 'chip live', title: 'Signals come from your camera through the Presage SmartSpectra SDK' }, h('i', { class: 'dot' }), 'Live · SmartSpectra');
  if (m === 'simulated') return h('span', { class: 'chip sim', title: 'Synthetic signals for trying the app: the camera stays off' }, 'Simulated signals');
  return h('span', { class: 'chip warn' }, 'Live mode not set up');
}

function renderHeader() {
  const nav = [['home', 'Rehearse'], ['history', 'History'], ['privacy', 'Privacy & data']];
  const locked = sessionActive() || !app.cfg.hasConsent;
  mount(document.getElementById('header'),
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'Rehearse'),
    h('nav', {}, nav.map(([id, label]) => h('button', {
      type: 'button',
      class: `nav ${app.screen === id || (id === 'home' && ['calibrate', 'rehearse', 'finishing', 'report', 'check', 'check-result'].includes(app.screen)) ? 'active' : ''}`,
      disabled: locked,
      onclick: () => go(id),
    }, label))),
    modeChip(),
  );
}

async function go(screen, arg) {
  clearTimers();
  app.screen = screen;
  window.scrollTo(0, 0);
  renderHeader();
  const fn = SCREENS[screen];
  try {
    await fn(arg);
  } catch (e) {
    console.error(e);
    mount(view(), errorCard('Something went wrong', e.message || String(e), () => go('home')));
  }
  renderHeader();
}

function errorCard(title, message, back) {
  return h('section', { class: 'card error' },
    h('h2', {}, title),
    h('p', {}, message),
    back ? h('button', { class: 'btn', type: 'button', onclick: back }, 'Back') : null,
  );
}

const item = (icon, title, text) => h('li', { class: 'item' },
  h('span', { class: `icon ${icon}`, 'aria-hidden': 'true' }),
  h('div', {}, h('strong', {}, title), h('p', {}, text)));

function toggle({ label, hint, checked, onchange, id }) {
  return h('label', { class: 'toggle', for: id },
    h('input', { type: 'checkbox', id, checked, onchange: (e) => onchange(e.target.checked) }),
    h('span', { class: 'switch', 'aria-hidden': 'true' }),
    h('span', { class: 'toggle-text' }, label, hint ? h('small', {}, hint) : null),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// consent

function consentItems(cfg) {
  return [
    item('cam', 'Camera only. No microphone. No recording.',
      'The camera is on only during calibration and a rehearsal, with a live preview on screen and your camera light on. ' +
      'Frames are analysed in memory on this computer by the Presage SmartSpectra SDK and then discarded. Rehearse never records audio or video.'),
    item('wave', 'What it reads',
      'Whether you are speaking (from the movement of your lips, using the face landmarks the SDK computes; Rehearse reduces them to a few numbers on arrival and never stores them), your blinks, the movement of your chest as you breathe, and, only if you switch it on, a pulse reading.'),
    item('disk', 'What it keeps, and where',
      `A summary and simplified timelines of each rehearsal, saved only on this computer (${cfg.dataDir}). ` +
      'No images, video or face landmarks are stored. One button on the Privacy & data page deletes everything.'),
    item('net', 'Network',
      'Rehearse uploads nothing, and its window is blocked from making network requests. In live mode the SmartSpectra SDK contacts Presage to validate your API key. ' +
      'Rehearse switches SDK telemetry off and asks only for the chest breathing trace, not the breathing rate, which in our tests kept the SDK from sending automatic AI-insight snapshots.'),
    item('pulse', 'Optional pulse reading (off by default)',
      'Presage documents that the SDK automatically sends periodic snapshots of vitals (pulse rate, heart-rate variability, breathing rate; never images or video) to its AI insight service when breathing and cardio metrics are requested. Switching the pulse reading on adds cardio data, so expect such snapshots. Rehearse never requests or shows insights.'),
    item('heart', 'Not a medical device',
      'Rehearse gives feedback on how you present. It does not diagnose, treat or assess any health condition, and its readings can be wrong.'),
  ];
}

async function consentScreen() {
  const cfg = app.cfg;
  let agreed = false;
  let pulse = cfg.settings.pulseEnabled === true;
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Agree and continue');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    app.cfg = await api.giveConsent({ pulseEnabled: pulse });
    go('home');
  });
  mount(view(), h('section', { class: 'card consent' },
    h('p', { class: 'eyebrow' }, 'Before you start'),
    h('h1', {}, 'Practise your talk with a camera that only listens with its eyes.'),
    h('p', { class: 'lede' }, 'Rehearse watches how you pace a talk: when you speak, when you pause, and whether you breathe in your pauses. Here is exactly what that involves.'),
    cfg.mode === 'simulated' ? h('p', { class: 'banner sim' }, 'Simulated mode: the camera stays off and every signal is synthetic.') : null,
    h('ul', { class: 'items' }, consentItems(cfg)),
    h('div', { class: 'consent-choices' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', onchange: (e) => { agreed = e.target.checked; btn.disabled = !agreed; } }),
        h('span', {}, 'I am the person in front of the camera and I agree to the above. I will not use Rehearse to measure anyone else.')),
      toggle({ id: 'consent-pulse', label: 'Also show a pulse reading', hint: 'Optional, information only. See the note on the pulse reading above.', checked: pulse, onchange: (v) => { pulse = v; } }),
    ),
    h('div', { class: 'actions' }, btn),
  ));
}

// ---------------------------------------------------------------------------------------------------------------
// home

function setupMissingCard() {
  return h('section', { class: 'card warn-card' },
    h('h2', {}, 'Live mode needs a SmartSpectra API key'),
    h('ol', {},
      h('li', {}, 'Create a free key at physiology.presagetech.com.'),
      h('li', {}, 'Store it in the environment variable SMARTSPECTRA_API_KEY (see the README).'),
      h('li', {}, 'Start Rehearse again from a new terminal with npm start.')),
    h('p', {}, 'Until then you can try everything with simulated signals; the camera stays off.'),
    h('button', { class: 'btn', type: 'button', onclick: () => api.relaunch('simulated') }, 'Restart with simulated signals'),
  );
}

function runCard(r) {
  const S = r.summary || {};
  return h('button', { class: 'run-card', type: 'button', onclick: () => go('report', r.id) },
    h('span', { class: 'run-title' }, r.title),
    h('span', { class: 'run-date' }, new Date(r.createdAt).toLocaleString(), r.mode === 'simulated' ? h('span', { class: 'mini-chip' }, 'simulated') : null),
    h('span', { class: 'run-stats' },
      h('span', {}, fmtClock(r.durationS)),
      h('span', {}, S.breathAnchoredPauses == null ? '–' : `${Math.round(S.breathAnchoredPauses * 100)}% breaths in pauses`),
      h('span', {}, S.longestRunS == null ? '–' : `longest stretch ${fmtSeconds(S.longestRunS)}`)),
  );
}

async function homeScreen(prefill) {
  if (prefill && typeof prefill.title === 'string') app.draft.title = prefill.title;
  const cfg = app.cfg;
  const { items } = await api.list();
  const titles = [...new Set(items.map((r) => r.title))].slice(0, 30);
  const canStart = cfg.mode === 'live' || cfg.mode === 'simulated';

  const title = h('input', { id: 'title', type: 'text', maxlength: '120', placeholder: 'e.g. Quarterly update, thesis defence, conference talk', list: 'titles', value: app.draft.title,
    oninput: (e) => { app.draft.title = e.target.value; } });
  const target = h('select', { id: 'target', onchange: (e) => { app.draft.targetS = e.target.value ? Number(e.target.value) : null; } },
    TARGETS.map((t) => h('option', { value: t ?? '', selected: t === app.draft.targetS }, t ? `${t / 60} min` : 'No target')));

  mount(view(),
    cfg.mode === 'live-unavailable' ? setupMissingCard() : null,
    h('section', { class: 'card start' },
      h('h1', {}, 'New rehearsal'),
      h('p', { class: 'lede' }, 'Sit as you will present, with your face and upper chest in view. Rehearse calibrates for about 20 seconds, then you give your talk.'),
      h('div', { class: 'form' },
        h('label', { for: 'title' }, 'What are you rehearsing?'), title,
        h('datalist', { id: 'titles' }, titles.map((t) => h('option', { value: t }))),
        h('label', { for: 'target' }, 'Target length'), target,
      ),
      h('div', { class: 'toggles' },
        toggle({ id: 'opt-pulse', label: 'Pulse reading', hint: 'Information only. When on, the SDK may send periodic vitals snapshots to Presage\'s AI insight service (see Privacy & data).',
          checked: cfg.settings.pulseEnabled, onchange: async (v) => { app.cfg = await api.updateSettings({ pulseEnabled: v }); } }),
        toggle({ id: 'opt-nudges', label: 'Gentle pause nudges', hint: `A quiet hint when you have spoken for ${NUDGE_RUN_S} s without a pause.`,
          checked: cfg.settings.nudges, onchange: async (v) => { app.cfg = await api.updateSettings({ nudges: v }); } }),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary big', type: 'button', disabled: !canStart, onclick: () => go('calibrate') }, 'Start calibration'),
        h('span', { class: 'fineprint' }, cfg.mode === 'simulated' ? 'Simulated signals: camera stays off.' : 'The camera turns on when you press Start and off when you finish.')),
    ),
    h('section', { class: 'steps' },
      h('div', { class: 'step' }, h('b', {}, '1 · Calibrate'), h('span', {}, 'About 20 s while the signals settle.')),
      h('div', { class: 'step' }, h('b', {}, '2 · Rehearse'), h('span', {}, 'Give your talk. No audio is captured.')),
      h('div', { class: 'step' }, h('b', {}, '3 · Review'), h('span', {}, 'Pauses, breaths and pacing on a timeline.')),
    ),
    checkCard(),
    items.length ? h('section', { class: 'recent' },
      h('h2', {}, 'Recent rehearsals'),
      h('div', { class: 'run-grid' }, items.slice(0, 4).map(runCard))) : null,
  );
  title.focus();
}

// ---------------------------------------------------------------------------------------------------------------
// calibration and rehearsal

function previewBox() {
  const box = h('div', { class: 'preview' });
  if (app.cfg.mode === 'simulated') {
    const ring = h('div', { class: 'sim-ring' });
    box.append(ring, h('div', { class: 'preview-label' }, 'Simulated signals · camera off'));
    box.simRing = ring;
  } else {
    const video = h('video', { autoplay: true, muted: true, playsinline: true });
    video.muted = true;
    // the blur is applied to the on-screen preview only (handy when sharing or recording the screen); the SDK
    // still receives the normal camera frames
    const blurred = () => app.cfg.settings.blurPreview === true;
    box.classList.toggle('blurred', blurred());
    const blurBtn = h('button', { class: 'preview-toggle', type: 'button' }, blurred() ? 'Show preview' : 'Blur preview');
    blurBtn.addEventListener('click', async () => {
      app.cfg = await api.updateSettings({ blurPreview: !blurred() });
      box.classList.toggle('blurred', blurred());
      setText(blurBtn, blurred() ? 'Show preview' : 'Blur preview');
    });
    box.append(video, h('div', { class: 'preview-label on' }, h('i', { class: 'dot' }), 'Camera on'), blurBtn);
    box.video = video;
    const attach = (st) => { video.srcObject = st || null; if (st) video.play().catch(() => {}); };
    attach(app.session?.stream);
    app.session?.on('stream', attach);
  }
  return box;
}

function updateSimRing(box) {
  if (!box.simRing) return;
  const a = app.session.buf.chest;
  if (a.length < 10) { box.simRing.style.transform = 'scale(0.8)'; return; }
  const tail = a.slice(-600).map((x) => x.v);
  const lo = Math.min(...tail), hi = Math.max(...tail);
  const v = (a[a.length - 1].v - lo) / ((hi - lo) || 1);
  box.simRing.style.transform = `scale(${(0.7 + 0.3 * v).toFixed(3)})`;
  box.simRing.classList.toggle('speaking', app.session.speakingNow() === true);
}

function checkRow(label) {
  const icon = h('span', { class: 'check-icon pending', 'aria-hidden': 'true' });
  const text = h('span', { class: 'check-detail' });
  const row = h('li', { class: 'check-row' }, icon, h('span', { class: 'check-label' }, label), text);
  row.set = (state, detail = '') => { icon.className = `check-icon ${state}`; setText(text, detail); };
  return row;
}

async function endSession() {
  const s = app.session;
  app.session = null;
  if (s) await s.close();
}

async function calibrateScreen(opts = {}) {
  const isCheck = opts.check === true;
  await endSession();
  app.stopReason = null;
  const face = true;   // landmarks are needed for speech detection (lip movement)
  const breathing = app.breathing || app.cfg.breathing;
  const session = new Session({ mode: app.cfg.mode, pulseEnabled: !isCheck && app.cfg.settings.pulseEnabled === true, face, breathing });
  app.session = session;
  const rows = {
    camera: checkRow(app.cfg.mode === 'simulated' ? 'Simulated input' : 'Camera'),
    face: checkRow('Face and position'),
    talking: checkRow('Speaking detection'),
    chest: checkRow('Breathing movement'),
    pose: face ? checkRow('Face tracking') : null,
    pulse: session.pulseEnabled ? checkRow('Pulse reading (optional)') : null,
  };
  const speakDot = h('span', { class: 'speak-dot' });
  const spark = h('div', { class: 'spark-wrap' });
  const elapsed = h('span', { class: 'fineprint' });
  const errorBox = h('div');
  const startBtn = h('button', { class: 'btn primary big', type: 'button', disabled: true,
    onclick: () => { if (isCheck) { session.startCheck(); go('check'); } else { session.startRehearsal(); go('rehearse'); } } },
  isCheck ? 'Start the check' : 'Start rehearsal');
  const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: async () => { await endSession(); go('home'); } }, 'Cancel');
  const preview = previewBox();

  mount(view(), h('section', { class: 'calibrate' },
    h('div', { class: 'cal-left' }, preview,
      h('div', { class: 'live-row' }, h('span', { class: 'live-label' }, 'Speaking'), speakDot, h('span', { class: 'live-label' }, 'Breathing'), spark)),
    h('div', { class: 'cal-right card' },
      h('p', { class: 'eyebrow' }, isCheck ? 'Accuracy check · calibration' : 'Calibration'),
      h('h1', {}, isCheck ? 'How well does Rehearse read you?' : app.draft.title || 'Untitled rehearsal'),
      h('p', { class: 'lede' }, isCheck
        ? 'Look at the screen as you will when presenting. When everything is green, start the check and follow the cards for about two minutes.'
        : 'Say a sentence, pause, take a breath. Check that the indicators follow you. Signals usually settle within 10 to 30 seconds.'),
      h('ul', { class: 'checklist' }, Object.values(rows).filter(Boolean)),
      errorBox,
      h('div', { class: 'actions' }, cancelBtn, startBtn), elapsed),
  ));

  session.on('error', (e) => {
    mount(errorBox, h('div', { class: 'banner error' },
      h('strong', {}, 'The SDK reported a problem. '),
      `${e.message || 'Unknown error'}${e.code !== undefined ? ` (code ${e.code})` : ''}`,
      e.retryable ? ' It may recover on its own.' : ''));
  });
  session.begin();

  every(150, () => {
    if (app.session !== session) return;
    const c = session.checklist();
    // Rehearse asks only for the chest trace by default; if this SDK build does not deliver it on its own, fall back
    // once to the SDK's full breathing bundle (chest, abdomen, rate) for the rest of the app run.
    if (session.breathing === 'chest' && !c.chest && c.talking && c.sinceBeginS > 25) {
      app.breathing = 'bundle';
      console.warn('[rehearse] no chest trace with CHEST_BREATHING alone; restarting with the breathing bundle');
      go('calibrate', opts);
      return;
    }
    rows.camera.set(c.camera ? 'ok' : 'pending', c.camera ? (app.cfg.mode === 'simulated' ? 'synthetic signals' : 'preview on') : 'starting…');
    const v = c.validation;
    rows.face.set(c.face ? 'ok' : v ? 'warn' : 'pending', v ? (VALIDATION_TEXT[v.name] || v.hint || v.name) : 'waiting for the first frames…');
    rows.talking.set(c.talking ? 'ok' : 'pending', c.talking ? 'follows your mouth' : 'warming up…');
    rows.chest.set(c.chest ? 'ok' : 'pending', c.chest ? 'chest trace received' : 'warming up…');
    if (rows.pose) rows.pose.set(c.pose ? 'ok' : session.first.pose !== undefined ? 'warn' : 'pending',
      c.pose ? 'lips and face tracked' : session.first.pose !== undefined ? 'paused: keep your upper chest in view' : 'warming up…');
    if (rows.pulse) rows.pulse.set(c.pulse ? 'ok' : 'pending', c.pulse ? `${Math.round(session.lastOf('pulse').v)} bpm (information only)` : 'usually ready after ~25 s');
    const sp = session.speakingNow();
    speakDot.className = `speak-dot ${sp === true ? 'on' : sp === false ? 'off' : ''}`;
    mount(spark, sparkline(session.buf.chest, { windowS: 15, width: 200, height: 36 }));
    updateSimRing(preview);
    const ready = c.face && c.steady && c.talking && c.chest && (c.pose !== false) && (!isCheck || session.recentPose(10).length >= 30);
    startBtn.disabled = !ready;
    if (!isCheck) setText(startBtn, ready && rows.pulse && !c.pulse ? 'Start (pulse still warming up)' : 'Start rehearsal');
    const t = Math.round(c.sinceBeginS);
    setText(elapsed, t > 50 && !ready
      ? `${t} s. Still waiting: check the light in front of you, keep your face and chest in view, and close other apps using the camera.`
      : `${t} s`);
  });
}

async function rehearseScreen() {
  const session = app.session;
  if (!session || session.phase !== 'rehearsing') return go('home');
  const target = app.draft.targetS;
  const timer = h('div', { class: 'timer' }, '0:00');
  const targetBar = h('div', { class: 'target-bar' }, h('i'));
  const state = h('div', { class: 'state-chip' }, '…');
  const nudge = h('div', { class: 'nudge', hidden: true }, 'Long stretch: pause after this point.');
  const spark = h('div', { class: 'spark-wrap wide' });
  const blinks = h('span', { class: 'sig-value' }, '–');
  const pulse = h('span', { class: 'sig-value' }, '–');
  const ratio = h('span', { class: 'sig-value' }, '–');
  const strip = h('div', { class: 'signals' },
    h('div', { class: 'sig' }, h('span', { class: 'sig-label' }, 'Breathing'), spark),
    h('div', { class: 'sig' }, h('span', { class: 'sig-label' }, 'Speaking so far'), ratio),
    h('div', { class: 'sig' }, h('span', { class: 'sig-label' }, 'Blinks'), blinks),
    session.pulseEnabled ? h('div', { class: 'sig' }, h('span', { class: 'sig-label' }, 'Pulse reading (info)'), pulse) : null,
  );
  let showSignals = true;
  const hideBtn = h('button', { class: 'btn ghost small', type: 'button' }, 'Hide live signals');
  hideBtn.addEventListener('click', () => { showSignals = !showSignals; strip.hidden = !showSignals; setText(hideBtn, showSignals ? 'Hide live signals' : 'Show live signals'); });
  const finishBtn = h('button', { class: 'btn primary big', type: 'button', onclick: () => finish() }, 'Finish rehearsal');
  const discardBtn = confirmButton({ label: 'Discard', armedLabel: 'Click again to discard', className: 'btn ghost', action: async () => { await endSession(); go('home'); } });
  const preview = previewBox();

  mount(view(), h('section', { class: 'rehearse' },
    h('div', { class: 'stage card' },
      h('p', { class: 'eyebrow' }, app.draft.title || 'Untitled rehearsal'),
      timer,
      target ? targetBar : null,
      target ? h('p', { class: 'fineprint' }, `Target ${fmtClock(target)}`) : null,
      state, nudge,
      h('div', { class: 'actions center' }, discardBtn, finishBtn),
      h('p', { class: 'fineprint' }, 'Tip: keep this window beside your slides. Measuring continues while you look elsewhere.'),
    ),
    h('div', { class: 'side' }, preview, h('div', { class: 'side-head' }, h('span', { class: 'eyebrow' }, 'Live signals'), hideBtn), strip),
  ));

  async function finish() {
    finishBtn.disabled = true;
    go('finishing');
  }

  every(100, () => {
    if (session.phase !== 'rehearsing') return;
    // the SDK can stop on its own (e.g. frame rate too low): keep what was measured and show the report
    if (session.status === 'error') {
      app.stopReason = session.error && session.error.message ? session.error.message : 'The SDK stopped measuring.';
      go('finishing');
      return;
    }
    const el = session.elapsedS;
    setText(timer, fmtClock(el));
    if (target) {
      targetBar.firstChild.style.width = `${Math.min(100, (el / target) * 100)}%`;
      targetBar.classList.toggle('over', el > target);
      timer.classList.toggle('over', el > target);
    }
    const sp = session.speakingNow();
    const { silenceS, runS } = session.pacing();
    if (sp === null) { state.className = 'state-chip idle'; setText(state, 'Waiting for signal'); }
    else if (sp) { state.className = 'state-chip speaking'; setText(state, 'Speaking'); }
    else { state.className = 'state-chip pause'; setText(state, silenceS !== null && silenceS >= 0.6 ? `Pause ${silenceS.toFixed(1)} s` : 'Pause'); }
    nudge.hidden = !(app.cfg.settings.nudges && sp && runS >= NUDGE_RUN_S);
    mount(spark, sparkline(session.buf.chest, { windowS: 20, width: 260, height: 40 }));
    const tk = session.buf.speech;
    let yes = 0, n = 0, blinkN = 0, prev = false;
    for (let i = tk.length - 1; i >= 0 && tk[i].ts >= session.startUs; i--) { n++; if (tk[i].detected) yes++; }
    setText(ratio, n ? `${Math.round((yes / n) * 100)}%` : '–');
    const bk = session.buf.blinking;
    for (let i = 0; i < bk.length; i++) {
      if (bk[i].ts < session.startUs) continue;
      if (bk[i].detected && !prev) blinkN++;
      prev = bk[i].detected;
    }
    setText(blinks, String(blinkN));
    const lp = session.lastOf('pulse');
    if (lp) setText(pulse, `${Math.round(lp.v)} bpm`);
    updateSimRing(preview);
  });
}

async function finishingScreen() {
  const session = app.session;
  if (!session) return go('home');
  mount(view(), h('section', { class: 'card center-card' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h2', {}, 'Wrapping up'),
    h('p', {}, 'Collecting the last signals and switching the camera off…')));
  const result = await session.finish();
  app.lastInsightPackets = session.insightPackets;
  app.lastDiagnostics = session.diagnostics();
  if (app.cfg.diagnostics) app.lastSeries = session.lastSeries || null;
  app.session = null;
  renderHeader();
  if (!result) return go('home');
  const record = {
    title: app.draft.title.trim() || 'Untitled rehearsal',
    mode: app.cfg.mode === 'live' ? 'live' : 'simulated',
    pulseEnabled: session.pulseEnabled,
    targetS: app.draft.targetS,
    durationS: result.durationS,
    summary: result.summary,
    timeline: result.timeline,
    appVersion: app.cfg.appVersion,
    sdkVersion: app.cfg.mode === 'live' ? app.cfg.sdkVersion : null,
    note: app.stopReason ? `Measurement stopped early: ${app.stopReason}` : null,
  };
  if (!result.enough) {
    app.current = { ...record, unsaved: true, counts: result.counts };
    return go('report');
  }
  const saved = await api.save(record);
  app.current = { ...record, id: saved.id, createdAt: saved.createdAt, title: saved.title };
  go('report');
}

// ---------------------------------------------------------------------------------------------------------------
// accuracy check

const r3 = (x) => Math.round(x * 1000) / 1000;

function checkSteps(t0) {
  let cum = 0;
  return CHECK_SCRIPT.map((st) => { const a = cum; cum += st.s; return { ...st, startUs: t0 + a * 1e6, endUs: t0 + cum * 1e6 }; });
}


// export for scripts/e2e-live.cjs (diagnostics only): derived signal series, never landmarks or images
function checkExport(buf, t0, steps, baseline, diagnostics) {
  const from = t0 - 12e6, to = steps[steps.length - 1].endUs + 3e6;
  const rel = (ts) => r3((ts - t0) / 1e6);
  const pick = (arr, f) => (arr || []).filter((x) => x.ts >= from && x.ts <= to).map(f);
  return {
    steps: steps.map((st) => [st.kind, st.block, rel(st.startUs), rel(st.endUs)]),
    talking: pick(buf.talking, (x) => [rel(x.ts), x.detected ? 1 : 0, x.stable ? 1 : 0]),
    chest: pick(buf.chest, (x) => [rel(x.ts), r3(x.v)]),
    pose: pick(buf.pose, (x) => [rel(x.ts), r3(x.pitch), r3(x.yaw), x.mouth == null ? null : Math.round(x.mouth * 10000) / 10000, x.size == null ? null : Math.round(x.size * 10) / 10]),
    smile: pick(buf.smile, (x) => [rel(x.ts), Math.round(x.v * 10) / 10]),
    blinking: pick(buf.blinking, (x) => [rel(x.ts), x.detected ? 1 : 0]),
    baseline, diagnostics,
  };
}

async function checkScreen() {
  const session = app.session;
  if (!session || session.phase !== 'checking') return go('home');
  const t0 = session.checkStartUs;
  const steps = checkSteps(t0);
  if (session.source && session.source.kind === 'simulated') {
    const src = session.source;   // the simulated speaker follows the cards, with a human-like 0.4 s delay
    src.cueAt = (t) => {
      const el = (src.startUs + t * 1e6 - t0) / 1e6 - 0.4;
      const at = el >= 0 ? stepAt(el) : null;
      return at ? { key: at.step.i, truth: at.step.truth } : null;
    };
  }
  const counter = h('p', { class: 'eyebrow' });
  const title = h('h1', { class: 'cue-title' });
  const text = h('p', { class: 'cue-text' });
  const bar = h('div', { class: 'target-bar cue-bar' }, h('i'));
  const overall = h('div', { class: 'target-bar thin' }, h('i'));
  const next = h('p', { class: 'fineprint' });
  const warn = h('p', { class: 'banner warn', hidden: true });
  const cancel = h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await endSession(); go('home'); } }, 'Cancel check');
  const preview = previewBox();
  mount(view(), h('section', { class: 'rehearse' },
    h('div', { class: 'stage card cue-card' }, counter, title, text, bar, next, warn, overall, h('div', { class: 'actions center' }, cancel)),
    h('div', { class: 'side' }, preview, h('p', { class: 'fineprint' }, 'Follow each card as it appears. Nothing is recorded; the check only compares the signals with the cards.')),
  ));
  let shown = -1, done = false;
  every(50, async () => {
    if (done) return;
    const el = (Date.now() * 1000 - t0) / 1e6;
    const at = session.status === 'error' ? null : stepAt(el);   // an SDK stop ends the check early
    overall.firstChild.style.width = `${Math.min(100, (el / CHECK_DURATION_S) * 100)}%`;
    if (!at) {
      done = true;
      clearTimers();
      mount(view(), h('section', { class: 'card center-card' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', {}, 'Scoring the check'), h('p', {}, 'Collecting the last signals and switching the camera off…')));
      try {
      const snap = await session.finishCheck();
      app.session = null;
      if (!snap) return go('home');
      const baseline = poseBaseline(snap.buf.pose.filter((x) => x.ts >= t0 - 10e6 && x.ts < t0));
      const speech = speechSeries(snap.buf.talking, snap.buf.pose);
      const result = evaluateCheck(steps, { ...snap.buf, talking: speech.talking }, baseline);
      result.speechSource = speech.source;
      const summary = {
        at: new Date().toISOString(), mode: app.cfg.mode,
        speaking: result.speaking, pauses: { scripted: result.pauses.scripted, found: result.pauses.found, falsePauses: result.pauses.falsePauses },
        breaths: result.breaths, speechSource: speech.source,
        stoppedEarly: snap.diagnostics.errors.length ? snap.diagnostics.errors[snap.diagnostics.errors.length - 1].message : null,
      };
      app.lastCheck = { summary, result };
      if (app.cfg.diagnostics) app.lastCheckExport = checkExport(snap.buf, t0, steps, baseline, snap.diagnostics);
      try { app.cfg = await api.updateSettings({ lastCheck: summary }); } catch (e) { console.warn('[rehearse] could not save the check summary', e); }
      app.lastInsightPackets = snap.diagnostics.insightPackets;
      return go('check-result');
      } catch (e) {
        console.error('[rehearse] scoring the check failed', e);
        await endSession();
        return mount(view(), errorCard('The check could not be scored', e.message || String(e), () => go('home')));
      }
    }
    const st = at.step;
    if (st.i !== shown) {
      shown = st.i;
      setText(counter, `Card ${st.i + 1} of ${CHECK_SCRIPT.length}`);
      setText(title, st.title);
      setText(text, st.text || '');
      text.hidden = !st.text;
      const nx = CHECK_SCRIPT[st.i + 1];
      setText(next, nx ? `Next: ${nx.title.toLowerCase()}` : 'Last card');
      title.className = `cue-title ${st.truth.talking ? 'talk' : 'quiet'}`;
    }
    bar.firstChild.style.width = `${Math.min(100, (1 - at.leftS / st.s) * 100)}%`;
    const lost = session.face && !session.faceFresh(2000) && !['down', 'side'].includes(st.kind);
    warn.hidden = !lost;
    if (lost) setText(warn, `Face tracking paused: ${session.validation && !session.validation.ok ? (VALIDATION_TEXT[session.validation.name] || session.validation.hint || 'adjust your position') : 'adjust your position'}.`);
  });
}

function verdict(x) {
  if (x === null || x === undefined) return { cls: 'na', text: 'Not measured' };
  if (x >= RELIABLE) return { cls: 'ok', text: 'Reliable for you' };
  if (x >= USE_WITH_CARE) return { cls: 'care', text: 'Use with care' };
  return { cls: 'low', text: 'Not reliable in these conditions' };
}

async function checkResultScreen() {
  const lc = app.lastCheck || (app.cfg.settings.lastCheck ? { summary: app.cfg.settings.lastCheck } : null);
  if (!lc) return go('home');
  const S = lc.summary;
  const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
  const speakAcc = S.speaking && S.speaking.speech !== null && S.speaking.silence !== null ? (S.speaking.speech + S.speaking.silence) / 2 : null;
  const pauseAcc = S.pauses && S.pauses.scripted ? S.pauses.found / S.pauses.scripted : null;
  const breathAcc = S.breaths && S.breaths.judged ? S.breaths.correct / S.breaths.judged : null;
  const row = (label, value, detail, acc, tip) => {
    const v = verdict(acc);
    return h('div', { class: `check-result ${v.cls}` },
      h('div', {}, h('strong', {}, label), h('p', { class: 'fineprint' }, detail)),
      h('div', { class: 'check-score' }, h('span', { class: 'stat-value' }, value), h('span', { class: `verdict ${v.cls}` }, v.text)),
      acc !== null && acc < RELIABLE && tip ? h('p', { class: 'tip' }, tip) : null);
  };
  mount(view(),
    h('section', { class: 'report-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Accuracy check', S.mode === 'simulated' ? h('span', { class: 'mini-chip' }, 'simulated signals') : h('span', { class: 'mini-chip live' }, 'live')),
        h('h1', {}, 'How well Rehearse read you')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => go('home') }, 'Done'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('calibrate', { check: true }) }, 'Run the check again'))),
    h('p', { class: 'lede' }, `Each signal is compared with what the cards asked you to do. "Reliable for you" means at least ${Math.round(RELIABLE * 100)}% agreement in this light and this position.`),
    h('section', { class: 'card check-results' },
      row('Speaking detection', pct(speakAcc), `While reading: ${pct(S.speaking?.speech)} of frames marked as speaking. While quiet: ${pct(S.speaking?.silence)} marked as quiet.`, speakAcc,
        'Keep your mouth clearly visible and well lit; avoid covering it with a hand or microphone.'),
      row('Pauses found', S.pauses ? `${S.pauses.found} of ${S.pauses.scripted}` : '–', S.pauses ? `${S.pauses.falsePauses} extra pause${S.pauses.falsePauses === 1 ? '' : 's'} detected while you were reading.` : '', pauseAcc,
        'Pauses are found from speaking detection; improving that improves pauses.'),
      row('Breath in pauses (experimental)', S.breaths && S.breaths.judged ? `${S.breaths.correct} of ${S.breaths.judged}` : '–', 'Pauses where the app correctly told a breath in from a held breath.', breathAcc,
        'Sit upright with your upper chest in view, and keep still during pauses.'),
    ),
    S.stoppedEarly ? h('p', { class: 'banner warn' }, `The SDK stopped before the end of the check: ${S.stoppedEarly} Scores cover the part before that.`) : null,
    h('p', { class: 'fineprint' }, `Checked ${new Date(S.at).toLocaleString()}. Only these summary numbers are kept (in your settings); the signals of the check are discarded.`),
  );
}

function checkCard() {
  const S = app.cfg.settings.lastCheck;
  return h('section', { class: 'card check-card' },
    h('div', {},
      h('h2', {}, 'How well does Rehearse read you?'),
      h('p', { class: 'fineprint' }, S
        ? `Last check ${new Date(S.at).toLocaleDateString()}: pauses found ${S.pauses?.found ?? '–'} of ${S.pauses?.scripted ?? '–'}, breaths told apart ${S.breaths?.correct ?? '–'} of ${S.breaths?.judged ?? '–'}.`
        : 'A two-minute guided check compares the signals with what you were asked to do, so you know which numbers to trust.')),
    h('div', { class: 'actions' },
      S ? h('button', { class: 'btn ghost', type: 'button', onclick: () => go('check-result') }, 'See results') : null,
      h('button', { class: 'btn', type: 'button', disabled: !(app.cfg.mode === 'live' || app.cfg.mode === 'simulated'), onclick: () => go('calibrate', { check: true }) }, S ? 'Run it again' : 'Run the check')),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// report

function stat(label, value, sub, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value), sub ? h('span', { class: 'stat-sub' }, sub) : null);
}

function statsFor(rec) {
  const S = rec.summary || {};
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const out = [
    stat('Length', fmtClock(rec.durationS), rec.targetS ? `target ${fmtClock(rec.targetS)}` : null),
    stat('Speaking', pct(S.speakingRatio), 'of the time'),
    stat('Pauses', S.pauseCount ?? '–', S.pausesPerMin != null ? `${S.pausesPerMin.toFixed(1)} per minute` : null),
    stat('Breaths in pauses · experimental', S.pausesWithBreathData ? `${S.breathsInPauses} of ${S.pausesWithBreathData}` : '–', S.breathAnchoredPauses != null ? pct(S.breathAnchoredPauses) : null),
    stat('Longest stretch', S.longestRunS != null ? fmtSeconds(S.longestRunS) : '–', 'without a pause'),
    stat('Average pause', S.meanPauseS != null ? fmtSeconds(S.meanPauseS) : '–'),
    stat('Blinks', S.blinksPerMin != null ? `${Math.round(S.blinksPerMin)}/min` : '–'),
  ];
  if (rec.pulseEnabled && S.pulse) {
    const p = S.pulse;
    out.push(stat('Pulse reading', Number.isFinite(p.closing) ? `${Math.round(p.opening)} → ${Math.round(p.closing)}` : `${Math.round(p.opening)}`, 'bpm · information only', 'info'));
  }
  return out;
}

function legend(rec) {
  return h('div', { class: 'legend' },
    h('span', {}, h('i', { class: 'lg speak' }), 'speaking'),
    h('span', {}, h('i', { class: 'lg pause' }), 'pause'),
    h('span', {}, h('i', { class: 'lg breath yes' }), 'breath taken in pause'),
    h('span', {}, h('i', { class: 'lg breath no' }), 'no breath detected'),
    h('span', {}, h('i', { class: 'lg chest' }), 'chest movement'),
    rec.pulseEnabled ? h('span', {}, h('i', { class: 'lg pulse' }), 'pulse reading (info only)') : null,
  );
}

async function reportScreen(id) {
  let rec = app.current;
  if (id) {
    rec = await api.get(id);
    if (!rec) return mount(view(), errorCard('Rehearsal not found', 'It may have been deleted.', () => go('history')));
    app.current = rec;
  }
  if (!rec) return go('home');
  app.draft.title = rec.title;

  if (rec.unsaved) {
    const c = rec.counts || {};
    mount(view(), h('section', { class: 'card' },
      h('h1', {}, 'Not enough to analyse'),
      h('p', {}, rec.durationS < MIN_REHEARSAL_S
        ? `This run lasted ${fmtSeconds(rec.durationS)}. Rehearse needs at least ${MIN_REHEARSAL_S} seconds.`
        : 'Hardly any speech signal arrived during the run. Keep your face in view and well lit, then try again.'),
      h('p', { class: 'fineprint' }, `Samples received: speaking ${c.talking ?? 0}, chest ${c.chest ?? 0}. Nothing was saved.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('calibrate') }, 'Try again'))));
    return;
  }

  const { items } = await api.list();
  const previous = items.find((r) => r.title === rec.title && r.id !== rec.id && String(r.createdAt) < String(rec.createdAt));
  const notes = rehearsalNotes(rec.summary, previous ? previous.summary : null);
  const del = confirmButton({ label: 'Delete this rehearsal', armedLabel: 'Click again to delete', className: 'btn ghost danger',
    action: async () => { await api.remove(rec.id); app.current = null; go('history'); } });

  mount(view(),
    h('section', { class: 'report-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, new Date(rec.createdAt).toLocaleString(), rec.mode === 'simulated' ? h('span', { class: 'mini-chip' }, 'simulated signals') : h('span', { class: 'mini-chip live' }, 'live')),
        h('h1', {}, rec.title)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => go('history') }, 'History'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('calibrate') }, 'Rehearse again'))),
    rec.note ? h('p', { class: 'banner warn' }, rec.note, ' The report covers the part before that.') : null,
    notes.length ? h('section', { class: 'notes' }, notes.map((n) => h('p', { class: `note ${n.kind}` }, h('span', { class: 'note-kind' }, n.kind === 'try' ? 'Try' : n.kind === 'good' ? 'Nice' : 'Note'), n.text))) : null,
    h('section', { class: 'stats' }, statsFor(rec)),
    h('section', { class: 'card chart-card' },
      h('h2', {}, 'Timeline'),
      timelineChart(rec),
      legend(rec),
      h('p', { class: 'fineprint' }, 'Pauses are silences of at least 0.6 s between words. A breath counts when the chest trace rises during the pause. Hover a pause for details.')),
    h('section', { class: 'footer-row' },
      h('p', { class: 'fineprint' }, 'Rehearse describes your delivery. It is not a medical device and does not assess health.'),
      del),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// history

async function historyScreen() {
  const { items, unreadable } = await api.list();
  const titles = [...new Set(items.map((r) => r.title))];
  if (app.historyFilter && !titles.includes(app.historyFilter)) app.historyFilter = '';
  const runs = items.filter((r) => !app.historyFilter || r.title === app.historyFilter);
  const chrono = runs.slice().reverse();
  const label = (r) => `${new Date(r.createdAt).toLocaleDateString()} ${r.title}`;
  const trend = (title, get, format, hint) => h('div', { class: 'trend-card card' },
    h('h3', {}, title), h('p', { class: 'fineprint' }, hint),
    trendChart(chrono.map((r) => ({ label: label(r), v: get(r.summary || {}) })), { format }));

  const filter = h('select', { onchange: (e) => { app.historyFilter = e.target.value; go('history'); } },
    h('option', { value: '' }, `All talks (${items.length})`),
    titles.map((t) => h('option', { value: t, selected: t === app.historyFilter }, t)));

  if (!items.length) {
    mount(view(), h('section', { class: 'card center-card' },
      h('h2', {}, 'No rehearsals yet'),
      h('p', {}, 'Your rehearsals appear here so you can see how your pacing changes between runs.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => go('home') }, 'Start a rehearsal')));
    return;
  }

  const row = (r) => {
    const S = r.summary || {};
    const del = confirmButton({ label: 'Delete', armedLabel: 'Confirm', className: 'btn ghost danger small',
      action: async () => { await api.remove(r.id); go('history'); } });
    return h('tr', {},
      h('td', {}, h('button', { class: 'link', type: 'button', onclick: () => go('report', r.id) }, new Date(r.createdAt).toLocaleString())),
      h('td', {}, r.title, r.mode === 'simulated' ? h('span', { class: 'mini-chip' }, 'sim') : null),
      h('td', { class: 'num' }, fmtClock(r.durationS)),
      h('td', { class: 'num' }, S.pausesPerMin != null ? S.pausesPerMin.toFixed(1) : '–'),
      h('td', { class: 'num' }, S.breathAnchoredPauses != null ? `${Math.round(S.breathAnchoredPauses * 100)}%` : '–'),
      h('td', { class: 'num' }, S.longestRunS != null ? fmtSeconds(S.longestRunS) : '–'),
      h('td', { class: 'num' }, S.blinksPerMin != null ? Math.round(S.blinksPerMin) : '–'),
      h('td', { class: 'num' }, r.pulseEnabled && S.pulse && Number.isFinite(S.pulse.opening) ? (Number.isFinite(S.pulse.closing) ? `${Math.round(S.pulse.opening)}→${Math.round(S.pulse.closing)}` : Math.round(S.pulse.opening)) : '–'),
      h('td', {}, del));
  };

  mount(view(),
    h('section', { class: 'history-head' }, h('h1', {}, 'History'), filter),
    unreadable ? h('p', { class: 'banner warn' }, `${unreadable} file(s) in the data folder could not be read and were skipped.`) : null,
    runs.length >= 2 ? h('section', { class: 'trends' },
      trend('Longest stretch without a pause', (S) => S.longestRunS, (v) => fmtSeconds(v), 'Shorter usually means easier to follow.'),
      trend('Breaths taken in pauses', (S) => (S.breathAnchoredPauses == null ? NaN : S.breathAnchoredPauses * 100), (v) => `${Math.round(v)}%`, 'Higher means fewer mid-sentence breaths.'),
      trend('Pauses per minute', (S) => S.pausesPerMin, (v) => v.toFixed(1), 'Room to breathe for you and your audience.'),
    ) : h('p', { class: 'fineprint' }, 'Rehearse the same talk twice to see trends.'),
    h('section', { class: 'card table-card' },
      h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'Talk', 'Length', 'Pauses/min', 'Breaths in pauses', 'Longest stretch', 'Blinks/min', 'Pulse (info)', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, runs.map(row)))),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// privacy & data

async function privacyScreen() {
  const cfg = (app.cfg = await api.config());
  const { items } = await api.list();
  const blocked = await api.blockedRequests();
  const row = (k, v, cls = '') => h('div', { class: `kv ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  const delAll = confirmButton({
    label: 'Delete all my data', armedLabel: `Click again: delete ${items.length} rehearsal${items.length === 1 ? '' : 's'} and my consent`, className: 'btn danger big',
    action: async () => {
      await endSession();
      await api.removeAll();
      app.cfg = await api.config();
      app.current = null;
      app.draft = { title: '', targetS: null };
      go('consent');
    },
  });
  mount(view(),
    h('h1', {}, 'Privacy & data'),
    h('section', { class: 'grid2' },
      h('div', { class: 'card' },
        h('h2', {}, 'Right now'),
        row('Camera', 'Off. It is on only during calibration and a rehearsal, with a preview on screen.'),
        row('Microphone', 'Never used. Rehearse requests video only.'),
        row('Network from the app window', `Blocked by the app (${blocked} attempt${blocked === 1 ? '' : 's'} blocked since start).`),
        row('SmartSpectra SDK telemetry', 'Switched off by Rehearse (enableTelemetry: false).'),
        row('SDK network use', cfg.mode === 'live' ? 'Validates your API key with Presage while measuring.' : 'None in simulated mode: the SDK is not loaded.'),
        row('AI insight packets received', cfg.mode === 'live' ? `${app.lastInsightPackets} in the last session (content discarded, never shown).` : 'Not applicable in simulated mode.'),
        h('div', { class: 'toggles single' },
          toggle({ id: 'priv-pulse', label: 'Pulse reading', hint: 'Off by default. When on, Presage documents that the SDK sends periodic snapshots of pulse rate, heart-rate variability and breathing rate (no images) to its AI insight service.',
            checked: cfg.settings.pulseEnabled, onchange: async (v) => { app.cfg = await api.updateSettings({ pulseEnabled: v }); } })),
      ),
      h('div', { class: 'card' },
        h('h2', {}, 'What is stored'),
        row('Rehearsals', `${items.length} on this computer`),
        row('Each rehearsal holds', 'Title, date, summary numbers, the speaking/pause timeline, a simplified chest trace, blink times and, if enabled, pulse readings.'),
        row('Never stored', 'Images, video, audio, face landmarks (reduced to lip opening and head angle on arrival, then discarded), your API key.'),
        row('Accuracy check', 'Only its summary scores, kept in your settings.'),
        row('Where', cfg.dataDir, 'mono'),
        row('Retention', 'Kept until you delete them. Nothing is synced or backed up by Rehearse.'),
        row('SDK working folder', cfg.sdkCacheDir, 'mono'),
        h('p', { class: 'fineprint' }, 'The SmartSpectra SDK manages its own working folder; Rehearse writes nothing there.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => api.openDataFolder() }, 'Open data folder')),
      ),
    ),
    h('section', { class: 'card danger-zone' },
      h('h2', {}, 'Delete everything'),
      h('p', {}, 'Removes every rehearsal and your consent from this computer, then shows the consent screen again. This cannot be undone.'),
      delAll),
    h('section', { class: 'card' },
      h('h2', {}, 'What you agreed to'),
      h('ul', { class: 'items compact' }, consentItems(cfg)),
      h('p', { class: 'fineprint' }, `Consent given ${cfg.settings.consentedAt ? new Date(cfg.settings.consentedAt).toLocaleString() : '–'}. Rehearse ${cfg.appVersion}${cfg.sdkVersion ? ` · SmartSpectra SDK ${cfg.sdkVersion}` : ''}.`)),
  );
}

// ---------------------------------------------------------------------------------------------------------------

const SCREENS = {
  consent: consentScreen,
  home: homeScreen,
  calibrate: calibrateScreen,
  rehearse: rehearseScreen,
  finishing: finishingScreen,
  report: reportScreen,
  history: historyScreen,
  privacy: privacyScreen,
  check: checkScreen,
  'check-result': checkResultScreen,
};

window.addEventListener('beforeunload', () => { if (app.session) app.session.close(); });
window.addEventListener('unhandledrejection', (e) => console.error('[rehearse] unhandled rejection', e.reason && (e.reason.stack || e.reason.message) || e.reason));
window.addEventListener('error', (e) => console.error('[rehearse] uncaught error', e.message, e.filename, e.lineno));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.screen === 'calibrate') { endSession().then(() => go('home')); }
});

(async function boot() {
  try {
    app.cfg = await api.config();
  } catch (e) {
    mount(view(), errorCard('Rehearse could not start', e.message || String(e)));
    return;
  }
  if (app.cfg.diagnostics) {
    // read-only hook for scripts/e2e-*.cjs; holds no images and no key
    window.__rehearseDiag = () => ({ screen: app.screen, mode: app.cfg.mode, lastInsightPackets: app.lastInsightPackets,
      session: app.session ? app.session.diagnostics() : null, last: app.lastDiagnostics || null, series: app.lastSeries || null,
      check: app.lastCheck ? { summary: app.lastCheck.summary, result: app.lastCheck.result, export: app.lastCheckExport || null } : null });
  }
  go(app.cfg.hasConsent ? 'home' : 'consent');
})();
