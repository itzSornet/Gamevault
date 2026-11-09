'use strict';

// Pure playtime state machine — no timers, no processes, no IPC. tracker.js
// feeds it "is the game's track process visible right now?" once per poll and
// forwards the events it returns. Every rule about when a session starts and
// ends lives here so it can be tested with a fake clock.
//
//   idle ──launch──▶ pending ──seen──▶ running ◀──seen── grace
//    ▲                  │                 │                │
//    └──── gave-up ─────┘                 └──── missed ───▶┘
//    ▲                                                     │
//    └────────── grace expired: session ends at lastSeen ──┘
//
// - A wrapper/launcher exiting during `pending` changes nothing: a session only
//   starts once the track process itself is seen.
// - One missed poll does not end a session: `grace` waits `graceMs`, and a
//   reappearance continues the same session.
// - A session ends at the last time the game was seen, not when we noticed.
// - Sessions shorter than `minSessionMs` are discarded (no hours, no entry):
//   launcher hand-offs and crash-on-start blips are not playtime.

const DEFAULTS = Object.freeze({
  graceMs: 60 * 1000,
  minSessionMs: 30 * 1000,
  pendingTimeoutMs: 90 * 1000,
  steamPendingTimeoutMs: 180 * 1000, // Steam may update / compile shaders first
  fastPollMs: 700,
  fastPollWindowMs: 20 * 1000,
  activePollMs: 3000,
  idlePollMs: 15000,
});

function createState(opts) {
  return {
    phase: 'idle',      // idle | pending | running | grace
    launchedAt: 0,
    sessionStart: 0,
    lastSeen: 0,
    viaSteam: !!(opts && opts.viaSteam),
  };
}

// The user (or the tray, or bgPoll) launched the game.
function launch(s, now, opts) {
  if (s.phase === 'running' || s.phase === 'grace') return [];
  s.phase = 'pending';
  s.launchedAt = now;
  s.viaSteam = !!(opts && opts.viaSteam);
  return [];
}

function endSession(s, end) {
  const start = s.sessionStart;
  s.phase = 'idle';
  s.launchedAt = 0;
  s.sessionStart = 0;
  const ms = Math.max(0, end - start);
  return ms;
}

function sessionEvent(start, end, ms, cfg) {
  if (ms < cfg.minSessionMs) {
    return { type: 'session-end', sessionStart: start, sessionEnd: end, sessionHours: 0, discarded: true };
  }
  return { type: 'session-end', sessionStart: start, sessionEnd: end, sessionHours: ms / 3600000, discarded: false };
}

// One poll result. Returns the events to emit, in order.
function observe(s, seen, now, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const events = [];
  switch (s.phase) {
    case 'idle':
    case 'pending': {
      if (seen) {
        s.phase = 'running';
        s.sessionStart = now;
        s.lastSeen = now;
        events.push({ type: 'started', sessionStart: now });
      } else if (s.phase === 'pending') {
        const limit = s.viaSteam ? cfg.steamPendingTimeoutMs : cfg.pendingTimeoutMs;
        if (now - s.launchedAt >= limit) {
          s.phase = 'idle';
          s.launchedAt = 0;
          events.push({ type: 'gave-up' });
        }
      }
      break;
    }
    case 'running': {
      if (seen) {
        s.lastSeen = now;
        events.push({ type: 'tick', sessionMs: now - s.sessionStart });
      } else {
        s.phase = 'grace';
      }
      break;
    }
    case 'grace': {
      if (seen) {
        s.phase = 'running';
        s.lastSeen = now;
        events.push({ type: 'tick', sessionMs: now - s.sessionStart });
      } else if (now - s.lastSeen >= cfg.graceMs) {
        const start = s.sessionStart;
        const end = s.lastSeen;
        const ms = endSession(s, end);
        events.push(sessionEvent(start, end, ms, cfg));
      }
      break;
    }
    default:
      s.phase = 'idle';
  }
  return events;
}

// Stop pressed / app quitting / game removed: close any open session now.
function stop(s, now, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  if (s.phase === 'running' || s.phase === 'grace') {
    const start = s.sessionStart;
    const end = s.phase === 'running' ? now : s.lastSeen;
    const ms = endSession(s, end);
    return [sessionEvent(start, end, ms, cfg)];
  }
  s.phase = 'idle';
  s.launchedAt = 0;
  return [];
}

function isActive(s) {
  return s.phase === 'pending' || s.phase === 'running' || s.phase === 'grace';
}

// Delay until the next poll, given every game's state.
function pollDelay(states, now, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  let delay = cfg.idlePollMs;
  for (const s of states) {
    if (s.phase === 'pending') {
      const fresh = now - s.launchedAt < cfg.fastPollWindowMs;
      delay = Math.min(delay, fresh ? cfg.fastPollMs : cfg.activePollMs);
    } else if (s.phase === 'running' || s.phase === 'grace') {
      delay = Math.min(delay, cfg.activePollMs);
    }
  }
  return delay;
}

module.exports = { DEFAULTS, createState, launch, observe, stop, isActive, pollDelay };
