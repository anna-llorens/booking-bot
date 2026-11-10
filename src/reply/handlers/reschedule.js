// reschedule.js — Moving an appointment (or the booking in progress), and keeping it as it was.
const F = require('../format');
const S = require('../slots');
const { toMinutes, toHHMM, toISODate, fromISODate, formatDate, listTimes } = F;
const { closedReason, freeSlots, pickProposals } = S;

function handleReschedule(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // In the middle of booking a new service, a day or time is part of that booking, not a change to another
    // appointment she already has (unless she says so: "cámbiame la del corte")
    if (state.mode === 'book' && state.pending.service && [...BOOKING_QUESTIONS, 'notes'].includes(state.lastQuestion) &&
        !ctx.noneOfThem && !/\b(cambi\w*|pasa\w*|mueve\w*|mover\w*|aplaz\w*|adelant\w*|retras\w*)\b/.test(t)) {
      merge();
      return nextStep();
    }
    // Several appointments and no way to tell which one she wants to move: ask
    if (appts.length > 1 && state.mode !== 'reschedule') {
      const target = matchAppointments(false);
      if (target.length === 1) focusOn(target[0]);
      else {
        state.lastQuestion = 'whichAppointment'; state.whichFor = 'reschedule'; state.proposals = [];
        return out(`Tienes ${appts.length} citas: ${listAppointments(appts)}. ¿Cuál quieres cambiar?`);
      }
    }
    // "ninguna me va bien": a third option that day, or the same times one week later
    if (ctx.noneOfThem && state.lastQuestion === 'proposal' && state.pending.date) {
      const p = state.pending;
      const sameDay = p.date;
      // every time already offered for that day, not only the last ones
      const offered = [...new Set([...(state.offered?.date === sameDay ? state.offered.times : []), ...state.proposals])];
      const nextWeek = u.sameTime || /\b(semana que viene|proxima semana|semana siguiente)\b/.test(t);
      // "la semana que viene" with no weekday means the same weekday one week later, not Monday
      const namedDay = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|pasado manana|\d{1,2})\b/.test(t);
      const newDay = u.date && (namedDay || !nextWeek);
      if (!nextWeek && !newDay && !u.time) {
        const rest = freeSlots(sameDay, { duration: p.duration || 30, timeOfDay: p.timeOfDay }, now, business, isFree)
          .filter(m => !offered.includes(toHHMM(m)));
        if (rest.length) {
          state.proposals = pickProposals(rest, null, business.maxProposals);
          state.offered = { date: sameDay, times: [...offered, ...state.proposals] };
          return out(`Vale 😊 Ese día también tengo ${listTimes(state.proposals)}. ¿Te va bien${state.proposals.length > 1 ? ' alguna' : ''}? Si no, te miro otro día.`);
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
    if (!ctx.appt && !state.pending.service) {
      state.lastQuestion = 'offerBooking'; state.proposals = [];
      return out('No veo ninguna cita a tu nombre. ¿Quieres que te busque hueco?');
    }
    if (ctx.appt && state.mode !== 'reschedule') {
      state.mode = 'reschedule';
      state.pending = { service: ctx.appt.service, details: [{ name: ctx.appt.name }], duration: ctx.appt.duration };
    }
    merge();
    if (!u.date && !u.time && !u.timeOfDay && !state.pending.date && ctx.appt) {
      // no new day yet: show her appointment and propose the first free times
      const step = nextStep({ exclude: [] });
      return { ...step, reply: `Claro. Ahora tienes ${apptText(ctx.appt)}. ${step.reply}` };
    }
    return nextStep();

}

function handleKeep(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // "al final sí que puedo ir", "dejamos la cita como estaba"
    state.pending = {}; state.mode = 'book'; state.lastQuestion = null; state.proposals = [];
    if (ctx.appt) return out(`¡Genial! La mantenemos: ${apptText(ctx.appt)} 😊`);
    return out('¡Perfecto! 😊');

}

module.exports = { reschedule: handleReschedule, keep: handleKeep };
