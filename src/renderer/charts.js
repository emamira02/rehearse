// SVG charts: the rehearsal timeline, small live sparklines and history trends. Colours come from CSS classes so
// light and dark themes both work.
import { s } from './dom.js';
import { fmtClock, fmtSeconds } from '../notes.js';

const W = 1000;

function quant(vals, q) {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function tickStep(dur) {
  for (const st of [10, 15, 30, 60, 120, 300, 600]) if (dur / st <= 10) return st;
  return 900;
}

function pathOf(points) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

// rec: { durationS, timeline, summary }
export function timelineChart(rec, { pulseMinConf = 50 } = {}) {
  const tl = rec.timeline || {};
  const dur = Math.max(rec.durationS || 0, 1);
  const PAD_L = 116, PAD_R = 16;
  const x = (t) => PAD_L + (Math.min(Math.max(t, 0), dur) / dur) * (W - PAD_L - PAD_R);
  const pulse = (tl.pulse || []).filter((p) => p[2] === null || p[2] >= pulseMinConf);
  const lanes = [
    { key: 'speech', label: 'Speaking', h: 46 },
    { key: 'chest', label: 'Chest movement', h: 64 },
    ...(pulse.length >= 2 ? [{ key: 'pulse', label: 'Pulse reading', h: 56 }] : []),
    { key: 'blinks', label: 'Blinks', h: 18 },
  ];
  const GAP = 14, TOP = 30;
  let y = TOP;
  for (const l of lanes) { l.y = y; y += l.h + GAP; }
  const H = y + 4;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'timeline', role: 'img', 'aria-label': 'Rehearsal timeline' });

  // time axis
  const step = tickStep(dur);
  for (let t = 0; t <= dur + 1e-6; t += step) {
    svg.append(
      s('line', { x1: x(t), x2: x(t), y1: TOP - 6, y2: H - 4, class: 'grid' }),
      s('text', { x: x(t), y: TOP - 12, class: 'tick', 'text-anchor': 'middle' }, fmtClock(t)),
    );
  }
  for (const l of lanes) {
    svg.append(s('text', { x: 0, y: l.y + l.h / 2 + 4, class: 'lane-label' }, l.label));
  }

  // speech lane: speaking blocks, pauses with breath markers, longest stretch bracket
  const sp = lanes[0];
  for (const [a, b, talking] of tl.segments || []) {
    if (!talking) continue;
    svg.append(s('rect', { x: x(a), y: sp.y + 14, width: Math.max(0.8, x(b) - x(a)), height: sp.h - 20, rx: 2, class: 'speak' }));
  }
  for (const [a, b, breath] of tl.pauses || []) {
    const cx = (x(a) + x(b)) / 2;
    const cls = breath === 1 ? 'breath yes' : breath === 0 ? 'breath no' : 'breath unknown';
    const label = `Pause of ${fmtSeconds(b - a)} at ${fmtClock(a)}: ${breath === 1 ? 'breath taken' : breath === 0 ? 'no breath detected' : 'breathing not measured'}`;
    svg.append(s('g', { class: 'pause-mark' },
      s('title', {}, label),
      s('rect', { x: x(a), y: sp.y + 14, width: Math.max(1.5, x(b) - x(a)), height: sp.h - 20, class: 'pause' }),
      s('circle', { cx, cy: sp.y + 6, r: 4.5, class: cls }),
    ));
  }
  const S = rec.summary || {};
  if (Number.isFinite(S.longestRunS) && S.longestRunS >= 20) {
    const a = x(S.longestRunStartS), b = x(S.longestRunStartS + S.longestRunS);
    const yb = sp.y + sp.h - 2;
    svg.append(s('g', { class: 'longest' },
      s('path', { d: `M${a},${yb - 4}L${a},${yb}L${b},${yb}L${b},${yb - 4}` }),
      s('text', { x: (a + b) / 2, y: yb + 11, 'text-anchor': 'middle' }, `longest stretch ${fmtSeconds(S.longestRunS)}`),
    ));
  }

  // chest lane
  const ch = lanes.find((l) => l.key === 'chest');
  const chest = tl.chest || [];
  if (chest.length > 2) {
    const lo = quant(chest.map((p) => p[1]), 0.02), hi = quant(chest.map((p) => p[1]), 0.98);
    const span = hi - lo || 1;
    const yv = (v) => ch.y + ch.h - 4 - ((Math.min(Math.max(v, lo), hi) - lo) / span) * (ch.h - 8);
    svg.append(s('path', { d: pathOf(chest.map(([t, v]) => [x(t), yv(v)])), class: 'trace chest' }));
  } else {
    svg.append(s('text', { x: x(0) + 6, y: ch.y + ch.h / 2 + 4, class: 'empty' }, 'no chest signal'));
  }

  // pulse lane (information only)
  const pl = lanes.find((l) => l.key === 'pulse');
  if (pl) {
    const vals = pulse.map((p) => p[1]);
    const lo = Math.floor(Math.min(...vals) - 2), hi = Math.ceil(Math.max(...vals) + 2);
    const yv = (v) => pl.y + pl.h - 4 - ((v - lo) / (hi - lo)) * (pl.h - 8);
    svg.append(
      s('path', { d: pathOf(pulse.map(([t, v]) => [x(t), yv(v)])), class: 'trace pulse' }),
      s('text', { x: W - PAD_R, y: pl.y + 8, class: 'axis-note', 'text-anchor': 'end' }, `${hi} bpm`),
      s('text', { x: W - PAD_R, y: pl.y + pl.h - 2, class: 'axis-note', 'text-anchor': 'end' }, `${lo}`),
    );
  }

  // blinks lane
  const bl = lanes.find((l) => l.key === 'blinks');
  for (const t of tl.blinks || []) {
    svg.append(s('line', { x1: x(t), x2: x(t), y1: bl.y + 2, y2: bl.y + bl.h - 2, class: 'blink' }));
  }
  return svg;
}

