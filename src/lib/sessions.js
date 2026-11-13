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

  // ---- activity: playtime per day / week across one game or many ----------

  // Hours per local day, oldest first, ending today. A session counts on the
  // day it started.
  function dayBuckets(sessions, days, now) {
    const n = Math.max(1, Math.floor(days) || 1);
    const today = new Date(toTime(now));
    const first = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -(n - 1));
    const firstDay = localDayNumber(first);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ start: addDays(first, i).getTime(), hours: 0, count: 0 });
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!isValidSession(s)) continue;
      const i = localDayNumber(new Date(s.start)) - firstDay;
      if (i < 0 || i >= n) continue;
      out[i].hours += s.duration;
      out[i].count += 1;
    }
    for (const b of out) b.hours = round2(b.hours);
    return out;
  }

  // Hours per Monday-based week, oldest first, ending with this week.
  function weekBuckets(sessions, weeks, now) {
    const n = Math.max(1, Math.floor(weeks) || 1);
    const thisWeek = startOfWeek(new Date(toTime(now)));
    const first = addDays(thisWeek, -7 * (n - 1));
    const firstDay = localDayNumber(first);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ start: addDays(first, i * 7).getTime(), hours: 0, count: 0 });
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!isValidSession(s)) continue;
      const i = Math.floor((localDayNumber(new Date(s.start)) - firstDay) / 7);
      if (i < 0 || i >= n) continue;
      out[i].hours += s.duration;
      out[i].count += 1;
    }
    for (const b of out) b.hours = round2(b.hours);
    return out;
  }

  // Days in a row with play. The current streak is still alive when the
  // last day played was today or yesterday.
  function playStreak(sessions, now) {
    const days = new Set();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (isValidSession(s)) days.add(localDayNumber(new Date(s.start)));
    }
    if (!days.size) return { current: 0, best: 0 };
    const sorted = Array.from(days).sort((a, b) => a - b);
    let best = 1;
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    const today = localDayNumber(new Date(toTime(now)));
    let current = 0;
    let day = days.has(today) ? today : (days.has(today - 1) ? today - 1 : null);
    while (day !== null && days.has(day)) { current += 1; day -= 1; }
    return { current, best };
  }

  // Every session of every game, newest first, tagged with its game's id.
  function allSessions(games) {
    const out = [];
    for (const g of Array.isArray(games) ? games : []) {
      if (!g || !Array.isArray(g.sessions)) continue;
      for (const s of g.sessions) {
        if (isValidSession(s)) out.push(Object.assign({}, s, { gameId: g.id }));
      }
    }
    out.sort((a, b) => b.start - a.start);
    return out;
  }

  // Games ranked by hours played from `since` on (all of their recorded
  // hours when `since` is null). Games with no time in the range drop out.
  function topGames(games, since, limit) {
    const rows = [];
    for (const g of Array.isArray(games) ? games : []) {
      if (!g) continue;
      let hours = 0;
      let count = 0;
      if (since == null) {
        hours = Number(g.hours) || 0;
        count = Array.isArray(g.sessions) ? g.sessions.filter(isValidSession).length : 0;
      } else {
        for (const s of Array.isArray(g.sessions) ? g.sessions : []) {
          if (isValidSession(s) && s.start >= since) { hours += s.duration; count += 1; }
        }
      }
      if (hours > 0) rows.push({ id: g.id, hours: round2(hours), count });
    }
    rows.sort((a, b) => b.hours - a.hours || b.count - a.count);
    return isFiniteNumber(limit) ? rows.slice(0, limit) : rows;
  }

  // "Active": opened in the last `days` days (default 7). Counts a launch
  // (lastOpened), a finished session (lastPlayed) or any session start/end.
  const ACTIVE_DAYS = 7;
  function isActive(game, now, days) {
    if (!game || typeof game !== 'object') return false;
    const since = toTime(now) - (isFiniteNumber(days) ? days : ACTIVE_DAYS) * DAY_MS;
    if (isFiniteNumber(game.lastOpened) && game.lastOpened >= since) return true;
    if (isFiniteNumber(game.lastPlayed) && game.lastPlayed >= since) return true;
    for (const s of Array.isArray(game.sessions) ? game.sessions : []) {
      if (!isValidSession(s)) continue;
      const end = isFiniteNumber(s.end) ? s.end : s.start;
      if (end >= since) return true;
    }
    return false;
  }

  return {
    formatDuration,
    formatClock,
    sessionStats,
    groupSessions,
    migrateStatuses,
    isActive,
    ACTIVE_DAYS,
    dayBuckets,
    weekBuckets,
    playStreak,
    allSessions,
    topGames,
  };
});
