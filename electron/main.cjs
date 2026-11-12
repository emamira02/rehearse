// Rehearse — Electron main process.
//
// Responsibilities: one locked-down window; the SmartSpectra IPC binding (live mode only); the local data store;
// the API key (read from SMARTSPECTRA_API_KEY, removed from the environment, handed only to our preload when the
// SDK is configured — it never reaches page JavaScript, logs or disk).
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const { createStore } = require('./store.cjs');

const SIMULATE = process.argv.includes('--simulate') || process.env.REHEARSE_SIMULATE === '1';
const DIAGNOSTICS = process.env.REHEARSE_DIAGNOSTICS === '1';   // exposes a read-only diagnostics hook to the page
const DEVTOOLS = process.env.REHEARSE_DEVTOOLS === '1';
// breathing metrics requested from the SDK: 'chest' (chest trace only) or 'bundle' (chest, abdomen, rate)
const BREATHING = process.env.REHEARSE_BREATHING === 'bundle' ? 'bundle' : 'chest';

// Read the key once, then drop it from the environment so no child process (renderer, GPU, utility) inherits it.
const API_KEY = (() => {
  const k = typeof process.env.SMARTSPECTRA_API_KEY === 'string' ? process.env.SMARTSPECTRA_API_KEY.trim() : '';
  delete process.env.SMARTSPECTRA_API_KEY;
  return k.length > 0 && k.length <= 1024 ? k : '';
})();
const MODE = SIMULATE ? 'simulated' : API_KEY ? 'live' : 'live-unavailable';

// Packaged builds load the native runtime from resources/smartspectra (see SDK README); dev runs resolve the
// per-platform npm package.
if (app.isPackaged) {
  const LIB = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
  if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

const SDK_VERSION = (() => { try { return require('@smartspectra/node-sdk/package.json').version; } catch { return null; } })();
const PAGE = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PAGE_URL = require('node:url').pathToFileURL(PAGE).href;
// file URLs may differ in percent-encoding or drive-letter case between Node and Chromium
const normUrl = (u) => { try { const s = decodeURI(String(u).split('#')[0]); return process.platform === 'win32' ? s.toLowerCase() : s; } catch { return ''; } };
const PAGE_NORM = normUrl(PAGE_URL);
const isOurPage = (u) => normUrl(u) === PAGE_NORM;

let win = null;
let store = null;
let blockedRequests = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

// Only our own bundled page may talk to the main process.
function trusted(event) {
  const frame = event.senderFrame;
  return !!win && event.sender === win.webContents && !!frame && isOurPage(frame.url);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

function config() {
  return {
    mode: MODE,
    keyPresent: !!API_KEY,
    dataDir: store.root,
    sdkCacheDir: path.join(app.getPath('cache'), app.getName(), 'SmartSpectraSDK'),
    appVersion: app.getVersion(),
    sdkVersion: SDK_VERSION,
    platform: process.platform,
    hasConsent: store.hasConsent(),
    settings: store.getSettings(),
    diagnostics: DIAGNOSTICS,
    breathing: BREATHING,
  };
}

function registerIpc() {
  handle('rehearse:config', () => config());
  handle('rehearse:consent', (prefs) => { store.giveConsent(prefs); return config(); });
  handle('rehearse:settings', (patch) => { store.updateSettings(patch); return config(); });
  handle('rehearse:list', () => store.list());
  handle('rehearse:get', (id) => store.get(id));
  handle('rehearse:save', (rec) => store.save(rec));
  handle('rehearse:remove', (id) => store.remove(id));
  handle('rehearse:removeAll', async () => {
    const res = store.removeAll();
    // Also wipe anything Chromium may have kept for the page (we use no web storage, this is belt and braces).
    try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch {}
    return res;
  });
  handle('rehearse:openDataFolder', async () => {
    fs.mkdirSync(store.root, { recursive: true });
    const err = await shell.openPath(store.root);
    return err === '';
  });
  handle('rehearse:blockedRequests', () => blockedRequests);
  handle('rehearse:relaunch', (mode) => {
    const args = process.argv.slice(1).filter((a) => a !== '--simulate');
    if (mode === 'simulated') args.push('--simulate');
    // the key was removed from our environment at startup; the relaunched process needs it back to go live
    if (mode === 'live' && API_KEY) process.env.SMARTSPECTRA_API_KEY = API_KEY;
    app.relaunch({ args });
    app.exit(0);
  });
  // Synchronous on purpose: the SDK renderer sends `configure` from its constructor, and our preload adds the key
  // to that one message. Answered only for our page, only in live mode.
  ipcMain.on('rehearse:sdkKey', (event) => { event.returnValue = trusted(event) && MODE === 'live' ? API_KEY : ''; });
}

function lockDownSession() {
  const ses = session.defaultSession;
  // The window never needs the network: SmartSpectra's own traffic (key check, usage) is made by the native
  // runtime in this process, not by the page. Cancel and count every web request the page might attempt.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => {
    blockedRequests++;
    cb({ cancel: true });
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const media = (details && details.mediaTypes) || [];
    const cameraOnly = media.length === 1 && media[0] === 'video';   // never the microphone
    callback(MODE === 'live' && permission === 'media' && cameraOnly && isOurPage(url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => MODE === 'live' && permission === 'media' && String(origin).startsWith('file://'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: 'Rehearse',
    backgroundColor: '#f6f4ef',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // keep measuring while the speaker looks at slides in another window
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  if (MODE === 'live') {
    const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');
    bindSmartSpectraIpc(win, {
      logger: (level, msg) => { if (DIAGNOSTICS || level === 'error') console[level === 'info' ? 'log' : level](`[smartspectra] ${msg}`); },
    });
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(PAGE);
  if (DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = createStore(path.join(app.getPath('userData'), 'rehearse-data'));
  registerIpc();
  lockDownSession();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
