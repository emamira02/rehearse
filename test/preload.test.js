// Our preload replaces the SDK's own preload to keep the API key out of page JavaScript. These tests load both
// files with a mocked `electron` module and check that (1) our bridge exposes everything the SDK's bridge exposes,
// on the same IPC channel, and (2) only the `configure` message gains the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function load(file, { key = 'TEST-KEY' } = {}) {
  const exposed = {};
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      postMessage: (channel, msg, ports) => sent.push({ channel, msg, ports }),
      sendSync: (channel) => (channel === 'rehearse:sdkKey' ? key : undefined),
      invoke: async (channel, ...args) => ({ channel, args }),
    },
  };
  const src = fs.readFileSync(file, 'utf8');
  const fakeRequire = (m) => { if (m === 'electron') return electron; throw new Error(`unexpected require ${m}`); };
  // eslint-disable-next-line no-new-func
  new Function('require', 'process', 'module', 'exports', src)(fakeRequire, { env: {} }, { exports: {} }, {});
  return { exposed, sent };
}

const sdkPreload = require.resolve('@smartspectra/node-sdk/preload');
const ourPreload = new URL('../electron/preload.cjs', import.meta.url);

test('bridge contract matches the installed SDK preload', () => {
  const sdk = load(sdkPreload).exposed.__smartspectraBridge;
  const ours = load(ourPreload).exposed.__smartspectraBridge;
  assert.ok(sdk && ours);
  for (const k of Object.keys(sdk)) {
    assert.ok(k in ours, `missing ${k}`);
    assert.equal(typeof ours[k], typeof sdk[k], `type of ${k}`);
  }
  const a = load(sdkPreload), b = load(ourPreload);
  a.exposed.__smartspectraBridge.attach();
  b.exposed.__smartspectraBridge.attach();
  assert.equal(b.sent[0].channel, a.sent[0].channel);
  assert.equal(b.sent[0].ports.length, 1);
  for (const x of [a, b]) for (const p of x.sent[0].ports) p.close?.();
});

test('the key is added to configure only, and never exposed to the page', async () => {
  const { exposed, sent } = load(ourPreload);
  const bridge = exposed.__smartspectraBridge;
  assert.throws(() => bridge.postMessage({ kind: 'configure' }), /before attach/);
  bridge.attach();
  bridge.attach();                                        // idempotent
  assert.equal(sent.length, 1);
  const far = sent[0].ports[0];
  const got = [];
  far.on('message', (m) => got.push(m));
  far.start?.();
  bridge.postMessage({ kind: 'configure', options: { apiKey: '', requestedMetrics: [0, 13] } });
  bridge.postMessage({ kind: 'start', replyId: 1, frameTransform: 0 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got[0].options.apiKey, 'TEST-KEY');
  assert.deepEqual(got[0].options.requestedMetrics, [0, 13]);
  assert.equal(got[1].options, undefined);
  assert.ok(!JSON.stringify(Object.keys(exposed.rehearse)).toLowerCase().includes('key'));
  bridge.close();
  far.close();
});
