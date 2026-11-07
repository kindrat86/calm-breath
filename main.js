'use strict';
// Calm Breath — main process.
// Scaffolded from the SmartSpectra electron-quickstart sample
// (github.com/Presage-Security/SmartSpectra, nodejs/samples/electron-quickstart),
// modified for Calm Breath: loads .env for the API key (never committed),
// exposes it to the renderer only through a scoped IPC bridge, and supports
// a --smoke headless self-test used by CI/local verification.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, ipcMain } = require('electron');

// Packaged builds: point the binding's resolver at the unpacked native
// runtime in resources/ (same layout as the quickstart).
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
    const LIB = {
        darwin: 'libsmartspectra_capi.dylib',
        win32: 'smartspectra_capi.dll',
        linux: 'libsmartspectra_capi.so',
    }[process.platform];
    if (LIB) {
        process.env.SMARTSPECTRA_CAPI_PATH =
            path.join(process.resourcesPath, 'smartspectra', LIB);
    }
}

const SMOKE = process.argv.includes('--smoke');
const SMOKE_TIMEOUT_MS = 45000;

// Minimal .env reader (KEY=VALUE lines, # comments). No extra dependencies.
function readEnv(file) {
    const out = {};
    try {
        const text = fs.readFileSync(file, 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
            if (m && !/^\s*#/.test(line)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch (e) { /* no .env: demo mode */ }
    return out;
}

const env = readEnv(path.join(__dirname, '.env'));
// Never log the key itself, only whether one is present.
const hasKey = !!(process.env.SMARTSPECTRA_API_KEY || env.SMARTSPECTRA_API_KEY);

const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

function createWindow() {
    const win = new BrowserWindow({
        width: 980,
        height: 720,
        backgroundColor: '#0e1116',
        webPreferences: {
            preload: path.join(__dirname, 'preload-extension.js'),
            contextIsolation: true,
            sandbox: false, // required so the preload can chain the SDK preload; isolation stays on
            nodeIntegration: false,
            additionalArguments: SMOKE ? ['calm-breath-smoke'] : [],
        },
    });

    bindSmartSpectraIpc(win);

    // Only the bundled local page; deny popups and navigation (quickstart pattern).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    // Scoped app bridge: renderer may ask for the API key and report smoke results.
    ipcMain.handle('calm-breath:key', () => process.env.SMARTSPECTRA_API_KEY || env.SMARTSPECTRA_API_KEY || null);
    ipcMain.on('calm-breath:smoke', (_e, payload) => {
        console.log(`[smoke] ${JSON.stringify(payload)}`);
        if (payload && payload.status === 'ok') {
            app.exit(0);
        } else {
            app.exit(1);
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'));

    if (SMOKE) {
        // Hard timeout: a hung smoke run fails rather than blocking CI.
        setTimeout(() => {
            console.error('[smoke] timeout — exiting 2');
            app.exit(2);
        }, SMOKE_TIMEOUT_MS);
    }
    return win;
}

app.whenReady().then(() => {
    // Camera-only permission for the bundled page only (quickstart pattern,
    // mic requests explicitly denied).
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
    });

    createWindow();
    console.log(`[calm-breath] mode=${SMOKE ? 'smoke' : 'normal'} api-key=${hasKey ? 'present (live mode available)' : 'absent (demo mode)'}`);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
