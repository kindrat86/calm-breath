'use strict';
// Live SmartSpectra source adapter (renderer-side).
//
// Wraps the SmartSpectraSDK renderer binding behind the same interface the
// demo source exposes, so the session controller can swap sources without
// knowing which is active:
//
//   await source.init()            // construct SDK, wire events
//   source.onSample(cb)            // cb({t, value, rmssd, confidence})
//   await source.start()           // camera on, measurement begins
//   await source.stop()            // camera off
//   await source.destroy()
//
// PRIVACY: constructed with enableTelemetry:false unless the user ticks the
// telemetry consent checkbox on the consent screen (opt-in here, even though
// the SDK defaults to aggregate telemetry on). Video frames stay in the
// local process; nothing is written to disk.
//
// Confidence gating: samples below the SDK-documented accuracy floors
// (breathing >= 45, HRV >= 50; src/validation.js) are dropped before they
// reach the tracker, so unreliable readings never steer the pacer or the
// calm score.

const validation = require('./validation.js');

// The SDK is required lazily inside init() so demo mode and unit tests never
// touch the native binding chain at all.
function createLiveSource(apiKey, opts) {
    const { allowTelemetry = false, onValidation, onStream, onError } = opts || {};
    let sdk = null;
    let t0 = null;
    let sampleCb = null;

    function emitRate(rateSample, hrvSample) {
        if (!sampleCb) return;
        const tSec = t0 != null ? (Date.now() - t0) / 1000 : null;
        sampleCb({
            t: tSec,
            value: rateSample && Number.isFinite(rateSample.value) ? rateSample.value : undefined,
            rmssd: hrvSample && Number.isFinite(hrvSample.rmssd) ? hrvSample.rmssd : undefined,
            confidence: rateSample ? rateSample.confidence : undefined,
            hrvConfidence: hrvSample ? hrvSample.confidence : undefined,
            hrvStable: hrvSample ? hrvSample.stable : undefined,
        });
    }

    // Decode the payload from a 'metrics' event. The SDK delivers an encoded
    // buffer (Buffer/Uint8Array) by default, or an already-decoded Metrics
    // object when a decoder class is registered on the renderer; both are
    // handled here. Returns null when there is nothing usable.
    function decodePayload(payload) {
        if (payload == null) return null;
        if (Buffer.isBuffer(payload) || payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
            const decoded = decodeFn(payload);
            return Buffer.isBuffer(decoded) || decoded instanceof Uint8Array ? null : decoded;
        }
        return typeof payload === 'object' ? payload : null;
    }

    let decodeFn = null;

    return {
        get label() { return 'live'; },
        async init() {
            if (!apiKey) throw new Error('No Presage API key set. Copy .env.example to .env and add your key.');
            const smartSpectra = require('@smartspectra/node-sdk/renderer');
            const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
            const { SmartSpectraSDK } = smartSpectra;
            decodeFn = decodeMetrics;
            sdk = new SmartSpectraSDK({
                apiKey,
                requestedMetrics: [
                    ...smartSpectra.breathingMetrics,
                    ...smartSpectra.cardioMetrics,
                ],
                enableTelemetry: !!allowTelemetry, // default OFF in Calm Breath (opt-in)
            });
            sdk.on('metrics', (buf) => {
                const metrics = decodePayload(buf);
                if (!metrics) return;
                const rateArr = metrics.breathing && metrics.breathing.rate;
                const hrvArr = metrics.cardio && metrics.cardio.hrv;
                const rateSample = rateArr && rateArr.length ? rateArr[rateArr.length - 1] : null;
                const hrvSample = hrvArr && hrvArr.length ? hrvArr[hrvArr.length - 1] : null;
                if (!rateSample && !hrvSample) return;

                // Confidence gates (SDK-documented accuracy floors).
                const rateOk = !rateSample || validation.confOk(rateSample.confidence, validation.CONFIDENCE.BREATHING_RATE);
                const hrvOk = !hrvSample || validation.confOk(hrvSample.confidence, validation.CONFIDENCE.HRV);
                if (!rateOk && !hrvOk) return; // both low quality: drop the whole tick

                emitRate(
                    rateOk ? rateSample : null,
                    hrvOk ? hrvSample : null,
                );
            });
            sdk.on('validationStatus', (code, _ts, hint) => {
                if (onValidation) onValidation(code, validation.validationHint(code), hint);
            });
            sdk.on('streamAvailable', (stream) => {
                if (onStream) onStream(stream);
            });
            sdk.on('error', (code, message, retryable) => {
                if (onError) onError(code, validation.errorHint(code, message), retryable);
            });
        },
        onSample(cb) { sampleCb = cb; },
        async start() {
            t0 = Date.now();
            await sdk.start();
        },
        async stop() { try { await sdk.stopAsync(); } catch (e) { /* idempotent */ } },
        async destroy() { try { if (sdk) await sdk.destroy(); } catch (e) { /* idempotent */ } },
    };
}

module.exports = { createLiveSource };
