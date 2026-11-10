// reply.js — Turns what understand() found into the bot's answer, keeping the conversation state.
//
// It is a pure function: no database, no clock, no network. Everything it needs comes in as options
// (business settings, catalog, availability, the customer's usual service), and everything it decides
// comes out in the returned state. src/bot.js loads those inputs from the store and saves the result.
// Replies are in Spanish because customers write in Spanish.
//
// Usage:
//   let state = newConversation();
//   ({ reply, state } = respond('quiero cita para un corte el viernes', state));
//
// The state is plain JSON (dates as 'YYYY-MM-DD'), so it can be stored or travel to a browser and back.
// Without an isFree option, availability is simulated (the same slots are always busy for a given day).

const { understand } = require('./understand');
const { isNonsense, isLaugh } = require('./dictionary');
const SAMPLE_CATALOG = require('./catalog.json').services;

// Sample business settings. Each business has its own (see src/demo-data.js and the businesses table).
const DEFAULT_BUSINESS = {
  opens: '09:30',
  closes: '20:00',
  closedWeekdays: [0],   // 0 = Sunday
  closedDates: [],       // public holidays: ['2026-12-08', '2026-12-25'] (or { date, reason })
  closedRanges: [],      // holidays: [{ from: '2026-08-10', to: '2026-08-24', reason: 'vacaciones' }]
  slotMinutes: 30,       // proposals start every 30 minutes
  maxProposals: 2,       // how many times the bot offers at once
  capacity: 1,           // appointments that can overlap (chairs / staff)
  address: null,         // answered when she asks where the salon is
};

const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// "de lunes a sábado" / "de martes a sábado" / "todos los días"
function openDaysText(closed) {
  const open = [1, 2, 3, 4, 5, 6, 0].filter(d => !closed.includes(d));
  if (open.length === 7) return 'todos los días';
  return open.length > 1 ? `de ${WEEKDAY_NAMES[open[0]]} a ${WEEKDAY_NAMES[open.at(-1)]}` : `los ${WEEKDAY_NAMES[open[0]]}s`;
}
// "Los domingos cerramos." / "Los domingos y lunes cerramos."
function closedDaysText(closed) {
  if (!closed.length) return '';
  const names = [1, 2, 3, 4, 5, 6, 0].filter(d => closed.includes(d)).map(d => WEEKDAY_NAMES[d] + (d === 0 || d === 6 ? 's' : ''));
  return ` Los ${names.length > 1 ? names.slice(0, -1).join(', ') + ' y ' + names.at(-1) : names[0]} cerramos.`;
}
const euros = n => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;

const TIME_OF_DAY_RANGES = {     // [from, to) in minutes since midnight
  morning: [0, 14 * 60],
  midday: [13 * 60, 16 * 60],
  afternoon: [15 * 60, 24 * 60],
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

// ---------- helpers ----------

const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const toISODate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromISODate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function formatDate(iso, today) {
  const d = fromISODate(iso);
  const diff = Math.round((d - fromISODate(toISODate(today))) / 86400000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  const weekday = d.toLocaleDateString('es-ES', { weekday: 'long' });
  const month = d.toLocaleDateString('es-ES', { month: 'long' });
  return `el ${weekday} ${d.getDate()} de ${month}`;
}

// Name to show for a detected service. If she only named the general service ("manicura", "uñas"),
// don't claim a variant she didn't ask for: "Manicura básica" becomes "Manicura".
function displayName(d) {
  return d.id && d.id === d.group ? d.name.replace(/ b[aá]sic[oa]$/i, '') : d.name;
}

function serviceLabel(p) {
  if (p.service === 'LAST') return 'lo de siempre';
  if (p.details?.length) {
    // nail art on top of another manicure: "manicura semipermanente con dibujos"
    const others = p.details.filter(d => d.id !== 'nail_art');
    if (others.length && others.length < p.details.length) {
      const names = others.map(d => displayName(d).toLowerCase());
      return (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]) + ' con dibujos';
    }
    const names = p.details.map(d => displayName(d).toLowerCase());
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0];
  }
  return p.service;
}

