const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDuration,
  formatClock,
  sessionStats,
  groupSessions,
  migrateStatuses,
} = require('../src/lib/sessions.js');

// Local-time constructors keep these tests independent of the host timezone.
const at = (year, month, day, hour = 0, minute = 0) =>
  new Date(year, month, day, hour, minute).getTime();

const NOW = at(2026, 7, 26, 21, 40); // Wed 26 Aug 2026, 21:40 local

/* ------------------------------------------------------------------ */
/* formatDuration                                                      */
/* ------------------------------------------------------------------ */

test('formatDuration: zero and under a minute', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(0.008), '<1m'); // 0.48 min rounds to 0
  assert.equal(formatDuration(0.0209), '1m'); // 1.254 min
});

test('formatDuration: minutes and hours', () => {
  assert.equal(formatDuration(0.7), '42m');
  assert.equal(formatDuration(2), '2h');
  assert.equal(formatDuration(2 + 19 / 60), '2h 19m');
  assert.equal(formatDuration(2.5), '2h 30m');
});

test('formatDuration: negative and non-finite values are an em dash', () => {
  assert.equal(formatDuration(-1), '\u2014');
  assert.equal(formatDuration(-0.5), '\u2014');
  assert.equal(formatDuration(NaN), '\u2014');
  assert.equal(formatDuration(Infinity), '\u2014');
  assert.equal(formatDuration(-Infinity), '\u2014');
  assert.equal(formatDuration(undefined), '\u2014');
});

/* ------------------------------------------------------------------ */
/* formatClock                                                         */
/* ------------------------------------------------------------------ */

test('formatClock: seconds and minutes', () => {
  assert.equal(formatClock(41 * 1000), '00:41');
  assert.equal(formatClock((41 * 60 + 12) * 1000), '41:12');
  assert.equal(formatClock((59 * 60 + 59) * 1000), '59:59');
});

test('formatClock: hours are unpadded, minutes and seconds are padded', () => {
  assert.equal(formatClock((1 * 3600 + 4 * 60 + 9) * 1000), '1:04:09');
  assert.equal(formatClock(2 * 3600 * 1000), '2:00:00');
  assert.equal(formatClock(12 * 3600 * 1000), '12:00:00');
});

test('formatClock: negative and non-finite values are an em dash', () => {
  assert.equal(formatClock(-1), '\u2014');
  assert.equal(formatClock(NaN), '\u2014');
  assert.equal(formatClock(Infinity), '\u2014');
  assert.equal(formatClock(undefined), '\u2014');
});

/* ------------------------------------------------------------------ */
/* sessionStats                                                        */
/* ------------------------------------------------------------------ */

test('sessionStats: empty input gives zeroes', () => {
  assert.deepEqual(sessionStats([], NOW), {
    count: 0,
    totalHours: 0,
    averageMinutes: 0,
    longestMinutes: 0,
    weekHours: 0,
    monthHours: 0,
    activeWeeks: 0,
  });
  assert.equal(sessionStats(undefined, NOW).count, 0);
});

test('sessionStats: totals, average and longest ignore invalid sessions', () => {
  const sessions = [
    { start: at(2026, 7, 26, 9, 0), end: at(2026, 7, 26, 11, 0), duration: 2 },
    { start: at(2026, 7, 25, 9, 0), duration: 1 },
    { start: at(2026, 7, 24, 9, 0), duration: 0.5 },
    { start: at(2026, 7, 24, 10, 0), duration: 0 },
    { start: NaN, duration: 5 },
    { duration: 3 },
  ];

  const stats = sessionStats(sessions, NOW);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalHours, 3.5);
  assert.equal(stats.averageMinutes, 70);
  assert.equal(stats.longestMinutes, 120);
  assert.equal(stats.weekHours, 3.5);
  assert.equal(stats.monthHours, 3.5);
  assert.equal(stats.activeWeeks, 1);
});

test('sessionStats: week starts Monday 00:00 local', () => {
  const sessions = [
    { start: at(2026, 7, 23, 23, 59), duration: 1 }, // Sunday, previous week
    { start: at(2026, 7, 24, 0, 1), duration: 2 }, // Monday, current week
  ];

  const stats = sessionStats(sessions, NOW);
  assert.equal(stats.count, 2);
  assert.equal(stats.totalHours, 3);
  assert.equal(stats.weekHours, 2);
  assert.equal(stats.activeWeeks, 2);
});

test('sessionStats: month follows the local calendar month', () => {
  const sessions = [
    { start: at(2026, 6, 31, 23, 59), duration: 1 }, // July 31
    { start: at(2026, 7, 1, 0, 1), duration: 2 }, // August 1
    { start: at(2026, 8, 1, 0, 1), duration: 4 }, // September 1, next month
  ];

  const stats = sessionStats(sessions, NOW);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalHours, 7);
  assert.equal(stats.monthHours, 2);
  assert.equal(stats.weekHours, 0);
});

