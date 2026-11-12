// Rehearse preload (sandboxed, isolated world).
//
// 1. `window.__smartspectraBridge`: same contract as `@smartspectra/node-sdk/preload` (attach / postMessage /
//    onMessage / close / diagnostics, one MessagePort to the main process on the 'smartspectra:attach' channel),
//    with one difference: the SDK's `configure` message gets the API key here, from the main process, so the key
//    never exists in page JavaScript. test/preload.test.js checks the contract against the installed SDK preload.
// 2. `window.rehearse`: the app's small, explicit main-process API (settings, local rehearsals, deletion).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ATTACH_CHANNEL = 'smartspectra:attach';
let port = null;
let messageListener = null;

function withKey(message) {
  if (!message || message.kind !== 'configure') return message;
  const apiKey = ipcRenderer.sendSync('rehearse:sdkKey');
  const options = { ...(message.options || {}), apiKey: typeof apiKey === 'string' ? apiKey : '' };
  return { ...message, options };
}

contextBridge.exposeInMainWorld('__smartspectraBridge', {
  diagnostics: false,
  attach() {
    if (port) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event) => { if (messageListener) messageListener(event.data); };
    ipcRenderer.postMessage(ATTACH_CHANNEL, null, [channel.port2]);
    port.start();
  },
  postMessage(message) {
    if (!port) throw new Error('rehearse preload: postMessage before attach()');
    port.postMessage(withKey(message));
  },
  onMessage(callback) {
    messageListener = typeof callback === 'function' ? callback : null;
  },
  close() {
    if (port) { try { port.close(); } catch { /* already closed */ } port = null; }
    messageListener = null;
  },
});

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('rehearse', {
  config: invoke('rehearse:config'),
  giveConsent: invoke('rehearse:consent'),
  updateSettings: invoke('rehearse:settings'),
  list: invoke('rehearse:list'),
  get: invoke('rehearse:get'),
  save: invoke('rehearse:save'),
  remove: invoke('rehearse:remove'),
  removeAll: invoke('rehearse:removeAll'),
  openDataFolder: invoke('rehearse:openDataFolder'),
  blockedRequests: invoke('rehearse:blockedRequests'),
  relaunch: invoke('rehearse:relaunch'),
});
