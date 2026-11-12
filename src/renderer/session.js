// One measuring session: calibration, then the rehearsal window, then a short drain so samples of the last
// frames (computed with some latency) still land inside the rehearsal. Owns the source and releases the camera
// on every exit path.
import { Emitter, LiveSource, SimSource } from './sources.js';
import { buildRehearsalResult } from '../rehearsal.js';
import { DEFAULTS } from '../analysis.js';
import { createLipTracker, SPEECH_DEFAULTS } from '../speech.js';

const KEEP = ['talking', 'blinking', 'chest', 'pulse', 'breathRate', 'pose', 'smile'];
const LIVE_GAP_US = 0.25e6;    // a lip reading this close to an SDK talking sample counts for it
const DRAIN_MS = { live: 2500, simulated: 600 };
const MAX_BUFFER_S = 3 * 3600;   // hard cap: a forgotten session can't grow memory without bound

export class Session extends Emitter {
  constructor({ mode, pulseEnabled, face = false, breathing = 'bundle' }) {
    super();
    this.mode = mode;
    this.pulseEnabled = pulseEnabled;
    this.face = face;
    this.breathing = breathing;
    this.phase = 'idle';
    this.buf = Object.fromEntries(KEEP.map((k) => [k, []]));
    this.first = {};             // first sample time (ms since begin) per signal, for the calibration checklist
    this.validation = null;
    this.status = 'idle';
    this.error = null;
    this.stream = null;
    this.startUs = null;
    this.stopUs = null;
    this.beganAt = null;
    this.insightPackets = 0;
    this.lagMs = { last: null, max: null };   // wall clock minus newest talking-sample timestamp
    this.errors = [];
    this.valHist = [];                        // validation events of the last 5 s: { t, ok }
    this.lips = createLipTracker();
    this.lastLip = null;                      // { ts, speaking } newest lip reading
    this.buf.speech = [];                     // live speech: SDK talking OR lips (same rule as the report)
    this.unsubs = [];
  }

  get elapsedS() { return this.startUs === null ? 0 : ((this.stopUs ?? Date.now() * 1000) - this.startUs) / 1e6; }

  async begin() {
    if (this.phase !== 'idle') return;
    this.phase = 'calibrating';
    this.beganAt = performance.now();
    try {
      const opts = { pulseEnabled: this.pulseEnabled, face: this.face, breathing: this.breathing };
      this.source = this.mode === 'live' ? new LiveSource(opts) : new SimSource(opts);
    } catch (e) {
      this.fail({ code: 'init', message: e.message || String(e), retryable: false });
      return;
    }
    const src = this.source;
    this.unsubs.push(
      src.on('status', (st) => { this.status = st; this.emit('change'); }),
      src.on('validation', (v) => {
        this.validation = v;
        const now = performance.now();
        if (v.ok) this.lastOkAt = now;
        this.valHist.push({ t: now, ok: !!v.ok });
        while (this.valHist.length && now - this.valHist[0].t > 5000) this.valHist.shift();
        this.emit('change');
      }),
      src.on('stream', (st) => { this.stream = st; this.emit('stream', st); }),
      src.on('error', (e) => this.fail(e)),
      src.on('insight', (n) => { this.insightPackets = n; }),
      src.on('samples', (b) => this.ingest(b)),
    );
    try {
      await src.start();
    } catch (e) {
      this.fail({ code: e.code ?? 'start', message: e.message || String(e), retryable: false });
    }
  }

