// smalltalk.js — Greetings, thanks, waiting, events, lateness, and everything else (the default).
const { isNonsense, isLaugh } = require('../../dictionary');
const F = require('../format');
const { toISODate, noteFrom, lowerFirst } = F;

function handleWait(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // "espera", "voy a mirar una cosa": nothing changes, whatever was on offer is still on offer
    return out('¡Claro, tómate tu tiempo! 😊');

}

function handleEvent(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "tengo una boda el sábado": nice to know, but it's not the day of the appointment
    state.pending.beforeDate = toISODate(u.eventDate);
    if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `¡Qué bien! 🎉 ${step.reply}` }; }
    state.lastQuestion = 'offerBooking';
    return out('¡Qué bien! 🎉 ¿Quieres que te busque hueco antes?');
  }

}

function handleGreeting(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    const smallTalk = /\b(que tal|como (estas|estais|esta|va|vais|te va|os va|andas|andais)|todo bien|(estas|estais|esta usted) bien)\b/.test(t);
    const hello = smallTalk ? '¡Muy bien, gracias! 😊' : '¡Hola! 😊';
    // in the middle of a booking: answer and carry on with it
    if (BOOKING_QUESTIONS.includes(state.lastQuestion) && state.pending.service) {
      const step = nextStep();
      return { ...step, reply: `${hello} ${step.reply}` };
    }
    return out(`${hello} ¿En qué te puedo ayudar? Te puedo dar cita, cambiarla o anularla.`);
  }

}

function handlePreamble(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // "una pregunta", "ah y una cosa": keep whatever was going on and wait for the question
    return out('¡Claro, dime! 😊');

}

function handleThanks(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    if (/\bgracias\b|amable/.test(u.normalizedText) && !/gust|encant|mejores|contenta|dejaste|quedo/.test(u.normalizedText)) {
      return out('¡A ti! 😊');
    }
    return out('¡Muchísimas gracias! Nos alegra mucho que te gustara 😊');

}

function handleLate(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    return out(previousTopic === 'late' ? '¡Sin problema, aquí te esperamos! 😊' : '¡Gracias por avisar! Te esperamos 🙏');

}

function handleDefault(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "??????", "...": she is waiting for an answer or didn't get the last one
    if (!t.trim()) {
      if (BOOKING_QUESTIONS.includes(state.lastQuestion)) { const step = nextStep(); return { ...step, reply: `Perdona 😊 ${step.reply}` }; }
      return out('¿Sí? Dime en qué te puedo ayudar 😊 Te puedo dar cita, cambiarla o anularla.');
    }
    // "me he dejado el paraguas": lost things, for the owner, with a nicer answer
    if (/\b(me he dejado|me deje|me olvide|se me olvido|he perdido|habeis visto|has visto)\b/.test(t) && !u.service && !u.date) {
      return { ...handover('Lo miramos y te decimos enseguida 😊'), fallback: false };
    }
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
    // "creo que funciona bastante bien", "esto está muy bien": positive feedback
    if (/\b(funciona (muy |bastante |super )?bien|esta (muy |bastante |super )?bien( esto| hecho)?|me gusta (mucho |bastante )?(esto|como funciona|el bot)|que (bien|chulo|util) (esto|el bot)|muy util)\b/.test(t)) {
      return out('¡Muchas gracias! 😊 ¿Te puedo ayudar en algo?');
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
      if (state.lastQuestion === 'service' && !state.pending.service) {
        return out('No sé qué servicio es ese 🤔 ¿Me lo dices de otra forma? Si quieres, te digo lo que hacemos (por ejemplo, "¿qué hacéis de uñas?").', { fallback: true, nonsense: true });
      }
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
    // Asked for the service and got something it doesn't know: not a note, and don't repeat the same list
    if (state.lastQuestion === 'service' && !state.pending.service) {
      return { ...out('No sé qué servicio es ese 🤔 ¿Me lo dices de otra forma? Si quieres, te digo lo que hacemos (por ejemplo, "¿qué hacéis de uñas?").'), fallback: true };
    }
    if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
      const isQuestion = /\?\s*$/.test(message.trim()) ||
        /^(que|como|cuando|donde|cuanto|cuanta|cuantos|por que|porque|sabes|sabeis|teneis|tienes|hay|puedo|se puede|podeis|puedes|con que)\b/.test(t);
      // only a remark with some content is written down ("tengo una boda por la noche", "tiene el pelo largo");
      // two or three loose words ("estás bien", "vale ya") are not a note
      if (!isQuestion && (noteFrom(message, t) || t.split(' ').length >= 4)) {
        // "tiene el pelo bastante largo", "tengo una boda por la noche": written down for the stylist
        addNote(message.trim().replace(/\s+/g, ' ').slice(0, 200));
        const step = nextStep();
        return { ...step, reply: `Tomo nota 😊 Mientras, ${lowerFirst(step.reply)}` };
      }
      if (!isQuestion) {
        const step = nextStep();
        return { ...step, reply: `Perdona, no te he entendido 😅 ${step.reply}`, fallback: true };
      }
      const step = nextStep();
      return { ...step, reply: `Te contestaremos enseguida. Mientras, ${lowerFirst(step.reply)}`, handover: true, fallback: true };
    }
    return { ...handover('Te contestaremos enseguida.'), fallback: !u.offTopic };
  }
}

module.exports = { wait: handleWait, event: handleEvent, greeting: handleGreeting, preamble: handlePreamble, thanks: handleThanks, late: handleLate, default: handleDefault };
