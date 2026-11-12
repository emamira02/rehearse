import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatedSpeaker, SIM_DELAYS } from '../src/sim.js';
import { buildRehearsalResult, MIN_REHEARSAL_S } from '../src/rehearsal.js';
import { speechRuns, segmentTalking, findPauses } from '../src/analysis.js';
import { rehearsalNotes, fmtClock, fmtSeconds } from '../src/notes.js';

const START = 1_800_000_000_000_000;   // epoch µs

test('simulator is deterministic and respects the live start-up delays', () => {
  const a = createSimulatedSpeaker({ seed: 3, startUs: START }).advanceTo(60);
  const b = createSimulatedSpeaker({ seed: 3, startUs: START }).advanceTo(60);
  assert.deepEqual(a.talking.slice(0, 50), b.talking.slice(0, 50));
  const firstS = (arr) => (arr[0].ts - START) / 1e6;
  assert.ok(firstS(a.talking) >= SIM_DELAYS.face);
  assert.ok(firstS(a.chest) >= SIM_DELAYS.chest);
  assert.ok(firstS(a.pulse) >= SIM_DELAYS.pulse);
  assert.equal(createSimulatedSpeaker({ seed: 3, pulseEnabled: false }).advanceTo(60).pulse.length, 0);
});

test('simulated rehearsal → plausible summary and compact timeline', () => {
  const sp = createSimulatedSpeaker({ seed: 11, startUs: START });
  const buf = sp.advanceTo(220);
  const startUs = START + 20e6, stopUs = START + 200e6;
  const r = buildRehearsalResult(buf, startUs, stopUs);
  assert.equal(r.enough, true);
  assert.equal(r.durationS, 180);
  const S = r.summary;
  assert.ok(S.pauseCount >= 6 && S.pauseCount <= 40, `pauses ${S.pauseCount}`);
  assert.ok(S.speakingRatio > 0.6 && S.speakingRatio < 0.95);
  // lip-based pause edges cut part of the inhale, so the breath share is under-estimated (the simulator breathes in
  // ~72% of pauses); this is why the metric is labelled experimental
  assert.ok(S.breathAnchoredPauses > 0.1 && S.breathAnchoredPauses <= 1, `breath share ${S.breathAnchoredPauses}`);
  assert.equal(S.speechSource, 'lips+sdk');
  assert.ok(S.lipCoverage > 0.9);
  assert.ok(S.longestRunS > 10);
  assert.ok(S.pulse && S.pulse.opening > S.pulse.closing, 'simulated pulse reading settles');
  // timeline: chest stored at ~10 Hz, times relative to the rehearsal start, inside [0, duration]
  assert.ok(Math.abs(r.timeline.chest.length - 1800) < 30);
  for (const [t] of r.timeline.chest) assert.ok(t >= 0 && t <= 180);
  assert.equal(r.timeline.pauses.length, S.pauseCount);
  assert.ok(JSON.stringify(r.timeline).length < 120_000);
});

test('too short or signal-less rehearsals are flagged, not analysed into nonsense', () => {
  const buf = createSimulatedSpeaker({ seed: 1, startUs: START }).advanceTo(40);
  assert.equal(buildRehearsalResult(buf, START + 20e6, START + 20e6 + (MIN_REHEARSAL_S - 1) * 1e6).enough, false);
  const empty = buildRehearsalResult({ talking: [], chest: [], pulse: [], blinking: [] }, START, START + 60e6);
  assert.equal(empty.enough, false);
  assert.equal(empty.summary.pauseCount, 0);
});

test('speechRuns splits speech at real pauses only', () => {
  const s = [];
  // talk 0-10, 0.3 s word gap, talk to 20, 2 s pause, talk 22-30
  for (let t = 0; t < 30; t += 0.1) {
    const tt = Math.round(t * 10) / 10;
    s.push({ t: tt, detected: !((tt >= 10 && tt < 10.3) || (tt >= 20 && tt < 22)) });
  }
  const segs = segmentTalking(s);
  const runs = speechRuns(segs, findPauses(segs));
  assert.equal(runs.length, 2);
  assert.ok(Math.abs(runs[0].duration - 20) < 0.11);
  assert.ok(Math.abs(runs[1].start - 22) < 0.11);
});

test('notes: rules fire on the right facts and never interpret the pulse', () => {
  const base = { durationS: 180, speakingS: 140, speakingRatio: 0.78, pauseCount: 10, longPauses: 0, pausesPerMin: 3.3,
    meanPauseS: 1.5, longestRunS: 52, longestRunStartS: 70, breathsInPauses: 3, pausesWithBreathData: 10,
    breathAnchoredPauses: 0.3, pulse: { opening: 91.6, closing: 80.2, change: -11.4 }, blinksPerMin: 15 };
  const notes = rehearsalNotes(base);
  const txt = notes.map((n) => n.text).join('\n');
  assert.match(txt, /longest stretch without a pause was 52 s \(from 1:10\)/);
  assert.match(txt, /3 of 10 pauses \(30%\)/);
  assert.match(txt, /about 92 bpm .* 80 bpm/);
  assert.match(txt, /not a health measurement/);
  assert.doesNotMatch(txt, /stress|anxi|calm|nervous|heart rate is|healthy|condition/i);
  const better = rehearsalNotes({ ...base, longestRunS: 25, breathAnchoredPauses: 0.8, breathsInPauses: 8 }, base);
  const t2 = better.map((n) => n.text).join('\n');
  assert.match(t2, /never spoke for more than 25 s/);
  assert.match(t2, /Since your previous run of this talk: longest stretch 52 s → 25 s; breaths in pauses 30% → 80%/);
  assert.equal(rehearsalNotes({ ...base, speakingS: 2 })[0].kind, 'info');
  assert.deepEqual(rehearsalNotes(null), []);
});

test('time formatting', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(65.9), '1:05');
  assert.equal(fmtClock(-1), '–');
  assert.equal(fmtSeconds(4.25), '4.3 s');
  assert.equal(fmtSeconds(42), '42 s');
  assert.equal(fmtSeconds(90), '1:30');
});
