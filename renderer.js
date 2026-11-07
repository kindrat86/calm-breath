'use strict';
// Calm Breath — renderer controller.
// Bundled by esbuild into dist/renderer.bundle.js. No framework, no network.
//
// Session flow: consent -> baseline (45s) -> pacer (90s, adaptive) ->
// after (45s) -> summary. All logic lives in src/*.pure modules (unit-
// tested); this file only wires them to the DOM and the metrics source.
//
// Sources: live (SmartSpectra SDK, camera) or demo (synthetic series,
// clearly labelled, no camera).

const pacerLib = require('./src/pacer.js');
const scoring = require('./src/scoring.js');
const sessionLib = require('./src/session.js');
const sim = require('./src/sim.js');
const metricsLib = require('./src/metrics.js');

const $ = (id) => document.getElementById(id);
const els = {
    banner: $('mode-banner'),
    screens: {
        consent: $('screen-consent'),
        decline: $('screen-decline'),
        session: $('screen-session'),
        summary: $('screen-summary'),
    },
    telemetryConsent: $('telemetry-consent'),
    btnStart: $('btn-start'), btnDecline: $('btn-decline'), btnBack: $('btn-back'),
    btnStop: $('btn-stop'), btnAgain: $('btn-again'), btnDone: $('btn-done'),
    phaseLabel: $('phase-label'), countdown: $('countdown'),
    readoutRate: $('readout-rate'), readoutTarget: $('readout-target'), readoutHrv: $('readout-hrv'),
    hint: $('hint'),
    cameraText: $('camera-text'), cameraDot: $('camera-dot'),
    scoreNum: $('score-num'), scoreNote: $('score-note'),
    beforeRate: $('before-rate'), afterRate: $('after-rate'),
    beforeHrv: $('before-hrv'), afterHrv: $('after-hrv'),
};

const app = {
    session: sessionLib.createSession(),
    pacer: null,
    tracker: metricsLib.createMetricsTracker(),
    baselineWindow: null,
    afterWindow: null,
    source: null,          // live or demo
    sourceKind: 'none',
    clock0: null,          // performance.now() at session start
    tickTimer: null,
    pacerAnim: null,
    smokeSteps: [],
};

function nowS() {
    return app.clock0 == null ? 0 : (performance.now() - app.clock0) / 1000;
}

function showScreen(name) {
    for (const [k, el] of Object.entries(els.screens)) {
        el.classList.toggle('hidden', k !== name);
    }
}

function setHint(text) { els.hint.textContent = text; }
function fmt1(x) { return x == null || !Number.isFinite(x) ? '—' : x.toFixed(1); }

// ---------- demo source (synthetic, labelled) ----------
// Mirrors the live source interface so the controller is source-agnostic.
function createDemoSource() {
    let cb = null;
    const startBpm = 15, endBpm = 7.5;
    return {
        get label() { return 'demo'; },
        async init() {},
        onSample(c) { cb = c; },
        async start() {
            this._iv = setInterval(() => {
                if (!cb) return;
                const t = nowS();
                const s = sim.synthSample(t, startBpm, endBpm, 180, 7);
                cb(s);
            }, 1000);
        },
        async stop() { if (this._iv) clearInterval(this._iv); },
        async destroy() { if (this._iv) clearInterval(this._iv); },
    };
}

// ---------- controller ----------

async function beginSession() {
    const telemetryOk = els.telemetryConsent.checked;
    app.session = sessionLib.createSession();
    app.tracker = metricsLib.createMetricsTracker();

    // Choose source: live only when a key is available; demo otherwise.
    let key = null;
    try { key = await window.calmbreath.getKey(); } catch (e) { key = null; }
    if (key) {
        const { createLiveSource } = require('./src/liveSource.js');
        app.source = createLiveSource(key, {
            allowTelemetry: telemetryOk,
            onValidation: (_code, hint) => setHint(hint || 'Signal weak — keep your face in view and steady.'),
            onError: (_code, message) => setHint(`Measurement issue: ${message}. You can continue with the pacer.`),
        });
        app.sourceKind = 'live';
        els.banner.classList.add('hidden');
    } else {
        app.source = createDemoSource();
        app.sourceKind = 'demo';
        els.banner.classList.remove('hidden');
    }

    await app.source.init();
    app.source.onSample((s) => {
        metricsLib.ingestSample(app.tracker, s);
    });

    app.clock0 = performance.now();
    sessionLib.start(app.session, 0, true);
    showScreen('session');
    els.cameraText.textContent = app.sourceKind === 'live' ? 'camera on' : 'demo data';
    els.cameraDot.classList.remove('off');

    await app.source.start();
    app.tickTimer = setInterval(tick, 250);
    startPacerAnimation();
    updateReadouts();
}

