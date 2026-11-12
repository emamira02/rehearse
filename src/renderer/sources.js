// Signal sources with one interface, so the rest of the app cannot tell live from simulated input:
//   on('status', 'starting' | 'running' | 'stopping' | 'idle' | 'error')
//   on('validation', { code, name, ok, tuning, hint })
//   on('samples', { talking, blinking, chest, pulse, breathRate })   ts in epoch microseconds
//   on('stream', MediaStream | null)        live camera preview (live only)
//   on('error', { code, message, retryable })
//   start(), stop(), destroy()
import {
  SmartSpectraSDK, ProcessingStatus, ValidationCode, MetricType, breathingMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics, presage } from '@smartspectra/node-sdk/messages';
import { createSimulatedSpeaker } from '../sim.js';
import { poseFeatures, happyScore } from '../face.js';

const HAPPY = presage.smartspectra.ExpressionType.HAPPY;

export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this._l.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    for (const fn of this._l.get(ev) || []) {
      try { fn(...args); } catch (e) { console.error(`[rehearse] ${ev} listener failed`, e); }
    }
  }
}

const STATUS = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '').toLowerCase()]));
const VALIDATION = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));

// Human wording for the SDK's positioning feedback.
export const VALIDATION_TEXT = Object.freeze({
  Ok: 'Looking good',
  NoFaceFound: 'No face found: sit in front of the camera',
  MultipleFacesFound: 'More than one face: only the speaker should be in view',
  FaceNotCentered: 'Move to the centre of the picture',
  FaceSizeOutOfRange: 'Adjust your distance to the camera',
  TooDark: 'Too dark: add light in front of you',
  TooBright: 'Too bright: avoid a light source behind or into the camera',
  ChestNotVisible: 'Make your upper chest visible',
  CameraTuning: 'Camera adjusting…',
  FrameRateTooLow: 'Camera frame rate too low: close other camera apps',
  ExcessiveMotion: 'Hold still for a moment',
  FaceTooClose: 'Move a little further back',
  FaceTooFar: 'Move a little closer',
  FaceTooHigh: 'Lower the camera or move down a little',
  FaceTooLow: 'Raise the camera or move up a little',
  FaceNotForward: 'Face the camera',
});

const tsNum = (ts) => {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts);
};

// Decoded SDK Metrics -> the app's sample batch. Only the fields Rehearse uses are read; face landmarks are reduced
// to { pitch, yaw } right here and the points themselves are dropped.
export function extractSamples(m) {
  const det = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ ts: tsNum(x.timestamp), detected: !!x.detected, stable: x.stable === true })).filter((x) => Number.isFinite(x.ts));
  const val = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => ({ ts: tsNum(x.timestamp), v: x.value, confidence: typeof x.confidence === 'number' ? x.confidence : undefined }))
    .filter((x) => Number.isFinite(x.ts) && typeof x.v === 'number' && Number.isFinite(x.v));
  return {
    talking: det(m?.face?.talking),
    blinking: det(m?.face?.blinking),
    chest: val(m?.breathing?.upperTrace),
    pulse: val(m?.cardio?.pulseRate),
    breathRate: val(m?.breathing?.rate),
    pose: (Array.isArray(m?.face?.landmarks) ? m.face.landmarks : []).map((x) => {
      const f = poseFeatures(x?.value);
      return f ? { ts: tsNum(x.timestamp), pitch: f.pitch, yaw: f.yaw, mouth: f.mouth, size: f.size } : null;
    }).filter((x) => x && Number.isFinite(x.ts)),
    smile: (Array.isArray(m?.face?.expression) ? m.face.expression : []).map((x) => {
      const v = happyScore(x, HAPPY);
      return v === null ? null : { ts: tsNum(x.timestamp), v };
    }).filter((x) => x && Number.isFinite(x.ts)),
  };
}

// Data minimisation: only what Rehearse uses. breathing 'chest' = chest trace only; 'bundle' = the SDK's breathing
// bundle (chest, abdomen, breathing rate). face = landmarks, reduced on arrival to a few numbers (lip opening for
// speech detection, head pitch/yaw); expressions only on request (not used by default). Pulse rate only when the
// user opted in.
export function requestedMetrics({ pulseEnabled = false, face = false, expressions = false, breathing = 'bundle' } = {}) {
  const m = breathing === 'chest' ? [MetricType.CHEST_BREATHING] : [...breathingMetrics];
  m.push(MetricType.TALKING, MetricType.BLINKING);
  if (face) m.push(MetricType.FACE_LANDMARKS);
  if (face && expressions) m.push(MetricType.EXPRESSIONS);
  if (pulseEnabled) m.push(MetricType.PULSE_RATE);
  return m;
}

