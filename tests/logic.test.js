'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const pacer = require('../src/pacer.js');
const scoring = require('../src/scoring.js');
const sessionLib = require('../src/session.js');
const sim = require('../src/sim.js');
const metricsLib = require('../src/metrics.js');

// ---------- pacer ----------

test('pacer clamps start rate to sane bounds', () => {
    assert.equal(pacer.clampStartBpm(30), 22);
    assert.equal(pacer.clampStartBpm(3), 8);
    assert.equal(pacer.clampStartBpm(0), 12);   // neutral default for bad input
    assert.equal(pacer.clampStartBpm(NaN), 12);
    assert.equal(pacer.clampStartBpm(14), 14);
});

test('pacer steps down only when following and after cooldown', () => {
    const p = pacer.createPacer(14);
    assert.equal(p.targetBpm, 14);
    // following at t=0..14: no step before cooldown
    pacer.updatePacer(p, 10, 13.8);
    assert.equal(p.targetBpm, 14);
    // cooldown elapsed (>=15s): steps down 0.5
    pacer.updatePacer(p, 16, 13.8);
    assert.equal(p.targetBpm, 13.5);
    // immediately after a step: cooldown resets
    pacer.updatePacer(p, 20, 13.4);
    assert.equal(p.targetBpm, 13.5);
});

test('pacer never goes below resonance floor', () => {
    const p = pacer.createPacer(8);
    for (let t = 0; t < 600; t += 1) {
        pacer.updatePacer(p, t, 6.0);
    }
    assert.equal(p.targetBpm, pacer.TARGET_BPM);
    assert.ok(p.targetBpm >= 6.0);
});

test('pacer holds steady when user breathes faster (does not chase up)', () => {
    const p = pacer.createPacer(12);
    for (let t = 0; t < 120; t += 1) pacer.updatePacer(p, t, 20);
    assert.equal(p.targetBpm, 12);
});

test('pacer meets the user partway when they breathe below target', () => {
    const p = pacer.createPacer(14);
    pacer.updatePacer(p, 5, 9); // 5 below target
    assert.ok(p.targetBpm < 14 && p.targetBpm >= 11.5, `target=${p.targetBpm}`);
});

test('pacer ignores null measurements', () => {
    const p = pacer.createPacer(14);
    pacer.updatePacer(p, 100, null);
    assert.equal(p.targetBpm, 14);
});

test('breathPhase and phaseScale stay in range and hit extremes', () => {
    const p1 = pacer.breathPhase(0, 6);
    assert.ok(p1 >= 0 && p1 < 1);
    assert.ok(Math.abs(pacer.breathPhase(10, 6) - pacer.breathPhase(0, 6)) < 1e-9); // 10s = 1 cycle at 6bpm
    assert.equal(pacer.phaseScale(0), 0.35);
    assert.ok(Math.abs(pacer.phaseScale(0.45) - 1.0) < 1e-9); // hold full
    assert.ok(Math.abs(pacer.phaseScale(0.95) - 0.35) < 1e-9); // exhale end
    assert.equal(pacer.phaseScale(0.2), 0.35 + 0.65 * 0.5);
});

// ---------- scoring ----------

test('calmScore: full rate+hrv path with synthetic windows', () => {
    const before = sim.synthWindow({ startBpm: 15, endBpm: 14.5, durationS: 45, seed: 1, hrvStartMs: 26, hrvEndMs: 28 });
    const after = sim.synthWindow({ startBpm: 10, endBpm: 7, durationS: 45, seed: 2, hrvStartMs: 36, hrvEndMs: 46 });
    const r = scoring.calmScore(before, after);
    assert.equal(r.mode, 'rate+hrv');
    assert.ok(r.score >= 0 && r.score <= 100, `score=${r.score}`);
    assert.ok(r.rateDrop > 3, `rateDrop=${r.rateDrop}`);
    assert.ok(r.hrvRatio > 0.2, `hrvRatio=${r.hrvRatio}`);
    assert.ok(typeof r.note === 'string' && r.note.length > 0);
});

test('calmScore: rate-only mode when HRV missing', () => {
    const before = sim.synthWindow({ startBpm: 15, endBpm: 14.5, seed: 3 });
    const after = sim.synthWindow({ startBpm: 9, endBpm: 6.5, seed: 4 });
    before.hrv = []; // no HRV samples
    const r = scoring.calmScore(before, after);
    assert.equal(r.mode, 'rate-only');
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.ok(/breathing rate only/.test(r.note));
});

test('calmScore: unavailable when windows too small', () => {
    const tiny = { rate: [{ t: 0, value: 12 }], hrv: [] };
    const r = scoring.calmScore(tiny, tiny);
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.score, null);
});

test('calmScore: faster-after session scores 0 with honest note', () => {
    const before = sim.synthWindow({ startBpm: 8, endBpm: 8, seed: 5, hrvStartMs: 40, hrvEndMs: 40 });
    const after = sim.synthWindow({ startBpm: 14, endBpm: 15, seed: 6, hrvStartMs: 26, hrvEndMs: 24 });
    const r = scoring.calmScore(before, after);
    assert.equal(r.score, 0);
    assert.ok(/faster at the end/.test(r.note));
});

