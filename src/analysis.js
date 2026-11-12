// Rehearsal analysis: pure functions over time-stamped SmartSpectra samples (seconds since the run started).
// No I/O, no SDK import: the same code runs on live samples and on the synthetic ones used by the tests.
//
// Inputs (all arrays sorted by t, any of them may be empty):
//   talking:  [{ t, detected: boolean }]        face.talking
//   chest:    [{ t, v: number }]                breathing.upperTrace (arbitrary units, only shape is used)
//   pulse:    [{ t, v: bpm, confidence?: 0-1 }] cardio.pulseRate
//   blinking: [{ t, detected: boolean }]        face.blinking
//
// Nothing here is a health measurement: the report describes the rehearsal (pauses, pacing, breaths taken in
// pauses, how the pulse reading moved) in plain words and never classifies or diagnoses anything.

export const DEFAULTS = Object.freeze({
  minPauseS: 0.6,        // shorter silences are gaps between words, not pauses
  smoothS: 0.3,          // talking flips shorter than this are merged into the surrounding state
  longPauseS: 4.0,       // pauses at least this long are reported separately
  inhaleFrac: 0.35,      // a breath = chest trace rises by >= this share of the run's typical breath range
  pulseMinConf: 0.5,     // pulse samples below this confidence are ignored
  pulseWindowS: 30,      // opening / closing windows for the pulse comparison
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function cleanSeries(arr, key) {
  if (!Array.isArray(arr)) return [];
  const out = arr.filter((s) => s && isNum(s.t) && (key === null || key in s));
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function quantile(values, q) {
  const v = values.filter(isNum).slice().sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// talking samples -> alternating segments [{start, end, talking}] covering [first t, last t]; flips shorter than
// smoothS are absorbed (a run of samples is a state change only if it lasts at least smoothS).
export function segmentTalking(talking, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = cleanSeries(talking, 'detected');
  if (s.length < 2) return [];
  const raw = [];
  for (let i = 0; i < s.length; i++) {
    const state = Boolean(s[i].detected);
    const end = i + 1 < s.length ? s[i + 1].t : s[i].t;
    const last = raw[raw.length - 1];
    if (last && last.talking === state) last.end = end;
    else raw.push({ start: s[i].t, end, talking: state });
  }
  // absorb short flips (repeat until stable: merging can create new short neighbours)
  let segs = raw;
  for (let changed = true; changed && segs.length > 1;) {
    changed = false;
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const dur = seg.end - seg.start;
      const inner = i > 0 && i < segs.length - 1;
      if (inner && dur < o.smoothS) {
        out[out.length - 1].end = seg.end;   // previous segment (opposite state) swallows the flip
        changed = true;
        continue;
      }
      const prev = out[out.length - 1];
      if (prev && prev.talking === seg.talking) { prev.end = seg.end; changed = true; }
      else out.push({ ...seg });
    }
    segs = out;
  }
  return segs.filter((g) => g.end > g.start);
}

// pauses = non-talking segments between two talking segments, at least minPauseS long (silence before the first
// word and after the last one is not a pause)
export function findPauses(segments, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const firstTalk = segments.findIndex((g) => g.talking);
  let lastTalk = -1;
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].talking) { lastTalk = i; break; }
  if (firstTalk < 0 || lastTalk <= firstTalk) return [];
  return segments
    .slice(firstTalk, lastTalk + 1)
    .filter((g) => !g.talking && g.end - g.start >= o.minPauseS)
    .map((g) => ({ start: g.start, end: g.end, duration: g.end - g.start }));
}

// typical breath range of the whole run: spread between the 10th and 90th percentile of the chest trace
export function breathRange(chest) {
  const s = cleanSeries(chest, 'v');
  if (s.length < 5) return NaN;
  return quantile(s.map((x) => x.v), 0.9) - quantile(s.map((x) => x.v), 0.1);
}

// true when the chest trace inside [start, end] rises by >= inhaleFrac * range after its minimum (an inhale)
export function inhaleIn(chest, start, end, range, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!isNum(range) || range <= 0) return null;
  const w = cleanSeries(chest, 'v').filter((x) => x.t >= start && x.t <= end);
  if (w.length < 3) return null;                  // not enough samples to tell
  let minV = Infinity, bestRise = 0;
  for (const x of w) {
    if (x.v < minV) minV = x.v;
    bestRise = Math.max(bestRise, x.v - minV);
  }
  return bestRise >= o.inhaleFrac * range;
}