export class LiveSource extends Emitter {
  constructor({ pulseEnabled, face = false, breathing = 'bundle' }) {
    super();
    this.kind = 'live';
    this.insightPackets = 0;
    this.sdkVersion = SmartSpectraSDK.version;
    // apiKey is intentionally absent: the preload adds it to the SDK's configure message.
    this.sdk = new SmartSpectraSDK({
      requestedMetrics: requestedMetrics({ pulseEnabled, face, breathing }),
      enableTelemetry: false,
      enableAccumulatedOutput: false,
    });
    const sdk = this.sdk;
    sdk.on('processingStatus', (st) => this.emit('status', STATUS[st] || `status-${st}`));
    sdk.on('validationStatus', (code, _ts, hint) => {
      const name = VALIDATION[code] || `Code${code}`;
      this.emit('validation', { code, name, ok: code === ValidationCode.kOk, tuning: code === ValidationCode.kCameraTuning, hint: hint || '' });
    });
    sdk.on('metrics', (buf) => {
      let m;
      try { m = decodeMetrics(buf); } catch (e) { console.warn('[rehearse] metrics decode failed', e); return; }
      if (!m || m instanceof Uint8Array) return;
      const lm = m.face?.landmarks;
      if (Array.isArray(lm) && lm.length) {
        const pts = lm[lm.length - 1]?.value;
        this.faceInfo = { landmarkSets: (this.faceInfo?.landmarkSets || 0) + lm.length, points: Array.isArray(pts) ? pts.length : 0,
          nose: Array.isArray(pts) && pts[1] ? { x: +Number(pts[1].x).toFixed(3), y: +Number(pts[1].y).toFixed(3) } : null };
      }
      this.emit('samples', extractSamples(m));
    });
    // Rehearse never asks for AI insights; it only counts packets the SDK delivers on its own (shown on the
    // privacy page) and discards their content.
    sdk.on('insight', () => { this.insightPackets++; this.emit('insight', this.insightPackets); });
    sdk.on('error', (code, message, retryable) => this.emit('error', { code, message: String(message || ''), retryable: !!retryable }));
    sdk.on('streamAvailable', (stream) => this.emit('stream', stream));
  }
  async start() { await this.sdk.start(); }
  async stop() {
    try { await this.sdk.stop(); } finally { this.emit('stream', null); }
  }
  destroy() { try { this.sdk.destroy(); } catch { /* already destroyed */ } }
}

export class SimSource extends Emitter {
  constructor({ pulseEnabled, face = false, seed = (Date.now() & 0x7fffffff) }) {
    super();
    this.kind = 'simulated';
    this.insightPackets = 0;
    this.sdkVersion = null;
    this.pulseEnabled = pulseEnabled;
    this.face = face;
    this.cueAt = null;              // set by the accuracy check: (tSecondsSinceStart) -> { key, truth } | null
    this.seed = seed;
    this.timers = [];
    this.lagS = 0.25;
  }
  async start() {
    this.emit('status', 'starting');
    const t0 = performance.now();
    this.startUs = Date.now() * 1000;
    this.speaker = createSimulatedSpeaker({ seed: this.seed, startUs: this.startUs, pulseEnabled: this.pulseEnabled, face: this.face,
      cueAt: (t) => (this.cueAt ? this.cueAt(t) : null) });
    this.timers.push(setTimeout(() => this.emit('status', 'running'), 1200));
    this.timers.push(setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      const ok = el > 2.5;
      this.emit('validation', { code: ok ? 0 : 10, name: ok ? 'Ok' : 'CameraTuning', ok, tuning: !ok, hint: '' });
    }, 1000));
    this.timers.push(setInterval(() => {
      const el = (performance.now() - t0) / 1000 - this.lagS;
      if (el > 0) this.emit('samples', this.speaker.advanceTo(el));
    }, 200));
  }
  async stop() {
    this.emit('status', 'stopping');
    this.destroy();
    this.emit('status', 'idle');
  }
  destroy() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }
}
