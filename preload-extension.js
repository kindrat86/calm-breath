'use strict';
// Calm Breath preload. Chains the SmartSpectra preload bridge (installed by
// the SDK's own preload file in this same isolated world) and adds a tiny
// scoped app bridge:
//   window.calmbreath.getKey()  -> Promise<string|null>  (Presage API key from .env)
//   window.calmbreath.smoke(p)  -> void                  (reports smoke-test result)
//   window.calmbreath.isSmoke() -> bool
//
// sandbox must be false so this preload can require() the SDK preload file;
// contextIsolation stays true, so renderer page code still has no direct
// access to Node, only to window.__smartspectraBridge and window.calmbreath.

require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calmbreath', {
    getKey: () => ipcRenderer.invoke('calm-breath:key'),
    smoke: (payload) => ipcRenderer.send('calm-breath:smoke', payload),
    isSmoke: () => process.argv.includes('calm-breath-smoke'),
});
