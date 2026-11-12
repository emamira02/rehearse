// Local data store for Rehearse. Runs in the Electron main process only (plain Node, testable without Electron).
//
// Layout under <root> (Electron: app.getPath('userData')):
//   settings.json            consent record + preferences
//   rehearsals/<id>.json     one file per rehearsal (derived signals and summary only: no images, no video,
//                            no audio, no face landmarks)
// Writes are atomic (temp file + rename), ids are generated here and validated on every access so a renderer
// can never address a path outside rehearsals/.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 1;
const CONSENT_VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_TITLE = 120;
const ID_RE = /^\d{8}-\d{6}-[a-f0-9]{6}$/;
const DEFAULT_SETTINGS = Object.freeze({ consentVersion: 0, consentedAt: null, pulseEnabled: false, nudges: true, lastCheck: null });
const MAX_CHECK_BYTES = 8 * 1024;

// numbers, booleans, short strings, null, nested plain objects/arrays only (an accuracy-check summary, no samples)
function plainData(x, depth = 0) {
  if (depth > 5) throw new RangeError('lastCheck too deep');
  if (x === null || typeof x === 'boolean') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') return x.slice(0, 80);
  if (Array.isArray(x)) return x.slice(0, 64).map((v) => plainData(v, depth + 1));
  if (typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x).slice(0, 64)) out[String(k).slice(0, 40)] = plainData(v, depth + 1);
    return out;
  }
  return null;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const finiteOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function cleanTitle(t) {
  const s = typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return (s || 'Untitled rehearsal').slice(0, MAX_TITLE);
}

// Shape check of what the renderer may persist. Unknown top-level keys are dropped, so nothing unexpected (e.g. a
// camera frame by mistake) can be written to disk through this API.
function sanitizeRecord(rec) {
  if (!isObj(rec)) throw new TypeError('record must be an object');
  if (!isObj(rec.summary)) throw new TypeError('record.summary missing');
  if (!isObj(rec.timeline)) throw new TypeError('record.timeline missing');
  const mode = rec.mode === 'live' ? 'live' : 'simulated';
  const out = {
    schema: SCHEMA,
    title: cleanTitle(rec.title),
    mode,
    pulseEnabled: rec.pulseEnabled === true,
    targetS: finiteOrNull(rec.targetS),
    durationS: finiteOrNull(rec.durationS) ?? 0,
    summary: rec.summary,
    timeline: rec.timeline,
    appVersion: typeof rec.appVersion === 'string' ? rec.appVersion.slice(0, 32) : null,
    sdkVersion: typeof rec.sdkVersion === 'string' ? rec.sdkVersion.slice(0, 32) : null,
    note: typeof rec.note === 'string' ? rec.note.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : null,
  };
  return out;
}

function lightSummary(rec) {
  return {
    id: rec.id, createdAt: rec.createdAt, title: rec.title, mode: rec.mode, durationS: rec.durationS,
    targetS: rec.targetS ?? null, pulseEnabled: rec.pulseEnabled, summary: rec.summary,
  };
}

function createStore(root) {
  if (typeof root !== 'string' || !root) throw new TypeError('store root required');
  const dir = path.join(root, 'rehearsals');
  const settingsFile = path.join(root, 'settings.json');
  const fileOf = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new RangeError('invalid rehearsal id');
    return path.join(dir, `${id}.json`);
  };

  function getSettings() {
    const s = readJson(settingsFile);
    return { ...DEFAULT_SETTINGS, ...(isObj(s) ? s : {}) };
  }

  function hasConsent() {
    return getSettings().consentVersion === CONSENT_VERSION;
  }

  function updateSettings(patch) {
    if (!isObj(patch)) throw new TypeError('settings patch must be an object');
    const cur = getSettings();
    const next = { ...cur };
    if ('pulseEnabled' in patch) next.pulseEnabled = patch.pulseEnabled === true;
    if ('nudges' in patch) next.nudges = patch.nudges !== false;
    if ('lastCheck' in patch) {
      const c = patch.lastCheck === null ? null : plainData(patch.lastCheck);
      if (c !== null && Buffer.byteLength(JSON.stringify(c), 'utf8') > MAX_CHECK_BYTES) throw new RangeError('lastCheck too large');
      next.lastCheck = c;
    }
    fs.mkdirSync(root, { recursive: true });
    atomicWrite(settingsFile, JSON.stringify(next, null, 2));
    return next;
  }

  function giveConsent(prefs = {}) {
    fs.mkdirSync(root, { recursive: true });
    const next = { ...getSettings(), consentVersion: CONSENT_VERSION, consentedAt: new Date().toISOString() };
    if (isObj(prefs) && 'pulseEnabled' in prefs) next.pulseEnabled = prefs.pulseEnabled === true;
    atomicWrite(settingsFile, JSON.stringify(next, null, 2));
    return next;
  }

  function save(rec) {
    const clean = sanitizeRecord(rec);
    const id = newId();
    const full = { id, createdAt: new Date().toISOString(), ...clean };
    const text = JSON.stringify(full);
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new RangeError('record too large');
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(fileOf(id), text);
    return lightSummary(full);
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return { items: [], unreadable: 0 }; }
    const items = [];
    let unreadable = 0;
    for (const n of names) {
      if (!n.endsWith('.json') || !ID_RE.test(n.slice(0, -5))) continue;
      const rec = readJson(path.join(dir, n));
      if (!isObj(rec) || rec.schema !== SCHEMA || !isObj(rec.summary)) { unreadable++; continue; }
      items.push(lightSummary(rec));
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { items, unreadable };
  }

  function get(id) {
    const rec = readJson(fileOf(id));
    return isObj(rec) && rec.schema === SCHEMA ? rec : null;
  }

  function remove(id) {
    const f = fileOf(id);
    const existed = fs.existsSync(f);
    fs.rmSync(f, { force: true });
    return existed;
  }

  // Deletes every rehearsal (including unreadable leftovers and temp files) and the consent record.
  function removeAll() {
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (n.endsWith('.json') && ID_RE.test(n.slice(0, -5))) removed++;
      fs.rmSync(path.join(dir, n), { force: true, recursive: true });
    }
    fs.rmSync(dir, { force: true, recursive: true });
    fs.rmSync(settingsFile, { force: true });
    return { removed };
  }

  return { dir, root, getSettings, hasConsent, updateSettings, giveConsent, save, list, get, remove, removeAll };
}

module.exports = { createStore, CONSENT_VERSION, SCHEMA, MAX_RECORD_BYTES, ID_RE, sanitizeRecord, cleanTitle };
