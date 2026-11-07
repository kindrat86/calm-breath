'use strict';
// Adaptive pacer logic. Pure module: no DOM, no Electron, no SDK.
//
// The pacer starts at the user's measured breathing rate and gently steps
// down toward a resonance target (~6 breaths/min). It only lowers the pace
// when the measured breathing rate actually follows the target (adaptive),
// and never raises it above the user's own comfortable rate.

const TARGET_BPM = 6.0;          // resonance breathing target, breaths/min
const MIN_START_BPM = 8.0;       // clamp: never start slower than 8 bpm (5s+ holds feel odd below this at entry)
const MAX_START_BPM = 22.0;      // clamp: never start faster than 22 bpm
const STEP_DOWN_BPM = 0.5;       // pace decrement when the user is following
const STEP_COOLDOWN_S = 15;      // min seconds between pace changes
const FOLLOW_TOLERANCE_BPM = 2.0; // measured within this of target => "following"

// Clamp a starting rate to a sane range.
function clampStartBpm(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return 12.0; // neutral default
    return Math.min(MAX_START_BPM, Math.max(MIN_START_BPM, rate));
}

// Initial pacer target: the measured rate, clamped.
function initialTarget(measuredBpm) {
    return clampStartBpm(measuredBpm);
}

function createPacer(startBpm) {
    return {
        targetBpm: clampStartBpm(startBpm),
        lastStepAt: 0,        // seconds, session clock
        minBpm: TARGET_BPM,
    };
}

// Called each tick (about 1 Hz) with the smoothed measured rate (or null when
// no signal). Returns the (possibly updated) target pace in breaths/min.
//
// Adaptive rule: only step the target DOWN when
//   - we have a measurement,
//   - the measurement is following the current target (within tolerance),
//   - the target is still above the resonance floor, and
//   - the cooldown has elapsed.
// If the user's measured rate rises well above the target (they lost the
// pace), hold the target steady rather than chasing them upward; if they are
// far below the target, ease the target down to meet them.
function updatePacer(pacer, nowS, measuredBpm) {
    if (measuredBpm == null || !Number.isFinite(measuredBpm)) return pacer.targetBpm;

    const diff = measuredBpm - pacer.targetBpm;

    if (diff >= -FOLLOW_TOLERANCE_BPM && diff <= FOLLOW_TOLERANCE_BPM) {
        // Following: after cooldown, step down toward the floor.
        if (pacer.targetBpm > pacer.minBpm && nowS - pacer.lastStepAt >= STEP_COOLDOWN_S) {
            pacer.targetBpm = Math.max(pacer.minBpm, pacer.targetBpm - STEP_DOWN_BPM);
            pacer.lastStepAt = nowS;
        }
    } else if (diff < -FOLLOW_TOLERANCE_BPM) {
        // Measured well BELOW target: they breathe slower than asked; meet
        // them partway down immediately (no cooldown needed to go slower).
        pacer.targetBpm = Math.max(
            pacer.minBpm,
            pacer.targetBpm - Math.min(STEP_DOWN_BPM, -diff / 2)
        );
        pacer.lastStepAt = nowS;
    }
    // diff > +tolerance: user breathing faster than target; hold steady and
    // let the visual pacer draw them down. Do not chase upward.
    return pacer.targetBpm;
}

// Phase of the breathing cycle at time t for a given pace, in [0, 1).
// 0 .. 0.4  inhale (growing circle)
// 0.4 .. 0.5 hold
// 0.5 .. 0.95 exhale (shrinking circle)
// 0.95 .. 1 rest
function breathPhase(tSeconds, targetBpm) {
    const cycle = tSeconds * targetBpm / 60;
    return cycle - Math.floor(cycle);
}

// Circle scale factor (0..1) for the pacer animation at phase p.
function phaseScale(p) {
    if (p < 0.4) return 0.35 + 0.65 * (p / 0.4);          // inhale
    if (p < 0.5) return 1.0;                               // hold
    if (p < 0.95) return 1.0 - 0.65 * ((p - 0.5) / 0.45);  // exhale
    return 0.35;                                           // rest
}

module.exports = {
    TARGET_BPM, MIN_START_BPM, MAX_START_BPM, FOLLOW_TOLERANCE_BPM,
    clampStartBpm, initialTarget, createPacer, updatePacer, breathPhase, phaseScale,
};
