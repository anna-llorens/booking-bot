// waitlist.js — The waiting list, and "luego te digo" (undecided).
const F = require('../format');
const { toISODate, formatDate, serviceLabel } = F;

function handleWaitlist(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "avísame si se libera algo antes", "si alguien cancela el jueves…": note what she wants, keep her appointment
    const p = state.pending;
    // the service she names, or the one she is booking, or the one of her current appointment
    const details = u.details.length ? u.details : p.details?.length ? p.details : (ctx.appt?.details ?? []);
    const entry = {
      service: u.service ?? p.service ?? ctx.appt?.service ?? null,
      details: details.map(d => ({ id: d.id, group: d.group, name: d.name, duration: d.duration ?? null })),
      date: u.date ? toISODate(u.date) : null,
      timeOfDay: u.timeOfDay ?? null,
      earlier: /\b(antes|mas pronto)\b/.test(t),
    };
    state.waitlist = [...(state.waitlist ?? []), entry];
    state.proposals = []; state.lastQuestion = null;
    const what = details.length ? ` para ${serviceLabel({ details })}` : entry.service ? ` para ${entry.service}` : '';
    const when = entry.date ? `${what ? '' : ' para'} ${formatDate(entry.date, today)}` : entry.earlier && ctx.appt ? ' por si queda algo antes' : '';
    const slot = entry.timeOfDay ? { morning: ' por la mañana', midday: ' a mediodía', afternoon: ' por la tarde' }[entry.timeOfDay] : '';
    const keep = ctx.appt ? ` Tu cita (${apptText(ctx.appt)}) se mantiene igual.` : '';
    return out(`¡Hecho! Te apunto en la lista de espera${what}${when}${slot}. Si se libera un hueco, te escribo 😊${keep}`, { waitlist: entry });
  }

}

function handleUndecided(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // "luego te digo", "lo hablo con mi marido y te confirmo": nothing is booked, the offer is dropped
    state.proposals = []; state.lastQuestion = null;
    if (u.declined) return out('¡Vale, sin problema! Aquí estamos para lo que necesites 😊');
    return out('¡Vale! Escríbeme cuando lo sepas y te busco hueco 😊');

}

module.exports = { waitlist: handleWaitlist, undecided: handleUndecided };