  ingest(batch) {
    if (this.phase === 'idle' || this.phase === 'done') return;
    for (const p of batch.pose || []) {
      const a = this.lips.push(p);
      if (a !== null) this.lastLip = { ts: p.ts, speaking: a >= SPEECH_DEFAULTS.threshold };
    }
    for (const x of batch.talking || []) {
      const lip = this.lastLip && Math.abs(this.lastLip.ts - x.ts) <= LIVE_GAP_US && this.lastLip.speaking;
      this.buf.speech.push({ ts: x.ts, detected: !!x.detected || !!lip });
    }
    if (this.buf.speech.length > 4096 && this.buf.speech[0].ts < (this.buf.speech[this.buf.speech.length - 1].ts - MAX_BUFFER_S * 1e6)) this.buf.speech.splice(0, 1024);
    const now = performance.now() - this.beganAt;
    for (const k of KEEP) {
      const arr = batch[k];
      if (!arr || !arr.length) continue;
      if (this.first[k] === undefined) this.first[k] = now;
      const dst = this.buf[k];
      for (const x of arr) dst.push(x);
      // drop calibration-era samples older than the cap
      const lim = (arr[arr.length - 1].ts ?? 0) - MAX_BUFFER_S * 1e6;
      if (dst.length > 4096 && dst[0].ts < lim) {
        let i = 0;
        while (i < dst.length && dst[i].ts < lim) i++;
        dst.splice(0, i);
      }
    }
    const tk = batch.talking;
    if (tk && tk.length) {
      const lag = Date.now() - tk[tk.length - 1].ts / 1000;
      this.lagMs.last = lag;
      if (this.phase === 'rehearsing') this.lagMs.max = Math.max(this.lagMs.max ?? lag, lag);
    }
    this.emit('samples', batch);
  }

  diagnostics() {
    return {
      phase: this.phase, status: this.status, validation: this.validation, errors: this.errors.slice(-5),
      counts: Object.fromEntries(KEEP.map((k) => [k, this.buf[k].length])),
      firstMs: { ...this.first }, lagMs: { ...this.lagMs }, insightPackets: this.insightPackets,
      faceInfo: this.source?.faceInfo || null, requested: { face: this.face, breathing: this.breathing, pulse: this.pulseEnabled },
    };
  }

  // Live readouts for the rehearsal screen ------------------------------------------------------------------
  lastOf(k) { const a = this.buf[k]; return a.length ? a[a.length - 1] : null; }

  // smoothed "speaking now": majority of the last ~0.4 s of talking samples
  speakingNow() {
    const a = this.buf.speech;
    if (!a.length) return null;
    const lim = a[a.length - 1].ts - 0.4e6;
    let yes = 0, n = 0;
    for (let i = a.length - 1; i >= 0 && a[i].ts >= lim; i--) { n++; if (a[i].detected) yes++; }
    return n ? yes * 2 >= n : null;
  }