function tick() {
    const t = nowS();
    const prev = app.session.state;
    sessionLib.tick(app.session, t);
    const state = app.session.state;

    if (state === 'pacer' && prev === 'baseline') {
        // Freeze baseline window; seed pacer at the measured rate.
        app.baselineWindow = metricsLib.snapshot(app.tracker);
        const measured = app.tracker.smoothRate != null ? app.tracker.smoothRate
            : scoring.windowRate(app.baselineWindow);
        app.pacer = pacerLib.createPacer(measured != null ? measured : 14);
        setHint('Breathe with the circle: in as it grows, out as it shrinks.');
    }
    if (state === 'pacer') {
        pacerLib.updatePacer(app.pacer, t, app.tracker.smoothRate);
    }
    if (state === 'after' && prev === 'pacer') {
        metricsLib.reset(app.tracker); // fresh window for the re-measure
        setHint('Keep breathing slowly. Measuring again...');
    }
    if (state === 'summary' && prev === 'after') {
        finishSession();
        return;
    }

    updateReadouts();
}

function updateReadouts() {
    const state = app.session.state;
    const rem = sessionLib.phaseRemaining(app.session, nowS());
    els.phaseLabel.textContent = {
        baseline: 'Baseline — breathe normally',
        pacer: 'Follow the circle',
        after: 'Re-measure — keep going',
    }[state] || state;
    els.countdown.textContent = rem == null ? '' : Math.ceil(rem);
    els.readoutRate.textContent = fmt1(app.tracker.smoothRate);
    const target = state === 'pacer' && app.pacer ? app.pacer.targetBpm : null;
    els.readoutTarget.textContent = fmt1(target);
    const lastHrv = app.tracker.hrv.length ? app.tracker.hrv[app.tracker.hrv.length - 1].rmssd : null;
    els.readoutHrv.textContent = fmt1(lastHrv);
}

