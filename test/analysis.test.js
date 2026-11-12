import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentTalking, findPauses, breathRange, inhaleIn, pulseSummary, blinkCount, analyzeRehearsal, quantile,
  normConfidence,
} from '../src/analysis.js';

const DT = 0.1;
const range = (a, b) => { const out = []; for (let t = a; t < b - 1e-9; t += DT) out.push(Math.round(t * 10) / 10); return out; };

// talk 0-5, pause 5-6.5, talk 6.5-12, gap 12-12.4 (between words), talk 12.4-20, long pause 20-25, talk 25-30
function talkingSamples({ flipAt = null } = {}) {
  const silent = (t) => (t >= 5 && t < 6.5) || (t >= 12 && t < 12.4) || (t >= 20 && t < 25);
  return range(0, 30).map((t) => ({ t, detected: flipAt !== null && Math.abs(t - flipAt) < 1e-9 ? false : !silent(t) }));
}

// chest trace: 4 s breathing cycle with its minimum at t=5 (an inhale starts as the first pause starts), plus a
// flat stretch inside [lo, hi) when asked
function chestSamples({ flat = null } = {}) {
  return range(0, 30).map((t) => {
    if (flat && t >= flat[0] && t < flat[1]) return { t, v: 0 };
    return { t, v: -Math.cos((2 * Math.PI * (t - 5)) / 4) };
  });
}

test('quantile interpolates and ignores non-numbers', () => {
  assert.equal(quantile([3, 1, 2, NaN, 'x'], 0.5), 2);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('segmentTalking: alternating segments, a one-sample flip is absorbed', () => {
  const segs = segmentTalking(talkingSamples({ flipAt: 3.0 }));
  assert.deepEqual(segs.map((g) => g.talking), [true, false, true, false, true, false, true]);
  assert.equal(segs[0].start, 0);
  assert.ok(Math.abs(segs[1].start - 5) < 1e-9 && Math.abs(segs[1].end - 6.5) < 1e-9);
});

test('findPauses: word gaps under 0.6 s are not pauses; edges are not pauses', () => {
  const pauses = findPauses(segmentTalking(talkingSamples()));
  assert.equal(pauses.length, 2);
  assert.ok(Math.abs(pauses[0].duration - 1.5) < 1e-9);
  assert.ok(Math.abs(pauses[1].duration - 5) < 1e-9);
  const leading = [{ t: 0, detected: false }, { t: 2, detected: true }, { t: 4, detected: true }, { t: 5, detected: false }, { t: 9, detected: false }];
  assert.equal(findPauses(segmentTalking(leading)).length, 0);
});

test('inhaleIn: a rising chest trace in the pause is a breath, a flat one is not', () => {
  const chest = chestSamples({ flat: [20, 25] });
  const r = breathRange(chest);
  assert.ok(r > 1.5 && r < 2.01);
  assert.equal(inhaleIn(chest, 5, 6.5, r), true);       // minimum at t=5, then rising
  assert.equal(inhaleIn(chest, 7, 8.4, r), false);      // maximum at t=7, falling only (an exhale)
  assert.equal(inhaleIn(chest, 20, 25, r), false);
  assert.equal(inhaleIn([], 0, 1, r), null);
  assert.equal(inhaleIn(chest, 0, 1, NaN), null);
});

test('pulseSummary: low-confidence samples ignored; opening vs closing medians', () => {
  const pulse = range(0, 90).map((t) => ({ t, v: t < 30 ? 96 : 80, confidence: 0.9 }));
  pulse.push({ t: 89.95, v: 200, confidence: 0.1 });
  const p = pulseSummary(pulse);
  assert.equal(p.opening, 96);
  assert.equal(p.closing, 80);
  assert.equal(p.change, -16);
  assert.equal(pulseSummary([{ t: 0, v: 70 }]), null);
  const short = pulseSummary(range(0, 20).map((t) => ({ t, v: 70 })));
  assert.equal(short.closing, null);
});

test('pulseSummary accepts SDK confidences on a 0-100 scale', () => {
  const pulse = range(0, 90).map((t) => ({ t, v: t < 30 ? 90 : 75, confidence: 67.4 }));
  pulse.push({ t: 89.95, v: 200, confidence: 12 });
  const p = pulseSummary(pulse);
  assert.equal(p.opening, 90);
  assert.equal(p.closing, 75);
  assert.equal(normConfidence(67.4), 0.674);
  assert.equal(normConfidence(0.8), 0.8);
  assert.equal(normConfidence(undefined), null);
});

test('blinkCount counts rising edges only', () => {
  const s = [false, true, true, false, true, false, false, true].map((d, i) => ({ t: i, detected: d }));
  assert.equal(blinkCount(s), 3);
});

test('analyzeRehearsal: end-to-end summary on synthetic signals', () => {
  const rep = analyzeRehearsal({
    talking: talkingSamples(), chest: chestSamples({ flat: [20, 25] }),
    pulse: range(0, 30).map((t) => ({ t, v: 88, confidence: 0.8 })), blinking: [],
  });
  assert.ok(Math.abs(rep.durationS - 29.9) < 1e-6);
  assert.equal(rep.pauseCount, 2);
  assert.equal(rep.longPauses, 1);
  assert.equal(rep.breathAnchoredPauses, 0.5);
  assert.ok(rep.speakingRatio > 0.7 && rep.speakingRatio < 0.8);
  assert.equal(rep.pulse.opening, 88);
  assert.equal(rep.blinksPerMin, null);                 // under 30 s: no per-minute rate
  const long = analyzeRehearsal({ talking: range(0, 60).map((t) => ({ t, detected: true })),
    blinking: range(0, 60).map((t) => ({ t, detected: Math.abs((t % 4) - 1) < 1e-9 })) });
  assert.ok(Math.abs(long.blinksPerMin - (15 * 60) / 59.9) < 1e-6);
});

test('analyzeRehearsal tolerates missing or malformed signals', () => {
  const rep = analyzeRehearsal({ talking: [{ t: 'x' }, null, { t: 1, detected: true }], chest: undefined, pulse: null });
  assert.equal(rep.pauseCount, 0);
  assert.equal(rep.breathAnchoredPauses, null);
  assert.equal(rep.pulse, null);
  assert.equal(rep.blinksPerMin, null);
});
