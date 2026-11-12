// Speaking detection from lip movement, computed from the SDK's face landmarks (inner-lip opening per frame, see
// face.js). Speech moves the lips several times per second; silence, a held smile or slow mouth breathing do not.
// Pure functions. Used alongside the SDK's own `face.talking`, never instead of measuring it.

// windowS and threshold were set on cards 1-8 of the live accuracy check run C (2026-11-12) and confirmed on cards
// 9-17: scripted pauses found 4/4 in both halves, ~80-90% of frames right (see HANDOFF 3c-ter).
export const SPEECH_DEFAULTS = Object.freeze({
  windowS: 0.6,        // activity = lip movement per second over this trailing window
  threshold: 0.08,     // eye-distance units per second; at or above → speaking
  centered: true,      // stamp activity at the middle of its window (reports); live tracking is trailing
  minFloor: 0.02,      // activity below this (eye-distance units per second) is never speech
  splitMin: 1.8,       // speech/silence split must be at least this ratio above the silence level
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// samples [{ts, mouth}] (ts in µs) → [{ts, a}] lip activity (units per second over the window). With centered (the
// default for reports), each value is stamped at the middle of its window, so pauses do not appear late; live use
// passes centered: false (only past samples exist).
export function lipActivity(samples, opts = {}) {
  const o = { ...SPEECH_DEFAULTS, ...opts };
  const s = (samples || []).filter((x) => x && isNum(x.ts) && isNum(x.mouth)).sort((a, b) => a.ts - b.ts);
  const out = [];
  let j = 0, acc = 0;                   // acc = sum |Δmouth| over (s[j].ts, s[i].ts]
  const win = o.windowS * 1e6;
  for (let i = 0; i < s.length; i++) {
    if (i > 0) acc += Math.abs(s[i].mouth - s[i - 1].mouth);
    while (j < i && s[i].ts - s[j].ts > win) { acc -= Math.abs(s[j + 1].mouth - s[j].mouth); j++; }
    const span = (s[i].ts - s[j].ts) / 1e6;
    if (span >= o.windowS * 0.5) out.push({ ts: o.centered ? Math.round((s[i].ts + s[j].ts) / 2) : s[i].ts, a: Math.max(0, acc) / span });
  }
  return out;
}

// Otsu split on log activity: the threshold that best separates two groups (speech, silence)
export function otsuThreshold(values) {
  const v = values.filter((x) => isNum(x) && x > 0).map(Math.log).sort((a, b) => a - b);
  if (v.length < 20) return null;
  const lo = v[0], hi = v[v.length - 1];
  if (!(hi > lo)) return null;
  const BINS = 64, hist = new Array(BINS).fill(0);
  for (const x of v) hist[Math.min(BINS - 1, Math.floor(((x - lo) / (hi - lo)) * BINS))]++;
  const total = v.length;
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += b * hist[b];
  let wB = 0, sumB = 0, best = -1, bestB = 0;
  for (let b = 0; b < BINS - 1; b++) {
    wB += hist[b]; sumB += b * hist[b];
    const wF = total - wB;
    if (!wB || !wF) continue;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bestB = b; }
  }
  return Math.exp(lo + ((bestB + 1) / BINS) * (hi - lo));
}

// threshold for one person and session; `fixed` (from a check) wins over the automatic split
export function speechThreshold(activity, opts = {}) {
  const o = { ...SPEECH_DEFAULTS, ...opts };
  if (isNum(o.fixed)) return o.fixed;
  const vals = activity.map((x) => x.a);
  const t = otsuThreshold(vals);
  if (t === null) return null;
  const sorted = vals.filter(isNum).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  return Math.max(o.minFloor, t, quiet * o.splitMin);
}

// → talking samples [{ts, detected}] in the same shape as the SDK's face.talking
export function talkingFromLips(samples, opts = {}) {
  const act = lipActivity(samples, opts);
  const thr = speechThreshold(act, opts);
  if (thr === null) return { talking: [], threshold: null };
  return { talking: act.map((x) => ({ ts: x.ts, detected: x.a >= thr })), threshold: thr };
}

// combine two talking series on the first one's timestamps: speaking if either says so (nearest sample ≤ 0.2 s)
export function fuseTalking(primary, secondary, maxGapUs = 0.2e6) {
  const b = (secondary || []).slice().sort((x, y) => x.ts - y.ts);
  let j = 0;
  return (primary || []).map((x) => {
    while (j + 1 < b.length && Math.abs(b[j + 1].ts - x.ts) <= Math.abs(b[j].ts - x.ts)) j++;
    const near = b[j] && Math.abs(b[j].ts - x.ts) <= maxGapUs ? b[j].detected : false;
    return { ts: x.ts, detected: !!x.detected || !!near };
  });
}

// Incremental version for live use: feed pose samples as they arrive, get the lip activity of each.
export function createLipTracker(opts = {}) {
  const o = { ...SPEECH_DEFAULTS, ...opts };
  const win = o.windowS * 1e6;
  const q = [];            // recent samples { ts, mouth }
  let acc = 0;             // sum |Δmouth| over q
  return {
    push(sample) {
      if (!sample || !isNum(sample.ts) || !isNum(sample.mouth)) return null;
      const last = q[q.length - 1];
      if (last && sample.ts <= last.ts) return null;               // out of order: ignore
      if (last) acc += Math.abs(sample.mouth - last.mouth);
      q.push(sample);
      while (q.length > 1 && sample.ts - q[0].ts > win) { acc -= Math.abs(q[1].mouth - q[0].mouth); q.shift(); }
      const span = (sample.ts - q[0].ts) / 1e6;
      return span >= o.windowS * 0.5 ? Math.max(0, acc) / span : null;
    },
    reset() { q.length = 0; acc = 0; },
  };
}

// Speech series used everywhere in the app: lips (fixed threshold) OR the SDK's face.talking, on the SDK's
// timestamps. Falls back to the SDK alone where no landmarks arrived (the SDK pauses face tracking when the framing
// is off). lipCoverage = share of samples that had a lip reading within 0.25 s.
export function speechSeries(sdkTalking, pose, opts = {}) {
  const o = { ...SPEECH_DEFAULTS, ...opts };
  const lips = talkingFromLips(pose, { ...o, fixed: o.threshold }).talking;
  const sdk = (sdkTalking || []).filter((x) => x && isNum(x.ts)).slice().sort((a, b) => a.ts - b.ts);
  if (!lips.length) return { talking: sdk, source: 'sdk', lipCoverage: 0 };
  if (!sdk.length) return { talking: lips, source: 'lips', lipCoverage: 1 };
  const fused = fuseTalking(sdk, lips, 0.25e6);
  let j = 0, covered = 0;
  for (const x of sdk) {
    while (j + 1 < lips.length && lips[j + 1].ts <= x.ts) j++;
    const near = [lips[j], lips[j + 1]].some((y) => y && Math.abs(y.ts - x.ts) <= 0.25e6);
    if (near) covered++;
  }
  return { talking: fused, source: 'lips+sdk', lipCoverage: covered / sdk.length };
}