function startPacerAnimation() {
    const canvas = $('pacer');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
    const baseR = Math.min(W, H) * 0.36;

    function draw() {
        ctx.clearRect(0, 0, W, H);
        const t = nowS();
        const state = app.session.state;
        const showPacer = state === 'pacer' && app.pacer;
        const bpm = showPacer ? app.pacer.targetBpm : (app.tracker.smoothRate || 12);
        const phase = pacerLib.breathPhase(t, bpm);
        const scale = pacerLib.phaseScale(phase);
        const r = baseR * scale;

        // guide ring
        ctx.beginPath();
        ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
        ctx.strokeStyle = '#262c38';
        ctx.lineWidth = 2;
        ctx.stroke();

        // breathing disc — hue warms as the session pace slows (delight)
        const progress = showPacer
            ? Math.min(1, Math.max(0, (pacerLib.clampStartBpm(app.pacer.targetBpm) - bpm) /
                Math.max(0.001, pacerLib.clampStartBpm(app.pacer.targetBpm) - pacerLib.TARGET_BPM)))
            : 0;
        const hue = 210 - 60 * progress; // cool blue -> warm teal/green
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(6, r), 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 45%, 55%, 0.85)`;
        ctx.fill();

        // phase word
        ctx.fillStyle = '#8b93a5';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        const word = phase < 0.4 ? 'breathe in' : phase < 0.5 ? 'hold' : phase < 0.95 ? 'breathe out' : 'rest';
        ctx.fillText(showPacer ? `${word} · ${bpm.toFixed(1)} br/min` : word, cx, H - 12);

        app.pacerAnim = requestAnimationFrame(draw);
    }
    app.pacerAnim = requestAnimationFrame(draw);
}

function stopPacerAnimation() {
    if (app.pacerAnim) cancelAnimationFrame(app.pacerAnim);
    app.pacerAnim = null;
}

async function finishSession() {
    if (app.tickTimer) clearInterval(app.tickTimer);
    app.tickTimer = null;
    stopPacerAnimation();
    app.afterWindow = metricsLib.snapshot(app.tracker);
    try { await app.source.stop(); } catch (e) { /* idempotent */ }
    try { await app.source.destroy(); } catch (e) { /* idempotent */ }
    els.cameraDot.classList.add('off');
    els.cameraText.textContent = 'camera off';

    const result = scoring.calmScore(app.baselineWindow, app.afterWindow);
    els.scoreNum.textContent = result.score == null ? '—' : result.score;
    els.scoreNote.textContent = result.note || '';
    els.beforeRate.textContent = result.before == null ? '—' : `${result.before.toFixed(1)} br/min`;
    els.afterRate.textContent = result.after == null ? '—' : `${result.after.toFixed(1)} br/min`;
    els.beforeHrv.textContent = result.beforeHrv == null ? '—' : `${result.beforeHrv.toFixed(0)} ms`;
    els.afterHrv.textContent = result.afterHrv == null ? '—' : `${result.afterHrv.toFixed(0)} ms`;
    showScreen('summary');

    smokeStep('summary', 'ok', {
        mode: app.sourceKind,
        score: result.score,
        mode_detail: result.mode,
        before: result.before, after: result.after,
    });
}

async function stopSession() {
    // User pressed Stop: still show a summary from what we have.
    sessionLib.stop(app.session, nowS());
    await finishSession();
}

function resetAll() {
    // Done button: back to consent, all data discarded.
    sessionLib.finish(app.session, nowS());
    app.baselineWindow = null;
    app.afterWindow = null;
    app.tracker = metricsLib.createMetricsTracker();
    showScreen('consent');
    smokeStep('reset', 'ok', null);
}

// ---------- smoke test (electron . --smoke) ----------
// Drives the app without a camera: starts a demo session, fast-forwards
// through the phases by manipulating the clock, and reports pass/fail.
function smokeStep(step, status, detail) {
    if (!window.calmbreath || !window.calmbreath.isSmoke()) return;
    app.smokeSteps.push({ step, status });
    console.log(`[smoke] step=${step} status=${status}`);
    if (step === 'reset') {
        window.calmbreath.smoke({ status: 'ok', steps: app.smokeSteps.map((s) => s.step) });
    }
}

async function runSmoke() {
    console.log('[smoke] starting demo-mode smoke session');
    els.telemetryConsent.checked = false;
    await beginSession();          // demo source (no key on this machine)
    // Fast-forward: emulate the full timed flow.
    const ff = async (seconds, expect) => {
        return new Promise((resolve) => {
            const step = 500;
            let moved = 0;
            const iv = setInterval(() => {
                moved += step / 1000;
                tick();
                if (app.session.state !== expect) {
                    clearInterval(iv);
                    resolve(app.session.state);
                } else if (moved >= seconds) {
                    clearInterval(iv);
                    resolve(app.session.state);
                }
            }, step);
        });
    };
    // Simulate the three timed phases by overriding the clock temporarily.
    const realClock0 = app.clock0;
    const jump = async (toState) => {
        while (app.session.state !== toState) {
            app.clock0 -= 1000; // 1s per loop
            tick();
            await new Promise((r) => setTimeout(r, 30));
            if (app.session.state === 'summary') break;
        }
    };
    await jump('pacer');
    smokeStep('pacer', 'ok', null);
    await jump('after');
    smokeStep('after', 'ok', null);
    await jump('summary');
    if (app.session.state !== 'summary') {
        window.calmbreath.smoke({ status: 'fail', reason: `ended at ${app.session.state}` });
        return;
    }
    // finishSession() already ran via tick -> summary transition.
    resetAll();
}

// ---------- wire up ----------
window.addEventListener('DOMContentLoaded', () => {
    els.btnStart.addEventListener('click', () => { beginSession(); });
    els.btnDecline.addEventListener('click', () => {
        app.session.declined = true;
        showScreen('decline');
    });
    els.btnBack.addEventListener('click', () => showScreen('consent'));
    els.btnStop.addEventListener('click', stopSession);
    els.btnAgain.addEventListener('click', () => { showScreen('consent'); });
    els.btnDone.addEventListener('click', resetAll);

    const isSmoke = window.calmbreath && window.calmbreath.isSmoke && window.calmbreath.isSmoke();
    if (isSmoke) runSmoke();
});
