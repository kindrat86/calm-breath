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

// The SDK is required lazily inside init() so demo mode and unit tests never
// touch the native binding chain at all.
function createLiveSource(apiKey, opts) {
    const { allowTelemetry = false, onValidation, onStream, onError } = opts || {};
    let sdk = null;
    let t0 = null;
    let sampleCb = null;

    return {
        get label() { return 'live'; },
        async init() {
            if (!apiKey) throw new Error('No Presage API key set. Copy .env.example to .env and add your key.');
            const smartSpectra = require('@smartspectra/node-sdk/renderer');
            const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
            const { SmartSpectraSDK } = smartSpectra;
            sdk = new SmartSpectraSDK({
                apiKey,
                requestedMetrics: [
                    ...smartSpectra.breathingMetrics,
                    ...smartSpectra.cardioMetrics,
                ],
                enableTelemetry: !!allowTelemetry, // default OFF in Calm Breath (opt-in)
            });
            sdk.on('metrics', (buf) => {
                const metrics = decodeMetrics(buf);
                if (Buffer.isBuffer(metrics)) return; // no decoder class registered
                if (!sampleCb) return;
                const tSec = t0 != null ? (Date.now() - t0) / 1000 : null;
                const rate = metrics.breathing && metrics.breathing.rate && metrics.breathing.rate.length
                    ? metrics.breathing.rate[metrics.breathing.rate.length - 1] : null;
                const hrv = metrics.cardio && metrics.cardio.hrv && metrics.cardio.hrv.length
                    ? metrics.cardio.hrv[metrics.cardio.hrv.length - 1] : null;
                sampleCb({
                    t: tSec,
                    value: rate ? rate.value : undefined,
                    rmssd: hrv ? hrv.rmssd : undefined,
                    confidence: rate ? rate.confidence : undefined,
                });
            });
            sdk.on('validationStatus', (code, _ts, hint) => {
                if (onValidation) onValidation(code, hint);
            });
            sdk.on('streamAvailable', (stream) => {
                if (onStream) onStream(stream);
            });
            sdk.on('error', (code, message, retryable) => {
                if (onError) onError(code, message, retryable);
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
