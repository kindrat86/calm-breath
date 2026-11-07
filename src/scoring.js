'use strict';
// Calm-score computation. Pure module.
//
// Inputs are the two windows of samples collected during baseline and
// re-measure phases:
//   { rate: [{t, value}, ...], hrv: [{t, rmssd}, ...] }
//
// Outputs a 0-100 relaxation index plus the plain-language parts used on the
// summary card. Documented formula (also in README):
//
//   calm = 0.6 * rateScore + 0.4 * hrvScore      (when HRV available)
//   calm = rateScore                              (breathing-rate-only mode)
//
//   rateScore: reduction in breathing rate, mapped: 0 br/min slower .. 100 at
//              >= 4 br/min slower. Clamped to [0, 100]. 4 br/min is a large,
//              deliberately conservative ceiling: dropping from a typical
//              14-16 br/min start to 6-8 by the end is the full effect.
//   hrvScore:  relative RMSSD increase, mapped: 0% .. 100 at >= +50%.
//              Clamped to [0, 100]. (RMSSD typically rises as breathing
//              slows toward resonance.)
//
// NOT a medical measurement. Wellness/relaxation feedback only.

const RATE_DROP_FULL = 4.0;   // br/min slower that maps to 100
const HRV_GAIN_FULL = 0.5;    // +50% RMSSD maps to 100
const MIN_SAMPLES = 3;        // need at least 3 samples in a window

function mean(xs) {
    if (!xs || xs.length === 0) return null;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

// Median breathing rate (br/min) of a window; null when unusable.
function windowRate(window) {
    if (!window || !Array.isArray(window.rate) || window.rate.length < MIN_SAMPLES) return null;
    return mean(window.rate.map((s) => s.value));
}

// Median RMSSD (ms) of a window; null when unusable.
function windowHrv(window) {
    if (!window || !Array.isArray(window.hrv) || window.hrv.length < MIN_SAMPLES) return null;
    const sorted = window.hrv.map((s) => s.rmssd).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length < MIN_SAMPLES) return null;
    return sorted[Math.floor(sorted.length / 2)];
}

// Core formula. Returns
// { score, mode: 'rate+hrv' | 'rate-only', before, after, rateDrop, hrvRatio, note }
function calmScore(beforeWindow, afterWindow) {
    const before = windowRate(beforeWindow);
    const after = windowRate(afterWindow);
    const beforeHrv = windowHrv(beforeWindow);
    const afterHrv = windowHrv(afterWindow);

    if (before == null || after == null) {
        return {
            score: null, mode: 'unavailable', before, after,
            rateDrop: null, hrvRatio: null,
            note: 'Not enough signal to score this session. Keep your face in view and try again.',
        };
    }

    const rateDrop = before - after; // positive = slower after
    const rateScore = Math.max(0, Math.min(100, (rateDrop / RATE_DROP_FULL) * 100));

    const hasHrv = beforeHrv != null && afterHrv != null && beforeHrv > 0;
    if (hasHrv) {
        const hrvRatio = (afterHrv - beforeHrv) / beforeHrv;
        const hrvScore = Math.max(0, Math.min(100, (hrvRatio / HRV_GAIN_FULL) * 100));
        const score = Math.round(0.6 * rateScore + 0.4 * hrvScore);
        return {
            score, mode: 'rate+hrv', before, after, beforeHrv, afterHrv,
            rateDrop, hrvRatio,
            note: plainLanguage(score, rateDrop),
        };
    }

    const score = Math.round(rateScore);
    return {
        score, mode: 'rate-only', before, after,
        rateDrop, hrvRatio: null,
        note: plainLanguage(score, rateDrop) + ' HRV was not available this session, so the score uses breathing rate only.',
    };
}

function plainLanguage(score, rateDrop) {
    if (score == null) return 'No score this session.';
    if (score >= 70) return 'Your breathing slowed markedly. Nice downshift.';
    if (score >= 40) return 'Your breathing slowed. With practice this gets easier.';
    if (rateDrop != null && rateDrop < 0) return 'Your breathing was faster at the end. No harm done; try a shorter session.';
    return 'Your breathing stayed about level. Relaxation builds with regular practice.';
}

module.exports = { calmScore, windowRate, windowHrv, RATE_DROP_FULL, HRV_GAIN_FULL, MIN_SAMPLES };
