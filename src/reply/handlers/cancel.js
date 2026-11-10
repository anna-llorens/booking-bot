// cancel.js — Cancelling: always asks first; with several appointments, asks which.

function handleCancel(ctx) {
  const { message, state, now, appts, out, focusOn, matchAppointments, listAppointments, apptText,
      cancelAppointment } = ctx;
    if (!ctx.appt) {
      state.pending = {}; state.lastQuestion = null; state.proposals = [];
      return out('Ahora mismo no tienes ninguna cita reservada.');
    }
    // Already asked "¿la anulo o la cambiamos?": now cancel it
    if (['confirmCancel', 'changeOrCancel'].includes(state.lastQuestion)) return cancelAppointment();
    // Several appointments: which one ("la del viernes", "la de la manicura"), or ask
    if (appts.length > 1) {
      const target = matchAppointments(true);
      if (target.length === 1) focusOn(target[0]);
      else {
        state.lastQuestion = 'whichAppointment'; state.whichFor = 'cancel'; state.proposals = [];
        return out(`Tienes ${appts.length} citas: ${listAppointments(appts)}. ¿Cuál quieres anular?`);
      }
    }
    // Never cancel on the first message: a misread would silently lose her appointment
    state.lastQuestion = 'confirmCancel'; state.proposals = [];
    return out(`Vaya 😔 Tienes ${apptText(ctx.appt)}. ¿Quieres que la anule o prefieres cambiarla a otro día?`);

}

module.exports = { cancel: handleCancel };
