// "How well does Rehearse read you?" A scripted sequence with known ground truth, and its evaluation.
// Pure: the app runs the script and timestamps each step; this module compares what the signals said with what
// the person was asked to do. Frame-level scores skip the first REACTION_S of every step (people need a moment to
// follow a cue).
import { segmentTalking, findPauses, breathRange, inhaleIn, DEFAULTS } from './analysis.js';
import { classifyHead, FACE_DEFAULTS } from './face.js';

export const REACTION_S = 1.0;

const SENTENCES = [
  'Today I want to show you how a small pause changes the way people listen.',
  'When we rush, the audience spends its energy keeping up instead of thinking.',
  'A pause gives every idea a moment to land before the next one arrives.',
  'Most speakers breathe in the middle of a sentence because they never stop.',
  'If you breathe in the pause, the sentence that follows starts with full support.',
  'Notes are useful, but every glance down is a moment the room loses your face.',
  'The best talks feel like a conversation, even when one person does the talking.',
  'Practice is where you make your mistakes, so the stage only sees your choices.',
  'Let me give you one example from a talk I gave last year.',
  'Three things matter here: the problem, the evidence, and what we do next.',
  'That is the whole idea, and it fits on a single slide.',
  'Thank you for listening, and I am happy to take your questions.',
];

// kind → instruction and ground truth
const KINDS = {
  speak:   { title: 'Read aloud, looking at the screen', talking: true, head: 'up', smile: null },
  breathe: { title: 'Pause and breathe in', talking: false, breath: true, head: null, smile: null },
  hold:    { title: 'Pause without breathing in', talking: false, breath: false, head: null, smile: null, say: 'Stay quiet and keep breathing out slowly. Do not take a breath.' },
  down:    { title: 'Keep talking, looking down at your desk', talking: true, head: 'down', smile: null, say: 'Count out loud: one, two, three…' },
  side:    { title: 'Keep talking, looking to one side', talking: true, head: 'side', smile: null, say: 'Count out loud: one, two, three…' },
  neutral: { title: 'Stay quiet with a neutral face', talking: false, head: 'up', smile: false },
  smile:   { title: 'Stay quiet and smile', talking: false, head: 'up', smile: true },
};

function build(seq) {
  let si = 0;
  return seq.map(([kind, s, block = 0], i) => {
    const k = KINDS[kind];
    const text = k.say || (k.talking ? SENTENCES[si++ % SENTENCES.length] : null);
    return Object.freeze({ i, kind, s, block, title: k.title, text, truth: { talking: k.talking, breath: k.breath ?? null, head: k.head, smile: k.smile } });
  });
}

// About 85 s: nine read-aloud cards and eight scripted pauses (four with a breath in, four without).
// (The head and smile blocks used on 2026-11-12 to evaluate those signals are in HEAD_SMILE_BLOCKS; they are not part
// of the in-app check because Rehearse does not use those signals.)
export const CHECK_SCRIPT = build([
  ['speak', 7], ['breathe', 3], ['speak', 6], ['hold', 3], ['speak', 7], ['breathe', 4], ['speak', 6], ['hold', 3],
  ['speak', 7], ['breathe', 3], ['speak', 6], ['hold', 4], ['speak', 6], ['breathe', 3], ['speak', 6], ['hold', 3],
  ['speak', 5],
]);
export const HEAD_SMILE_BLOCKS = Object.freeze([
  ['down', 6, 1], ['speak', 5, 1], ['side', 5, 1], ['speak', 4, 1], ['neutral', 3, 1], ['smile', 3, 1], ['neutral', 3, 1],
  ['down', 6, 2], ['speak', 5, 2], ['side', 5, 2], ['speak', 4, 2], ['neutral', 3, 2], ['smile', 3, 2], ['neutral', 3, 2],
]);

export const CHECK_DURATION_S = CHECK_SCRIPT.reduce((a, st) => a + st.s, 0);

// Step whose window contains `elapsedS` (seconds since the check started), or null after the end.
export function stepAt(elapsedS, script = CHECK_SCRIPT) {
  let t = 0;
  for (const st of script) { if (elapsedS < t + st.s) return { step: st, startS: t, leftS: t + st.s - elapsedS }; t += st.s; }
  return null;
}

