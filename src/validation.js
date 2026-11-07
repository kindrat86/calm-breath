'use strict';
// Signal-quality hints + confidence gating for the live SmartSpectra path.
// Pure module — no SDK import, fully unit-testable.
//
// Values below are taken from the SDK's own declarations shipped in
// node_modules/@smartspectra/node-sdk (index.d.ts): ValidationCode and
// SmartSpectraErrorCode enums, plus the confidence-to-accuracy notes in
// generated.d.ts (breathing rate stable >= 45, HRV stable >= 50,
// pulse rate stable >= 40). These are documented accuracy standards of
// the SDK's models, not medical thresholds.

// ValidationCode -> short, non-alarming, action-oriented UI hint.
const VALIDATION_HINTS = {
    0: null, // kOk — nothing to say
    1: 'No face detected — position your face in the camera view.',
    2: 'Multiple faces detected — make sure only you are in frame.',
    3: 'Center your face in the camera view.',
    4: 'Move slightly closer or farther from the camera.', // deprecated size code
    5: 'Too dark — add a little more light on your face.',
    6: 'Too bright — reduce glare or strong light on your face.',
    7: 'Your chest is not visible — sit back a little so breathing motion can be read.',
    10: 'This camera needs a moment to adapt its exposure — hold still.',
    11: 'Low frame rate — close other apps using the camera.',
    12: 'Too much movement — try to sit still and relax.',
    13: 'Move a little farther from the camera.',
    14: 'Move a little closer to the camera.',
    15: 'Move your face a little lower in the frame.',
    16: 'Move your face a little higher in the frame.',
    17: 'Look straight at the camera.',
};

// SmartSpectraErrorCode -> user-facing message. Auth/config/credit errors
// mean live mode cannot continue; the app falls back to the pacer alone.
const ERROR_HINTS = {
    1: 'The measurement could not start in this state. Please restart the session.',
    2: 'The Presage API key was rejected. Check the key in your .env file.',
    3: 'The SDK could not configure the camera. You can continue with the pacer alone.',
    4: 'Free trial credits exhausted. You can continue with the pacer alone.',
    5: 'Network issue contacting the Presage service. You can continue with the pacer alone.',
    6: 'The Presage service reported an error. You can continue with the pacer alone.',
    7: 'Camera unavailable. Check that no other app is using it and allow camera access.',
    8: 'Measurement failed on this frame — keep steady, it will retry.',
    9: 'Could not read a camera frame. You can continue with the pacer alone.',
    10: 'Internal timestamp issue — please restart the session.',
    11: 'Frame stream hiccup — hold still, it should recover.',
};

// Confidence floor for a sample to count as "stable" per the SDK's docs.
const CONFIDENCE = {
    BREATHING_RATE: 45, // +/- 1 br/min accuracy standard
    HRV: 50,            // +/- 5 ms accuracy standard
    PULSE_RATE: 40,     // +/- 3 bpm accuracy standard
};

function validationHint(code) {
    return Object.prototype.hasOwnProperty.call(VALIDATION_HINTS, code)
        ? VALIDATION_HINTS[code] : 'Signal weak — keep your face in view and steady.';
}

function errorHint(code, message) {
    const known = Object.prototype.hasOwnProperty.call(ERROR_HINTS, code)
        ? ERROR_HINTS[code] : null;
    return message ? `${known || 'Measurement issue'}: ${message}` : (known || 'Measurement issue.');
}

// Gate a decoded sample by the SDK-documented confidence floor. Samples
// below the floor are dropped (never shown, never scored) so low-quality
// camera input cannot steer the pacer or the calm score.
function confOk(confidence, floor) {
    return confidence == null || confidence >= floor; // null = not reported -> keep (SDK still emitted it)
}

const module_ = {
    VALIDATION_HINTS,
    ERROR_HINTS,
    CONFIDENCE,
    validationHint,
    errorHint,
    confOk,
};

module.exports = module_;
