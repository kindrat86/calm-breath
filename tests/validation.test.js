'use strict';
// Unit tests for src/validation.js — signal-quality hint maps and
// confidence gating (values sourced from the SDK's own declarations).

const test = require('node:test');
const assert = require('node:assert');
const validation = require('../src/validation.js');

test('every documented ValidationCode has a hint (or explicit null for kOk)', () => {
    const codes = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17];
    for (const code of codes) {
        const hint = validation.validationHint(code);
        if (code === 0) {
            assert.equal(hint, null, 'kOk should map to null (no hint)');
        } else {
            assert.equal(typeof hint, 'string', `code ${code} should have a string hint`);
            assert.ok(hint.length > 8, `code ${code} hint should be actionable`);
            assert.ok(!/medical|diagnos|treat/.test(hint), `code ${code} hint must stay non-medical`);
        }
    }
});

test('unknown validation codes fall back to a generic non-medical hint', () => {
    const hint = validation.validationHint(999);
    assert.equal(typeof hint, 'string');
    assert.ok(/face in view/.test(hint));
});

test('every documented SmartSpectraErrorCode has a message', () => {
    const codes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (const code of codes) {
        const msg = validation.errorHint(code, null);
        assert.equal(typeof msg, 'string', `code ${code} should have a message`);
        assert.ok(msg.length > 8);
    }
    // auth failure is specific and actionable
    assert.ok(/key/.test(validation.errorHint(2, null)));
});

test('errorHint appends the SDK message when present', () => {
    const msg = validation.errorHint(4, 'credits used 10/10');
    assert.ok(/credits used 10\/10/.test(msg));
    assert.ok(/exhausted/.test(msg));
});

test('confidence gates use the SDK-documented accuracy floors', () => {
    assert.equal(validation.CONFIDENCE.BREATHING_RATE, 45);
    assert.equal(validation.CONFIDENCE.HRV, 50);
    assert.equal(validation.CONFIDENCE.PULSE_RATE, 40);
});

test('confOk: at/above floor passes, below fails, absent confidence passes', () => {
    assert.equal(validation.confOk(45, 45), true);   // exactly at floor
    assert.equal(validation.confOk(44.9, 45), false); // just below
    assert.equal(validation.confOk(50, 45), true);
    assert.equal(validation.confOk(10, 45), false);
    // null/undefined = SDK did not report confidence -> keep the sample
    assert.equal(validation.confOk(null, 45), true);
    assert.equal(validation.confOk(undefined, 50), true);
});
