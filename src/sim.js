'use strict';
// Deterministic synthetic signal source. Used ONLY for (a) unit tests and
// (b) the in-app "demo mode" (no API key), where every value shown is
// synthetic and labelled as such. Never presented as live data.
//
// Simulates a person whose breathing rate eases from `startBpm` toward
// `endBpm` over `durationS`, plus an RMSSD that rises as rate falls. Output
// shape mirrors what the SmartSpectra metrics events give us after
// extraction: { rate: [{t, value}], hrv: [{t, rmssd}] }.

function lerp(a, b, k) { return a + (b - a) * k; }

// Simple deterministic PRNG (mulberry32) so runs are reproducible in tests.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Generate a full synthetic session window at 1 Hz.
// opts: { startBpm, endBpm, durationS, hrvStartMs, hrvEndMs, seed, jitterBpm }
function synthWindow(opts) {
    const {
        startBpm = 15, endBpm = 7, durationS = 45,
        hrvStartMs = 28, hrvEndMs = 46, seed = 42, jitterBpm = 0.35,
    } = opts || {};
    const rand = mulberry32(seed);
    const rate = [];
    const hrv = [];
    for (let t = 0; t < durationS; t += 1) {
        const k = t / Math.max(1, durationS - 1);
        const r = lerp(startBpm, endBpm, k) + (rand() - 0.5) * 2 * jitterBpm;
        rate.push({ t, value: Math.round(r * 10) / 10 });
        const h = lerp(hrvStartMs, hrvEndMs, k) + (rand() - 0.5) * 4;
        hrv.push({ t, rmssd: Math.round(h * 10) / 10 });
    }
    return { rate, hrv };
}

// Live tick generator for demo mode: returns the next sample pair at call
// time given the session clock. `progress` is 0..1 within the phase.
function synthSample(nowS, phaseStartBpm, phaseEndBpm, durationS, seed) {
    const rand = mulberry32(seed + Math.floor(nowS));
    const k = Math.min(1, Math.max(0, nowS / Math.max(1, durationS - 1)));
    const r = lerp(phaseStartBpm, phaseEndBpm, k) + (rand() - 0.5) 	* 0.7;
    const h = lerp(28, 44, k) + (rand() - 0.5) * 4;
    return {
        t: nowS,
        value: Math.round(r * 10) / 10,
        rmssd: Math.round(h * 10) / 10,
    };
}

module.exports = { synthWindow, synthSample, mulberry32 };
