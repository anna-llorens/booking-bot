// services.js — The catalog: the services list, prices and durations.
const F = require('../format');
const S = require('../slots');
const { euros, displayName, serviceLabel, listTimes, serviceExamples } = F;

function handleServices(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // the salon's own catalog, grouped by category; one category in detail if she asks for it
    const { CATEGORY_LABELS } = F;
    const priceText = list => { const p = list.map(s => s.price).filter(x => x != null); return p.length ? ` (desde ${euros(Math.min(...p))})` : ''; };
    const keepBooking = BOOKING_QUESTIONS.includes(state.lastQuestion);
    if (!keepBooking) { state.lastQuestion = 'service'; state.proposals = []; }
    const ending = keepBooking ? '' : ' ¿Qué te apetece? Dime el servicio y te busco hueco 😊';
    if (u.category) {
      const list = services.filter(s => s.category === u.category);
      if (!list.length) return out(`Ahora mismo no hacemos ${CATEGORY_LABELS[u.category]?.replace(/^\S+ /, '').toLowerCase() ?? 'eso'} 😔 ¿Te puedo ayudar con otra cosa?`);
      const lines = list.slice(0, 30).map(s => `• ${displayName(s)}${s.price != null ? `: ${euros(s.price)}` : ''}`);
      // in the middle of a booking, remind her of it instead of changing the subject
      const still = keepBooking && state.pending.service && state.proposals.length
        ? `\nSi prefieres otro de estos, dímelo. Si no, sigo con ${serviceLabel(state.pending)}: ${listTimes(state.proposals)} 😊`
        : keepBooking ? '' : `\n${ending.trim()}`;
      return out(`${CATEGORY_LABELS[u.category] ?? 'Servicios'}:\n${lines.join('\n')}${list.length > 30 ? '\n• …y más' : ''}${still}`);
    }
    const order = Object.keys(CATEGORY_LABELS);
    const cats = [...new Set(services.map(s => s.category))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const lines = cats.map(c => {
      const list = services.filter(s => s.category === c);
      const general = list.filter(s => s.id === s.group);
      const names = (general.length ? general : list).slice(0, 4).map(s => displayName(s).toLowerCase());
      return `• ${CATEGORY_LABELS[c] ?? c}: ${names.join(', ')}${list.length > names.length ? '…' : ''}${priceText(list)}`;
    });
    return out(`Esto es lo que hacemos:\n${lines.join('\n')}\nSi quieres el detalle de algo, pregúntame (por ejemplo, "¿qué hacéis de uñas?").${ending}`);
  }

}

function handlePrice(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    remember(u.details);
    // "¿y cuánto cuesta?" without naming the service: use the one we were talking about;
    // "¿todo junto cuánto sería?": everything she asked about
    const together = !u.details.length && /\b(todo|todos|junto|juntos|en total|las dos|los dos|ambos|ambas)\b/.test(t);
    const all = [...(state.pending.details ?? []), ...(state.recentServices ?? [])].filter((d, i, a) => a.findIndex(x => x.id === d.id) === i);
    const source = together && all.length > 1 ? { details: all } : u.details.length ? u : state.pending.details?.length ? state.pending : null;
    // "precios" with no service at all: ask which one instead of handing it over
    if (!source) {
      state.lastQuestion = 'priceService'; state.proposals = [];
      const ex = serviceExamples(services, 3);
      return out(`¿De qué servicio quieres saber el precio? (por ejemplo, ${ex.slice(0, -1).join(', ')} o ${ex.at(-1)}) Si quieres, te digo los precios de un tipo de servicio, por ejemplo «precios de uñas».`);
    }
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

}

function handleDuration(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    remember(u.details); // "¿cuánto dura la keratina?" → "vale": book keratina without asking again
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

}

module.exports = { services: handleServices, price: handlePrice, duration: handleDuration };
