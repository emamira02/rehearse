// Simulated SmartSpectra-like signals for development and tests (no camera, no SDK, no credits).
//
// A scripted speaker alternates stretches of speech (with short word gaps) and pauses. The chest trace follows
// speech breathing: a slow exhale while talking, a quick inhale in most pauses, and a hurried mid-sentence breath
// when a stretch runs too long. Signal start-up delays mimic the live smoke test of 2026-11-11 (talking/blinking
// after ~7.7 s, chest trace ~9.1 s, breathing rate ~22 s, pulse ~26 s). Deterministic for a given seed.
//
// Output samples use the same shape the app extracts from decoded SDK metrics, with `ts` in epoch microseconds.
// With `face`, it also emits head pose features and a HAPPY score (occasional glances down at notes, smiles).
// With `cueAt(tSeconds) -> { key, truth } | null`, the speaker follows a script instead (used by the accuracy check):
// truth = { talking, breath: true | false | null, head: 'up' | 'down' | 'side' | null, smile: boolean | null }.

export const SIM_DELAYS = Object.freeze({ face: 7.7, chest: 9.1, rate: 22.4, pulse: 26.4 });
const FPS = 30;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Speech script: [{start, end, talking}] with word gaps inside speech, built lazily as time advances.
function makeScript(rnd) {
  const segs = [];
  let t = 0;
  let n = 0;
  const push = (dur, talking) => { segs.push({ start: t, end: t + dur, talking }); t += dur; };
  push(2.5 + rnd() * 2, false);                                   // settles in before speaking
  return {
    segs,
    extendTo(until) {
      while (t < until) {
        n++;
        // mostly phrases of 3-12 s; every ~6th stretch is a long run (25-50 s) without a real pause
        const runLen = n % 6 === 4 ? 25 + rnd() * 25 : 3 + rnd() * 9;
        const runEnd = t + runLen;
        while (t < runEnd) {
          push(Math.min(runEnd - t, 1 + rnd() * 2.5), true);
          if (t < runEnd - 0.5) push(0.12 + rnd() * 0.3, false);    // word gap, not a pause
        }
        const r = rnd();
        push(r < 0.12 ? 4 + rnd() * 2.5 : 0.7 + rnd() * 2.3, false); // pause (sometimes long)
      }
    },
  };
}

export const SIM_POSE = Object.freeze({ pitch: 0.42, yaw: 0.0, downPitch: 0.24, sideYaw: 0.5 });