test('sessionStats: activeWeeks counts distinct Monday weeks in the last 12', () => {
  const sessions = [
    { start: at(2026, 7, 26, 10, 0), duration: 1 }, // week of Aug 24
    { start: at(2026, 7, 24, 10, 0), duration: 1 }, // same week
    { start: at(2026, 7, 19, 10, 0), duration: 1 }, // week of Aug 17
    { start: at(2026, 7, 5, 10, 0), duration: 1 }, // week of Aug 3
    { start: at(2026, 6, 6, 10, 0), duration: 1 }, // week of Jul 6
    { start: at(2026, 5, 1, 10, 0), duration: 1 }, // week of Jun 1, outside 12 weeks
  ];

  assert.equal(sessionStats(sessions, NOW).activeWeeks, 4);
});

/* ------------------------------------------------------------------ */
/* groupSessions                                                       */
/* ------------------------------------------------------------------ */

test('groupSessions: empty or missing input gives no groups', () => {
  assert.deepEqual(groupSessions([]), []);
  assert.deepEqual(groupSessions(null), []);
  assert.deepEqual(groupSessions(undefined), []);
});

test('groupSessions: one month groups, totals and row labels', () => {
  const sessions = [
    { start: at(2026, 7, 12, 9, 5), end: at(2026, 7, 12, 9, 50), duration: 0.75 },
    { start: at(2026, 7, 26, 21, 40), end: at(2026, 7, 26, 23, 59), duration: 2 + 19 / 60 },
  ];

  const groups = groupSessions(sessions, NOW);
  assert.equal(groups.length, 1);

  const group = groups[0];
  assert.equal(group.key, '2026-08');
  assert.equal(group.label, 'August 2026');
  assert.equal(group.count, 2);
  assert.equal(group.totalHours, 3.07);
  assert.equal(group.gapBeforeWeeks, null);
  assert.equal(group.items.length, 2);
  assert.equal(group.items[0].start, sessions[1].start);
  assert.equal(group.items[0].dayLabel, 'Wed 26');
  assert.equal(group.items[0].startLabel, '21:40');
  assert.equal(group.items[0].durationLabel, '2h 19m');
  assert.equal(group.items[0].crossesMidnight, false);
  assert.equal(group.items[1].durationLabel, '45m');
});

test('groupSessions: two months, newest month and newest rows first', () => {
  const sessions = [
    { start: at(2026, 6, 12, 10, 0), duration: 1 }, // July 12
    { start: at(2026, 7, 26, 21, 40), duration: 2 }, // August 26
    { start: at(2026, 7, 3, 18, 5), duration: 1.5 }, // August 3
  ];

  const groups = groupSessions(sessions, NOW);
  assert.deepEqual(groups.map((group) => group.key), ['2026-08', '2026-07']);
  assert.equal(groups[0].label, 'August 2026');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].totalHours, 3.5);
  assert.deepEqual(
    groups[0].items.map((item) => item.start),
    [sessions[1].start, sessions[2].start]
  );
  assert.equal(groups[1].label, 'July 2026');
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].gapBeforeWeeks, null);
});

test('groupSessions: invalid sessions are ignored', () => {
  const goodStart = at(2026, 7, 26, 20, 0);
  const sessions = [
    null,
    undefined,
    {},
    { start: goodStart, duration: 0 },
    { start: goodStart, duration: -1 },
    { start: NaN, duration: 1 },
    { start: Infinity, duration: 1 },
    { start: goodStart, duration: NaN },
    { start: goodStart, end: at(2026, 7, 26, 21, 0), duration: 1 },
  ];

  const groups = groupSessions(sessions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 1);
  assert.equal(groups[0].totalHours, 1);
  assert.equal(groups[0].items.length, 1);
});

test('groupSessions: unsorted input is not mutated', () => {
  const older = { start: at(2026, 7, 3, 18, 5), duration: 1.5 };
  const newer = { start: at(2026, 7, 26, 21, 40), duration: 2 };
  const sessions = [older, newer];
  const snapshot = sessions.map((session) => ({ ...session }));

  const groups = groupSessions(sessions);
  assert.equal(groups[0].items[0].start, newer.start);
  assert.equal(groups[0].items[1].start, older.start);
  assert.deepEqual(sessions, snapshot);
  assert.equal(sessions[0], older);
  assert.notEqual(groups[0].items[0], newer);
});

