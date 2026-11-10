// context.js — Everything one message needs, built once: what she said (understand), the conversation state,
// the salon settings and availability, and the shared steps the handlers use (propose times, book, cancel…).
// Pure: no store, no clock (the date comes in as an option).
const { understand } = require('../understand');
const H = require('../hours');
const SAMPLE_CATALOG = require('../catalog.json').services;
const F = require('./format');
const S = require('./slots');
const { DEFAULT_BUSINESS, newConversation, STALE_OFFER_MINUTES, MAX_LISTED_TIMES } = require('./conversation');
const { TIME_OF_DAY_RANGES, toMinutes, toHHMM, toISODate, fromISODate, formatDate, displayName, serviceLabel,
  listTimes, noteFrom, lowerFirst, serviceExamples } = F;
const { isSimulatedBusy, closedReason, closedNote, lastBookableDate, earliestStart, freeSlots, pickProposals } = S;

// Options:
//   today     Date            "now", for "mañana", "el viernes" and not proposing past times
//   services  [service]       the business catalog (see catalog.json); a service may have a price
//   business  {settings}      opening hours, closed days, capacity, address… (see DEFAULT_BUSINESS)
//   isFree    (date, startMinutes, duration, { ignoreId }) => bool   real availability; simulated if omitted.
//             ignoreId: the appointment being moved (its own slot counts as free)
//   usual     [detail]        the customer's last service, for "lo de siempre"
//   now       Date            the current moment, for minNoticeMinutes (defaults to `today`)
function createContext(message, state = newConversation(), {
  today,
  services = SAMPLE_CATALOG,
  business: businessSettings = {},
  isFree: isFreeOption = (date, start) => !isSimulatedBusy(date, start),
  usual = null,
  now = today,
} = {}) {
  const business = { ...DEFAULT_BUSINESS, ...businessSettings };
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new TypeError('respond(): pass { today } as a valid Date (the salon\'s wall-clock time)');
  state = JSON.parse(JSON.stringify(state)); // never mutate the caller's state
  // An offer left unanswered for more than 3 hours is stale: start fresh (confirmed appointments are kept)
  if (state.lastAt && now - new Date(state.lastAt) > STALE_OFFER_MINUTES * 60000) {
    state.pending = {}; state.proposals = []; state.lastQuestion = null; state.mode = 'book';
    state.offered = null; state.waitlistOffer = null; state.lastReply = null; state.lastMessage = null; state.misunderstood = 0;
  }
  state.lastAt = now.toISOString();
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
      return { ...step, reply: `${reply} Mientras, ${lowerFirst(step.reply)}`, handover: true };
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

  // Availability: her own appointment's slot only counts as free while she is moving that appointment
  const isFree = (date, start, duration) => H.fitsInside(H.dayHours(business, date), start, duration) &&
    isFreeOption(date, start, duration, { ignoreId: state.mode === 'reschedule' && appt?.id ? appt.id : null });

  // She may have several appointments; `appt` is the one being talked about
  let appt = state.appointment;
  const appts = state.appointments?.length ? state.appointments : (appt ? [appt] : []);
  const focusOn = a => { appt = a; state.appointment = a; state.focusId = a?.id ?? null; };
  // Which of her appointments she means: by service ("la de la manicura") and/or day ("la del viernes")
  const matchAppointments = (byDate = true) => appts.filter(a =>
    (!u.service || a.service === u.service || (a.details ?? []).some(d => d.group === u.service || d.id === u.details[0]?.id)) &&
    (!byDate || !u.date || a.date === toISODate(u.date)));
  const listAppointments = list => list.map((a, i) => `${list.length > 1 ? `${i + 1}) ` : ''}${apptText(a)}`).join(list.length > 2 ? '; ' : list.length === 2 ? ' y ' : '');
  const apptText = a => `${a.name.toLowerCase()}, ${formatDate(a.date, today)} a las ${a.time}`;

  // Copies whatever the customer just said into the appointment being built.
  const addNote = text => {
    const p = state.pending;
    if (text && !(p.notes ?? []).includes(text)) p.notes = [...(p.notes ?? []), text];
  };
  const merge = () => {
    const p = state.pending;
    const previousTime = p.time;
    const previousDate = p.date;
    addNote(noteFrom(message, t)); // "corte, solo las puntas", "para mi hija"…
    if (u.service === 'LAST' && usual?.length) {
      // "lo de siempre": her last service, from her history
      p.service = usual[0].group; p.details = usual; p.duration = usual.reduce((n, d) => n + (d.duration ?? 0), 0) || null;
    } else if (u.service === 'LAST' && !p.service) {
      // "lo de siempre" with no history: ask, never book something called "lo de siempre"
      p.askedUsual = true;
    } else if (u.service === 'LAST') {
      // she is already booking a service: keep it
    } else if (u.service && p.details?.length && /\b(tambien|ademas|anad\w*|anade\w*|sumale|suma|junto con|y otra)\b/.test(t)) {
      // "y también las cejas", "añade las cejas": add to what she already asked for, don't replace it
      const extra = u.details.filter(d => !p.details.some(x => x.id === d.id));
      p.details = [...p.details, ...extra];
      p.duration = p.details.reduce((n, d) => n + (d.duration ?? 0), 0) || null;
    } else if (u.service) { p.service = u.service; p.details = u.details; p.duration = u.totalDuration; }
    // "martes o miércoles": book on the first, also show the second
    if (u.dates?.length > 1 && !u.time) p.altDate = toISODate(u.dates[1]);
    // a different day drops the other day offered; repeating the same one ("para el martes por la tarde") keeps it
    else if (u.date && p.date !== previousDate && p.date !== p.altDate) delete p.altDate;
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
      const withoutTimes = t.replace(/\b\d{1,2}[:.h]\d{2}\b/g, ' ').replace(/\b(a|sobre|hacia|de|para|por) las \d{1,2}\b/g, ' ');
      if (p.date && /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t) &&
          !/\b\d{1,2}\b|que viene|proxim|siguiente|semana/.test(withoutTimes)) {
        const ref = fromISODate(p.date);
        const monday = new Date(ref); monday.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
        const same = new Date(monday); same.setDate(monday.getDate() + ((u.date.getDay() + 6) % 7));
        // naming the weekday of the day being discussed ("el miércoles a las 17:30" while on Wed 18) keeps that day;
        // but "martes" said on a Tuesday while discussing today means next Tuesday
        // the other day she was offered ("…y mañana, 09:30 o 19:30" → "el miércoles a las 9:30")
        if (p.altDate && fromISODate(p.altDate).getDay() === u.date.getDay()) newDate = p.altDate;
        else if (toISODate(same) === p.date && p.date !== toISODate(today)) newDate = p.date;
        else if (same >= fromISODate(toISODate(today)) && toISODate(same) !== p.date) newDate = toISODate(same);
      }
      if (newDate !== p.date && !u.time) delete p.time; // new day: the old time no longer applies
      p.date = newDate;
    }
    if (u.timeOfDay) { p.timeOfDay = u.timeOfDay; if (!u.time) delete p.time; }
    if (u.time) p.time = u.time;
    // an exact time outside a time of day said earlier beats it ("por la tarde" … "el miércoles a las 10");
    // inside it, both stay ("a mediodía" … "sobre la 1")
    if (u.time && !u.timeOfDay && p.timeOfDay) {
      const [from, to] = TIME_OF_DAY_RANGES[p.timeOfDay] ?? [0, 24 * 60];
      if (toMinutes(u.time) < from || toMinutes(u.time) >= to) delete p.timeOfDay;
    }
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
    // only right after talking about them ("¿cuánto cuesta el tinte?" → "vale, dame cita"), not hours later
    const justAsked = ['price', 'duration', 'services', 'describe'].includes(previousTopic) || (state.lastQuestion === 'service' && previousTopic === 'book');
    if (!justAsked) return null;
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
      if (freeSlots(iso, { duration: p.duration || 30, timeOfDay: p.timeOfDay }, now, business, isFree).length) return iso;
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
      if (p.askedUsual) return out(`No encuentro tu última cita 🤔 ¿Qué te sueles hacer? (${serviceExamples(services).join(', ')}…)`);
      return out(`¿Qué servicio te quieres hacer? (${serviceExamples(services).join(', ')}…)`);
    }
    const duration = p.duration || 30;
    const slotsOn = iso => freeSlots(iso, { duration, timeOfDay: p.timeOfDay }, now, business, isFree).filter(m => !exclude.includes(toHHMM(m)));
    let note = '';
    const lastDay = lastBookableDate(now, business);
    if (p.date && p.date > lastDay) {
      // beyond maxDaysAhead: offer the waiting list for that day
      state.lastQuestion = 'offerWaitlist';
      state.waitlistOffer = { service: p.service, details: p.details ?? [], date: p.date, timeOfDay: p.timeOfDay ?? null };
      return out(`Todavía no tengo la agenda abierta para esa fecha; puedo darte cita hasta ${formatDate(lastDay, today)}. ¿Te apunto en la lista de espera para ese día?`);
    }
    const todayIso = toISODate(now);
    const earliest = earliestStart(now, business);
    if (p.date === todayIso && p.time && toMinutes(p.time) < earliest.getHours() * 60 + earliest.getMinutes() && toISODate(earliest) === todayIso) {
      note = `Para hoy a las ${p.time} ya no me da tiempo 😔`;
      delete p.time;
    }
    if (p.date && !slotsOn(p.date).length) {
      const closed = closedReason(p.date, business);
      // nothing left today only because of the notice: "para hoy ya no me da tiempo"
      const tooLate = !closed && p.date === todayIso &&
        freeSlots(p.date, { duration, timeOfDay: p.timeOfDay }, new Date(fromISODate(todayIso)), business, isFree).length > 0;
      const slotText = p.timeOfDay ? { morning: ' por la mañana', midday: ' a mediodía', afternoon: ' por la tarde' }[p.timeOfDay] : '';
      // "el sábado por la tarde" when Saturdays are mornings only: that part of the day is closed
      const partClosed = !closed && p.timeOfDay && p.timeOfDay !== 'midday' && !H.timeOfDayIntervals(H.dayHours(business, p.date), p.timeOfDay).length;
      const When = (w => w[0].toUpperCase() + w.slice(1))(formatDate(p.date, today));
      note = closed ? closedNote(closed) : partClosed ? `${When}${slotText} cerramos 😔` : tooLate ? 'Para hoy ya no me da tiempo 😔' : `No me queda hueco ${formatDate(p.date, today)}${slotText} 😔`;
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
    // the same times she has already seen for that day ("para el martes por la tarde" after 15:30 / 18:30):
    // show more of that day instead of repeating them
    const seen = state.offered?.date === p.date ? state.offered.times : [];
    let more = false;
    if (!p.time && (u.timeOfDay || u.date) && seen.length && state.proposals.every(h => seen.includes(h)) && slots.length > state.proposals.length) {
      state.proposals = pickProposals(slots, null, Math.min(slots.length, MAX_LISTED_TIMES));
      more = true;
    }
    state.lastQuestion = 'proposal';
    state.offered = { date: p.date, times: [...new Set([...seen, ...state.proposals])] };
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
    const dayIntervals = H.dayHours(business, p.date);
    // "a mediodía" on a split day: the last time before the break and the first after it
    const lunch = H.lunchBreak(dayIntervals);
    if (p.timeOfDay === 'midday' && lunch && !p.time) {
      const before = slots.filter(m => m < lunch[0]).at(-1), after = slots.find(m => m >= lunch[1]);
      state.proposals = [before, after].filter(m => m != null).map(toHHMM);
      state.offered = { date: p.date, times: [...new Set([...seen, ...state.proposals])] };
      const times = state.proposals.map(h => `a las ${h}`).join(' o ');
      return out(`${lead}A mediodía cerramos de ${H.clock(lunch[0])} a ${H.clock(lunch[1])}${times ? `; ${when} tengo ${times}` : ''}. ¿${state.proposals.length > 1 ? 'Cuál te va mejor' : 'Te va bien'}?`);
    }
    if (chosenByBot) {
      return out(`${lead}Lo primero que tengo para ${serviceLabel(p)} es ${when}: ${listTimes(state.proposals)}. ${question.replace('?', '')}, o prefieres otro día?`);
    }
    // why the time she asked for doesn't work: closed then, or the service doesn't fit before closing
    const asked = p.time ? toMinutes(p.time) : null;
    const openThen = asked != null && dayIntervals.some(([a, b]) => asked >= a && asked < b);
    const closesAt = openThen ? dayIntervals.find(([a, b]) => asked >= a && asked < b)[1] : null;
    const timeIntro = asked == null ? null
      : !openThen ? `A las ${p.time} ${when} estamos cerrados${lunch && asked >= lunch[0] && asked < lunch[1] ? ` (a mediodía cerramos de ${H.clock(lunch[0])} a ${H.clock(lunch[1])})` : ''}. Tengo`
      : asked + duration > closesAt ? `A las ${p.time} no da tiempo a hacer ${serviceLabel(p)} antes de cerrar a las ${H.clock(closesAt)}. Tengo`
      : `A las ${p.time} no me queda hueco ${when}. Tengo`;
    const intro = p.time ? timeIntro : more ? `${when[0].toUpperCase()}${when.slice(1)}${p.timeOfDay ? { morning: ' por la mañana', midday: ' a mediodía', afternoon: ' por la tarde' }[p.timeOfDay] : ''} tengo todo esto` : `Para ${serviceLabel(p)} ${when} tengo`;
    // "martes o miércoles": the other day too (she can say "el miércoles a las 10")
    let also = '';
    if (p.altDate && p.altDate !== p.date) {
      const alt = pickProposals(freeSlots(p.altDate, { duration, timeOfDay: p.timeOfDay }, now, business, isFree), null, business.maxProposals);
      also = alt.length ? ` Y ${formatDate(p.altDate, today)}, ${alt.join(' o ')}.` : ` ${formatDate(p.altDate, today)[0].toUpperCase()}${formatDate(p.altDate, today).slice(1)} no me queda hueco.`;
    }
    return out(`${lead}${intro}: ${listTimes(state.proposals)}.${also} ${question}`);
  };

  // "¿tienes más horas?", "¿hay más huecos?": every free time that day (not just two)
  const moreTimes = () => {
    const p = state.pending;
    const duration = p.duration || 30;
    const seen = state.offered?.date === p.date ? state.offered.times : state.proposals;
    const all = freeSlots(p.date, { duration, timeOfDay: p.timeOfDay }, now, business, isFree);
    const rest = all.filter(m => !seen.includes(toHHMM(m)));
    const when = formatDate(p.date, today);
    if (!rest.length) {
      return out(`${when[0].toUpperCase()}${when.slice(1)} no tengo más horas que esas 😔 ¿Te miro otro día?`);
    }
    state.proposals = pickProposals(all, null, Math.min(all.length, MAX_LISTED_TIMES));
    state.offered = { date: p.date, times: [...new Set([...seen, ...state.proposals])] };
    return out(`Claro 😊 ${when} tengo: ${listTimes(state.proposals)}. ¿Cuál te va mejor?`);
  };

  const cancelAppointment = () => {
    state.cancelledId = appt?.id ?? null; // bot.js cancels exactly this one
    state.appointment = null; state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = [];
    return out(`Hecho, he anulado tu cita (${apptText(appt)}). ¡Esperamos verte pronto!`);
  };

  // Books (or moves) the appointment at the chosen time.
  const book = (time, { skipNotes = false } = {}) => {
    const p = state.pending;
    // never accept a slot that is no longer valid (notice window passed, taken, outside the diary)
    if (!freeSlots(p.date, { duration: p.duration || 30 }, now, business, isFree).includes(toMinutes(time))) {
      delete p.time;
      const step = nextStep({ exclude: [time] });
      return { ...step, reply: `Vaya, a las ${time} ya no puedo darte cita 😔 ${step.reply}` };
    }
    const wasReschedule = state.mode === 'reschedule' && appt;
    // Before booking a new appointment: "¿quieres que apunte algo especial?" (asked once)
    if (business.askForNotes && !wasReschedule && !skipNotes && !p.notesAsked) {
      p.notesAsked = true; p.time = time;
      state.lastQuestion = 'notes'; state.proposals = [time];
      const have = p.notes?.length ? ` Te apunto como nota: «${p.notes.join(' · ')}».` : '';
      const ask = have ? '¿Quieres que apunte algo más?' : '¿Quieres que apunte algo especial para la cita (un diseño, alergias, si es para otra persona…)?';
      return out(`¡Genial! Te guardo ${serviceLabel(p)} ${formatDate(p.date, today)} a las ${time}.${have} ${ask} Si no, dime «no» y lo confirmo.`);
    }
    const notes = [...(wasReschedule && appt.notes ? [appt.notes] : []), ...(p.notes ?? [])].join(' · ') || null;
    state.appointment = {
      ...(wasReschedule && appt.id ? { id: appt.id } : {}),
      service: p.service,
      details: (p.details ?? []).map(d => ({ id: d.id, group: d.group, name: d.name, duration: d.duration ?? null })),
      name: (label => label[0].toUpperCase() + label.slice(1))(serviceLabel(p)),
      duration: p.duration || 30,
      date: p.date,
      time,
      notes,
    };
    state.lastOffer = state.proposals.length > 1 ? { date: p.date, times: [...state.proposals], pending: { ...p } } : null;
    state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = []; state.recentServices = [];
    const noteText = notes && !wasReschedule ? ` Nota: «${notes}».` : '';
    return out(wasReschedule
      ? `¡Hecho! Te he cambiado la cita: ${apptText(state.appointment)}. ¡Hasta entonces! 😊`
      : `¡Perfecto! Te apunto para ${apptText(state.appointment)}.${noteText} ¡Hasta entonces! 😊`);
  };

  // "no", "tampoco"… to the times on offer (set by rules.js, used by the reschedule handler)
  const ctx = {
    message, state, u, t, today, now, business, services, usual, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book, noneOfThem: false,
  };
  // the topic and the appointment being talked about change as the rules and handlers run
  Object.defineProperty(ctx, 'topic', { get: () => topic, set: v => { topic = v; }, enumerable: true });
  Object.defineProperty(ctx, 'appt', { get: () => appt, set: v => { appt = v; }, enumerable: true });
  return ctx;
}

module.exports = { createContext };
