const test = require('node:test');
const assert = require('node:assert/strict');

const { dayBuckets, weekBuckets, playStreak, allSessions, topGames } = require('../src/lib/sessions.js');

// Local-time constructors keep these tests independent of the host timezone.
const at = (year, month, day, hour = 0, minute = 0) => new Date(year, month, day, hour, minute).getTime();
const NOW = at(2026, 7, 26, 21, 40); // Wed 26 Aug 2026, 21:40 local
const s = (start, duration) => ({ start, end: start + duration * 3600000, duration });

test('dayBuckets: one bucket per day, oldest first, ending today', () => {
  const out = dayBuckets([
    s(at(2026, 7, 26, 10), 1.5),
    s(at(2026, 7, 26, 18), 0.5),
    s(at(2026, 7, 24, 23, 30), 2), // counts on the day it started
    s(at(2026, 7, 10), 3), // outside the window
    { start: at(2026, 7, 25), duration: 0 }, // not a session
  ], 7, NOW);
  assert.equal(out.length, 7);
  assert.equal(out[0].start, at(2026, 7, 20));
  assert.equal(out[6].start, at(2026, 7, 26));
  assert.deepEqual(out.map((b) => b.hours), [0, 0, 0, 0, 2, 0, 2]);
  assert.equal(out[6].count, 2);
});

test('dayBuckets: bad input gives empty buckets', () => {
  assert.deepEqual(dayBuckets(null, 3, NOW).map((b) => b.hours), [0, 0, 0]);
  assert.equal(dayBuckets([], 0, NOW).length, 1);
});

test('weekBuckets: Monday-based weeks ending with this one', () => {
  const out = weekBuckets([
    s(at(2026, 7, 24, 9), 1), // Mon this week
    s(at(2026, 7, 23, 22), 2), // Sun last week
    s(at(2026, 7, 3, 12), 4), // Mon 3 weeks ago
  ], 4, NOW);
  assert.equal(out.length, 4);
  assert.equal(out[3].start, at(2026, 7, 24));
  assert.equal(out[0].start, at(2026, 7, 3));
  assert.deepEqual(out.map((b) => b.hours), [4, 0, 2, 1]);
});

test('playStreak: current run ends today or yesterday', () => {
  const days = (list) => list.map((d) => s(at(2026, 7, d, 20), 1));
  assert.deepEqual(playStreak(days([24, 25, 26]), NOW), { current: 3, best: 3 });
  assert.deepEqual(playStreak(days([23, 24, 25]), NOW), { current: 3, best: 3 }, 'yesterday keeps it alive');
  assert.deepEqual(playStreak(days([10, 11, 12, 13, 22, 23]), NOW), { current: 0, best: 4 });
  assert.deepEqual(playStreak([], NOW), { current: 0, best: 0 });
  // two sessions on one day are one day
  assert.deepEqual(playStreak([s(at(2026, 7, 26, 9), 1), s(at(2026, 7, 26, 20), 1)], NOW), { current: 1, best: 1 });
});

test('allSessions: every game, newest first, tagged with the game', () => {
  const out = allSessions([
    { id: 'a', sessions: [s(at(2026, 7, 20), 1), s(at(2026, 7, 25), 1)] },
    { id: 'b', sessions: [s(at(2026, 7, 22), 1), { start: 1, duration: -1 }] },
    { id: 'c' },
    null,
  ]);
  assert.deepEqual(out.map((x) => x.gameId), ['a', 'b', 'a']);
});

test('topGames: ranks by hours in the range, or all-time hours', () => {
  const games = [
    { id: 'a', hours: 50, sessions: [s(at(2026, 7, 25), 1)] },
    { id: 'b', hours: 5, sessions: [s(at(2026, 7, 24), 3), s(at(2026, 6, 1), 2)] },
    { id: 'c', hours: 0, sessions: [] },
  ];
  assert.deepEqual(topGames(games, null).map((g) => g.id), ['a', 'b']);
  const recent = topGames(games, at(2026, 7, 20));
  assert.deepEqual(recent.map((g) => [g.id, g.hours, g.count]), [['b', 3, 1], ['a', 1, 1]]);
  assert.equal(topGames(games, null, 1).length, 1);
});

test('isActive: opened, played or a session in the last 7 days', () => {
  const { isActive } = require('../src/lib/sessions.js');
  const DAY = 864e5;
  assert.equal(isActive({ lastOpened: NOW - 2 * DAY }, NOW), true, 'launched 2 days ago');
  assert.equal(isActive({ lastPlayed: NOW - 6.9 * DAY }, NOW), true);
  assert.equal(isActive({ lastPlayed: NOW - 7.1 * DAY }, NOW), false, 'just over a week');
  assert.equal(isActive({ sessions: [s(NOW - 3 * DAY, 1)] }, NOW), true);
  assert.equal(isActive({ sessions: [s(NOW - 30 * DAY, 1)], lastOpened: NOW - 20 * DAY }, NOW), false);
  assert.equal(isActive({ status: 'Playing' }, NOW), false, 'status alone does not count');
  assert.equal(isActive({ lastPlayed: NOW - 10 * DAY }, NOW, 14), true, 'custom window');
  assert.equal(isActive(null, NOW), false);
});