test('groupSessions: cross-midnight rows are flagged and grouped by start', () => {
  const sessions = [
    { start: at(2026, 7, 26, 23, 50), end: at(2026, 7, 27, 0, 10), duration: 20 / 60 },
    { start: at(2026, 7, 25, 22, 0), end: at(2026, 7, 25, 23, 0), duration: 1 },
    { start: at(2026, 7, 31, 23, 50), end: at(2026, 8, 1, 0, 10), duration: 20 / 60 },
  ];

  const groups = groupSessions(sessions, NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, '2026-08'); // the Aug 31 row does not move to September
  assert.equal(groups[0].items[0].start, sessions[2].start);
  assert.equal(groups[0].items[0].crossesMidnight, true);
  assert.equal(groups[0].items[1].crossesMidnight, true);
  assert.equal(groups[0].items[2].crossesMidnight, false);
  assert.equal(groups[0].items[0].dayLabel, 'Mon 31');
});

test('groupSessions: gapBeforeWeeks is set only when more than 3 weeks', () => {
  const far = groupSessions([
    { start: at(2026, 6, 1, 12, 0), duration: 1 }, // July 1
    { start: at(2026, 7, 26, 21, 40), duration: 1 }, // August 26 (8 weeks later)
  ]);
  assert.equal(far[0].gapBeforeWeeks, 8);
  assert.equal(far[1].gapBeforeWeeks, null);

  const exactlyThree = groupSessions([
    { start: at(2026, 6, 31, 12, 0), duration: 1 }, // July 31
    { start: at(2026, 7, 21, 12, 0), duration: 1 }, // August 21 (exactly 3 weeks)
  ]);
  assert.equal(exactlyThree[0].gapBeforeWeeks, null);
  assert.equal(exactlyThree[1].gapBeforeWeeks, null);

  const four = groupSessions([
    { start: at(2026, 6, 31, 12, 0), duration: 1 }, // July 31
    { start: at(2026, 7, 28, 12, 0), duration: 1 }, // August 28 (4 weeks)
  ]);
  assert.equal(four[0].gapBeforeWeeks, 4);
});

/* ------------------------------------------------------------------ */
/* migrateStatuses                                                     */
/* ------------------------------------------------------------------ */

test('migrateStatuses: Dropped becomes null on a clone', () => {
  const input = [{
    id: 'a',
    name: 'Alpha',
    status: 'Dropped',
    wishlisted: true,
    hours: 12,
    notes: 'keep me',
  }];

  const result = migrateStatuses(input);
  assert.deepEqual(result.changed, { dropped: 1, want: 0 });
  assert.equal(result.games[0].status, null);
  assert.equal(result.games[0].wishlisted, true); // already wishlisted stays true
  assert.equal(result.games[0].hours, 12);
  assert.equal(result.games[0].notes, 'keep me');
  assert.notEqual(result.games[0], input[0]);
});

test('migrateStatuses: Want becomes null plus wishlisted', () => {
  const input = [{
    id: 'w',
    name: 'Wanted',
    status: 'Want',
    hours: 0,
    notes: 'maybe later',
  }];

  const result = migrateStatuses(input);
  assert.deepEqual(result.changed, { dropped: 0, want: 1 });
  assert.equal(result.games[0].status, null);
  assert.equal(result.games[0].wishlisted, true);
  assert.equal(result.games[0].notes, 'maybe later');
  assert.notEqual(result.games[0], input[0]);
});

test('migrateStatuses: preserves other fields and does not mutate input', () => {
  const sessions = [{ start: at(2026, 7, 26, 21, 40), duration: 2 }];
  const input = [
    { id: 'x', name: 'X', status: 'Dropped', hours: 4, sessions, notes: 'n' },
    { id: 'y', name: 'Y', status: 'Finished', wishlisted: true, hours: 2 },
    { id: 'z', name: 'Z', hours: 0 },
  ];
  const deepBefore = JSON.parse(JSON.stringify(input));

  const result = migrateStatuses(input);
  assert.deepEqual(input, deepBefore);
  assert.equal(result.games[0].sessions, sessions); // shallow clone
  assert.equal(result.games[0].wishlisted, undefined);
  assert.equal(result.games[1].status, 'Finished');
  assert.equal(result.games[1].wishlisted, true);
  assert.equal(result.games[2].status, undefined);
  assert.ok(result.games.every((game, index) => game !== input[index]));
});

test('migrateStatuses: running it twice is a no-op', () => {
  const input = [
    { id: 'a', name: 'Alpha', status: 'Dropped' },
    { id: 'b', name: 'Beta', status: 'Want' },
    { id: 'c', name: 'Gamma', status: 'Playing' },
  ];

  const first = migrateStatuses(input);
  const second = migrateStatuses(first.games);

  assert.deepEqual(second.changed, { dropped: 0, want: 0 });
  assert.deepEqual(second.games, first.games);
  assert.notEqual(second.games[0], first.games[0]);
});
