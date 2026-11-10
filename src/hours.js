// hours.js — Opening hours per day, with split days (9:30–13:30 and 16:30–20:00). Pure functions.
//
// settings.hours: { mon: [["09:30","13:30"],["16:30","20:00"]], …, sat: [["09:00","14:00"]] }
// A day with no entry (or an empty list) is closed. Without `hours`, they are built from the older
// settings opens / closes / closedWeekdays, so existing salons keep working.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_PLURALS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// "9:30", "16:00" (no leading zero: how people write opening hours)
const clock = mins => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
const weekdayOf = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

// Clock ranges for a time of day on a continuous day (minutes since midnight, [from, to))
const CLOCK_RANGES = { morning: [0, 14 * 60], midday: [13 * 60, 16 * 60], afternoon: [15 * 60, 24 * 60] };

// Open intervals for each weekday (0 = Sunday), in minutes: [[start, end], …]
function weekHours(business) {
  if (business.hours) {
    return DAY_KEYS.map(k => (business.hours[k] ?? []).map(([a, b]) => [toMinutes(a), toMinutes(b)]).sort((x, y) => x[0] - y[0]));
  }
  const closed = business.closedWeekdays ?? [];
  return DAY_KEYS.map((_, d) => (closed.includes(d) ? [] : [[toMinutes(business.opens ?? '09:30'), toMinutes(business.closes ?? '20:00')]]));
}
const dayHours = (business, isoDate) => weekHours(business)[weekdayOf(isoDate)];
// Weekdays with no opening at all (for "los domingos cerramos")
const closedWeekdaysOf = business => weekHours(business).map((h, d) => (h.length ? null : d)).filter(d => d !== null);

// The part of the day a time of day means, as a list of [from, to). Split days: "mañana" is the first
// interval and "tarde" the later ones; continuous days use the clock ranges. [] = closed then.
function timeOfDayIntervals(intervals, timeOfDay) {
  if (!timeOfDay || !intervals.length) return intervals;
  if (intervals.length >= 2) {
    if (timeOfDay === 'morning') return [intervals[0]];
    if (timeOfDay === 'afternoon') return intervals.slice(1);
    // midday on a split day: around the lunch break (the end of the morning and the start of the afternoon)
    return intervals;
  }
  const [from, to] = CLOCK_RANGES[timeOfDay];
  return intervals.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
}

// The lunch break of a split day, as [from, to], or null
const lunchBreak = intervals => (intervals.length >= 2 ? [intervals[0][1], intervals[1][0]] : null);

// Does an appointment [start, start + duration) fit entirely inside one open interval?
const fitsInside = (intervals, start, duration) => intervals.some(([a, b]) => start >= a && start + duration <= b);

const intervalsText = intervals => intervals.map(([a, b]) => `de ${clock(a)} a ${clock(b)}`).join(' y ');

// "De lunes a viernes de 9:30 a 13:30 y de 16:30 a 20:00. Sábados de 9:00 a 14:00. Domingos cerrado."
// Consecutive days (Monday → Sunday) with the same hours are grouped.
function hoursSummary(business) {
  const week = weekHours(business);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  for (const d of order) {
    const key = JSON.stringify(week[d]);
    const last = groups.at(-1);
    if (last && last.key === key) last.days.push(d); else groups.push({ key, days: [d], hours: week[d] });
  }
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const daysText = days => days.length === 1 ? DAY_PLURALS[days[0]]
    : days.length === 2 ? `${DAY_PLURALS[days[0]]} y ${DAY_PLURALS[days[1]]}`
    : `de ${DAY_NAMES[days[0]]} a ${DAY_NAMES[days.at(-1)]}`;
  // open days first (grouped), then the closed ones together: "… Lunes y domingos cerrado."
  const open = groups.filter(g => g.hours.length).map(g => `${cap(daysText(g.days))} ${intervalsText(g.hours)}.`);
  const closedDays = order.filter(d => !week[d].length);
  const closed = closedDays.length ? [`${cap(closedDays.map(d => DAY_PLURALS[d]).join(', ').replace(/, ([^,]*)$/, ' y $1'))} cerrado.`] : [];
  return [...open, ...closed].join(' ');
}

module.exports = {
  DAY_KEYS, DAY_NAMES, DAY_PLURALS, CLOCK_RANGES, toMinutes, clock,
  weekHours, dayHours, closedWeekdaysOf, timeOfDayIntervals, lunchBreak, fitsInside, intervalsText, hoursSummary,
};
