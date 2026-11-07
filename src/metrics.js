'use strict';
// Metric extraction + smoothing shared by the live SDK path and demo mode.
// Pure module.
//
// The SmartSpectra `metrics` event delivers a cumulative Metrics protobuf
// (decoded via @smartspectra/node-sdk/messages). We extract the LAST sample
// of breathing rate and HRV each tick and run a short moving-average
// smoother so the UI number and the pacer's adaptive decision don't jitter.

const SMOOTH_N = 5; // moving-average window, samples (~1 Hz => 5 s)

function createMetricsTracker() {
    return {
        rate: [],        // [{t, value}]
        hrv: [],         // [{t, rmssd}]
        smoothRate: null,
        _rateBuf: [],
        confidence: null,
        lastValidation: null, // { code, hint }
    };
}

// Feed one decoded metrics object (as produced by decodeMetrics) into the
// tracker. Safe against missing/empty fields (unauthorized metrics arrive
// empty, per docs).
function ingestDecoded(tracker, metrics, tSeconds) {
    if (!metrics || typeof metrics !== 'object') return tracker;
    const rateSample = metrics.breathing && metrics.breathing.rate && metrics.breathing.rate.length
        ? metrics.breathing.rate[metrics.breathing.rate.length - 1] : null;
    const hrvSample = metrics.cardio && metrics.cardio.hrv && metrics.cardio.hrv.length
        ? metrics.cardio.hrv[metrics.cardio.hrv.length - 1] : null;

    if (rateSample && Number.isFinite(rateSample.value)) {
        const t = tSeconds != null ? tSeconds
            : (Number.isFinite(rateSample.timestamp) ? rateSample.timestamp / 1e6 : tracker.rate.length);
        tracker.rate.push({ t, value: rateSample.value });
        if (rateSample.confidence != null) tracker.confidence = rateSample.confidence;
        tracker._rateBuf.push(rateSample.value);
        if (tracker._rateBuf.length > SMOOTH_N) tracker._rateBuf.shift();
        tracker.smoothRate = tracker._rateBuf.reduce((a, b) => a + b, 0) / tracker._rateBuf.length;
    }
    if (hrvSample && Number.isFinite(hrvSample.rmssd)) {
        const t = tSeconds != null ? tSeconds
            : (Number.isFinite(hrvSample.timestamp) ? hrvSample.timestamp / 1e6 : tracker.hrv.length);
        tracker.hrv.push({ t, rmssd: hrvSample.rmssd });
    }
    return tracker;
}

// Feed one synthetic sample {t, value, rmssd} (demo mode / tests).
function ingestSample(tracker, sample) {
    if (sample && Number.isFinite(sample.value)) {
        tracker.rate.push({ t: sample.t, value: sample.value });
        tracker._rateBuf.push(sample.value);
        if (tracker._rateBuf.length > SMOOTH_N) tracker._rateBuf.shift();
        tracker.smoothRate = tracker._rateBuf.reduce((a, b) => a + b, 0) / tracker._rateBuf.length;
    }
    if (sample && Number.isFinite(sample.rmssd)) {
        tracker.hrv.push({ t: sample.t, rmssd: sample.rmssd });
    }
    return tracker;
}

// Window snapshot in the shape scoring.calmScore expects.
function snapshot(tracker) {
    return { rate: tracker.rate.slice(), hrv: tracker.hrv.slice() };
}

function reset(tracker) {
    tracker.rate = [];
    tracker.hrv = [];
    tracker.smoothRate = null;
    tracker._rateBuf = [];
    tracker.confidence = null;
    tracker.lastValidation = null;
    return tracker;
}

module.exports = { createMetricsTracker, ingestDecoded, ingestSample, snapshot, reset, SMOOTH_N };
