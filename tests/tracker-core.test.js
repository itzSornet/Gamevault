'use strict';

// HORIZON-2.0 M1 "Truth" fixtures: wrapper→game, launcher-only, direct exe,
// plus grace, failure and Stop. Time is simulated; nothing is launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/backend/tracker-core.js');

// Drive one game through a timeline. `seenAt(t)` says whether the track
// process is visible at time t (ms). Polls every `step` ms until `until`.
function simulate({ seenAt, until, step = 3000, launchAt = 0, viaSteam = false, stopAt = null }) {
  const s = core.createState();
  const events = [];
  core.launch(s, launchAt, { viaSteam });
  for (let t = launchAt; t <= until; t += step) {
    if (stopAt !== null && t >= stopAt) {
      events.push(...core.stop(s, t).map((e) => ({ ...e, at: t })));
      break;
    }
    events.push(...core.observe(s, seenAt(t), t).map((e) => ({ ...e, at: t })));
  }
  return { s, events, ends: events.filter((e) => e.type === 'session-end') };
}

const MIN = 60 * 1000;

test('direct exe: one session with the right length', () => {
  const { ends, events } = simulate({ seenAt: (t) => t >= 3000 && t <= 30 * MIN, until: 40 * MIN });
  assert.equal(events.filter((e) => e.type === 'started').length, 1);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].discarded, false);
  // ends at the last poll the game was seen, not when the grace ran out
  assert.ok(Math.abs(ends[0].sessionEnd - 30 * MIN) <= 3000);
  assert.ok(Math.abs(ends[0].sessionHours - (30 * MIN - 3000) / 3600000) < 0.01);
});

test('wrapper → game: the launcher exiting does not end anything', () => {
  // wrapper runs 0–10 s (not a track process); the game appears at 25 s
  const { ends, events } = simulate({ seenAt: (t) => t >= 25000 && t <= 20 * MIN, until: 25 * MIN });
  assert.equal(events.filter((e) => e.type === 'started').length, 1);
  assert.equal(events.find((e) => e.type === 'started').sessionStart >= 25000, true);
  assert.equal(ends.length, 1);
  assert.equal(events.some((e) => e.type === 'gave-up'), false);
});

test('launcher-only: nothing ever seen → no playtime, gives up', () => {
  const { ends, events } = simulate({ seenAt: () => false, until: 5 * MIN });
  assert.equal(ends.length, 0);
  assert.equal(events.filter((e) => e.type === 'gave-up').length, 1);
  const gaveUp = events.find((e) => e.type === 'gave-up');
  assert.ok(gaveUp.at >= core.DEFAULTS.pendingTimeoutMs && gaveUp.at < core.DEFAULTS.pendingTimeoutMs + 3000);
});

test('Steam launches get a longer pending window', () => {
  const { events } = simulate({ seenAt: () => false, until: 5 * MIN, viaSteam: true });
  const gaveUp = events.find((e) => e.type === 'gave-up');
  assert.ok(gaveUp.at >= core.DEFAULTS.steamPendingTimeoutMs);
});

test('40 s gap (e.g. game restarts itself) stays one session', () => {
  const seenAt = (t) => (t >= 3000 && t < 10 * MIN) || (t >= 10 * MIN + 40000 && t <= 20 * MIN);
  const { ends } = simulate({ seenAt, until: 25 * MIN });
  assert.equal(ends.length, 1);
  assert.ok(ends[0].sessionHours > 19 / 60);
});

test('2 minute gap splits into two sessions', () => {
  const seenAt = (t) => (t >= 3000 && t < 10 * MIN) || (t >= 12 * MIN && t <= 20 * MIN);
  const { ends } = simulate({ seenAt, until: 25 * MIN });
  assert.equal(ends.length, 2);
  assert.equal(ends.every((e) => !e.discarded), true);
});

test('blips under 30 s are discarded, not counted', () => {
  const { ends } = simulate({ seenAt: (t) => t >= 3000 && t <= 15000, until: 3 * MIN });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].discarded, true);
  assert.equal(ends[0].sessionHours, 0);
});

test('Stop closes the session at the moment it was pressed', () => {
  const { ends } = simulate({ seenAt: (t) => t >= 3000, until: 60 * MIN, stopAt: 10 * MIN });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].sessionEnd, 10 * MIN);
});

test('Stop during grace ends at the last time the game was seen', () => {
  const s = core.createState();
  core.launch(s, 0);
  core.observe(s, true, 0);
  core.observe(s, true, 5 * MIN);
  core.observe(s, false, 5 * MIN + 3000); // grace
  const [end] = core.stop(s, 5 * MIN + 20000);
  assert.equal(end.sessionEnd, 5 * MIN);
});

test('retry after giving up works', () => {
  const s = core.createState();
  core.launch(s, 0);
  const gave = core.observe(s, false, core.DEFAULTS.pendingTimeoutMs);
  assert.equal(gave[0].type, 'gave-up');
  core.launch(s, 200000);
  const started = core.observe(s, true, 203000);
  assert.equal(started[0].type, 'started');
});

test('poll delay: fast while freshly pending, active while running, slow when idle', () => {
  const pending = core.createState(); core.launch(pending, 0);
  assert.equal(core.pollDelay([pending], 1000), core.DEFAULTS.fastPollMs);
  assert.equal(core.pollDelay([pending], 30000), core.DEFAULTS.activePollMs);
  const idle = core.createState();
  assert.equal(core.pollDelay([idle], 0), core.DEFAULTS.idlePollMs);
});

const platform = require('../src/backend/platform.js');

test('parseRunningAppId reads the reg.exe DWORD (hex or decimal)', () => {
  const out = '\r\nHKEY_CURRENT_USER\Software\Valve\Steam\r\n    RunningAppID    REG_DWORD    0x2da\r\n';
  assert.equal(platform.parseRunningAppId(out), 730);
  assert.equal(platform.parseRunningAppId('RunningAppID REG_DWORD 0x0'), 0);
  assert.equal(platform.parseRunningAppId(''), 0);
  assert.equal(platform.parseRunningAppId('ERROR: The system was unable to find the specified registry key'), 0);
});

test('steamAppIdFromUri accepts rungameid/run/launch only', () => {
  assert.equal(platform.steamAppIdFromUri('steam://rungameid/730'), '730');
  assert.equal(platform.steamAppIdFromUri('STEAM://run/1245620'), '1245620');
  assert.equal(platform.steamAppIdFromUri('steam://store/730'), '');
  assert.equal(platform.steamAppIdFromUri('https://store.steampowered.com/app/730'), '');
});
