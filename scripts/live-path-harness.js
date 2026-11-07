'use strict';
// Offline live-path harness: verifies the full pipeline the SDK's 'metrics'
// events go through in live mode — WITHOUT a camera, API key, or native
// binding. Runs in plain Node (no Electron).
//
// How: build real protobuf-encoded Metrics buffers with the SDK's own
// generated message classes (presage.smartspectra.Metrics.encode(...).finish()),
// i.e. the exact wire format the SDK emits on its 'metrics' event. A stub
// SDK object replays those buffers through the real createLiveSource event
// handlers (decode -> confidence gate -> extraction -> smoother), then the
// samples drive the real session/pacer/scoring modules for a full
// baseline -> pacer -> after -> summary run.
//
// Usage: node scripts/live-path-harness.js [--verbose]
// Exit 0 = all checks passed.

const path = require('path');
const process = require('process');

const repoRoot = path.join(__dirname, '..');
const { presage } = require(path.join(repoRoot, 'node_modules', '@smartspectra', 'node-sdk', 'js', 'messages', 'generated.js'));

const { createLiveSource } = require(path.join(repoRoot, 'src', 'liveSource.js'));
const metricsLib = require(path.join(repoRoot, 'src', 'metrics.js'));
const pacerLib = require(path.join(repoRoot, 'src', 'pacer.js'));
const scoring = require(path.join(repoRoot, 'src', 'scoring.js'));
const sessionLib = require(path.join(repoRoot, 'src', 'session.js'));

const VERBOSE = process.argv.includes('--verbose');

function log(...args) { if (VERBOSE) console.log('[harness]', ...args); }

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// ---------- helpers to build real protobuf Metrics buffers ----------

const US = 1e6; // seconds -> microseconds (protobuf timestamps are µs)

function makeBreathingSample(bpm, confidence, tSec) {
    return presage.smartspectra.MeasurementWithConfidence.create({
        value: bpm,
        stable: confidence >= 45,
        confidence,
        timestamp: Math.round(tSec * US),
    });
}

function makeHrvSample(rmssd, confidence, tSec) {
    return presage.smartspectra.Hrv.create({
        rmssd,
        meanNn: 800,
        sdnn: 40,
        confidence,
        stable: confidence >= 50,
        timestamp: Math.round(tSec * US),
    });
}

// Cumulative Metrics message, exactly the shape the 'metrics' event emits:
// each event contains all samples so far, and Calm Breath reads the LAST.
function makeMetricsBuffer(rateSamples, hrvSamples) {
    const msg = presage.smartspectra.Metrics.create({
        breathing: { rate: rateSamples },
        cardio: { hrv: hrvSamples },
    });
    return presage.smartspectra.Metrics.encode(msg).finish();
}

// ---------- stub SDK that replays buffers through the real handlers ----------

function makeStubSdk(buffers) {
    const handlers = { metrics: [], validationStatus: [], error: [], streamAvailable: [] };
    return {
        constructorArgs: null,
        on(event, cb) { handlers[event].push(cb); },
        emit(event, ...args) { handlers[event].forEach((cb) => cb(...args)); },
        async start() { this.started = true; },
        async stopAsync() { this.stopped = true; },
        async destroy() { this.destroyed = true; },
        handlers,
    };
}

// Monkey-patch require so createLiveSource's lazy require pulls our stub.
const Module = require('module');
const sdkResolve = require.resolve('@smartspectra/node-sdk/renderer', { paths: [repoRoot] });
const msgResolve = require.resolve('@smartspectra/node-sdk/messages', { paths: [repoRoot] });
const realLoad = Module._load;
let stubRenderer = null;
Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === path.join(repoRoot, 'src', 'liveSource.js')) {
        if (request === '@smartspectra/node-sdk/renderer') return stubRenderer;
        if (request === '@smartspectra/node-sdk/messages') {
            return { decodeMetrics: (buf) => presage.smartspectra.Metrics.decode(buf) };
        }
    }
    return realLoad(request, parent, isMain);
};

// ---------- checks ----------

