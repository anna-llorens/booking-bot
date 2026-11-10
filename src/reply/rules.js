// rules.js — What runs before the intent handlers, in this order: answers to the bot's own open questions
// ("no" to "¿te busco hueco?", the notes question, "¿cuál de tus citas?"), follow-ups that change the topic
// ("y por la tarde también?", "otro"), and messages handled the same whatever the intent (a service the salon
// doesn't do, "¿en qué consiste?", "ayer no pude ir", "¿a las 5 o a las 6?"…). Returns a reply, or nothing.
const { understand } = require('../understand');
const SAMPLE_CATALOG = require('../catalog.json').services;
const F = require('./format');
const S = require('./slots');
const { toMinutes, toISODate, formatDate, serviceLabel, listTimes, noteFrom, lowerFirst, serviceExamples } = F;
const { freeSlots } = S;

function runRules(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE,
    BOOKING_QUESTIONS, out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree,
    addNote, merge, nextStep, moreTimes, book } = ctx;
  // "No" to "¿Quieres que te busque hueco?" / "¿Te apunto en la lista de espera?"
  if (['offerBooking', 'offerWaitlist'].includes(state.lastQuestion) && /^no\b/.test(t) && !u.service && !u.date && !u.time) {
    state.waitlistOffer = null;
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
    if (/^(no|nop|nope)?( nada)?( mas)?( gracias)?( (de momento|por ahora|nada mas))?$/.test(t) && t ||
        /^(no )?(nada|eso es todo|es todo|ya esta|de momento no|por ahora no|nada mas|todo bien)( gracias)?$/.test(t)) {
      return out('¡Perfecto! Que tengas un buen día 😊');
    }
    // "genial, gracias" / "adiós": she is done
    const bareReply = !u.service && !u.date && !u.time && !u.timeOfDay;
    if (bareReply && (u.intent === 'thanks' || GOODBYE.test(t) || (u.intent === 'confirm' && /\bgracias\b/.test(t)))) {
      return out('¡A ti! Que tengas un buen día 😊');
    }
    if (u.intent === 'confirm' && !u.service && !u.date && !u.time) return out('¡Claro! Dime 😊');
  }
  // A category on its own ("manos y pies", "corporal") or, right after the list, a category that is also a
  // general service ("depilación"): list that category's services. It doesn't change the booking in progress
  // and it is never written down as a note.
  {
    const onlyCategory = u.category && !u.service && t.split(' ').length <= 4;
    // the category names as the list shows them ("depilación" is both a category and a general service)
    const genericAfterList = u.category && previousTopic === 'services' &&
      /^(la |el |lo de |de )?(peluqueria|color|coloracion|tratamientos( capilares)?|barberia|facial|corporal|depilacion|manos y pies|unas|cejas y pestanas|cejas|pestanas)$/.test(t);
    if ((onlyCategory || genericAfterList || ((previousTopic === 'services' || state.lastQuestion === 'service') && u.category && !u.service)) &&
        [null, 'book', 'reschedule'].includes(u.intent) && !u.date && !u.time) ctx.topic = 'services';
  }

  // "precios de color", "precios de uñas": that category's price list (plural "precios" = a list)
  if (u.category && /\b(precios|tarifas)\b/.test(t) && !u.date && !u.time && [null, 'book', 'price', 'services'].includes(u.intent)) ctx.topic = 'services';

  // "otro", "otro día", "mejor otro" after "…¿o prefieres otro día?": the next day with room
  if (state.lastQuestion === 'proposal' && state.pending.date && !u.date && !u.time && !u.service &&
      /^(y )?(otro|otro dia|otro dia mejor|mejor otro( dia)?|prefiero otro( dia)?|otra fecha|otro diferente|otro distinto|el siguiente|el dia siguiente|al dia siguiente)( (por la|de) (manana|tarde)| a mediodia)?( porfa| por favor| mejor)?$/.test(t)) ctx.topic = 'nextDay';
  // "no", "tampoco", "otra", "otra hora" to the times on offer: none of them suits her (offer others, never a note)
  ctx.noneOfThem = u.noneOfThem || (state.lastQuestion === 'proposal' &&
    /^(no|nop|tampoco|no me va|no me viene|no me cuadra|no puedo a esa hora|otra|otras|otra hora|otras horas|otra mejor)( porfa| por favor)?$/.test(t));
  if (ctx.noneOfThem && state.lastQuestion === 'proposal' && ctx.topic !== 'reschedule') ctx.topic = 'reschedule';

  // "¿tienes más horarios?", "¿hay más huecos?", "¿alguna hora más?" while times are on offer: more times that day
  if (state.lastQuestion === 'proposal' && state.pending.date && !u.date && !u.time && !u.service &&
      /\b((mas|otras?|otros) (horas|horarios|huecos|opciones)|(tienes|teneis|hay|tendrias|tendriais) (algo )?mas\b|alguna (hora )?mas|que mas (tienes|teneis|hay))\b/.test(t)) ctx.topic = 'moreTimes';

  // "y la de la manicura?" right after telling her appointments: that one
  if (previousTopic === 'check' && (u.service || u.date) && !u.time && [null, 'book', 'reschedule'].includes(u.intent) &&
      /^(y )?(la|el|lo|las|los) (de|del)\b|^y\b/.test(t)) ctx.topic = 'check';

  // "tinte" right after "¿De qué servicio quieres saber el precio?": its price
  if (state.lastQuestion === 'priceService' && u.service && !u.date && !u.time && [null, 'book', 'price'].includes(u.intent)) ctx.topic = 'price';

  // "las dos cosas" / "ambas" right after "¿Para X, Y o las dos cosas?"
  if (state.lastQuestion === 'service' && state.recentServices?.length > 1 && !u.service && u.intent !== 'price' &&
      /\b(las dos|los dos|ambas|ambos|las 2|todo|todas|las tres)\b/.test(t)) ctx.topic = 'book';

  // Follow-ups that only make sense after the previous answer:
  //   after the opening hours: "¿y por la tarde también?"   after a price: "¿y si me hago también un corte?"
  const followUp = /^y\b|\btambien\b/.test(t) && !u.date && !u.time;
  if (previousTopic === 'hours' && followUp && !u.service && [null, 'book', 'hours'].includes(u.intent)) ctx.topic = 'hours';
  if (previousTopic === 'price' && followUp && [null, 'book', 'price'].includes(u.intent)) ctx.topic = 'price';


  // "no sé si podré ir mañana": don't move it to that day, ask what she wants
  if (u.unsure && !u.time) {
    ctx.topic = 'reschedule';
    state.proposals = [];
    if (!ctx.appt) {
      state.lastQuestion = 'offerBooking';
      return out('Ahora mismo no veo ninguna cita a tu nombre. ¿Quieres que te busque hueco?');
    }
    state.lastQuestion = 'changeOrCancel';
    return out(`Sin problema 😊 Tienes ${apptText(ctx.appt)}. ¿Quieres que la cambiemos a otro día o prefieres anularla?`);
  }

  // "perfecto pues el viernes" right after booking it: she is just confirming the same day
  if (ctx.appt && !state.lastQuestion && u.date && toISODate(u.date) === ctx.appt.date && !u.time && !u.service &&
      !/\b(cambi\w*|pasa\w*|mueve\w*|mover\w*|aplaz\w*|adelant\w*|retras\w*)\b/.test(t) &&
      ['book', 'reschedule', 'confirm'].includes(u.intent)) {
    ctx.topic = 'confirm';
    return out(`¡Genial! Te esperamos ${formatDate(ctx.appt.date, today)} a las ${ctx.appt.time} 😊`);
  }

  // Answer to "¿Quieres que apunte algo especial?": a note, a "no", or a change of plans
  if (state.lastQuestion === 'notes' && state.pending.time) {
    const time = state.pending.time;
    // a service named inside a note ("que no le corte el flequillo") is part of the note, not a change
    const looksLikeNote = !!noteFrom(message, t);
    const changes = u.date || u.time || u.option || ((u.service || u.timeOfDay) && !looksLikeNote) ||
      ['reschedule', 'cancel', 'undecided', 'wait', 'waitlist', 'check', 'price', 'hours', 'info', 'services', 'duration', 'keep'].includes(u.intent);
    if (!changes) {
      if (/^(si+|vale si|si quiero|si porfa|si por favor)$/.test(t)) return out('¡Claro! Dime qué quieres que apunte 😊');
      const nothing = /^(no|nop|nada|no nada|nada mas|no gracias|asi esta bien|esta bien|asi bien|todo bien|ninguna|nada especial|no hace falta)( gracias)?$/.test(t) ||
        (['confirm', 'thanks'].includes(u.intent) && !noteFrom(message, t));
      if (!nothing) addNote(message.trim().replace(/\s+/g, ' ').slice(0, 200));
      return book(time, { skipNotes: true });
    }
    state.lastQuestion = 'proposal'; // she changed something: carry on as with any offer
  }

  // A service that exists but this salon doesn't do ("tinte" at a beauty center): say so, don't ask "¿qué servicio?"
  if (!u.service && services !== SAMPLE_CATALOG && ['book', 'price', 'duration', 'choose', null].includes(u.intent) &&
      !['notes', 'confirmCancel', 'changeOrCancel'].includes(state.lastQuestion)) {
    const general = understand(message, { today, services: SAMPLE_CATALOG });
    if (general.service && general.service !== 'LAST' && !services.some(s => s.group === general.service)) {
      const label = serviceLabel(general);
      const name = business.name ? `En ${business.name} no hacemos` : 'No hacemos';
      if (BOOKING_QUESTIONS.includes(state.lastQuestion) && state.pending.service) {
        const step = nextStep();
        return { ...step, reply: `${name} ${label} 😔 ${step.reply}` };
      }
      state.lastQuestion = 'service'; state.proposals = [];
      return out(`${name} ${label} 😔 Lo que sí hacemos: ${serviceExamples(services, 5).join(', ')}… Si quieres, te enseño la lista completa («servicios»).`);
    }
  }

  // "¿en qué consiste?", "¿qué es el microblading?": the service's description, or the stylist explains
  if (/\b(en que consiste|que es (eso|esto|el|la|lo)|que incluye|que lleva|como es (eso|el|la)|que hac(eis|en|es) en|me explicas|explicame)\b/.test(t) &&
      !u.date && !u.time && [null, 'book', 'services', 'price', 'reschedule'].includes(u.intent)) {
    ctx.topic = 'describe';
    const source = u.details.length ? u.details : (state.pending.details ?? []);
    const texts = source.map(d => services.find(s => s.id === d.id)).filter(s => s?.description).map(s => s.description);
    const inBooking = BOOKING_QUESTIONS.includes(state.lastQuestion) && state.pending.service;
    if (texts.length) {
      if (inBooking) { const step = nextStep(); return { ...step, reply: `${texts.join(' ')} ${step.reply}` }; }
      state.lastQuestion = 'offerBooking'; state.proposals = [];
      if (u.details.length) remember(u.details);
      return out(`${texts.join(' ')} ¿Quieres que te busque hueco?`);
    }
    if (source.length || u.service) {
      if (inBooking) { const step = nextStep(); return { ...step, reply: `Te lo explica la peluquera enseguida 😊 Mientras, ${lowerFirst(step.reply)}`, handover: true }; }
      return { ...handover('Te lo explica la peluquera enseguida 😊'), fallback: false };
    }
  }

  // "¿estáis muy ocupados?", "¿tenéis mucho lío?": answer and offer a slot
  if (/\b(estais|estas|vais|ibais) (muy |tan |bastante )?(ocupad[oa]s?|liad[oa]s?|a tope|llenos|completos)\b|\b(teneis|tienes|hay) (mucho|tanto) (lio|trabajo|jaleo)\b/.test(t) && !u.date && !u.service) {
    ctx.topic = 'busy';
    if (BOOKING_QUESTIONS.includes(state.lastQuestion) && state.pending.service) { const step = nextStep(); return { ...step, reply: `Bastante, pero te encuentro hueco 😊 ${step.reply}` }; }
    state.lastQuestion = 'offerBooking'; state.proposals = [];
    return out('Bastante, ¡pero seguro que te encuentro un hueco! 😊 ¿Quieres que te busque uno?');
  }

  // "ya me dices cuando puedas", "me dices algo": she is waiting for the salon, not choosing a time
  if (/\b(ya me (dices|diras|contaras|cuentas|comentas)|me (dices|cuentas|comentas) algo|me (dices|cuentas) cuando (puedas|sepas|lo veas))\b/.test(t) && !u.date && !u.time) {
    ctx.topic = 'waitSalon';
    return out('¡Claro! En cuanto lo vea la peluquera, te escribe 😊');
  }

  // "no quiero depilación (, quiero manicura)": drop that service; use the other one if she names it
  if (/^(no|pero no) (quiero|queria|busco|necesito|me interesa|me apetece)\b/.test(t) && !u.date && !u.time &&
      ['book', null, 'reschedule'].includes(u.intent)) {
    const wanted = u.details.length > 1 ? u.details.slice(-1) : [];
    state.pending = wanted.length ? { service: wanted[0].group, details: wanted, duration: wanted[0].duration ?? null } : {};
    state.proposals = []; state.mode = 'book';
    ctx.topic = 'notThat';
    if (wanted.length) {
      const step = nextStep();
      return { ...step, reply: `¡Vale! ${step.reply}` };
    }
    state.lastQuestion = 'service';
    return out(`¡Vale! ¿Qué te quieres hacer entonces? (${serviceExamples(services).join(', ')}…) Si quieres, te enseño la lista («servicios»).`);
  }

  // "no sé qué quiero hacerme", "¿qué me recomiendas?": help her choose (before "quiero" makes it a booking)
  if (!u.service && !u.date && !u.time &&
      /\b(no se que (quiero|hacerme|me hago)|(me )?(puedes|podeis|podrias) (sugerir|recomendar|aconsejar)(me)?|sugerirme|recomiendas|recomendais|aconsejas|que me (hago|haria|recomiendas))\b/.test(t)) {
    ctx.topic = 'advice';
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
    if (times && ['book', 'reschedule', 'choose'].includes(ctx.topic)) {
      if (!['book', 'choose'].includes(ctx.topic) || state.mode === 'reschedule') state.mode = ctx.appt ? 'reschedule' : state.mode;
      if (ctx.appt && state.mode === 'reschedule' && !p.service) state.pending = { service: ctx.appt.service, details: ctx.appt.details ?? [], duration: ctx.appt.duration };
      merge();
      const q = state.pending;
      if (q.service && q.date) {
        const open = freeSlots(q.date, { duration: q.duration || 30 }, now, business, isFree);
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

  // Answer to "Tienes 2 citas: … ¿Cuál quieres cambiar / anular?"
  if (state.lastQuestion === 'whichAppointment') {
    const byOption = u.option ? [appts[u.option === -1 ? appts.length - 1 : u.option - 1]].filter(Boolean) : [];
    const chosen = byOption.length ? byOption : matchAppointments(true);
    if (chosen.length === 1) {
      focusOn(chosen[0]);
      const action = state.whichFor; state.whichFor = null;
      if (action === 'cancel') {
        state.lastQuestion = 'confirmCancel';
        return out(`Vale. ¿Seguro que quieres anular ${apptText(ctx.appt)}? Si prefieres, te la cambio a otro día.`);
      }
      state.mode = 'reschedule';
      state.pending = { service: ctx.appt.service, details: ctx.appt.details ?? [{ name: ctx.appt.name }], duration: ctx.appt.duration };
      state.lastQuestion = null;
      merge();
      const step = nextStep();
      return { ...step, reply: `Vale, ${apptText(ctx.appt)}. ${step.reply}` };
    }
    if (!['cancel', 'reschedule', 'undecided', 'wait', 'greeting', 'thanks'].includes(u.intent)) {
      return out(`¿Cuál de las dos? ${listAppointments(appts)}`);
    }
    state.lastQuestion = null;
  }
  return null;
}

module.exports = { runRules };
