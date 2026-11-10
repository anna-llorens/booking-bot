// book.js — Booking: propose times, choose one, confirm, more times, another day.
const F = require('../format');
const S = require('../slots');
const { toMinutes, toISODate, fromISODate, formatDate, serviceLabel, listTimes, lowerFirst } = F;
const { freeSlots } = S;

function handleMoreTimes(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    return moreTimes();

}

function handleNextDay(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // look from the day after the one on offer ("otro día por la tarde" keeps the time of day)
    const p = state.pending;
    if (u.timeOfDay) p.timeOfDay = u.timeOfDay;
    const next = fromISODate(p.date); next.setDate(next.getDate() + 1);
    p.fromDate = toISODate(next);
    delete p.date; delete p.time; delete p.altDate;
    return nextStep();
  }

}

function handleBook(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "quiero cita (para el 25)" as a new request: a new booking from scratch. Her existing appointments are
    // closed: nothing is inherited from them (or from an earlier, abandoned booking), so she is asked the service.
    const newRequest = /\b(quiero|queria|quisiera|necesito|me (das|dais|puedes dar|podeis dar)|pedir|coger|reservar) (una |otra |nueva )?(cita|hora|hueco)\b|\b(otra|nueva) cita\b/.test(t);
    if (newRequest && !u.service && (state.mode === 'reschedule' || !BOOKING_QUESTIONS.includes(state.lastQuestion))) {
      state.mode = 'book'; state.pending = {}; state.proposals = []; state.offered = null;
    }
    if (state.mode === 'reschedule' && !u.service) { merge(); return nextStep(); }
    if (!state.lastQuestion || state.lastQuestion === 'anythingElse') state.mode = 'book';
    merge();
    const ask = useRecentServices();
    if (ask) return ask;
    const step = nextStep();
    // "¿me das cita el sábado para tinte? ¿aceptáis bizum?": the booking goes on, the question is answered too
    if (u.infoTopics?.length) {
      const answers = u.infoTopics.map(k => business.info?.[k]).filter(Boolean);
      const missing = u.infoTopics.some(k => !business.info?.[k]);
      step.reply = `${answers.length ? answers.join(' ') + ' ' : ''}${step.reply}${missing ? ' Lo otro que me preguntas te lo contestamos enseguida.' : ''}`;
      if (missing) step.handover = true;
    }
    // "¿hacéis manicura semipermanente?": say yes before asking for the day
    if (u.service && u.service !== 'LAST' && /\b(haceis|hace|haces|ofreceis)\b/.test(t) && !u.date && !u.time) {
      step.reply = `¡Sí, hacemos ${serviceLabel(state.pending)}! 😊 ${step.reply}`;
    }
    return step;
  }

}

function handleChoose(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "no espera, la primera mejor" right after booking the second one: move it to the one she meant
    if (state.lastQuestion !== 'proposal' && ctx.appt && u.option && state.lastOffer?.date === ctx.appt.date) {
      const time = u.option === -1 ? state.lastOffer.times.at(-1) : state.lastOffer.times[u.option - 1];
      if (time && time !== ctx.appt.time) {
        state.mode = 'reschedule'; state.pending = { ...state.lastOffer.pending };
        return book(time);
      }
      if (time) return out(`¡Sí! Ya la tienes ${formatDate(ctx.appt.date, today)} a las ${ctx.appt.time} 😊`);
    }
    // "vale, la de las 17:00 si sigue libre" with no offer open (e.g. after "luego te digo"):
    // she picked an exact time for the booking she was making, so book it if it is free
    if (state.lastQuestion !== 'proposal' && u.time && state.pending.service && (state.pending.date || u.date)) {
      merge();
      const q = state.pending;
      const open = freeSlots(q.date, { duration: q.duration || 30 }, now, business, isFree);
      if (open.includes(toMinutes(u.time))) return book(u.time);
      return nextStep();
    }
    // "la segunda" when only one time was offered
    if (state.lastQuestion === 'proposal' && u.option > state.proposals.length) {
      return out(`Solo te he propuesto ${state.proposals.length === 1 ? `las ${state.proposals[0]}` : listTimes(state.proposals)}. ¿Te ${state.proposals.length === 1 ? 'la reservo' : 'va bien alguna'}?`);
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

}

function handleConfirm(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    if (state.lastQuestion === 'confirmCancel' && ctx.appt) return cancelAppointment();
    // "perfecto, pues añade las cejas también": add it, check the slot still fits, then book
    if (u.service && state.lastQuestion === 'proposal') {
      merge();
      const q = state.pending;
      if (state.proposals.length === 1 && isFree(q.date, toMinutes(state.proposals[0]), q.duration || 30)) return book(state.proposals[0]);
      return nextStep();
    }
    // "mejor esa": the time she just mentioned
    if (state.lastQuestion === 'proposal' && /\b(esa|ese)\b/.test(t) && state.proposals.includes(state.pending.time)) return book(state.pending.time);
    // "sí" to "¿Te apunto en la lista de espera para ese día?" (date beyond the open diary)
    if (state.lastQuestion === 'offerWaitlist' && state.waitlistOffer) {
      const entry = { ...state.waitlistOffer, earlier: false };
      state.waitlist = [...(state.waitlist ?? []), entry];
      state.waitlistOffer = null; state.lastQuestion = null; state.proposals = []; state.pending = {};
      const what = entry.details.length ? ` para ${serviceLabel(entry)}` : '';
      return out(`¡Hecho! Te apunto en la lista de espera${what} ${formatDate(entry.date, today)}. En cuanto abra la agenda, te escribo 😊`, { waitlist: entry });
    }
    // "sí" to "¿Quieres que te busque hueco?" / "¿Quieres pedir una?": start the booking
    // ...keeping the service she was asking about ("¿cuánto cuesta el tinte?" → "sí": tinte, don't ask again)
    if (state.lastQuestion === 'offerBooking') {
      state.mode = 'book';
      if (!state.pending.service) state.pending = {};
      const ask = useRecentServices();
      return ask ?? nextStep();
    }
    if (state.lastQuestion === 'proposal' && state.proposals.length === 1) return book(state.proposals[0]);
    if (state.lastQuestion === 'proposal') return out(`¿Cuál prefieres? ${listTimes(state.proposals)}`);
    if (GOODBYE.test(t)) return out('¡Hasta pronto! 😊');
    if (ctx.appt && u.date && toISODate(u.date) !== ctx.appt.date) {
      // "sí, el jueves allí estaré" but her appointment is on Friday: don't move it, ask
      state.mode = 'reschedule';
      state.pending = { service: ctx.appt.service, details: ctx.appt.details ?? [{ name: ctx.appt.name }], duration: ctx.appt.duration };
      merge();
      const step = nextStep();
      return { ...step, reply: `Tu cita es ${formatDate(ctx.appt.date, today)} a las ${ctx.appt.time}. Si quieres cambiarla: ${lowerFirst(step.reply)}` };
    }
    if (ctx.appt) return out(`¡Genial! Te esperamos ${formatDate(ctx.appt.date, today)} a las ${ctx.appt.time} 😊`);
    return out('¡Perfecto! 😊');

}

module.exports = { moreTimes: handleMoreTimes, nextDay: handleNextDay, book: handleBook, choose: handleChoose, confirm: handleConfirm };
