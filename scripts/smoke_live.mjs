// Live smoke test of the SmartSpectra Node SDK on the default camera (the owner agreed to a short run).
// Keeps NO images and NO raw landmarks: only per-field sample counts, timing and the last scalar values are written
// to results/smoke_live.json. The API key is read from SMARTSPECTRA_API_KEY and never printed.
// Usage: node scripts/smoke_live.mjs [seconds=25]
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics, MetricType,
} from '@smartspectra/node-sdk';

const SECONDS = Math.min(60, Math.max(5, Number(process.argv[2] || 25)));
const apiKey = process.env.SMARTSPECTRA_API_KEY;
if (!apiKey) { console.error('SMARTSPECTRA_API_KEY missing'); process.exit(2); }

const face = [MetricType.TALKING, MetricType.BLINKING].filter((x) => x !== undefined);
const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...face] });

const t0 = Date.now();
const rel = () => (Date.now() - t0) / 1000;
const log = { requestedFace: face, statuses: [], validations: {}, errors: [], firstMetricAtS: null, events: 0, fields: {}, last: {} };

function note(field, arr, pick) {
  if (!Array.isArray(arr) || !arr.length) return;
  const f = (log.fields[field] ||= { samples: 0, firstAtS: null });
  f.samples += arr.length;
  if (f.firstAtS === null) f.firstAtS = rel();
  log.last[field] = pick(arr[arr.length - 1]);
}

sdk.on('processingStatus', (s) => { log.statuses.push([rel(), String(s)]); });
sdk.on('validationStatus', (code, ts, hint) => {
  const k = String(code); log.validations[k] = (log.validations[k] || 0) + 1;
  if (log.validations[k] === 1) console.log(`validation ${k} at ${rel().toFixed(1)} s ${hint || ''}`);
});
sdk.on('error', (code, message, retryable) => { log.errors.push([rel(), String(code), String(message).slice(0, 200), retryable]); });
sdk.on('metrics', (buf) => {
  log.events++;
  const m = decodeMetrics(buf);
  if (!m || Buffer.isBuffer(m)) return;
  if (log.firstMetricAtS === null) log.firstMetricAtS = rel();
  note('breathing.rate', m.breathing?.rate, (x) => x?.value);
  note('breathing.upperTrace', m.breathing?.upperTrace, (x) => x?.value);
  note('breathing.lowerTrace', m.breathing?.lowerTrace, (x) => x?.value);
  note('cardio.pulseRate', m.cardio?.pulseRate, (x) => ({ v: x?.value, conf: x?.confidence }));
  note('cardio.hrv', m.cardio?.hrv, (x) => ({ rmssd: x?.rmssd, stable: x?.stable }));
  note('face.talking', m.face?.talking, (x) => x?.detected);
  note('face.blinking', m.face?.blinking, (x) => x?.detected);
});

const cams = SmartSpectraSDK.availableCameras();
console.log(`cameras: ${cams.map((c) => c.name).join(', ')}`);
sdk.useCamera(CameraSelection.default);
sdk.start();
console.log(`measuring for ${SECONDS} s...`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
try { await sdk.stopAsync(); } catch (e) { log.errors.push([rel(), 'stop', String(e).slice(0, 200)]); }
try { await sdk.destroy(); } catch (e) { log.errors.push([rel(), 'destroy', String(e).slice(0, 200)]); }
log.durationS = rel();
mkdirSync('results', { recursive: true });
writeFileSync('results/smoke_live.json', JSON.stringify(log, null, 2));
console.log(JSON.stringify({ events: log.events, firstMetricAtS: log.firstMetricAtS, fields: log.fields, last: log.last, errors: log.errors.length, statuses: log.statuses.slice(-4) }, null, 1));
process.exit(0);
