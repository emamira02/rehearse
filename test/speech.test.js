import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lipActivity, otsuThreshold, talkingFromLips, fuseTalking } from '../src/speech.js';
import { mulberry32 } from '../src/sim.js';

// 30 Hz lip opening: speech = 4-6 Hz movement, silence = still lips with landmark jitter
function lips(pattern, seed = 1) {
  const rnd = mulberry32(seed);
  const out = [];
  let t = 0;
  for (const [speaking, dur] of pattern) {
    for (const end = t + dur; t < end - 1e-9; t += 1 / 30) {
      const m = speaking ? 0.06 + 0.05 * Math.abs(Math.sin(2 * Math.PI * (4 + 2 * rnd()) * t)) : 0.02;
      out.push({ ts: Math.round(t * 1e6), mouth: m + 0.002 * (rnd() - 0.5), truth: speaking });
    }
  }
  return out;
}

test('lipActivity is high while speaking and low while silent', () => {
  const s = lips([[true, 5], [false, 5]]);
  const a = lipActivity(s);
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  const speak = a.filter((x) => x.ts > 1e6 && x.ts < 4.5e6).map((x) => x.a);
  const quiet = a.filter((x) => x.ts > 6e6).map((x) => x.a);
  assert.ok(mean(speak) > 10 * mean(quiet), `${mean(speak)} vs ${mean(quiet)}`);
});

test('talkingFromLips separates speech from silence (incl. a held smile-like opening)', () => {
  const s = lips([[true, 6], [false, 3], [true, 7], [false, 4], [true, 5], [false, 3]], 7);
  // a held wide mouth (smile) is static: same as silence for this detector
  for (const x of s) if (x.ts > 26e6) x.mouth += 0.04;
  const { talking, threshold } = talkingFromLips(s);
  assert.ok(threshold > 0);
  let ok = 0, n = 0;
  for (const x of talking) {
    const src = s.find((y) => y.ts === x.ts);
    // skip 0.7 s after each change (window warm-up)
    const tt = x.ts / 1e6;
    if ([0, 6, 9, 16, 20, 25, 28].some((b) => tt >= b && tt < b + 0.7)) continue;
    n++; if (x.detected === src.truth) ok++;
  }
  assert.ok(ok / n > 0.95, `accuracy ${ok / n}`);
});

test('degenerate inputs', () => {
  assert.equal(otsuThreshold([1, 2, 3]), null);
  assert.deepEqual(talkingFromLips([]), { talking: [], threshold: null });
  assert.deepEqual(lipActivity([{ ts: 0, mouth: null }]), []);
});

test('fuseTalking: either source speaking → speaking', () => {
  const a = [0, 1, 2, 3].map((i) => ({ ts: i * 1e5, detected: i === 0 }));
  const b = [0, 1, 2, 3].map((i) => ({ ts: i * 1e5 + 1e4, detected: i === 2 }));
  assert.deepEqual(fuseTalking(a, b).map((x) => x.detected), [true, false, true, false]);
  assert.deepEqual(fuseTalking(a, []).map((x) => x.detected), [true, false, false, false]);
});

test('speechSeries: lips rescue speech the SDK misses; SDK alone when no landmarks', async () => {
  const { speechSeries } = await import('../src/speech.js');
  const s = lips([[true, 6], [false, 3], [true, 6]], 3);
  // SDK sees almost nothing (as measured live): speaking only on every 10th sample
  const sdk = s.map((x, i) => ({ ts: x.ts, detected: x.truth && i % 10 === 0 }));
  const r = speechSeries(sdk, s);
  assert.equal(r.source, 'lips+sdk');
  assert.ok(r.lipCoverage > 0.95);
  const speakFrames = r.talking.filter((x, i) => s[i].truth && x.ts > 1e6);
  assert.ok(speakFrames.filter((x) => x.detected).length / speakFrames.length > 0.9);
  const none = speechSeries(sdk, []);
  assert.equal(none.source, 'sdk');
  assert.deepEqual(none.talking.map((x) => x.detected), sdk.map((x) => x.detected));
});

test('createLipTracker matches lipActivity on the same stream', async () => {
  const { createLipTracker } = await import('../src/speech.js');
  const s = lips([[true, 3], [false, 2]], 5);
  const tr = createLipTracker();
  const live = s.map((x) => tr.push(x)).filter((x) => x !== null);
  const batch = lipActivity(s).map((x) => x.a);
  assert.equal(live.length, batch.length);
  for (let i = 0; i < live.length; i++) assert.ok(Math.abs(live[i] - batch[i]) < 1e-9);
  assert.equal(tr.push({ ts: 0, mouth: 0.1 }), null);       // out of order ignored
});