export function createSimulatedSpeaker({ seed = 7, startUs = 0, delays = SIM_DELAYS, pulseEnabled = true, face = true, cueAt = null } = {}) {
  const rnd = mulberry32(seed);
  const script = makeScript(rnd);
  const dt = 1 / FPS;
  let i = 0;                    // next frame index
  let seg = 0;                  // index into script.segs
  let lung = 0.7;               // 0..1 lung volume proxy
  let inhale = null;            // { to, rate } while an inhale is under way
  let breathDecided = -1;       // index of the pause segment whose breath was already decided
  let blinkUntil = -1;
  let nextBlink = 3 + rnd() * 4;
  let nextPulse = delays.pulse, nextRate = delays.rate;
  let lookUntil = -1, nextLook = 20 + rnd() * 30, smileUntil = -1, nextSmile = 15 + rnd() * 30;
  let lastCueKey = null;
  let lipTarget = 0, lipNow = 0, nextSyllable = 0;
  const tsOf = (t) => Math.round(startUs + t * 1e6);

  function stateAt(t) {
    script.extendTo(t + 60);
    while (script.segs[seg].end <= t) seg++;
    return script.segs[seg];
  }

  // Advances the simulation to time `until` (seconds since start) and returns every sample produced on the way.
  function advanceTo(until) {
    const out = { talking: [], blinking: [], chest: [], pulse: [], breathRate: [], pose: [], smile: [] };
    for (; i * dt <= until; i++) {
      const t = i * dt;
      const cue = cueAt ? cueAt(t) : null;
      const s = cue ? { talking: cue.truth.talking } : stateAt(t);
      const isPause = cue ? !cue.truth.talking : !s.talking && s.end - s.start >= 0.6;
      if (cue && cue.key !== lastCueKey) {
        lastCueKey = cue.key;
        inhale = cue.truth.breath === true ? { to: Math.min(1, lung + 0.35 + rnd() * 0.15), rate: 0.9 } : null;
        breathDecided = seg;                                          // scripted pauses decide their own breath
      }

      // chest: slow exhale while talking, inhale in (most) pauses, hurried breath when running out of air
      if (cue && cue.truth.breath === false) {
        // holding the breath: no change
      } else if (inhale) {
        lung = Math.min(inhale.to, lung + inhale.rate * dt);
        if (lung >= inhale.to - 1e-6) inhale = null;
      } else if (isPause && breathDecided !== seg) {
        breathDecided = seg;
        if (rnd() < 0.72) inhale = { to: 0.82 + rnd() * 0.18, rate: 1.0 + rnd() * 0.6 };
      } else if (s.talking && lung < 0.12) {
        inhale = { to: 0.55 + rnd() * 0.2, rate: 1.8 };              // mid-sentence breath
      } else if (s.talking) {
        lung -= (0.035 + rnd() * 0.01) * dt;                          // ~0.04/s exhale while speaking
      } else if (!isPause) {
        lung -= 0.01 * dt;
      } else {
        lung -= 0.02 * dt;                                            // holding / slowly exhaling in a pause
      }
      lung = Math.max(0, Math.min(1, lung));

      const ts = tsOf(t);
      if (t >= delays.face) {
        const flip = rnd() < 0.006;                                   // single-frame detector noise
        out.talking.push({ ts, detected: flip ? !s.talking : s.talking });
        if (t >= nextBlink) { blinkUntil = t + 0.12 + rnd() * 0.08; nextBlink = t + 1 + (-Math.log(Math.max(rnd(), 1e-9))) * 3.2; }
        out.blinking.push({ ts, detected: t < blinkUntil });
      }
      if (t >= delays.chest) out.chest.push({ ts, v: 100 + 6 * lung + 0.08 * gauss(rnd) });
      if (face && t >= delays.face && i % 2 === 0) {                 // ~15 Hz face outputs
        let head = cue ? cue.truth.head : null, smiling = cue ? cue.truth.smile === true : false;
        if (!cue) {
          if (t >= nextLook) { lookUntil = t + 3 + rnd() * 5; nextLook = lookUntil + 20 + rnd() * 40; }
          if (t >= nextSmile) { smileUntil = t + 1.5 + rnd() * 1.5; nextSmile = smileUntil + 25 + rnd() * 35; }
          head = t < lookUntil && s.talking ? 'down' : 'up';
          smiling = t < smileUntil;
        }
        const pitch = SIM_POSE.pitch + (head === 'down' ? SIM_POSE.downPitch : 0) + 0.012 * gauss(rnd);
        const yaw = SIM_POSE.yaw + (head === 'side' ? SIM_POSE.sideYaw : 0) + 0.03 * gauss(rnd);
        // lip opening in eye-distance units: irregular openings per syllable (4-6/s) while talking, closed at rest,
        // quantised like real landmarks (~1 px at ~140 px eye distance); levels match run C (2026-11-12)
        if (s.talking && t >= nextSyllable) { lipTarget = 0.09 * rnd(); nextSyllable = t + 0.16 + 0.1 * rnd(); }
        if (!s.talking) lipTarget = 0;
        lipNow += (lipTarget - lipNow) * 0.45;
        const mouth = Math.max(0, Math.round((lipNow + 0.0012 * gauss(rnd)) / 0.007) * 0.007);
        out.pose.push({ ts, pitch, yaw, mouth, size: 140 });
        out.smile.push({ ts, v: Math.max(0, Math.min(100, (smiling ? 80 : 8) + 6 * gauss(rnd))) });
      }
      if (t >= nextRate) {
        out.breathRate.push({ ts, v: 11 + 3 * rnd(), confidence: 50 + 40 * rnd() });
        nextRate += 5;
      }
      if (pulseEnabled && t >= nextPulse) {
        const v = 74 + 16 * Math.exp(-t / 100) + 2 * Math.sin(t / 23) + 1.2 * gauss(rnd);
        const confidence = rnd() < 0.08 ? 15 + 20 * rnd() : 55 + 35 * rnd();
        out.pulse.push({ ts, v, confidence });
        nextPulse += 1;
      }
    }
    return out;
  }

  return { advanceTo, script: () => script.segs, fps: FPS };
}
