// Head orientation and smile from SmartSpectra face outputs. Pure functions.
//
// Landmarks are 2D points from the SDK's MediaPipe face-landmark model (468 points, 478 with attention; the first
// 468 share the canonical MediaPipe indices). Raw landmarks are reduced to two numbers per frame the moment they
// arrive and are never kept:
//   pitch: where the nose tip sits between the eye line and the chin (0 = on the eye line, 1 = at the chin).
//          It grows when the head tilts down (the nose tip drops towards the chin in the picture).
//   yaw:   horizontal offset of the nose tip from the middle of the eyes, in eye-distance units. Its magnitude
//          grows when the head turns sideways.
//   mouth: inner-lip opening in eye-distance units (speech makes it move quickly).
//   size:  eye distance in the SDK's landmark units (how large the face is in the picture).
// Both are measured in a frame aligned with the eye line, so they do not change with image scale, distance to the
// camera or head roll. Each person's own "facing the screen" values come from the calibration phase.

export const LM = Object.freeze({ NOSE_TIP: 1, CHIN: 152, EYE_OUTER_L: 33, EYE_OUTER_R: 263, LIP_UPPER_IN: 13, LIP_LOWER_IN: 14, MIN_POINTS: 468 });

// Thresholds fixed before the first live validation run (2026-11-12); see HANDOFF for how they were evaluated.
export const FACE_DEFAULTS = Object.freeze({
  pitchDown: 0.10,      // pitch above baseline by this much → head down
  yawSide: 0.25,        // |yaw - baseline| above this → turned away
  smileMin: 50,         // HAPPY confidence (0-100) at or above this → smiling
  baselineMinFrames: 30,
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pt = (p) => (p && isNum(p.x) && isNum(p.y) ? p : null);

export function poseFeatures(points) {
  if (!Array.isArray(points) || points.length < LM.MIN_POINTS) return null;
  const n = pt(points[LM.NOSE_TIP]), c = pt(points[LM.CHIN]);
  const l = pt(points[LM.EYE_OUTER_L]), r = pt(points[LM.EYE_OUTER_R]);
  if (!n || !c || !l || !r) return null;
  const ex = r.x - l.x, ey = r.y - l.y;
  const eyeDist = Math.hypot(ex, ey);
  if (!(eyeDist > 1e-6)) return null;
  const ux = ex / eyeDist, uy = ey / eyeDist;            // along the eye line
  const vx = -uy, vy = ux;                                // perpendicular, pointing down the face
  const mx = (l.x + r.x) / 2, my = (l.y + r.y) / 2;
  const along = (p) => (p.x - mx) * ux + (p.y - my) * uy;
  const down = (p) => (p.x - mx) * vx + (p.y - my) * vy;
  const chinDown = down(c);
  if (!(Math.abs(chinDown) > 1e-6)) return null;
  // the perpendicular may point up if the face is upside down in the picture; normalise by the chin's side
  const pitch = down(n) / chinDown;
  const yaw = along(n) / eyeDist;
  if (!isNum(pitch) || !isNum(yaw)) return null;
  const lu = pt(points[LM.LIP_UPPER_IN]), ll = pt(points[LM.LIP_LOWER_IN]);
  const mouth = lu && ll ? Math.hypot(ll.x - lu.x, ll.y - lu.y) / eyeDist : null;
  return { pitch, yaw, mouth, size: eyeDist };
}

function median(vals) {
  const v = vals.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = (v.length - 1) / 2;
  return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
}

// pose samples [{pitch, yaw}] recorded while the person faces the screen (calibration) → personal baseline
export function poseBaseline(samples, opts = {}) {
  const o = { ...FACE_DEFAULTS, ...opts };
  const ok = (samples || []).filter((s) => s && isNum(s.pitch) && isNum(s.yaw));
  if (ok.length < o.baselineMinFrames) return null;
  return { pitch: median(ok.map((s) => s.pitch)), yaw: median(ok.map((s) => s.yaw)), frames: ok.length };
}

// 'up' (facing the screen/audience), 'down' (looking down, e.g. at notes), 'side' (turned away) or null
export function classifyHead(sample, baseline, opts = {}) {
  const o = { ...FACE_DEFAULTS, ...opts };
  if (!sample || !baseline || !isNum(sample.pitch) || !isNum(sample.yaw)) return null;
  if (sample.pitch - baseline.pitch > o.pitchDown) return 'down';
  if (Math.abs(sample.yaw - baseline.yaw) > o.yawSide) return 'side';
  return 'up';
}

// HAPPY confidence (0-100) from one SDK Expression entry; null when absent
export function happyScore(expression, happyType = 5) {
  const scores = expression && Array.isArray(expression.scores) ? expression.scores : null;
  if (!scores) return null;
  for (const s of scores) if (s && s.type === happyType && isNum(s.confidence)) return s.confidence;
  return null;
}