const ratio = (a, b) => (b > 0 ? a / b : null);

// steps: [{ ...script step, startUs, endUs }] as actually run. buf: { talking, chest, pose, smile } with ts (µs).
export function evaluateCheck(steps, buf, baseline, opts = {}) {
  const o = { ...DEFAULTS, ...FACE_DEFAULTS, ...opts };
  const t0 = steps[0].startUs;
  const rel = (ts) => (ts - t0) / 1e6;
  const win = (arr, a, b) => (arr || []).filter((x) => x.ts >= a && x.ts < b);
  const inner = (st) => [st.startUs + REACTION_S * 1e6, st.endUs];

  // speaking detection, frame level
  let speechOk = 0, speechN = 0, silenceOk = 0, silenceN = 0;
  for (const st of steps) {
    const [a, b] = inner(st);
    for (const x of win(buf.talking, a, b)) {
      if (st.truth.talking) { speechN++; if (x.detected) speechOk++; } else { silenceN++; if (!x.detected) silenceOk++; }
    }
  }

  // pauses and breaths, with the same analysis code the reports use
  const endUs = steps[steps.length - 1].endUs;
  const talking = win(buf.talking, t0, endUs).map((x) => ({ t: rel(x.ts), detected: x.detected }));
  const chest = win(buf.chest, t0, endUs).map((x) => ({ t: rel(x.ts), v: x.v }));
  const detected = findPauses(segmentTalking(talking, o), o);
  const range = breathRange(chest);
  const scripted = steps.filter((st) => st.kind === 'breathe' || st.kind === 'hold');
  let found = 0, breathOk = 0, breathN = 0;
  const pauseRows = scripted.map((st) => {
    const a = rel(st.startUs), b = rel(st.endUs);
    const match = detected.find((p) => Math.min(p.end, b + 0.8) - Math.max(p.start, a) >= 0.4 * (b - a));
    let breath = null;
    if (match) {
      found++;
      breath = inhaleIn(chest, match.start, match.end, range, o);
      if (breath !== null) { breathN++; if (breath === st.truth.breath) breathOk++; }
    }
    return { kind: st.kind, startS: a, found: !!match, breath, expected: st.truth.breath };
  });
  const speakWindows = steps.filter((st) => st.truth.talking).map((st) => [rel(st.startUs) + REACTION_S, rel(st.endUs) - 0.5]);
  const falsePauses = detected.filter((p) => speakWindows.some(([a, b]) => p.start >= a && p.end <= b)).length;

  // head and smile, frame level, per block
  const blocks = {};
  for (const blk of [1, 2]) {
    let hOk = 0, hN = 0, sOk = 0, sN = 0;
    const perClass = { up: [0, 0], down: [0, 0], side: [0, 0] };
    for (const st of steps.filter((x) => x.block === blk)) {
      const [a, b] = inner(st);
      if (st.truth.head && baseline) {
        for (const x of win(buf.pose, a, b)) {
          const c = classifyHead(x, baseline, o);
          if (c === null) continue;
          hN++; perClass[st.truth.head][1]++;
          if (c === st.truth.head) { hOk++; perClass[st.truth.head][0]++; }
        }
      }
      if (st.truth.smile !== null) {
        for (const x of win(buf.smile, a, b)) {
          if (typeof x.v !== 'number') continue;
          sN++;
          if ((x.v >= o.smileMin) === st.truth.smile) sOk++;
        }
      }
    }
    blocks[blk] = {
      head: ratio(hOk, hN), headFrames: hN,
      headByClass: Object.fromEntries(Object.entries(perClass).map(([k, [ok, n]]) => [k, ratio(ok, n)])),
      smile: ratio(sOk, sN), smileFrames: sN,
    };
  }

  return {
    durationS: rel(endUs),
    speaking: { speech: ratio(speechOk, speechN), silence: ratio(silenceOk, silenceN), frames: speechN + silenceN },
    pauses: { scripted: scripted.length, found, falsePauses, rows: pauseRows },
    breaths: { correct: breathOk, judged: breathN, scriptedBreathe: scripted.filter((s) => s.kind === 'breathe').length },
    blocks,
    baseline: baseline ? { pitch: baseline.pitch, yaw: baseline.yaw, frames: baseline.frames } : null,
  };
}