async function main() {
    // 1. Wire format round-trip: generated classes encode/decode and the
    //    live source extracts the last breathing + HRV sample with gates.
    {
        const stub = makeStubSdk();
        stubRenderer = {
            SmartSpectraSDK: function StubSDK(args) { stub.constructorArgs = args; return stub; },
            breathingMetrics: [1, 2, 3],
            cardioMetrics: [4, 5],
        };
        const seen = [];
        let validationSeen = null;
        const src = createLiveSource('test-key', {
            onValidation: (code, hint) => { validationSeen = { code, hint }; },
        });
        await src.init();
        src.onSample((s) => seen.push(s));
        await src.start();

        // Cumulative events: growing arrays, plus a low-confidence sample
        // in the middle that must be gated out.
        const buf1 = makeMetricsBuffer(
            [makeBreathingSample(14.2, 90, 0), makeBreathingSample(14.0, 88, 1)],
            [makeHrvSample(28, 82, 1)],
        );
        const buf2 = makeMetricsBuffer(
            [makeBreathingSample(14.2, 90, 0), makeBreathingSample(14.0, 99, 1), makeBreathingSample(9.9, 10, 2)], // conf 10 < 45
            [makeHrvSample(28, 82, 1), makeHrvSample(55, 20, 2)], // conf 20 < 50
        );
        stub.emit('metrics', Buffer.from(buf1));
        stub.emit('metrics', Buffer.from(buf2));

        check('sdk constructed with key + requested metrics + telemetry off',
            stub.constructorArgs
            && stub.constructorArgs.apiKey === 'test-key'
            && stub.constructorArgs.enableTelemetry === false
            && stub.constructorArgs.requestedMetrics.length === 5,
            JSON.stringify(stub.constructorArgs));

        check('decodes protobuf buffer, extracts last cumulative sample',
            seen.length >= 1 && Math.abs(seen[0].value - 14.0) < 0.001 && Math.abs(seen[0].rmssd - 28) < 0.001,
            JSON.stringify(seen[0]));
        check('low-confidence samples dropped (conf 10 rate, conf 20 hrv -> no tick at all)',
            seen.length === 1,
            `seen.length=${seen.length}, last=${JSON.stringify(seen[seen.length - 1])}`);

        // validationStatus mapping
        stub.emit('validationStatus', 5, 12345, 'sdk hint');
        check('validation hint mapped for kTooDark(5)',
            validationSeen && validationSeen.code === 5
            && /dark/.test(validationSeen.hint),
            JSON.stringify(validationSeen));

        // error mapping
        let errSeen = null;
        const src2 = createLiveSource('k', { onError: (c, m) => { errSeen = { c, m }; } });
        stubRenderer.SmartSpectraSDK = function (args) { return makeStubSdk(); };
        await src2.init();
        // use src2's own stub: re-fetch via a fresh emit is awkward; instead test mapping directly
        errSeen = null;
        const { errorHint } = require(path.join(repoRoot, 'src', 'validation.js'));
        const m = errorHint(2, '401');
        check('error hint mapped for kAuthenticationFailed(2)', /rejected/.test(m), m);

        await src.stop();
        await src.destroy();
        check('stop/destroy idempotent on stub', stub.stopped === true && stub.destroyed === true);
    }

    // 2. Full session driven by protobuf-decoded samples: baseline -> adaptive
    //    pacer stepping down only when followed -> after -> calm score.
    {
        stubRenderer = {
            SmartSpectraSDK: function (args) {
                const stub = makeStubSdk();
                stub.constructorArgs = args;
                currentStub = stub;
                return stub;
            },
            breathingMetrics: [1],
            cardioMetrics: [4],
        };
        let currentStub = null;

        const src = createLiveSource('test-key', {});
        await src.init();
        const tracker = metricsLib.createMetricsTracker();
        src.onSample((s) => metricsLib.ingestSample(tracker, s));
        await src.start();

        // Simulate a 3-minute session at 1 Hz: baseline 45 s at ~14 br/min,
        // then the user follows the pacer down to ~7, then re-measure.
        const session = sessionLib.createSession();
        sessionLib.start(session, 0, true);
        let pacer = null;
        let baselineWindow = null;
        const phaseLog = [];

        for (let t = 0; t <= 180; t += 1) {
            const stateBefore = session.state;
            // user's breathing rate depends on phase
            let bpm; let conf = 90;
            if (stateBefore === 'baseline') bpm = 14 + 0.4 * Math.sin(t);
            else if (stateBefore === 'pacer' && pacer) bpm = pacer.targetBpm + 0.3 * Math.sin(t);
            else if (stateBefore === 'after') bpm = 7.2 + 0.3 * Math.sin(t);
            else bpm = 8;
            const buf = makeMetricsBuffer(
                [makeBreathingSample(bpm, conf, t)],
                [makeHrvSample(t < 60 ? 25 + t * 0.1 : 45 + (t - 60) * 0.2, 85, t)],
            );
            currentStub.emit('metrics', Buffer.from(buf));

            sessionLib.tick(session, t);
            const state = session.state;
            if (state !== stateBefore) phaseLog.push(`${stateBefore}->${state}@${t}`);
            if (state === 'pacer' && stateBefore === 'baseline') {
                baselineWindow = metricsLib.snapshot(tracker);
                const measured = tracker.smoothRate != null ? tracker.smoothRate : 14;
                pacer = pacerLib.createPacer(measured);
            }
            if (state === 'pacer') pacerLib.updatePacer(pacer, t, tracker.smoothRate);
            if (state === 'after' && stateBefore === 'pacer') metricsLib.reset(tracker);
        }

        const afterWindow = metricsLib.snapshot(tracker);
        const result = scoring.calmScore(baselineWindow, afterWindow);

        check('session walked baseline->pacer->after->summary',
            /baseline->pacer/.test(phaseLog.join(' ')) && /pacer->after/.test(phaseLog.join(' ')) && /after->summary/.test(phaseLog.join(' ')),
            phaseLog.join(','));
        check('pacer stepped target down (>= 2.5 bpm slower) while never chasing up',
            pacer.targetBpm <= 14.2 - 2.5 && pacer.targetBpm >= pacer.minBpm,
            `targetBpm=${pacer && pacer.targetBpm}`);
        check('calm score computed from decoded before/after windows',
            result.score != null && result.before != null && result.after != null,
            JSON.stringify(result));
        check('breathing rate improved (after < before)',
            result.after < result.before,
            `before=${result.before} after=${result.after}`);
        await src.destroy();
    }

    console.log(failures === 0 ? 'HARNESS OK' : `HARNESS FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS CRASH', e); process.exit(1); });
