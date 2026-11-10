// check.js — "¿Tengo cita?", "mis citas", "¿me lo mandas por escrito?".
const F = require('../format');
const { toISODate, formatDate, serviceLabel } = F;

function handleCheck(ctx) {
  const { state, u, t, today, business, appts, BOOKING_QUESTIONS, out, focusOn, matchAppointments,
        listAppointments, apptText, nextStep } = ctx;
    if (ctx.appt && /\b(escrito|olvide|mandas|mandais|envias|enviais|pasas|whatsapp|mensaje|recordar)\b/.test(t)) {
      const where = business.address ? `\n📍 ${business.address}` : '';
      return out(`¡Claro! Te lo dejo por escrito 📝\n${ctx.appt.name}\n📅 ${formatDate(ctx.appt.date, today)}\n🕒 a las ${ctx.appt.time}${where}`);
    }
    if (appts.length) {
      // all of them, or the ones she asks about ("¿y la de la manicura?", "¿tengo algo el viernes?")
      const asked = (u.service || u.date) ? matchAppointments(true) : appts;
      if (!asked.length) return out(`No veo ninguna cita${u.service ? ` de ${serviceLabel(u)}` : ''}${u.date ? ` ${formatDate(toISODate(u.date), today)}` : ''}. Tienes ${appts.length > 1 ? `estas: ${listAppointments(appts)}` : apptText(appts[0])}.`);
      // "citas" / "mis citas" on their own: after listing them, offer another one
      const bare = /^(las |mis |ver |ver las |ver mis )?(citas|reservas)( porfa| por favor| please)?$/.test(t);
      const more = bare && !BOOKING_QUESTIONS.includes(state.lastQuestion) ? ' ¿Quieres pedir otra?' : '';
      if (more) { state.lastQuestion = 'offerBooking'; state.proposals = []; }
      if (asked.length === 1) {
        if (!more) focusOn(asked[0]);
        return out(`Tienes cita ${formatDate(asked[0].date, today)} a las ${asked[0].time} para ${asked[0].name.toLowerCase()}.${more}`);
      }
      return out(`Tienes ${asked.length} citas: ${listAppointments(asked)}.${more}`);
    }
    // in the middle of a booking: say so and carry on with it
    if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
      const step = nextStep();
      return { ...step, reply: `Ahora mismo no tienes ninguna cita reservada. ${step.reply}` };
    }
    state.lastQuestion = 'offerBooking'; state.proposals = [];
    return out('Ahora mismo no tienes ninguna cita reservada. ¿Quieres pedir una?');

}

module.exports = { check: handleCheck };