// Simulated calendar: some slots are taken, always the same ones for a given day.
// Used when no real availability is passed in (tests, demos).
function isSimulatedBusy(isoDate, mins) {
  let h = 0;
  for (const c of `${isoDate}|${mins}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 10 < 4; // ~40 % of slots busy
}

// Why the salon is closed that day, or null if it is open: a weekly day off, a public holiday or holidays.
function closedReason(isoDate, business) {
  if ((business.closedWeekdays ?? []).includes(fromISODate(isoDate).getDay())) return { kind: 'weekday' };
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

function freeSlots(isoDate, { duration, timeOfDay }, today, business, isFree) {
  if (closedReason(isoDate, business)) return [];
  const nowMins = isoDate === toISODate(today) ? today.getHours() * 60 + today.getMinutes() : -1;
  const [from, to] = TIME_OF_DAY_RANGES[timeOfDay] ?? [0, 24 * 60];
  const slots = [];
  for (let m = toMinutes(business.opens); m + duration <= toMinutes(business.closes); m += business.slotMinutes) {
    if (m <= nowMins || m < from || m >= to) continue;
    if (isFree(isoDate, m, duration)) slots.push(m);
  }
  return slots;
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

function listTimes(times) {
  if (times.length === 1) return `a las ${times[0]}`;
  return times.map((t, i) => `${i + 1}) ${t}`).join('  ');
}

// "¿Qué día…" → "¿qué día…" (skips the opening ¿ / ¡)
const lowerFirst = s => s.replace(/^([¿¡]?)(\p{L})/u, (_, p, c) => p + c.toLowerCase());

// ---------- main ----------

// Same reply as the previous one ("vale" → "¡Perfecto! 😊" over and over): the bot stays silent.
// The message is still processed (and still handed to the owner if needed); only the text is not sent.
// A new question for the owner ("¿hay parking?" after "¿tenéis bizum?") still gets its answer
// even if the text is the same, unless she sent the very same message again.
// After MAX_MISUNDERSTOOD messages in a row it didn't understand, the bot stops answering
// (the owner still gets them and they are still logged) until she says something it understands.
const MAX_MISUNDERSTOOD = 2;

function respond(message, state = newConversation(), options = {}) {
  const previousReply = state?.lastReply ?? null;
  const previousMessage = state?.lastMessage ?? null;
  const result = computeReply(message, state, options);
  const misunderstood = result.fallback ? (state?.misunderstood ?? 0) + 1 : 0;
  result.state.misunderstood = misunderstood;
  if (misunderstood > MAX_MISUNDERSTOOD) {
    result.state.lastMessage = result.understanding.normalizedText;
    return { ...result, reply: '', silent: true, silentReason: 'misunderstood' };
  }
  const sameMessage = result.understanding.normalizedText === previousMessage;
  result.state.lastMessage = result.understanding.normalizedText;
  if (result.reply && result.reply === previousReply && (sameMessage || !result.handover)) {
    // She said something new ("después de comer", "esta semana a poder ser") but the times on offer are the
    // same: say so instead of going silent. Silence is only for a repeated message or a bare "vale".
    const bare = ['confirm', 'thanks', 'greeting', 'preamble', null].includes(result.understanding.intent);
    if (!sameMessage && !bare && result.state.lastQuestion === 'proposal') {
      const u = result.understanding;
      const reply = `${u.date || u.timeOfDay || u.anyDay || u.anyTime || u.time ? 'Es lo que tengo 😊' : '¡Perfecto! 😊'} ${result.reply}`;
      result.state.lastReply = reply;
      return { ...result, reply, silent: false };
    }
    return { ...result, reply: '', silent: true, silentReason: 'repeated' };
  }
  result.state.lastReply = result.reply;
  return { ...result, silent: false };
}

// Options:
//   today     Date            "now", for "mañana", "el viernes" and not proposing past times
//   services  [service]       the business catalog (see catalog.json); a service may have a price
//   business  {settings}      opening hours, closed days, capacity, address… (see DEFAULT_BUSINESS)
//   isFree    (date, startMinutes, duration) => bool   real availability; simulated if omitted
//   usual     [detail]        the customer's last service, for "lo de siempre"
function computeReply(message, state = newConversation(), {
  today = new Date(),
  services = SAMPLE_CATALOG,
  business: businessSettings = {},
  isFree = (date, start) => !isSimulatedBusy(date, start),
  usual = null,
} = {}) {
  const business = { ...DEFAULT_BUSINESS, ...businessSettings };
  state = JSON.parse(JSON.stringify(state)); // never mutate the caller's state
  const u = understand(message, {
    today,
    services,
    context: { lastQuestion: state.lastQuestion, proposals: state.proposals, hasAppointment: !!state.appointment },
  });

  const t = u.normalizedText;
  const previousTopic = state.lastTopic ?? null;
  let topic = u.intent;
  const out = (reply, extra = {}) => { state.lastTopic = topic; return { reply, understanding: u, state, handover: false, ...extra }; };
  const GOODBYE = /^(adios|chao|chau|bye|un beso|besos|besitos|hasta (luego|pronto|manana))\b/;
  const BOOKING_QUESTIONS = ['proposal', 'day', 'service', 'time', 'timeOfDay'];
  // Hands the message to the owner. In the middle of a booking the bot carries on with it;
  // otherwise it offers more help, so the next "no" / "sí" is understood.
  const handover = reply => {
    if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
      const step = nextStep();
      return { ...step, reply: `${reply} ${step.reply}`, handover: true };
    }
    state.lastQuestion = 'anythingElse'; state.proposals = [];
    return out(`${reply} ¿Puedo ayudarte en algo más?`, { handover: true });
  };
  // Remembers services she asks about without booking them (prices), for "para las dos cosas".
  const remember = details => {
    state.recentServices = state.recentServices ?? [];
    for (const d of details) if (!state.recentServices.some(r => r.id === d.id)) state.recentServices.push(d);
    state.recentServices = state.recentServices.slice(-3);
  };

  // "No" to "¿Quieres que te busque hueco?"
  if (state.lastQuestion === 'offerBooking' && /^no\b/.test(t) && !u.service && !u.date && !u.time) {
    state.lastQuestion = null;
    return out('¡Vale! Aquí estamos para lo que necesites 😊');
  }

  // "No" to "¿la anulo o la cambiamos?": keep it as it is
  if (['confirmCancel', 'changeOrCancel'].includes(state.lastQuestion) && state.appointment &&
      /^no\b/.test(t) && !['cancel', 'reschedule'].includes(u.intent) && !u.date && !u.time) {
    state.lastQuestion = null;
    return out(`¡Perfecto! La mantenemos: ${state.appointment.name.toLowerCase()}, ${formatDate(state.appointment.date, today)} a las ${state.appointment.time} 😊`);
  }

  // Answer to "¿Puedo ayudarte en algo más?"
  if (state.lastQuestion === 'anythingElse') {
    state.lastQuestion = null;
    if (/^(no|nop|nada|nada mas|no nada|no gracias|no es todo|eso es todo|ya esta|de momento no|por ahora no)( gracias| nada)?$/.test(t)) {
      return out('¡Perfecto! Que tengas un buen día 😊');
    }
    // "genial, gracias" / "adiós": she is done
    const bareReply = !u.service && !u.date && !u.time && !u.timeOfDay;
    if (bareReply && (u.intent === 'thanks' || GOODBYE.test(t) || (u.intent === 'confirm' && /\bgracias\b/.test(t)))) {
      return out('¡A ti! Que tengas un buen día 😊');
    }
    if (u.intent === 'confirm' && !u.service && !u.date && !u.time) return out('¡Claro! Dime 😊');
  }
  // "las dos cosas" / "ambas" right after "¿Para X, Y o las dos cosas?"
  if (state.lastQuestion === 'service' && state.recentServices?.length > 1 && !u.service && u.intent !== 'price' &&
      /\b(las dos|los dos|ambas|ambos|las 2|todo|todas|las tres)\b/.test(t)) topic = 'book';

  // Follow-ups that only make sense after the previous answer:
  //   after the opening hours: "¿y por la tarde también?"   after a price: "¿y si me hago también un corte?"
  const followUp = /^y\b|\btambien\b/.test(t) && !u.date && !u.time;
  if (previousTopic === 'hours' && followUp && !u.service && [null, 'book', 'hours'].includes(u.intent)) topic = 'hours';
  if (previousTopic === 'price' && followUp && [null, 'book', 'price'].includes(u.intent)) topic = 'price';

  const appt = state.appointment;
  const apptText = a => `${a.name.toLowerCase()}, ${formatDate(a.date, today)} a las ${a.time}`;

  // "no sé si podré ir mañana": don't move it to that day, ask what she wants
  if (u.unsure && !u.time) {
    topic = 'reschedule';
    state.proposals = [];
    if (!appt) {
      state.lastQuestion = 'offerBooking';
      return out('Ahora mismo no veo ninguna cita a tu nombre. ¿Quieres que te busque hueco?');
    }
    state.lastQuestion = 'changeOrCancel';
    return out(`Sin problema 😊 Tienes ${apptText(appt)}. ¿Quieres que la cambiemos a otro día o prefieres anularla?`);
  }

  // "perfecto pues el viernes" right after booking it: she is just confirming the same day
  if (appt && !state.lastQuestion && u.date && toISODate(u.date) === appt.date && !u.time && !u.service &&
      ['book', 'reschedule', 'confirm'].includes(u.intent)) {
    topic = 'confirm';
    return out(`¡Genial! Te esperamos ${formatDate(appt.date, today)} a las ${appt.time} 😊`);
  }

  // Copies whatever the customer just said into the appointment being built.
  const merge = () => {
    const p = state.pending;
    const previousTime = p.time;
    if (u.service === 'LAST' && usual?.length) {
      // "lo de siempre": her last service, from her history
      p.service = usual[0].group; p.details = usual; p.duration = usual.reduce((n, d) => n + (d.duration ?? 0), 0) || null;
    } else if (u.service && p.details?.length && /\b(tambien|ademas|anad\w*|anade\w*|sumale|suma|junto con|y otra)\b/.test(t)) {
      // "y también las cejas", "añade las cejas": add to what she already asked for, don't replace it
      const extra = u.details.filter(d => !p.details.some(x => x.id === d.id));
      p.details = [...p.details, ...extra];
      p.duration = p.details.reduce((n, d) => n + (d.duration ?? 0), 0) || null;
    } else if (u.service) { p.service = u.service; p.details = u.details; p.duration = u.totalDuration; }
    if (u.excludeDate) {
      // "mañana no puedo": that day is out, look from the next one
      const out = toISODate(u.excludeDate);
      if (p.date === out || !p.date) { delete p.date; delete p.time; }
      const next = fromISODate(out); next.setDate(next.getDate() + 1);
      p.fromDate = toISODate(next);
    }
    if (u.date) {
      let newDate = toISODate(u.date);
      // "quería decir el jueves" while talking about Wed 18: the Thursday of that same week (19), not the 12th
      if (p.date && /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t) &&
          !/\b\d{1,2}\b|que viene|proxim|siguiente|semana/.test(t)) {
        const ref = fromISODate(p.date);
        const monday = new Date(ref); monday.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
        const same = new Date(monday); same.setDate(monday.getDate() + ((u.date.getDay() + 6) % 7));
        if (same >= fromISODate(toISODate(today))) newDate = toISODate(same);
      }
      if (newDate !== p.date && !u.time) delete p.time; // new day: the old time no longer applies
      p.date = newDate;
    }
    if (u.timeOfDay) { p.timeOfDay = u.timeOfDay; if (!u.time) delete p.time; }
    if (u.time) p.time = u.time;
    if (u.anyDay && !u.date) p.anyDay = true;
    if ((u.anyTime || (u.anyDay && state.lastQuestion === 'proposal')) && !u.time) { p.anyTime = true; delete p.time; }
    if (u.fromDate) p.fromDate = toISODate(u.fromDate);
    // "a la misma hora": the time of the appointment she is moving, or the time she was just offered
    if (u.sameTime && !u.time) {
      const same = state.mode === 'reschedule' && appt ? appt.time : (state.proposals?.[0] ?? previousTime ?? appt?.time);
      if (same) p.time = same;
    }
  };

  // "para las dos cosas" / no service at all, after asking about prices: use those services
  const useRecentServices = () => {
    const recent = state.recentServices ?? [];
    const p = state.pending;
    if (u.service || p.service || !recent.length) return null;
    const both = /\b(las dos( cosas)?|las 2( cosas)?|ambas( cosas)?|todo eso|todo|las tres( cosas)?)\b/.test(t);
    if (both || recent.length === 1) {
      p.details = [...recent];
      p.service = recent[0].group;
      p.duration = recent.reduce((n, d) => n + (d.duration ?? 0), 0) || null;
      return null;
    }
    state.lastQuestion = 'service'; state.proposals = [];
    const names = recent.map(d => displayName(d).toLowerCase());
    return out(`¿Para ${names.slice(0, -1).join(', ')}, ${names.at(-1)} o las dos cosas?`);
  };

  // First day (from today, up to 3 weeks ahead) with a free slot that fits.
  const firstFreeDay = (p, fromIso = null) => {
    const start = fromIso && fromISODate(fromIso) > today ? fromISODate(fromIso) : today;
    for (let i = 0; i < 21; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const iso = toISODate(d);
      if (p.beforeDate && iso >= p.beforeDate) break; // "tengo una boda el sábado": before the event
      if (freeSlots(iso, { duration: p.duration || 30, timeOfDay: p.timeOfDay }, today, business, isFree).length) return iso;
    }
    return null;
  };

  // Asks for the service if missing, otherwise always proposes concrete times. When she hasn't said
  // a day (or the day she said is closed or full), it proposes the first day that has room.
  const nextStep = ({ exclude = [] } = {}) => {
    const p = state.pending;
    state.proposals = [];
    if (!p.service) {
      state.lastQuestion = 'service';
      return out('¿Qué servicio te quieres hacer? (corte, tinte, mechas, manicura…)');
    }
    const duration = p.duration || 30;
    const slotsOn = iso => freeSlots(iso, { duration, timeOfDay: p.timeOfDay }, today, business, isFree).filter(m => !exclude.includes(toHHMM(m)));
    let note = '';
    if (p.date && !slotsOn(p.date).length) {
      const closed = closedReason(p.date, business);
      const slotText = p.timeOfDay ? { morning: ' por la mañana', midday: ' a mediodía', afternoon: ' por la tarde' }[p.timeOfDay] : '';
      note = closed ? closedNote(closed) : `No me queda hueco ${formatDate(p.date, today)}${slotText} 😔`;
      // holidays: look from the day after they end
      const next = fromISODate(closed?.kind === 'range' ? closed.to : p.date); next.setDate(next.getDate() + 1);
      p.fromDate = toISODate(next);
      delete p.date; delete p.time;
    }
    let chosenByBot = false;
    if (!p.date) {
      const first = firstFreeDay(p, p.fromDate);
      if (!first) {
        state.lastQuestion = 'day';
        return out(`${note ? note + ' ' : ''}Estas semanas lo tengo todo lleno para ${serviceLabel(p)}. ¿Te paso con la peluquería para buscar una solución?`, { handover: true });
      }
      p.date = first; chosenByBot = true;
      delete p.anyDay; delete p.fromDate;
    }
    const slots = slotsOn(p.date);
    state.proposals = pickProposals(slots, p.time, business.maxProposals);
    state.lastQuestion = 'proposal';
    state.offered = { date: p.date, times: [...(state.offered?.date === p.date ? state.offered.times : []), ...state.proposals] };
    const when = formatDate(p.date, today);
    const lead = note ? `${note} ` : '';
    // "a la hora que os venga bien": pick one and ask
    if (p.anyTime && !p.time) {
      state.proposals = [state.proposals[0]];
      delete p.anyTime;
      return out(`${lead}Te pongo ${serviceLabel(p)} ${when} a las ${state.proposals[0]}. ¿Te va bien?`);
    }
    if (p.time && state.proposals.length === 1 && state.proposals[0] === p.time) {
      return out(`${lead}Tengo hueco ${when} a las ${p.time} para ${serviceLabel(p)}. ¿Te lo reservo?`);
    }
    const question = state.proposals.length === 1 ? '¿Te va bien?' : '¿Cuál te va mejor?';
    if (chosenByBot) {
      return out(`${lead}Lo primero que tengo para ${serviceLabel(p)} es ${when}: ${listTimes(state.proposals)}. ${question.replace('?', '')}, o prefieres otro día?`);
    }
    const intro = p.time ? `A las ${p.time} no me queda hueco ${when}. Tengo` : `Para ${serviceLabel(p)} ${when} tengo`;
    return out(`${lead}${intro}: ${listTimes(state.proposals)}. ${question}`);
  };

  const cancelAppointment = () => {
    state.appointment = null; state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = [];
    return out(`Hecho, he anulado tu cita (${apptText(appt)}). ¡Esperamos verte pronto!`);
  };

  // Books (or moves) the appointment at the chosen time.
  const book = time => {
    const p = state.pending;
    const wasReschedule = state.mode === 'reschedule' && appt;
    state.appointment = {
      ...(wasReschedule && appt.id ? { id: appt.id } : {}),
      service: p.service,
      details: (p.details ?? []).map(d => ({ id: d.id, group: d.group, name: d.name, duration: d.duration ?? null })),
      name: (label => label[0].toUpperCase() + label.slice(1))(serviceLabel(p)),
      duration: p.duration || 30,
      date: p.date,
      time,
    };
    state.lastOffer = state.proposals.length > 1 ? { date: p.date, times: [...state.proposals], pending: { ...p } } : null;
    state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = []; state.recentServices = [];
    return out(wasReschedule
      ? `¡Hecho! Te he cambiado la cita: ${apptText(state.appointment)}. ¡Hasta entonces! 😊`
      : `¡Perfecto! Te apunto para ${apptText(state.appointment)}. ¡Hasta entonces! 😊`);
  };

  // "ya me dices cuando puedas", "me dices algo": she is waiting for the salon, not choosing a time
  if (/\b(ya me (dices|diras|contaras|cuentas|comentas)|me (dices|cuentas|comentas) algo|me (dices|cuentas) cuando (puedas|sepas|lo veas))\b/.test(t) && !u.date && !u.time) {
    topic = 'waitSalon';
    return out('¡Claro! En cuanto lo vea la peluquera, te escribe 😊');
  }

  // "no sé qué quiero hacerme", "¿qué me recomiendas?": help her choose (before "quiero" makes it a booking)
  if (!u.service && !u.date && !u.time &&
      /\b(no se que (quiero|hacerme|me hago)|(me )?(puedes|podeis|podrias) (sugerir|recomendar|aconsejar)(me)?|sugerirme|recomiendas|recomendais|aconsejas|que me (hago|haria|recomiendas))\b/.test(t)) {
    topic = 'advice';
    if (state.pending.service) {
      const step = nextStep();
      return { ...step, reply: `¡Buena pregunta! Se lo paso a la peluquera para que te aconseje 😊 Mientras, ${lowerFirst(step.reply)}`, handover: true };
    }
    state.lastQuestion = 'service'; state.proposals = [];
    return out('¡Claro! 😊 Cuéntame qué te apetece: ¿algo para el pelo (corte, color, mechas…), uñas, cejas o algún tratamiento? Si prefieres, le paso tu mensaje a la peluquera para que te aconseje.');
  }

  // "ayer no pude ir", "se me pasó la cita": no telling off. The owner is told; the bot offers a new day.
  if (/\b((ayer|el otro dia|esta manana|antes) no (pude|podia|he podido) (ir|venir|llegar)|se me (paso|olvido) la cita|no (pude|he podido) (ir|venir) a la cita|no me presente|falte a la cita)\b/.test(t)) {
    const wantsNew = u.intent === 'book' || /\b(otra|nueva) (cita|hora)|\bme (das|dais|buscas|puedes dar) otra\b/.test(t);
    if (wantsNew) {
      state.mode = 'book'; merge();
      const step = nextStep();
      return { ...step, reply: `¡No te preocupes! 😊 ${step.reply}`, handover: true };
    }
    state.lastQuestion = 'offerBooking'; state.proposals = [];
    return out('¡No te preocupes, son cosas que pasan! 😊 ¿Quieres que te busque otro día?', { handover: true });
  }

  // "¿a las 5 o a las 6?", "a las 9 o 9 y media", "si no puede ser a las 18" (after one time was offered)
  {
    const p = state.pending;
    let times = u.times?.length > 1 ? u.times : null;
    if (!times && u.time && p.time && state.lastQuestion === 'proposal' &&
        /^(y )?si no (puede ser|se puede|es posible|hay|tienes|teneis|pudiera ser)\b/.test(t)) times = [p.time, u.time];
    if (times && ['book', 'reschedule', 'choose'].includes(topic)) {
      if (!['book', 'choose'].includes(topic) || state.mode === 'reschedule') state.mode = appt ? 'reschedule' : state.mode;
      if (appt && state.mode === 'reschedule' && !p.service) state.pending = { service: appt.service, details: appt.details ?? [], duration: appt.duration };
      merge();
      const q = state.pending;
      if (q.service && q.date) {
        const open = freeSlots(q.date, { duration: q.duration || 30 }, today, business, isFree);
        const free = times.filter(h => open.includes(toMinutes(h)));
        if (free.length) {
          q.time = free[0];
          state.proposals = free; state.lastQuestion = 'proposal';
          const taken = times.filter(h => !free.includes(h));
          const when = formatDate(q.date, today);
          if (free.length === times.length) return out(`${when[0].toUpperCase()}${when.slice(1)} tengo libres ${free.length > 2 ? 'todas' : 'las dos'}: ${listTimes(free)}. ¿Cuál prefieres?`);
          return out(`A las ${taken.join(' y ')} no me queda hueco, pero a las ${free.join(' y ')} sí. ¿Te ${free.length > 1 ? 'va bien alguna' : 'lo reservo'}?`);
        }
        q.time = times[0];
        return nextStep();
      }
    }
  }

  switch (topic) {
    case 'wait':
      // "espera", "voy a mirar una cosa": nothing changes, whatever was on offer is still on offer
      return out('¡Claro, tómate tu tiempo! 😊');

    case 'keep':
      // "al final sí que puedo ir", "dejamos la cita como estaba"
      state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = [];
      if (appt) return out(`¡Genial! La mantenemos: ${apptText(appt)} 😊`);
      return out('¡Perfecto! 😊');

    case 'duration': {
      const source = u.details.length ? u : state.pending.details?.length ? state.pending : null;
      const minutes = source?.details?.reduce((n, d) => n + ((services.find(s => s.id === d.id) ?? d).duration ?? 0), 0);
      if (!minutes) return handover('Enseguida te decimos cuánto dura.');
      const text = minutes < 60 ? `unos ${minutes} minutos` : minutes % 60 === 0 ? `${minutes / 60 === 1 ? 'una hora' : `unas ${minutes / 60} horas`}`
        : minutes % 60 === 30 ? `${Math.floor(minutes / 60) === 1 ? 'una hora' : `unas ${Math.floor(minutes / 60)} horas`} y media` : `unos ${minutes} minutos`;
      const reply = `${serviceLabel(source)[0].toUpperCase()}${serviceLabel(source).slice(1)} dura ${text}, más o menos.`;
      if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `${reply} ${step.reply}` }; }
      state.lastQuestion = 'offerBooking'; state.proposals = [];
      return out(`${reply} ¿Quieres que te busque hueco?`);
    }

    case 'event': {
      // "tengo una boda el sábado": nice to know, but it's not the day of the appointment
      state.pending.beforeDate = toISODate(u.eventDate);
      if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `¡Qué bien! 🎉 ${step.reply}` }; }
      state.lastQuestion = 'offerBooking';
      return out('¡Qué bien! 🎉 ¿Quieres que te busque hueco antes?');
    }

    case 'greeting':
      if (/\b(que tal|como (estas|estais|esta|va|vais|te va|os va)|todo bien)\b/.test(t)) {
        return out('¡Muy bien, gracias! 😊 ¿En qué te puedo ayudar? Te puedo dar cita, cambiarla o anularla.');
      }
      return out('¡Hola! 😊 ¿En qué te puedo ayudar? Te puedo dar cita, cambiarla o anularla.');

    case 'undecided':
      // "luego te digo", "lo hablo con mi marido y te confirmo": nothing is booked, the offer is dropped
      state.proposals = []; state.lastQuestion = null;
      return out('¡Vale! Escríbeme cuando lo sepas y te busco hueco 😊');

    case 'waitlist': {
      // "avísame si se libera algo antes", "si alguien cancela el jueves…": note what she wants, keep her appointment
      const p = state.pending;
      // the service she names, or the one she is booking, or the one of her current appointment
      const details = u.details.length ? u.details : p.details?.length ? p.details : (appt?.details ?? []);
      const entry = {
        service: u.service ?? p.service ?? appt?.service ?? null,
        details: details.map(d => ({ id: d.id, group: d.group, name: d.name, duration: d.duration ?? null })),
        date: u.date ? toISODate(u.date) : null,
        timeOfDay: u.timeOfDay ?? null,
        earlier: /\b(antes|mas pronto)\b/.test(t),
      };
      state.waitlist = [...(state.waitlist ?? []), entry];
      state.proposals = []; state.lastQuestion = null;
      const what = details.length ? ` para ${serviceLabel({ details })}` : entry.service ? ` para ${entry.service}` : '';
      const when = entry.date ? `${what ? '' : ' para'} ${formatDate(entry.date, today)}` : entry.earlier && appt ? ' por si queda algo antes' : '';
      const slot = entry.timeOfDay ? { morning: ' por la mañana', midday: ' a mediodía', afternoon: ' por la tarde' }[entry.timeOfDay] : '';
      const keep = appt ? ` Tu cita (${apptText(appt)}) se mantiene igual.` : '';
      return out(`¡Hecho! Te apunto en la lista de espera${what}${when}${slot}. Si se libera un hueco, te escribo 😊${keep}`, { waitlist: entry });
    }

    case 'preamble':
      // "una pregunta", "ah y una cosa": keep whatever was going on and wait for the question
      return out('¡Claro, dime! 😊');

    case 'thanks':
      if (/\bgracias\b|amable/.test(u.normalizedText) && !/gust|encant|mejores|contenta|dejaste|quedo/.test(u.normalizedText)) {
        return out('¡A ti! 😊');
      }
      return out('¡Muchísimas gracias! Nos alegra mucho que te gustara 😊');

    case 'book': {
      if (state.mode === 'reschedule' && !u.service) { merge(); return nextStep(); }
      if (!state.lastQuestion || state.lastQuestion === 'anythingElse') state.mode = 'book';
      merge();
      const ask = useRecentServices();
      if (ask) return ask;
      const step = nextStep();
      // "¿hacéis manicura semipermanente?": say yes before asking for the day
      if (u.service && u.service !== 'LAST' && /\b(haceis|hace|haces|ofreceis)\b/.test(t) && !u.date && !u.time) {
        step.reply = `¡Sí, hacemos ${serviceLabel(state.pending)}! 😊 ${step.reply}`;
      }
      return step;
    }

    case 'choose': {
      // "no espera, la primera mejor" right after booking the second one: move it to the one she meant
      if (state.lastQuestion !== 'proposal' && appt && u.option && state.lastOffer?.date === appt.date) {
        const time = u.option === -1 ? state.lastOffer.times.at(-1) : state.lastOffer.times[u.option - 1];
        if (time && time !== appt.time) {
          state.mode = 'reschedule'; state.pending = { ...state.lastOffer.pending };
          return book(time);
        }
        if (time) return out(`¡Sí! Ya la tienes ${formatDate(appt.date, today)} a las ${appt.time} 😊`);
      }
      // "vale, la de las 17:00 si sigue libre" with no offer open (e.g. after "luego te digo"):
      // she picked an exact time for the booking she was making, so book it if it is free
      if (state.lastQuestion !== 'proposal' && u.time && state.pending.service && (state.pending.date || u.date)) {
        merge();
        const q = state.pending;
        const open = freeSlots(q.date, { duration: q.duration || 30 }, today, business, isFree);
        if (open.includes(toMinutes(u.time))) return book(u.time);
        return nextStep();
      }
      if (state.lastQuestion === 'proposal') {
        let time = null;
        if (u.option) time = u.option === -1 ? state.proposals.at(-1) : state.proposals[u.option - 1];
        else if (u.time && state.proposals.includes(u.time)) time = u.time;
        if (time) return book(time);
        merge();
        return nextStep();
      }
      merge();
      return nextStep();
    }

    case 'confirm':
      if (state.lastQuestion === 'confirmCancel' && appt) return cancelAppointment();
      // "perfecto, pues añade las cejas también": add it, check the slot still fits, then book
      if (u.service && state.lastQuestion === 'proposal') {
        merge();
        const q = state.pending;
        if (state.proposals.length === 1 && isFree(q.date, toMinutes(state.proposals[0]), q.duration || 30)) return book(state.proposals[0]);
        return nextStep();
      }
      // "mejor esa": the time she just mentioned
      if (state.lastQuestion === 'proposal' && /\b(esa|ese)\b/.test(t) && state.proposals.includes(state.pending.time)) return book(state.pending.time);
      // "sí" to "¿Quieres que te busque hueco?" / "¿Quieres pedir una?": start the booking
      if (state.lastQuestion === 'offerBooking') { state.mode = 'book'; state.pending = {}; return nextStep(); }
      if (state.lastQuestion === 'proposal' && state.proposals.length === 1) return book(state.proposals[0]);
      if (state.lastQuestion === 'proposal') return out(`¿Cuál prefieres? ${listTimes(state.proposals)}`);
      if (GOODBYE.test(t)) return out('¡Hasta pronto! 😊');
      if (appt && u.date && toISODate(u.date) !== appt.date) {
        // "sí, el jueves allí estaré" but her appointment is on Friday: don't move it, ask
        state.mode = 'reschedule';
        state.pending = { service: appt.service, details: appt.details ?? [{ name: appt.name }], duration: appt.duration };
        merge();
        const step = nextStep();
        return { ...step, reply: `Tu cita es ${formatDate(appt.date, today)} a las ${appt.time}. Si quieres cambiarla: ${lowerFirst(step.reply)}` };
      }
      if (appt) return out(`¡Genial! Te esperamos ${formatDate(appt.date, today)} a las ${appt.time} 😊`);
      return out('¡Perfecto! 😊');

    case 'reschedule':
      // "ninguna me va bien": a third option that day, or the same times one week later
      if (u.noneOfThem && state.lastQuestion === 'proposal' && state.pending.date) {
        const p = state.pending;
        const sameDay = p.date;
        // every time already offered for that day, not only the last ones
        const offered = [...new Set([...(state.offered?.date === sameDay ? state.offered.times : []), ...state.proposals])];
        const nextWeek = u.sameTime || /\b(semana que viene|proxima semana|semana siguiente)\b/.test(t);
        // "la semana que viene" with no weekday means the same weekday one week later, not Monday
        const namedDay = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|pasado manana|\d{1,2})\b/.test(t);
        const newDay = u.date && (namedDay || !nextWeek);
        if (!nextWeek && !newDay && !u.time) {
          const rest = freeSlots(sameDay, { duration: p.duration || 30, timeOfDay: p.timeOfDay }, today, business, isFree)
            .filter(m => !offered.includes(toHHMM(m)));
          if (rest.length) {
            state.proposals = pickProposals(rest, null, business.maxProposals);
            state.offered = { date: sameDay, times: [...offered, ...state.proposals] };
            return out(`Vale 😊 Ese día también tengo ${listTimes(state.proposals)}. ¿Te va bien alguna? Si no, te miro otro día.`);
          }
        }
        if (!newDay) {
          const d = fromISODate(sameDay); d.setDate(d.getDate() + 7);
          const iso = toISODate(d);
          const free = closedReason(iso, business) ? []
            : offered.filter(h => isFree(iso, toMinutes(h), p.duration || 30));
          if (free.length) {
            p.date = iso; delete p.time;
            state.proposals = free.slice(0, business.maxProposals);
            state.offered = { date: iso, times: [...state.proposals] };
            return out(`Vale. La semana que viene, ${formatDate(iso, today)}, tengo a la misma hora: ${listTimes(state.proposals)}. ¿Te va bien?`);
          }
        }
        merge();
        return nextStep({ exclude: newDay ? [] : offered });
      }
      if (!appt && !state.pending.service) {
        state.lastQuestion = 'offerBooking'; state.proposals = [];
        return out('No veo ninguna cita a tu nombre. ¿Quieres que te busque hueco?');
      }
      if (appt && state.mode !== 'reschedule') {
        state.mode = 'reschedule';
        state.pending = { service: appt.service, details: [{ name: appt.name }], duration: appt.duration };
      }
      merge();
      if (!u.date && !u.time && !u.timeOfDay && !state.pending.date && appt) {
        // no new day yet: show her appointment and propose the first free times
        const step = nextStep({ exclude: [] });
        return { ...step, reply: `Claro. Ahora tienes ${apptText(appt)}. ${step.reply}` };
      }
      return nextStep();

    case 'cancel':
      if (!appt) {
        state.pending = {}; state.lastQuestion = null; state.proposals = [];
        return out('Ahora mismo no tienes ninguna cita reservada.');
      }
      // Already asked "¿la anulo o la cambiamos?": now cancel it
      if (['confirmCancel', 'changeOrCancel'].includes(state.lastQuestion)) return cancelAppointment();
      // Never cancel on the first message: a misread would silently lose her appointment
      state.lastQuestion = 'confirmCancel'; state.proposals = [];
      return out(`Vaya 😔 Tienes ${apptText(appt)}. ¿Quieres que la anule o prefieres cambiarla a otro día?`);

    case 'check':
      if (appt && /\b(escrito|olvide|mandas|mandais|envias|enviais|pasas|whatsapp|mensaje|recordar)\b/.test(t)) {
        const where = business.address ? `\n📍 ${business.address}` : '';
        return out(`¡Claro! Te lo dejo por escrito 📝\n${appt.name}\n📅 ${formatDate(appt.date, today)}\n🕒 a las ${appt.time}${where}`);
      }
      if (appt) return out(`Tienes cita ${formatDate(appt.date, today)} a las ${appt.time} para ${appt.name.toLowerCase()}.`);
      // in the middle of a booking: say so and carry on with it
      if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
        const step = nextStep();
        return { ...step, reply: `Ahora mismo no tienes ninguna cita reservada. ${step.reply}` };
      }
      state.lastQuestion = 'offerBooking'; state.proposals = [];
      return out('Ahora mismo no tienes ninguna cita reservada. ¿Quieres pedir una?');

    case 'hours': {
      // "¿abrís el 8 de diciembre?", "¿el sábado estáis?": that day
      if (u.date) {
        const iso = toISODate(u.date);
        const c = closedReason(iso, business);
        const when = formatDate(iso, today);
        const When = `${when[0].toUpperCase()}${when.slice(1)}`;
        if (c?.kind === 'range') return out(`${When} no: ${rangeText(c.from, c.to)} ${closedForText(c.reason)} 😔`);
        if (c) return out(`${When} estamos cerrados${c.kind === 'holiday' ? ` (${c.reason})` : ''} 😔`);
        return out(`Sí, ${when} abrimos de ${business.opens} a ${business.closes} 😊`);
      }
      // "¿cerráis en agosto?", "¿abrís en Navidad?": holidays that month
      const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      const month = /\bnavidad(es)?\b/.test(t) ? 11 : MONTHS.findIndex(m => new RegExp(`\\b${m}\\b`).test(t));
      if (month >= 0) {
        const inMonth = iso => fromISODate(iso).getMonth() === month;
        const ranges = (business.closedRanges ?? []).filter(r => inMonth(r.from) || inMonth(r.to));
        const dates = (business.closedDates ?? []).map(c => (typeof c === 'string' ? c : c.date)).filter(inMonth);
        const parts = [
          ...ranges.map(r => `${rangeText(r.from, r.to)} ${closedForText(r.reason || 'vacaciones')}`),
          ...(dates.length ? [`cerramos ${dates.map(d => `el ${fromISODate(d).getDate()}`).join(', ').replace(/, ([^,]*)$/, ' y $1')}`] : []),
        ];
        const name = MONTHS[month];
        if (parts.length) return out(`En ${name}, ${parts.join(', y ')}. El resto de días, horario normal: ${openDaysText(business.closedWeekdays)} de ${business.opens} a ${business.closes}.`);
        return out(`En ${name} abrimos con el horario de siempre: ${openDaysText(business.closedWeekdays)} de ${business.opens} a ${business.closes} 😊`);
      }
      if (u.timeOfDay === 'afternoon') return out(`Sí, por la tarde también: ${openDaysText(business.closedWeekdays)} abrimos hasta las ${business.closes}.`);
      if (u.timeOfDay === 'morning') return out(`Sí, por la mañana abrimos a las ${business.opens}, ${openDaysText(business.closedWeekdays)}.`);
      return out(`Abrimos ${openDaysText(business.closedWeekdays)} de ${business.opens} a ${business.closes}.${closedDaysText(business.closedWeekdays)}`);
    }

    case 'price': {
      remember(u.details);
      // "¿y cuánto cuesta?" without naming the service: use the one we were talking about;
      // "¿todo junto cuánto sería?": everything she asked about
      const together = !u.details.length && /\b(todo|todos|junto|juntos|en total|las dos|los dos|ambos|ambas)\b/.test(t);
      const all = [...(state.pending.details ?? []), ...(state.recentServices ?? [])].filter((d, i, a) => a.findIndex(x => x.id === d.id) === i);
      const source = together && all.length > 1 ? { details: all } : u.details.length ? u : state.pending.details?.length ? state.pending : null;
      const what = source ? ` de ${serviceLabel(source)}` : '';
      // Prices in the catalog: answer directly. Otherwise the owner answers.
      const priced = source?.details?.map(d => services.find(s => s.id === d.id)).filter(s => s && s.price != null) ?? [];
      if (source && priced.length === source.details.length) {
        const parts = priced.map(s => `${displayName(s)}: ${euros(s.price)}`);
        const text = priced.length > 1
          ? `${parts.join(', ')}. En total, ${euros(priced.reduce((n, s) => n + s.price, 0))}.`
          : `${parts[0]}.`;
        if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `${text} ${step.reply}` }; }
        state.lastQuestion = 'offerBooking'; state.proposals = [];
        return out(`${text} ¿Quieres que te busque hueco?`);
      }
      return handover(`Enseguida te decimos el precio${what}.`);
    }

    case 'late':
      return out(previousTopic === 'late' ? '¡Sin problema, aquí te esperamos! 😊' : '¡Gracias por avisar! Te esperamos 🙏');

    default: {
      // Laughs, emojis and happy reactions ("jajaja", "😂", "¡qué bien!"): just smile back
      if (t.split(' ').every(w => isLaugh(w) || /^(xd+|lol)$/.test(w)) ||
          /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]+$/u.test(message.trim()) ||
          /^(que (bien|guay|chulo|bonito|ilusion|maravilla)|ole|bien)$/.test(t)) {
        return out('😊');
      }
      // "perdona!!", "perdona el lío": nothing to forgive
      if (/^(perdona|perdon|disculpa|disculpad|lo siento|sorry)( (el lio|las molestias|la tardanza|por el lio|que te moleste|mucho|eh))?( (ja|je)\w*)?$/.test(t)) {
        return out('¡No pasa nada! 😊');
      }
      // "ya estoy aquí", "estoy en la puerta": the salon needs to know right away
      if (/\b(ya )?(estoy|he llegado|estamos) (en la puerta|aqui|fuera|abajo|llegando ya)\b|\bhe llegado\b/.test(t)) {
        return { ...out('¡Perfecto, ahora te abrimos! 😊'), handover: true };
      }
      // "qué fuerte", "qué mal", "vaya": a reaction with nothing for the owner to answer
      if (/^(que (fuerte|mal|pena|rollo|faena|horror|palo|raro|susto)|vaya|uf+|madre mia|ostras|jo|jolin|en serio)$/.test(t)) {
        state.lastQuestion = 'anythingElse';
        return out('Vaya 😔 ¿Te puedo ayudar en algo?');
      }
      // "¿dónde estáis?", "¿me mandas la dirección?": answered from the business settings
      if (business.address && /\b(direccion|donde (estais|esta|esta la peluqueria|os encuentro|queda)|como (llego|se llega)|ubicacion|ubicados)\b/.test(t)) {
        if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `Estamos en ${business.address} 📍 ${step.reply}` }; }
        state.lastQuestion = 'anythingElse';
        return out(`Estamos en ${business.address} 📍 ¿Puedo ayudarte en algo más?`);
      }
      // "no te entiendo": the bot got lost, a person should take over
      if (/\b(no (te|os) entiendo|no entiendo (nada|lo que)|no me (has|habeis) entendido|no me entiendes|que dices)\b/.test(t)) {
        return { ...handover('Perdona, me he liado 😅 Te contestaremos enseguida.'), fallback: false };
      }
      // "¿sería posible?" in the middle of a booking: yes, carry on
      if (BOOKING_QUESTIONS.includes(state.lastQuestion) && /^(y )?((seria|sera|es|esta) )?posible|^(se puede|puede ser|podria ser|se podria)$/.test(t)) {
        const step = nextStep();
        return { ...step, reply: `¡Claro! 😊 ${step.reply}` };
      }
      // Made-up words only ("oeoe", "asdf qwer"): say so and let her rephrase. Not worth the owner's
      // time, but the server still saves it to not-understood.json.
      if (!u.offTopic && !u.service && !u.date && !u.time && !u.timeOfDay && isNonsense(t)) {
        const again = (state.misunderstood ?? 0) >= 1; // second time in a row: explain what it can do
        if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
          const step = nextStep();
          return { ...step, reply: `${again ? 'Sigo sin entenderte 😅' : 'Perdona, no te he entendido 😅'} ${step.reply}`, fallback: true, nonsense: true };
        }
        return out(again
          ? 'Sigo sin entenderte 😅 Puedo darte cita, cambiarla o anularla, o pasarle tu mensaje a la peluquería.'
          : 'Perdona, no te he entendido 😅 ¿Me lo puedes decir de otra forma?', { fallback: true, nonsense: true });
      }
      // "¿se puede hacer todo junto?" while booking several services: yes
      if (BOOKING_QUESTIONS.includes(state.lastQuestion) && (state.pending.details?.length ?? 0) > 1 &&
          /\b(todo junto|todo seguido|a la vez|el mismo dia|todo en la misma cita|juntos)\b/.test(t)) {
        const step = nextStep();
        return { ...step, reply: `¡Sí, te lo hacemos todo junto! 😊 ${step.reply}` };
      }
      // A side remark in the middle of a booking ("tengo una boda por la noche"): the owner gets it,
      // and the bot carries on with the booking instead of dropping it.
      // A question she asked ("¿hay parking?") gets "te contestamos enseguida", a remark gets "tomo nota".
      if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
        const isQuestion = /\?\s*$/.test(message.trim()) ||
          /^(que|como|cuando|donde|cuanto|cuanta|cuantos|por que|porque|sabes|sabeis|teneis|tienes|hay|puedo|se puede|podeis|puedes|con que)\b/.test(t);
        const step = nextStep();
        const ack = isQuestion ? 'Te contestaremos enseguida.' : 'Tomo nota 😊';
        return { ...step, reply: `${ack} Mientras, ${lowerFirst(step.reply)}`, handover: true, fallback: true };
      }
      return { ...handover('Te contestaremos enseguida.'), fallback: true };
    }
  }
}

module.exports = { respond, newConversation, DEFAULT_BUSINESS, isSimulatedBusy, serviceLabel, closedReason };
