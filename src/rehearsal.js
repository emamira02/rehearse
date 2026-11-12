// Turns the raw sample buffers of one rehearsal (epoch-µs timestamps) into what the app shows and stores:
// a summary (numbers) and a compact timeline (what the report draws). Pure; shared by the app and the tests.
import { analyzeRehearsal, segmentTalking, DEFAULTS } from './analysis.js';
import { speechSeries } from './speech.js';

export const MIN_REHEARSAL_S = 15;
const CHEST_HZ = 10;          // stored chest trace resolution (analysis runs on full resolution first)

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;   // chest trace units are small (live values around ±1)

function inWindow(arr, startUs, stopUs, map) {
  const out = [];
  for (const x of arr || []) {
    if (!x || !Number.isFinite(x.ts) || x.ts < startUs || x.ts > stopUs) continue;
    out.push(map((x.ts - startUs) / 1e6, x));
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function relativeSignals(buffers, startUs, stopUs) {
  return {
    talking: inWindow(buffers.talking, startUs, stopUs, (t, x) => ({ t, detected: x.detected })),
    blinking: inWindow(buffers.blinking, startUs, stopUs, (t, x) => ({ t, detected: x.detected })),
    chest: inWindow(buffers.chest, startUs, stopUs, (t, x) => ({ t, v: x.v })),
    pulse: inWindow(buffers.pulse, startUs, stopUs, (t, x) => ({ t, v: x.v, confidence: x.confidence })),
  };
}

function downsample(series, hz) {
  const out = [];
  let bin = -1, sum = 0, n = 0, tSum = 0;
  const flush = () => { if (n) out.push([r2(tSum / n), r4(sum / n)]); };
  for (const x of series) {
    const b = Math.floor(x.t * hz);
    if (b !== bin) { flush(); bin = b; sum = 0; n = 0; tSum = 0; }
    sum += x.v; tSum += x.t; n++;
  }
  flush();
  return out;
}

function blinkTimes(blinking) {
  const out = [];
  for (let i = 0; i < blinking.length; i++) {
    if (blinking[i].detected && !(i > 0 && blinking[i - 1].detected)) out.push(r2(blinking[i].t));
  }
  return out;
}

// buffers: { talking, blinking, chest, pulse } arrays of samples with `ts` in epoch µs.
export function buildRehearsalResult(buffers, startUs, stopUs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const durationS = Math.max(0, (stopUs - startUs) / 1e6);
  // speech = lip movement (from the SDK's face landmarks) OR the SDK's face.talking
  const speech = speechSeries(buffers.talking, buffers.pose);
  const sig = relativeSignals({ ...buffers, talking: speech.talking }, startUs, stopUs);
  const analysis = analyzeRehearsal(sig, o);
  const { pauses, ...summary } = analysis;
  const segments = segmentTalking(sig.talking, o).map((g) => [r2(g.start), r2(g.end), g.talking ? 1 : 0]);
  const timeline = {
    segments,
    pauses: pauses.map((p) => [r2(p.start), r2(p.end), p.breath === null ? null : p.breath ? 1 : 0]),
    chest: downsample(sig.chest, CHEST_HZ),
    pulse: sig.pulse.map((x) => [r2(x.t), r2(x.v), typeof x.confidence === 'number' ? r2(x.confidence) : null]),
    blinks: blinkTimes(sig.blinking),
  };
  const enough = durationS >= MIN_REHEARSAL_S && summary.durationS > 0;
  summary.speechSource = speech.source;
  summary.lipCoverage = r2(speech.lipCoverage);
  return { durationS: r2(durationS), summary, timeline, enough, counts: {
    talking: sig.talking.length, chest: sig.chest.length, pulse: sig.pulse.length, blinking: sig.blinking.length,
  } };
}
