// conversation.js — Default salon settings, a new conversation state, and the bot's limits.

// Sample business settings. Each business has its own (see src/demo-data.js and the businesses table).
const DEFAULT_BUSINESS = {
  opens: '09:30',
  closes: '20:00',
  closedWeekdays: [0],   // 0 = Sunday (only used when there is no `hours`)
  hours: null,           // per day, split days allowed: { mon: [["09:30","13:30"],["16:30","20:00"]], … }; no entry = closed
  closedDates: [],       // public holidays: ['2026-12-08', '2026-12-25'] (or { date, reason })
  closedRanges: [],      // holidays: [{ from: '2026-08-10', to: '2026-08-24', reason: 'vacaciones' }]
  slotMinutes: 30,       // proposals start every 30 minutes
  maxProposals: 2,       // how many times the bot offers at once
  capacity: 1,           // appointments that can overlap (chairs / staff)
  address: null,         // answered when she asks where the salon is
  timezone: 'Europe/Madrid', // bot.js reads messages in the salon's wall-clock time
  minNoticeMinutes: 120, // no appointment may start sooner than now + this
  maxDaysAhead: 60,      // the diary is open this many days ahead
  // Answers the owner writes when setting up the salon. Empty ones are handed to the owner.
  info: {},              // { walkIn, payment, parking, children, pets, cancellationPolicy, latePolicy }
  name: null,            // the salon's name (bot.js passes it from the businesses table)
  askForNotes: true,     // before booking, ask "¿quieres que apunte algo especial?" and save it with the appointment
};

function newConversation() {
  return {
    lastQuestion: null,  // what the bot just asked: see understand() context
    proposals: [],       // times the bot just offered, e.g. ['10:00', '12:30']
    pending: {},         // appointment being built: { service, details, date, timeOfDay, time }
    mode: 'book',        // 'book' | 'reschedule'
    recentServices: [],  // services she asked about (e.g. prices), for "para las dos cosas"
    lastTopic: null,     // intent of the last message, for follow-ups like "¿y por la tarde también?"
    lastReply: null,     // last thing the bot said, so it never sends the same text twice in a row
    lastMessage: null,   // last message (normalized), to tell a repeated message from a new one
    misunderstood: 0,    // messages in a row the bot didn't understand (it goes silent after MAX_MISUNDERSTOOD)
    offered: null,       // { date, times }: every time already offered for that day, for "ninguna me va bien"
    waitlist: [],        // "avísame si se libera algo": what she is waiting for (bot.js saves each new one)
    appointment: null,   // confirmed appointment: { service, name, duration, date, time }
  };
}

// After MAX_MISUNDERSTOOD messages in a row it didn't understand, the bot stops answering (see index.js).
const MAX_MISUNDERSTOOD = 2;
const STALE_OFFER_MINUTES = 180; // an offer left unanswered this long is dropped
const MAX_LISTED_TIMES = 6;       // when she asks for more times, list up to this many

module.exports = { DEFAULT_BUSINESS, newConversation, MAX_MISUNDERSTOOD, STALE_OFFER_MINUTES, MAX_LISTED_TIMES };
