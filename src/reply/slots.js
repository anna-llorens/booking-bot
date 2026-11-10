// slots.js — Which times are free: opening hours, closed days, notice window, diary horizon. Pure.
const H = require('../hours');
const { toMinutes, toHHMM, toISODate, fromISODate } = require('./format');

// Simulated calendar: some slots are taken, always the same ones for a given day.
// Used when no real availability is passed in (tests, demos).
function isSimulatedBusy(isoDate, mins) {
  let h = 0;
  for (const c of `${isoDate}|${mins}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 10 < 4; // ~40 % of slots busy
}

// Why the salon is closed that day, or null if it is open: a weekly day off, a public holiday or holidays.
function closedReason(isoDate, business) {
  if (!H.dayHours(business, isoDate).length) return { kind: 'weekday' };
  for (const c of business.closedDates ?? []) {
    const date = typeof c === 'string' ? c : c.date;
    if (date === isoDate) return { kind: 'holiday', reason: (typeof c === 'object' && c.reason) || 'festivo' };
  }
  for (const r of business.closedRanges ?? []) {
    if (isoDate >= r.from && isoDate <= r.to) return { kind: 'range', reason: r.reason || 'vacaciones', from: r.from, to: r.to };
  }
  return null;
}

const monthName = iso => fromISODate(iso).toLocaleDateString('es-ES', { month: 'long' });

// "del 10 al 24 de agosto" / "del 28 de diciembre al 6 de enero"
function rangeText(from, to) {
  const a = fromISODate(from), b = fromISODate(to);
  return a.getMonth() === b.getMonth()
    ? `del ${a.getDate()} al ${b.getDate()} de ${monthName(to)}`
    : `del ${a.getDate()} de ${monthName(from)} al ${b.getDate()} de ${monthName(to)}`;
}

// "estamos de vacaciones" / "estamos cerrados por reformas"
const closedForText = reason => /^vacaciones/i.test(reason) ? `estamos de ${reason}` : `estamos cerrados por ${reason}`;

function closedNote(c) {
  if (c.kind === 'holiday') return `Ese día estamos cerrados (${c.reason}) 😔`;
  if (c.kind === 'range') { const t = rangeText(c.from, c.to); return `${t[0].toUpperCase()}${t.slice(1)} ${closedForText(c.reason)} 😔`; }
  return 'Ese día estamos cerrados 😔';
}

// "A mediodía" on a split day: the last hour before the lunch break and the first hour after it
function middayRanges(day) {
  const [from, to] = H.lunchBreak(day);
  return [[Math.max(day[0][0], from - 60), from], [to, Math.min(day[1][1], to + 60)]];
}

// Last day the diary is open (now + maxDaysAhead)
function lastBookableDate(now, business) {
  const d = new Date(now); d.setDate(d.getDate() + (business.maxDaysAhead ?? 60));
  return toISODate(d);
}

// Earliest moment an appointment may start (now + minNoticeMinutes)
const earliestStart = (now, business) => new Date(now.getTime() + (business.minNoticeMinutes ?? 0) * 60000);

// Start times (minutes) free that day: open, inside the notice window and the diary, and free in the calendar
function freeSlots(isoDate, { duration, timeOfDay }, now, business, isFree) {
  if (closedReason(isoDate, business)) return [];
  if (isoDate > lastBookableDate(now, business)) return [];
  const earliest = earliestStart(now, business);
  if (isoDate < toISODate(earliest)) return [];
  const minStart = isoDate === toISODate(earliest) ? earliest.getHours() * 60 + earliest.getMinutes() : -1;
  const day = H.dayHours(business, isoDate);
  // the appointment must fit entirely inside one open interval (no 90-minute tint at 12:30 if it closes at 13:30)
  const ranges = timeOfDay === 'midday' && H.lunchBreak(day) ? middayRanges(day) : H.timeOfDayIntervals(day, timeOfDay);
  const slots = [];
  for (const [a, b] of ranges) {
    for (let m = a; m + duration <= b; m += business.slotMinutes) {
      if (m < minStart || !H.fitsInside(day, m, duration)) continue;
      if (isFree(isoDate, m, duration)) slots.push(m);
    }
  }
  return [...new Set(slots)].sort((x, y) => x - y);
}

// Picks a few slots spread over the day (or the closest ones to the requested time).
function pickProposals(slots, wantedTime, max) {
  if (wantedTime) {
    const w = toMinutes(wantedTime);
    if (slots.includes(w)) return [toHHMM(w)];
    return [...slots].sort((a, b) => Math.abs(a - w) - Math.abs(b - w)).slice(0, 2).sort((a, b) => a - b).map(toHHMM);
  }
  if (slots.length <= max) return slots.map(toHHMM);
  const picked = [];
  for (let i = 0; i < max; i++) picked.push(slots[Math.round(i * (slots.length - 1) / (max - 1))]);
  return picked.map(toHHMM);
}

module.exports = { isSimulatedBusy, closedReason, monthName, rangeText, closedForText, closedNote, middayRanges, lastBookableDate, earliestStart, freeSlots, pickProposals };