// Live sparkline of the last `windowS` seconds of a series [{ts, v}] (epoch µs).
export function sparkline(series, { windowS = 20, width = 240, height = 44, cls = 'chest' } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: `spark ${cls}`, preserveAspectRatio: 'none' });
  if (!series || series.length < 3) return svg;
  const end = series[series.length - 1].ts;
  const from = end - windowS * 1e6;
  let i = series.length - 1;
  while (i > 0 && series[i - 1].ts >= from) i--;
  const pts = series.slice(i);
  const vals = pts.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  svg.append(s('path', {
    d: pathOf(pts.map((p) => [((p.ts - from) / (windowS * 1e6)) * width, height - 3 - ((p.v - lo) / span) * (height - 6)])),
    class: 'trace',
  }));
  return svg;
}

// History trend: one small line chart; points [{label, v}] oldest first.
export function trendChart(points, { width = 300, height = 90, format = (v) => String(v) } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'trend', role: 'img' });
  const pts = points.filter((p) => Number.isFinite(p.v));
  if (pts.length === 0) {
    svg.append(s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'empty' }, 'no data yet'));
    return svg;
  }
  const vals = pts.map((p) => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const PX = 14, PY = 16;
  const xs = (i) => (pts.length === 1 ? width / 2 : PX + (i / (pts.length - 1)) * (width - 2 * PX));
  const ys = (v) => height - PY - ((v - lo) / (hi - lo)) * (height - 2 * PY);
  svg.append(s('path', { d: pathOf(pts.map((p, i) => [xs(i), ys(p.v)])), class: 'trace' }));
  pts.forEach((p, i) => svg.append(s('g', {},
    s('title', {}, `${p.label}: ${format(p.v)}`),
    s('circle', { cx: xs(i), cy: ys(p.v), r: i === pts.length - 1 ? 4.5 : 3, class: i === pts.length - 1 ? 'dot last' : 'dot' }),
  )));
  const last = pts[pts.length - 1];
  svg.append(s('text', { x: Math.min(width - 4, xs(pts.length - 1)), y: Math.max(11, ys(last.v) - 8), 'text-anchor': 'end', class: 'trend-label' }, format(last.v)));
  return svg;
}
