// timezone.js — The salon's wall-clock time, whatever time zone the server runs in.
//
// understand.js and reply.js work with plain Date objects and read them with getDate(), getHours()…
// (the process's local fields). bot.js turns the real moment of a message into a Date whose local fields
// are the salon's wall-clock time, so "mañana" written at 00:30 in Madrid is the right day even on a
// server running in UTC, and an appointment at 10:00 stays at 10:00 across a daylight-saving change.
// No dependencies: Intl.DateTimeFormat.

const DEFAULT_TIMEZONE = 'Europe/Madrid';
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

// The salon's wall-clock time at `instant`, as { year, month (1-12), day, hour, minute, second }
function wallClock(instant, timeZone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

// A Date whose local fields (getDate, getHours…) are the salon's wall-clock time at `instant`
function salonNow(instant, timeZone = DEFAULT_TIMEZONE) {
  const w = wallClock(instant, timeZone);
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

// The real moment of a wall-clock time in the salon ("2026-11-10T10:00" in Madrid → that instant)
function instantAt(wall, timeZone = DEFAULT_TIMEZONE) {
  const [date, time = '00:00'] = wall.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = time.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) { // correct by the zone's offset at that moment (twice, for DST edges)
    const w = wallClock(new Date(guess), timeZone);
    guess += Date.UTC(y, m - 1, d, h, mi, s) - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  }
  return new Date(guess);
}

module.exports = { DEFAULT_TIMEZONE, wallClock, salonNow, instantAt };
