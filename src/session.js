'use strict';
// Session state machine. Pure module.
//
// States: idle -> consent -> baseline (45s) -> pacer (adaptive, 90s)
//         -> after (45s) -> summary -> idle
//
// `advance(t)` transitions on elapsed seconds within the phase; external
// events (decline, stop, error) force transitions. The machine itself holds
// no timers; the caller drives it with a clock, which keeps it testable.

const PHASES = {
    idle:     { next: 'consent',  duration: null },
    consent:  { next: 'baseline', duration: null },
    baseline: { next: 'pacer',    duration: 45 },
    pacer:    { next: 'after',    duration: 90 },
    after:    { next: 'summary',  duration: 45 },
    summary:  { next: 'idle',     duration: null },
};

function createSession() {
    return {
        state: 'idle',
        phaseStart: null,   // seconds on the driving clock
        history: [],        // [{ state, enteredAt, exitedAt }]
        stopped: false,
        declined: false,
    };
}

function enter(session, state, nowS) {
    const prev = session.state;
    session.state = state;
    session.phaseStart = nowS;
    session.history.push({ state, enteredAt: nowS, from: prev });
}

// Start a session (from idle). Requires explicit consent flag.
function start(session, nowS, consent) {
    if (session.state !== 'idle') return session;
    if (!consent) {
        enter(session, 'idle', nowS);
        session.declined = true;
        return session;
    }
    enter(session, 'baseline', nowS);
    return session;
}

// Tick: advance by clock. Auto-advances timed phases.
function tick(session, nowS) {
    const phase = PHASES[session.state];
    if (phase && phase.duration != null) {
        const elapsed = nowS - session.phaseStart;
        if (elapsed >= phase.duration) {
            enter(session, phase.next, nowS);
        }
    }
    return session.state;
}

// Explicit stop (user pressed Stop): go to summary, mark stopped.
function stop(session, nowS) {
    if (session.state === 'idle' || session.state === 'summary') return session;
    session.stopped = true;
    enter(session, 'summary', nowS);
    return session;
}

// Finish summary -> idle (discard all session data).
function finish(session, nowS) {
    enter(session, 'idle', nowS);
    session.stopped = false;
    session.declined = false;
    return session;
}

function phaseElapsed(session, nowS) {
    if (session.phaseStart == null) return 0;
    return Math.max(0, nowS - session.phaseStart);
}

function phaseRemaining(session, nowS) {
    const phase = PHASES[session.state];
    if (!phase || phase.duration == null) return null;
    return Math.max(0, phase.duration - (nowS - session.phaseStart));
}

module.exports = { PHASES, createSession, start, tick, stop, finish, phaseElapsed, phaseRemaining };
