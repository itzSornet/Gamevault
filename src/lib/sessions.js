/* Play-session summaries and grouping shared by the renderer and main process.
 *
 * UMD-ish: in Node it exports, in the renderer it lands on window.Sessions.
 * All time-of-day/month/week bucketing is local time; weeks start Monday.
 * Sessions are read-only here: nothing in this file mutates its input.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sessions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function toTime(value) {
    if (value instanceof Date) return value.getTime();
    return isFiniteNumber(value) ? value : Date.now();
  }

  function isValidSession(session) {
    return (
      !!session &&
      isFiniteNumber(session.start) &&
      isFiniteNumber(session.duration) &&
      session.duration > 0
    );
  }

  function startOfWeek(date) {
    const mondayOffset = (date.getDay() + 6) % 7; // Monday = 0, Sunday = 6
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset);
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function localDayNumber(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  }

  // Whole calendar weeks between two local dates (DST-safe).
  function wholeWeeksBetween(olderMs, newerMs) {
    return Math.floor((localDayNumber(new Date(newerMs)) - localDayNumber(new Date(olderMs))) / 7);
  }

  // Hours as a float -> '<1m' | '42m' | '2h' | '2h 19m'.
  function formatDuration(hours) {
    if (!isFiniteNumber(hours) || hours < 0) return '\u2014';
    const totalMinutes = Math.round(hours * 60);
    if (totalMinutes < 1) return '<1m';
    if (totalMinutes < 60) return totalMinutes + 'm';

    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  // Milliseconds -> 'MM:SS' or 'H:MM:SS'.
  function formatClock(ms) {
    if (!isFiniteNumber(ms) || ms < 0) return '\u2014';

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    return pad2(minutes) + ':' + pad2(seconds);
  }

  // Totals for the current week/month plus rolling activity, all local time.
  function sessionStats(sessions, now) {
    const nowDate = new Date(toTime(now));
    const list = Array.isArray(sessions) ? sessions : [];
    const weekStart = startOfWeek(nowDate);
    const nextWeek = addDays(weekStart, 7);
    const monthStart = startOfMonth(nowDate);
    const nextMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1);
    const twelveWeekStart = addDays(weekStart, -11 * 7);

    let count = 0;
    let totalHours = 0;
    let weekHours = 0;
    let monthHours = 0;
    let longestMinutes = 0;
    const activeWeeks = new Set();

    for (const session of list) {
      if (!isValidSession(session)) continue;

      count += 1;
      totalHours += session.duration;
      longestMinutes = Math.max(longestMinutes, Math.round(session.duration * 60));

      if (session.start >= weekStart.getTime() && session.start < nextWeek.getTime()) {
        weekHours += session.duration;
      }
      if (session.start >= monthStart.getTime() && session.start < nextMonth.getTime()) {
        monthHours += session.duration;
      }
      if (session.start >= twelveWeekStart.getTime() && session.start <= nowDate.getTime()) {
        activeWeeks.add(startOfWeek(new Date(session.start)).getTime());
      }
    }

    return {
      count,
      totalHours: round2(totalHours),
      averageMinutes: count ? Math.round((totalHours * 60) / count) : 0,
      longestMinutes,
      weekHours: round2(weekHours),
      monthHours: round2(monthHours),
      activeWeeks: activeWeeks.size,
    };
  }

  function toDisplayItem(session) {
    const startDate = new Date(session.start);
    const hasEnd = isFiniteNumber(session.end);
    const endDate = hasEnd ? new Date(session.end) : null;

    return {
      start: session.start,
      end: session.end,
      duration: session.duration,
      dayLabel: WEEKDAYS[startDate.getDay()] + ' ' + startDate.getDate(),
      startLabel: pad2(startDate.getHours()) + ':' + pad2(startDate.getMinutes()),
      durationLabel: formatDuration(session.duration),
      crossesMidnight: !!endDate && localDayNumber(endDate) > localDayNumber(startDate),
    };
  }

  // Newest month first; each month's rows newest first.
  function groupSessions(sessions, now) {
    void now; // accepted for API symmetry; grouping is driven by session starts
    const list = Array.isArray(sessions) ? sessions : [];
    const valid = list.filter(isValidSession).slice();
    valid.sort((a, b) => b.start - a.start);

    const groups = [];
    const byKey = new Map();

    for (const session of valid) {
      const startDate = new Date(session.start);
      const key = startDate.getFullYear() + '-' + pad2(startDate.getMonth() + 1);
      let group = byKey.get(key);

      if (!group) {
        group = {
          key,
          label: MONTHS[startDate.getMonth()] + ' ' + startDate.getFullYear(),
          count: 0,
          totalHours: 0,
          gapBeforeWeeks: null,
          items: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }

      group.items.push(toDisplayItem(session));
      group.count += 1;
      group.totalHours += session.duration;
    }

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      group.totalHours = round2(group.totalHours);

      if (i === groups.length - 1) continue;
      const newerNewest = group.items[0].start;
      const olderNewest = groups[i + 1].items[0].start;
      const weeks = wholeWeeksBetween(olderNewest, newerNewest);
      group.gapBeforeWeeks = weeks > 3 ? weeks : null;
    }

    return groups;
  }

  // 'Dropped' -> null, 'Want' -> null + wishlisted, always on shallow clones.
  function migrateStatuses(games) {
    const list = Array.isArray(games) ? games : [];
    const changed = { dropped: 0, want: 0 };

    const migrated = list.map((game) => {
      if (!game || typeof game !== 'object') return game;

      const next = Object.assign({}, game);
      if (next.status === 'Dropped') {
        next.status = null;
        changed.dropped += 1;
      } else if (next.status === 'Want') {
        next.status = null;
        next.wishlisted = true;
        changed.want += 1;
      }
      return next;
    });

    return { games: migrated, changed };
  }

  return {
    formatDuration,
    formatClock,
    sessionStats,
    groupSessions,
    migrateStatuses,
  };
});
