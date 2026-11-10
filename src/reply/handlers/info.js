// info.js — Salon information: info texts, opening hours, the salon name, how the waiting list works.
const H = require('../../hours');
const F = require('../format');
const S = require('../slots');
const { toISODate, fromISODate, formatDate, groupWeekdays } = F;
const { closedReason, rangeText, closedForText } = S;

function handleInfo(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "¿aceptáis bizum?", "¿con cuánta antelación tengo que cancelar?": from settings.info, or the owner
    const answers = (u.infoTopics ?? [u.topic]).map(k => business.info?.[k]).filter(Boolean);
    if (!answers.length) return handover('Te contestaremos enseguida.');
    const text = answers.join(' ');
    if (BOOKING_QUESTIONS.includes(state.lastQuestion)) {
      const step = nextStep();
      return { ...step, reply: `${text} ${step.reply}` };
    }
    if (u.topic === 'walkIn' && !ctx.appt) {
      state.lastQuestion = 'offerBooking'; state.proposals = [];
      return out(`${text} ¿Quieres que te busque hueco?`);
    }
    state.lastQuestion = 'anythingElse'; state.proposals = [];
    return out(`${text} ¿Puedo ayudarte en algo más?`);
  }

}

function handleHours(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
  {
    // "¿abrís el 8 de diciembre?", "¿el sábado estáis?": that day
    if (u.date) {
      const iso = toISODate(u.date);
      const c = closedReason(iso, business);
      const when = formatDate(iso, today);
      const When = `${when[0].toUpperCase()}${when.slice(1)}`;
      if (c?.kind === 'range') return out(`${When} no: ${rangeText(c.from, c.to)} ${closedForText(c.reason)} 😔`);
      if (c) return out(`${When} estamos cerrados${c.kind === 'holiday' ? ` (${c.reason})` : ''} 😔`);
      const dayH = H.dayHours(business, iso);
      // "¿el lunes abrís por la tarde?", "¿el sábado cerráis a mediodía?"
      if (u.timeOfDay === 'midday') {
        const br = H.lunchBreak(dayH);
        return out(br ? `${When} cerramos a mediodía, de ${H.clock(br[0])} a ${H.clock(br[1])}. Abrimos ${H.intervalsText(dayH)}.` : `${When} no cerramos a mediodía: abrimos ${H.intervalsText(dayH)} 😊`);
      }
      if (u.timeOfDay) {
        const part = H.timeOfDayIntervals(dayH, u.timeOfDay);
        const label = u.timeOfDay === 'morning' ? 'por la mañana' : 'por la tarde';
        return out(part.length ? `Sí, ${when} ${label} abrimos ${H.intervalsText(part)} 😊` : `${When} ${label} cerramos 😔 Abrimos ${H.intervalsText(dayH)}.`);
      }
      return out(`Sí, ${when} abrimos ${H.intervalsText(dayH)} 😊`);
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
      if (parts.length) return out(`En ${name}, ${parts.join(', y ')}. El resto de días, horario normal: ${H.hoursSummary(business)}`);
      return out(`En ${name} abrimos con el horario de siempre: ${H.hoursSummary(business)}`);
    }
    // "¿cerráis a mediodía?", "¿abrís por las tardes?", "¿y por la mañana?": from the hours, days grouped
    if (u.timeOfDay) {
      const week = H.weekHours(business);
      const byDay = week.map(d => {
        if (u.timeOfDay === 'midday') { const br = H.lunchBreak(d); return br ? `cerramos de ${H.clock(br[0])} a ${H.clock(br[1])}` : d.length ? 'abrimos sin cerrar' : null; }
        const part = H.timeOfDayIntervals(d, u.timeOfDay);
        if (!part.length) return null;
        // a continuous day: "hasta las 20:00" / "desde las 9:30"; a split day: its own interval
        if (d.length === 1) return u.timeOfDay === 'afternoon' ? `hasta las ${H.clock(d[0][1])}` : `desde las ${H.clock(d[0][0])}`;
        return H.intervalsText(part);
      });
      const groups = groupWeekdays(byDay);
      if (u.timeOfDay === 'midday') {
        if (!week.some(d => H.lunchBreak(d))) return out(`No cerramos a mediodía 😊 ${H.hoursSummary(business)}`);
        return out(`A mediodía ${groups.map(g => `${g.days} ${g.text}`).join('; ')}.`);
      }
      const label = u.timeOfDay === 'morning' ? 'por la mañana' : 'por la tarde';
      if (!groups.length) return out(`${label[0].toUpperCase()}${label.slice(1)} no abrimos 😔 ${H.hoursSummary(business)}`);
      const also = previousTopic === 'hours' ? ' también' : '';
      return out(`Sí, ${label}${also}: ${groups.map(g => `${g.days} ${g.text}`).join('; ')}.`);
    }
    return out(H.hoursSummary(business));
  }

}

function handleName(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    return out(business.name ? `Somos ${business.name} 😊 ¿En qué te puedo ayudar?` : 'Te contestaremos enseguida.', business.name ? {} : { handover: true });

}

function handleHelp(ctx) {
  const { message, state, u, t, today, now, business, services, previousTopic, appts, GOODBYE, BOOKING_QUESTIONS,
    out, handover, remember, focusOn, matchAppointments, listAppointments, apptText, isFree, addNote, merge,
    useRecentServices, firstFreeDay, nextStep, moreTimes, cancelAppointment, book } = ctx;
    // "¿cómo funciona la lista de espera?"
    state.lastQuestion = 'offerWaitlistHelp';
    return out('Si el día que quieres no tengo hueco, te apunto en la lista de espera. Si alguien cancela, te escribo para darte su hora 😊 Solo dime para qué servicio y qué día (por ejemplo, "avísame si se libera algo el jueves por la tarde").');

}

module.exports = { info: handleInfo, hours: handleHours, name: handleName, help: handleHelp };
