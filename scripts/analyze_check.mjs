// Offline analysis of a saved accuracy check (results/check/check-<mode>.json): scores the SDK's face.talking, the
// lip-movement detector and the app's production speech series (lips OR SDK) with the same evaluation code the app
// uses, on the scripted pause part (cards 1-17) and, when present, the head/smile blocks.
// Usage: node scripts/analyze_check.mjs [results/check/check-live.json]
import fs from 'node:fs';
import { evaluateCheck } from '../src/check.js';
import { poseBaseline } from '../src/face.js';
import { talkingFromLips, speechSeries } from '../src/speech.js';

const file = process.argv[2] || 'results/check/check-live.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const ex = d.check && d.check.export;
if (!ex) { console.error('no export in', file); process.exit(2); }
const T0 = 1_800_000_000_000_000;
const us = (t) => Math.round(T0 + t * 1e6);
const steps = ex.steps.map(([kind, block, a, b], i) => ({ i, kind, block, startUs: us(a), endUs: us(b), truth: truthOf(kind) }));
function truthOf(kind) {
  return {
    speak: { talking: true, breath: null, head: 'up', smile: null }, breathe: { talking: false, breath: true, head: null, smile: null },
    hold: { talking: false, breath: false, head: null, smile: null }, down: { talking: true, breath: null, head: 'down', smile: null },
    side: { talking: true, breath: null, head: 'side', smile: null }, neutral: { talking: false, breath: null, head: 'up', smile: false },
    smile: { talking: false, breath: null, head: 'up', smile: true },
  }[kind];
}
const pose = ex.pose.map(([t, pitch, yaw, mouth, size]) => ({ ts: us(t), pitch, yaw, mouth, size }));
const buf = {
  talking: ex.talking.map(([t, dd]) => ({ ts: us(t), detected: dd === 1 })),
  chest: ex.chest.map(([t, v]) => ({ ts: us(t), v })),
  pose,
  smile: ex.smile.map(([t, v]) => ({ ts: us(t), v })),
};
const baseline = poseBaseline(pose.filter((x) => x.ts < T0 && x.ts >= T0 - 10e6));
const hasMouth = pose.some((x) => typeof x.mouth === 'number');
const lips = hasMouth ? talkingFromLips(pose, { fixed: 0.08 }) : { talking: [], threshold: null };
const variants = { sdk: buf.talking };
if (hasMouth) { variants.lips = lips.talking; variants.app = speechSeries(buf.talking, pose).talking; }

const pct = (x) => (x === null || x === undefined ? '  – ' : `${(x * 100).toFixed(0).padStart(3)}%`);
console.log(`file ${file} | steps ${steps.length} | baseline ${baseline ? `pitch ${baseline.pitch.toFixed(3)} yaw ${baseline.yaw.toFixed(3)} (${baseline.frames} frames)` : 'none'} | lip threshold ${lips.threshold ?? '–'}`);
const sizes = pose.map((x) => x.size).filter((x) => typeof x === 'number').sort((a, b) => a - b);
if (sizes.length) console.log(`face size (eye distance, px): median ${sizes[Math.floor(sizes.length / 2)].toFixed(1)}`);
for (const [name, talking] of Object.entries(variants)) {
  const r = evaluateCheck(steps, { ...buf, talking }, baseline);
  const firstHalf = r.pauses.rows.slice(0, 4), secondHalf = r.pauses.rows.slice(4);
  const okB = (rows) => rows.filter((x) => x.found && x.breath === x.expected).length;
  console.log(`\n[${name}] speech frames ${pct(r.speaking.speech)} | silence frames ${pct(r.speaking.silence)} | pauses found ${r.pauses.found}/${r.pauses.scripted} | false pauses ${r.pauses.falsePauses} | breaths right ${r.breaths.correct}/${r.breaths.judged}`);
  console.log(`   pauses (first 4 / last 4): found ${firstHalf.filter((x) => x.found).length}/4, ${secondHalf.filter((x) => x.found).length}/4 | breath right ${okB(firstHalf)}/4, ${okB(secondHalf)}/4`);
  for (const row of r.pauses.rows) console.log(`   ${row.kind.padEnd(7)} @${row.startS.toFixed(1).padStart(6)} s  found=${row.found ? 'Y' : 'n'} breath=${row.breath} expected=${row.expected}`);
  if (name === 'sdk') {
    for (const blk of [1, 2]) {
      const b = r.blocks[blk];
      console.log(`   block ${blk}: head ${pct(b.head)} (${b.headFrames} frames; up ${pct(b.headByClass.up)} down ${pct(b.headByClass.down)} side ${pct(b.headByClass.side)}) | smile ${pct(b.smile)} (${b.smileFrames})`);
    }
  }
}
console.log(`\ninsight packets during the run: ${ex.diagnostics?.insightPackets ?? '–'} | breathing requested: ${ex.diagnostics?.requested?.breathing ?? '–'}`);