  // seconds since speech last stopped (null while speaking) and since the current speech run began
  pacing() {
    const a = this.buf.speech;
    if (!a.length) return { silenceS: null, runS: null };
    const nowTs = a[a.length - 1].ts;
    let lastTalk = null;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].detected) { lastTalk = a[i].ts; break; }
    const silenceS = lastTalk === null ? null : (nowTs - lastTalk) / 1e6;
    // run start = end of the latest silence that lasted at least minPauseS (scan back, bounded to 10 min)
    let runStart = null, silentSince = null;
    const floor = Math.max(this.startUs ?? 0, nowTs - 600e6);
    for (let i = a.length - 1; i >= 0 && a[i].ts >= floor; i--) {
      if (!a[i].detected) { if (silentSince === null) silentSince = a[i].ts; }
      else {
        if (silentSince !== null && silentSince - a[i].ts >= DEFAULTS.minPauseS * 1e6) { runStart = silentSince; break; }
        silentSince = null;
      }
    }
    if (runStart === null) runStart = Math.max(floor, a[0].ts);
    const speaking = this.speakingNow();
    return { silenceS: speaking ? 0 : silenceS, runS: speaking ? (nowTs - runStart) / 1e6 : 0 };
  }

  // positioning has been Ok for most of the last `ms` (the SDK's feedback flickers frame to frame)
  steadyOk(ms = 3000, share = 0.8) {
    const now = performance.now();
    if (this.beganAt === null || now - this.beganAt < ms) return false;
    const recent = this.valHist.filter((e) => now - e.t <= ms);
    return recent.length >= 2 && recent.filter((e) => e.ok).length / recent.length >= share;
  }

  // the SDK delivers face landmarks only while it is happy with the framing; true if they arrived recently
  faceFresh(ms = 1500) {
    const p = this.lastOf('pose');
    return !!p && Date.now() * 1000 - p.ts <= ms * 1000;
  }

  checklist() {
    const has = (k) => this.first[k] !== undefined;
    return {
      camera: this.mode === 'simulated' ? true : !!this.stream,
      running: this.status === 'running',
      // positioning feedback flickers between Ok and hints frame to frame; Ok within the last 3 s counts
      face: !!this.validation && (this.validation.ok || (this.lastOkAt !== undefined && performance.now() - this.lastOkAt < 3000)),
      validation: this.validation,
      talking: has('talking'),
      chest: has('chest'),
      pulse: this.pulseEnabled ? has('pulse') : null,
      pose: this.face ? has('pose') && this.faceFresh() : null,
      steady: this.steadyOk(),
      sinceBeginS: this.beganAt === null ? 0 : (performance.now() - this.beganAt) / 1000,
    };
  }

  // pose samples of the `seconds` before `untilUs` (default: now), e.g. the end of calibration → personal baseline
  recentPose(seconds = 12, untilUs = Date.now() * 1000) {
    const from = untilUs - seconds * 1e6;
    return this.buf.pose.filter((x) => x.ts >= from && x.ts <= untilUs);
  }

  startRehearsal() {
    if (this.phase !== 'calibrating') return;
    this.startUs = Date.now() * 1000;
    this.phase = 'rehearsing';
    this.emit('change');
  }

  async finish() {
    if (this.phase !== 'rehearsing') return null;
    this.stopUs = Date.now() * 1000;
    this.phase = 'finishing';
    this.emit('change');
    await new Promise((r) => setTimeout(r, DRAIN_MS[this.mode] ?? 1000));
    const result = buildRehearsalResult(this.buf, this.startUs, this.stopUs);
    // derived series for offline analysis (read only through the diagnostics hook; never stored by the app)
    const t0 = this.startUs, rel = (ts) => Math.round((ts - t0) / 1000) / 1000;
    const inWin = (arr) => arr.filter((x) => x.ts >= t0 - 5e6 && x.ts <= this.stopUs + 3e6);
    this.lastSeries = {
      talking: inWin(this.buf.talking).map((x) => [rel(x.ts), x.detected ? 1 : 0]),
      pose: inWin(this.buf.pose).map((x) => [rel(x.ts), x.mouth ?? null, x.size ?? null]),
      chest: inWin(this.buf.chest).map((x) => [rel(x.ts), Math.round(x.v * 1000) / 1000]),
    };
    await this.close();
    return result;
  }

  // accuracy check: same buffers, but the window is the scripted sequence instead of a rehearsal
  startCheck() {
    if (this.phase !== 'calibrating') return;
    this.checkStartUs = Date.now() * 1000;
    this.phase = 'checking';
    this.emit('change');
  }

  async finishCheck() {
    if (this.phase !== 'checking') return null;
    this.phase = 'finishing';
    this.emit('change');
    await new Promise((r) => setTimeout(r, DRAIN_MS[this.mode] ?? 1000));
    const snapshot = { buf: this.buf, checkStartUs: this.checkStartUs, diagnostics: this.diagnostics() };
    await this.close();
    return snapshot;
  }

  async close() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    const src = this.source;
    // bounded: after an SDK error the stop acknowledgement may never come
    try { if (src) await Promise.race([src.stop(), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { console.warn('[rehearse] stop failed', e); }
    try { if (src) src.destroy(); } catch { /* ignore */ }
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stream = null;
    this.emit('stream', null);
    this.emit('change');
  }

  fail(e) {
    this.error = e;
    this.errors.push({ code: e.code, message: String(e.message || '').slice(0, 200), retryable: !!e.retryable });
    this.emit('error', e);
    this.emit('change');
  }
}