test('calmScore: monotone windows do not crash (equal before/after)', () => {
    const w = sim.synthWindow({ startBpm: 12, endBpm: 12, hrvStartMs: 30, hrvEndMs: 30, seed: 7 });
    const r = scoring.calmScore(w, w);
    assert.ok(r.score != null && r.score >= 0 && r.score <= 100);
});

// ---------- session state machine ----------

test('session: consent required, decline keeps idle', () => {
    const s = sessionLib.createSession();
    sessionLib.start(s, 0, false);
    assert.equal(s.state, 'idle');
    assert.equal(s.declined, true);
});

test('session: full happy path with timed transitions', () => {
    const s = sessionLib.createSession();
    sessionLib.start(s, 0, true);
    assert.equal(s.state, 'baseline');
    assert.equal(sessionLib.tick(s, 44), 'baseline');
    assert.equal(sessionLib.tick(s, 45), 'pacer');
    assert.equal(sessionLib.tick(s, 134), 'pacer');
    assert.equal(sessionLib.tick(s, 135), 'after');
    assert.equal(sessionLib.tick(s, 180), 'summary');
    assert.equal(sessionLib.tick(s, 400), 'summary'); // summary is untimed; finish() returns to idle
});

test('session: stop from any active phase goes to summary', () => {
    const s = sessionLib.createSession();
    sessionLib.start(s, 0, true);
    sessionLib.tick(s, 45); // -> pacer
    sessionLib.stop(s, 60);
    assert.equal(s.state, 'summary');
    assert.equal(s.stopped, true);
    sessionLib.finish(s, 61);
    assert.equal(s.state, 'idle');
});

test('session: phaseRemaining counts down', () => {
    const s = sessionLib.createSession();
    sessionLib.start(s, 0, true);
    assert.equal(sessionLib.phaseRemaining(s, 0), 45);
    assert.equal(sessionLib.phaseRemaining(s, 40), 5);
    assert.equal(sessionLib.phaseRemaining(s, 100), 0); // still baseline (unticked): clamps at 0
    sessionLib.tick(s, 45);
    assert.equal(sessionLib.phaseRemaining(s, 45), 90);
});

// ---------- metrics tracker ----------

test('metrics: ingestSample smooths and snapshots', () => {
    const tr = metricsLib.createMetricsTracker();
    [12, 12.2, 11.8, 12.4, 12.0, 11.6].forEach((v, i) =>
        metricsLib.ingestSample(tr, { t: i, value: v, rmssd: 30 + i }));
    assert.equal(tr.rate.length, 6);
    assert.ok(Math.abs(tr.smoothRate - 12.0) < 0.35); // mean of last 5
    const snap = metricsLib.snapshot(tr);
    assert.equal(snap.rate.length, 6);
    assert.equal(snap.hrv.length, 6);
    metricsLib.reset(tr);
    assert.equal(tr.rate.length, 0);
    assert.equal(tr.smoothRate, null);
});

test('metrics: ingestDecoded maps SmartSpectra payload shape', () => {
    const tr = metricsLib.createMetricsTracker();
    const decoded = {
        breathing: { rate: [{ value: 13.7, confidence: 0.82, timestamp: 5_000_000 }] },
        cardio: { hrv: [{ rmssd: 31.2, timestamp: 5_000_000 }] },
    };
    metricsLib.ingestDecoded(tr, decoded, 5);
    assert.equal(tr.rate.length, 1);
    assert.equal(tr.rate[0].value, 13.7);
    assert.equal(tr.confidence, 0.82);
    assert.equal(tr.hrv.length, 1);
    assert.equal(tr.hrv[0].rmssd, 31.2);
    // empty cardio (unauthorized metric) must not crash
    metricsLib.ingestDecoded(tr, { breathing: { rate: [] }, cardio: null }, 6);
    assert.equal(tr.rate.length, 1);
});

// ---------- end-to-end synthetic session ----------

test('synthetic full session: simulator follows pacer and scores well', () => {
    // Simulate a realistic user: starts at 15 bpm, tracks the pacer target
    // with lag + noise. Baseline window ~15 bpm, end window near 6-8.
    const tr = metricsLib.createMetricsTracker();
    const p = pacer.createPacer(15);
    let userRate = 15;
    const rates = [];
    for (let t = 0; t < 90; t += 1) {
        pacer.updatePacer(p, t, userRate);
        // user relaxes toward target with lag
        userRate = userRate + (p.targetBpm - userRate) * 0.08 + (t % 3 === 0 ? 0.15 : -0.1);
        rates.push({ t, value: Math.round(userRate * 10) / 10 });
    }
    const baseline = { rate: rates.slice(0, 20), hrv: rates.map((r, i) => ({ t: r.t, rmssd: 26 + i * 0.05 })) };
    const after = { rate: rates.slice(-20), hrv: rates.slice(-20).map((r, i) => ({ t: r.t, rmssd: 38 + i * 0.05 })) };
    const result = scoring.calmScore(baseline, after);
    assert.equal(result.mode, 'rate+hrv');
    assert.ok(result.score > 60, `adaptive session should score well, got ${result.score}`);
});

test('synthetic generator is deterministic per seed', () => {
    const a = sim.synthWindow({ seed: 99 });
    const b = sim.synthWindow({ seed: 99 });
    assert.deepEqual(a, b);
    const c = sim.synthWindow({ seed: 100 });
    assert.notDeepEqual(a.rate, c.rate);
});