function medianIn(series, from, to) {
  return quantile(series.filter((x) => x.t >= from && x.t <= to).map((x) => x.v), 0.5);
}

// SDK confidences arrive on a 0-100 scale (live test 2026-11-11: 67.4); thresholds here are 0-1
export function normConfidence(c) {
  if (!isNum(c)) return null;
  return c > 1 ? c / 100 : c;
}

export function pulseSummary(pulse, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = cleanSeries(pulse, 'v').filter((x) => {
    const c = normConfidence(x.confidence);
    return isNum(x.v) && (c === null || c >= o.pulseMinConf);
  });
  if (s.length < 4) return null;
  const t0 = s[0].t, t1 = s[s.length - 1].t;
  if (t1 - t0 < 2 * o.pulseWindowS) {
    return { opening: medianIn(s, t0, t1), closing: null, change: null, samples: s.length };
  }
  const opening = medianIn(s, t0, t0 + o.pulseWindowS);
  const closing = medianIn(s, t1 - o.pulseWindowS, t1);
  return { opening, closing, change: closing - opening, samples: s.length };
}

export function blinkCount(blinking) {
  const s = cleanSeries(blinking, 'detected');
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i].detected && !(i > 0 && s[i - 1].detected)) n++;
  return n;
}

// stretches of speech between two pauses (word gaps shorter than minPauseS do not split a stretch)
export function speechRuns(segments, pauses) {
  const talk = segments.filter((g) => g.talking);
  if (!talk.length) return [];
  const runs = [];
  let start = talk[0].start;
  for (const p of pauses) {
    if (p.start > start) runs.push({ start, end: p.start, duration: p.start - start });
    start = p.end;
  }
  const end = talk[talk.length - 1].end;
  if (end > start) runs.push({ start, end, duration: end - start });
  return runs;
}

export function analyzeRehearsal(signals, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const segs = segmentTalking(signals.talking, o);
  const pauses = findPauses(segs, o);
  const range = breathRange(signals.chest);
  const withBreath = pauses.map((p) => ({ ...p, breath: inhaleIn(signals.chest, p.start, p.end, range, o) }));
  const speaking = segs.filter((g) => g.talking).reduce((a, g) => a + (g.end - g.start), 0);
  const total = segs.length ? segs[segs.length - 1].end - segs[0].start : 0;
  const known = withBreath.filter((p) => p.breath !== null);
  const blinks = blinkCount(signals.blinking);
  const runs = speechRuns(segs, pauses);
  const longest = runs.reduce((a, r) => (!a || r.duration > a.duration ? r : a), null);
  return {
    durationS: total,
    speakingS: speaking,
    speakingRatio: total > 0 ? speaking / total : null,
    pauses: withBreath,
    pauseCount: pauses.length,
    longPauses: pauses.filter((p) => p.duration >= o.longPauseS).length,
    pausesPerMin: total >= 30 ? (pauses.length * 60) / total : null,
    meanPauseS: pauses.length ? pauses.reduce((a, p) => a + p.duration, 0) / pauses.length : null,
    longestRunS: longest ? longest.duration : null,
    longestRunStartS: longest ? longest.start : null,
    breathsInPauses: known.filter((p) => p.breath).length,
    pausesWithBreathData: known.length,
    breathAnchoredPauses: known.length ? known.filter((p) => p.breath).length / known.length : null,
    pulse: pulseSummary(signals.pulse, o),
    blinksPerMin: total >= 30 ? (blinks * 60) / total : null,
  };
}
