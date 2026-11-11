// reply-owner.js — Owner mode: answers the salon owner and prepares the changes she asks for. Pure: no store.
//
//   respondOwner(message, state, options) → { reply, state, changes, understanding }
//
// options: today (salon wall-clock Date), business (settings + name), catalog (every service, also inactive),
//          appointments (booked, from today on, with customerName), inbox, waitlist, lastChange, isFree
//
// Queries ("¿qué tengo hoy?") are answered straight away. Changes are never applied here: the bot asks
// "¿…? (sí / no)", keeps the change in state.pending, and returns it in `changes` only after "sí".
// src/bot.js applies `changes` and records each one (table owner_changes) so "deshacer" can revert it.
//
// Each change carries what it needs to be applied and undone:
//   settings changes  { type, set: { key: newValue }, previous: { key: oldValue or null }, summary }
//   catalog changes   { type, serviceId, price | duration | active, previous: { … }, summary }
//   appointments      { type, appointmentId, date, time, previous, summary } / bookManual { name, date, time, details… }
//   undo              { type: 'undo', changeId, summary }
const H = require('../hours');
const { understandOwner } = require('./understand-owner');
const { closedReason } = require('../reply/slots');
const { euros, fromISODate } = require('../reply/format');
const { normalize } = require('../understand');

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cap = s => s[0].toUpperCase() + s.slice(1);
const joinList = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}` : items[0] ?? '');

// "jueves 12 de noviembre"
function dayName(isoDate) {
  const d = fromISODate(isoDate);
  return `${d.toLocaleDateString('es-ES', { weekday: 'long' })} ${d.getDate()} de ${d.toLocaleDateString('es-ES', { month: 'long' })}`;
}
// "el jueves 12 de noviembre", "hoy (martes 10 de noviembre)"
function dayText(isoDate, today) {
  const diff = Math.round((fromISODate(isoDate) - fromISODate(iso(today))) / 86400000);
  if (diff === 0) return `hoy (${dayName(isoDate)})`;
  if (diff === 1) return `mañana (${dayName(isoDate)})`;
  return `el ${dayName(isoDate)}`;
}
const rangeText = (from, to) => `del ${dayName(from)} al ${dayName(to)}`;
const hoursText = intervals => (intervals.length ? H.intervalsText(intervals) : 'cerrado');

// "34600000004" → "+34 600 000 004"; customers booked by hand have no phone
const formatPhone = p => (!p || p.startsWith('manual:') ? null : /^34\d{9}$/.test(p) ? `+34 ${p.slice(2, 5)} ${p.slice(5, 8)} ${p.slice(8)}` : `+${p}`);
const customerName = a => a.customerName || formatPhone(a.customerPhone) || 'sin nombre';
// old appointments booked as "lo de siempre" without knowing what that was
const apptService = a => (a.service === 'LAST' ? 'servicio sin concretar («lo de siempre»)' : a.name);
const apptLine = a => `• ${a.time} ${customerName(a)} — ${apptService(a)} (${durationText(a.duration)})`;
const apptLineWithDay = a => `• ${dayName(a.date)}, ${a.time} ${customerName(a)} — ${apptService(a)}`;
// 45 → "45 min", 120 → "2 h", 90 → "1 h 30 min"
const durationText = m => (m == null ? 'sin duración' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
// who wrote a message in the inbox
const sender = h => (h.customerName ? `${h.customerName} (${formatPhone(h.phone) ?? 'sin teléfono'})` : formatPhone(h.phone) ?? 'sin teléfono');
const INBOX_PAGE = 5;

const serviceName = s => s.name;
const findService = (catalog, id) => catalog.find(s => s.id === id) ?? null;

const HELP = [
  'Esto es lo que puedo hacer en modo dueña:',
  '📅 Agenda: «¿qué tengo hoy?», «citas de mañana», «¿cuántas citas tengo esta semana?»',
  '🔒 Cierres: «el jueves cierro», «cierro del 10 al 24 de agosto por vacaciones», «al final el jueves abro»',
  '🕘 Horarios: «mañana abro a las 10», «a partir de ahora los sábados cierro a las 14», «¿qué horario tengo?»',
  '💶 Servicios: «queratina» (ver duración y precio), «queratina 4h», «sube el tinte a 38», «¿cuánto cobro por las mechas?», «ya no hago permanente»',
  '✍️ Citas: «apunta a Lucía mañana a las 10 para corte», «cancela la cita de Ana del jueves», «mueve la de las 17:00 del viernes a las 18:00»',
  '📥 «¿qué me han preguntado?» y luego un número: ignorar, responder a la clienta o enseñarle la respuesta al bot · «ignora todos» · «¿qué respuestas has aprendido?»',
  '⏳ «¿quién hay en lista de espera?»',
  '↩️ «deshacer» deshace el último cambio · 👋 «salir» para salir del modo dueña',
].join('\n');
const NOT_UNDERSTOOD = 'No te he entendido 😅 Escribe *ayuda* para ver ejemplos.';
const UNDO_HINT = 'Si te has equivocado, escribe *deshacer*.';
const NO_AUTO_CANCEL = 'Las citas NO se cancelan solas: avisa a esas clientas o dime «cancela la cita de …».';

// ---- free time in a day (for the agenda and for booking by hand) ----

// Free stretches of a day as [[from, to]], in minutes: open and with fewer than `capacity` appointments
function freeStretches(date, business, appointments, fromMinute = 0) {
  const capacity = business.capacity ?? 1;
  const busy = appointments.filter(a => a.date === date).map(a => [toMinutes(a.time), toMinutes(a.time) + a.duration]);
  const out = [];
  for (const [a, b] of H.dayHours(business, date)) {
    let start = null;
    for (let m = Math.max(a, fromMinute); m <= b; m += 5) {
      const free = m < b && busy.filter(([x, y]) => x <= m && m < y).length < capacity;
      if (free && start === null) start = m;
      if (!free && start !== null) { if (m - start >= 15) out.push([start, m]); start = null; }
    }
  }
  return out;
}

// Free start times that day for `duration`, closest to `wanted` first
function freeTimes(date, duration, business, isFree, wanted = null, limit = 3) {
  const step = business.slotMinutes ?? 30;
  const times = [];
  for (const [a, b] of H.dayHours(business, date)) {
    for (let m = a; m + duration <= b; m += step) if (isFree(date, m, duration)) times.push(m);
  }
  if (wanted != null) times.sort((x, y) => Math.abs(x - wanted) - Math.abs(y - wanted) || x - y);
  return times.slice(0, limit).sort((x, y) => x - y).map(H.clock);
}

// Appointments that would no longer fit with new hours: hoursFor(date) → intervals ([] = closed), or undefined = unchanged
function affectedBy(appointments, hoursFor) {
  return appointments.filter(a => {
    const h = hoursFor(a.date);
    return h !== undefined && !H.fitsInside(h, toMinutes(a.time), a.duration);
  });
}

// ---- the reply ----

function respondOwner(message, state = {}, options = {}) {
  const { today, business = {}, catalog = [], appointments = [], inbox = [], waitlist = [], lastChange = null, isFree = () => true } = options;
  const u = understandOwner(message, { today, catalog });
  const todayISO = iso(today);
  const pending = state.pending ?? null;
  let newState = { ...state, pending: null, lastTopic: u.intent ?? state.lastTopic ?? null };
  // "de el viernes" → "del viernes", "a el jueves" → "al jueves"
  const tidy = text => text.replace(/\bde el\b/g, 'del').replace(/\ba el\b/g, 'al');
  const out = (reply, extra = {}) => ({ reply: tidy(reply), state: newState, changes: [], understanding: u, ...extra });

  // Ask before changing anything: "¿Cierro el jueves 12 de noviembre? (sí / no)"
  const confirm = (change, question, done, warning = '', after = null) => {
    newState = { ...newState, pending: { kind: 'confirm', changes: [change], done, after } };
    return out(`${warning ? warning + '\n\n' : ''}${question} (sí / no)`);
  };
  // "Ojo: ese día tienes 2 citas:" + the list + "Las citas NO se cancelan solas…"
  const warnList = (list, where) => list.length
    ? `Ojo: ${where(list.length === 1 ? '1 cita' : `${list.length} citas`)}:\n${list.map(apptLineWithDay).join('\n')}\n${NO_AUTO_CANCEL}`
    : '';

  // leaving owner mode: src/bot.js writes the goodbye (it knows whether this phone is an owner's)
  if (u.intent === 'logout') return out('', { logout: true, asCustomer: u.asCustomer });

  // ---- answers to the bot's own questions ----
  if (pending?.kind === 'confirm') {
    // after an inbox action, back to the list: "Dime otro número…"
    const back = pending.after ? afterInbox(pending.after, pending.changes) : '';
    if (u.intent === 'yes') {
      newState.lastTopic = 'changed';
      return out(`Hecho ✅ ${pending.done} ${UNDO_HINT}${back}`, { changes: pending.changes });
    }
    if (u.intent === 'no') return out(`Vale, no cambio nada 👍${back}`);
  }

  // ---- the inbox: a list, then one message with its options, then the reply text ----
  if (pending?.kind === 'replyText') {
    const h = inbox.find(x => x.id === pending.handoverId);
    if (u.intent === 'no' || /^(cancela|cancelar|dejalo|nada)$/.test(u.normalizedText)) return out(`Vale, no le respondo 👍${afterInbox(pending.after)}`);
    if (!h) return out('Ese mensaje ya no está pendiente 🤔');
    if (!['undo', 'help', 'logout'].includes(u.intent)) return replyToCustomer(h, message.trim(), pending.teach, pending.after);
  }
  if (pending?.kind === 'inboxItem') {
    const h = inbox.find(x => x.id === pending.handoverId);
    const choice = u.number ?? null;
    if (h && (choice === 1 || (u.intent === 'ignore' && !u.numbers.length && !u.all))) return ignore([h], pending.after, false);
    if (h && (choice === 2 || u.intent === 'replyChoice')) return askReplyText(h, false, pending.after);
    if (h && (choice === 3 || u.intent === 'teachChoice')) return askReplyText(h, true, pending.after);
    if (u.intent === 'inboxMore' || u.intent === 'inbox') return showInbox(0, u.all);
    if (!h) return out('Ese mensaje ya no está pendiente 🤔 Escribe «¿qué me han preguntado?» para ver los que quedan.');
  }
  if (pending?.kind === 'inbox') {
    if (u.intent === 'inboxMore') return showInbox(u.all ? 0 : pending.shown, u.all, pending.ids);
    if (!u.intent && u.number) {
      const id = pending.ids[u.number - 1];
      const h = inbox.find(x => x.id === id);
      if (!id) return out(`No tengo el número ${u.number} 🤔 Van del 1 al ${pending.ids.length}.`, { state: (newState = { ...newState, pending }) });
      if (!h) return out(`El ${u.number} ya no está pendiente. Dime otro número.`, { state: (newState = { ...newState, pending }) });
      return showItem(h, pending);
    }
  }
  if (u.intent === 'ignore') {
    const list = pending?.kind === 'inbox' || pending?.kind === 'inboxItem' ? (pending.after ?? pending) : null;
    if (u.ask) {
      if (list) newState = { ...newState, pending: list };
      return out(list ? '¿Cuáles? Dime los números, por ejemplo «ignora 1, 3 y 5».' : 'Primero te enseño los mensajes: escribe «¿qué me han preguntado?» y luego «ignora 1, 3 y 5».');
    }
    if (u.all) {
      if (!inbox.length) return out('No tienes mensajes pendientes 🎉');
      return ignore(inbox, null, true);
    }
    if (u.numbers.length) {
      const ids = list?.ids ?? inbox.map(h => h.id);
      const chosen = u.numbers.map(n => inbox.find(h => h.id === ids[n - 1])).filter(Boolean);
      if (!chosen.length) return out('No encuentro esos mensajes 🤔 Escribe «¿qué me han preguntado?» para ver la lista con sus números.');
      return ignore(chosen, list, true);
    }
    return out('¿Qué mensajes ignoro? Por ejemplo «ignora 1, 3 y 5» o «ignora todos».');
  }
  if (u.intent === 'inboxMore' && inbox.length) return showInbox(0, u.all);
  if (pending?.kind === 'choose') {
    const n = u.normalizedText.match(/^(?:la |el )?(\d)$|^(?:la )?(primera|segunda|tercera|cuarta)$/);
    const index = n ? (n[1] ? +n[1] : ['primera', 'segunda', 'tercera', 'cuarta'].indexOf(n[2]) + 1) - 1 : -1;
    const options_ = pending.ids.map(id => appointments.find(a => a.id === id)).filter(Boolean);
    let chosen = options_[index] ?? null;
    if (!chosen && (u.time || u.date)) {
      const m = options_.filter(a => (!u.time || a.time === u.time) && (!u.date || a.date === u.date));
      if (m.length === 1) chosen = m[0];
    }
    if (chosen) return actOnAppointment(pending.action, chosen, pending);
    if (u.intent === 'no') return out('Vale, lo dejamos 👍');
    if (!u.intent) return out(`¿Cuál de ellas? Dime el número (1-${options_.length}).`, { state: (newState = { ...newState, pending }) });
  }
  if (pending?.kind === 'draft' && !['yes', 'no', 'undo', 'help', 'logout'].includes(u.intent) &&
      (!u.intent || u.intent === 'agenda' || u.intent === 'serviceInfo' || u.intent === pending.action)) {
    const d = { ...pending.draft };
    const before = JSON.stringify(d);
    if (pending.asking === 'name' && !u.intent && !u.date && !u.time && !u.serviceId) d.name = message.trim().replace(/[.!?¿¡]/g, '').replace(/^\w/, c => c.toUpperCase());
    for (const k of ['name', 'date', 'time', 'serviceId']) if (u[k] && !(k === 'name' && pending.asking !== 'name' && d.name)) d[k] = u[k];
    if (pending.action === 'moveAppointment') {
      if (u.date) d.newDate = u.date;
      if (u.time) d.newTime = u.time;
    }
    if (JSON.stringify(d) !== before) {
      return pending.action === 'bookManual' ? bookManual(d) : moveAppointment(d, pending.appointmentId);
    }
    if (u.intent === 'no') return out('Vale, lo dejamos 👍');
  }
  if (u.intent === 'yes' || u.intent === 'no') {
    return out(u.intent === 'yes' ? 'No tengo nada pendiente de confirmar 😊 ¿Qué necesitas?' : 'Vale 👍');
  }

  // ---- queries ----
  if (u.intent === 'help') return out(HELP);
  if (u.intent === 'agenda' || (!u.intent && u.date && state.lastTopic === 'agenda')) {
    newState.lastTopic = 'agenda';
    return out(agenda(u.from ? u : { date: u.date ?? todayISO }));
  }
  if (u.intent === 'inbox') return showInbox(0, false);
  if (u.intent === 'learnedAnswers') {
    const learned = business.learnedAnswers ?? [];
    if (!learned.length) return out('Todavía no me has enseñado ninguna respuesta. En «¿qué me han preguntado?», elige un mensaje y la opción 3.');
    newState = { ...newState, pending: { kind: 'learned' } };
    return out(`Contesto yo sola a estos mensajes:\n${learned.map((l, i) => `${i + 1}) «${l.text}» → «${l.answer}»`).join('\n')}\n\nPara que deje de usar una: «olvida la respuesta 2».`);
  }
  if (u.intent === 'forgetAnswer') {
    const learned = business.learnedAnswers ?? [];
    const item = learned[u.number - 1];
    if (!item) return out(learned.length ? `No tengo la respuesta ${u.number} 🤔 Van del 1 al ${learned.length}.` : 'No tengo respuestas aprendidas.');
    return confirm(
      { type: 'forgetAnswer', set: { learnedAnswers: learned.filter(l => l !== item) }, previous: { learnedAnswers: learned }, summary: `olvidar la respuesta a «${item.text}»` },
      `¿Dejo de contestar sola a «${item.text}»? A partir de ahora te llegará a ti.`, `Olvidada: «${item.text}» vuelve a llegarte a ti.`);
  }
  if (u.intent === 'waitlist') {
    if (!waitlist.length) return out('No hay nadie en lista de espera.');
    const lines = waitlist.map(w => {
      const svc = w.details?.[0]?.name ?? w.service;
      const when = [w.date && dayName(w.date), w.timeOfDay && { morning: 'por la mañana', midday: 'a mediodía', afternoon: 'por la tarde' }[w.timeOfDay], w.earlier && 'antes que su cita'].filter(Boolean).join(', ');
      return `• +${w.phone}: ${[svc, when].filter(Boolean).join(', ') || 'cualquier hueco'}`;
    });
    return out(`En lista de espera (${waitlist.length}):\n${lines.join('\n')}`);
  }
  if (u.intent === 'hours') return out(hoursOverview());

  // ---- catalog ----
  if (['serviceInfo', 'getPrice', 'getDuration', 'setPrice', 'setDuration', 'disableService', 'enableService'].includes(u.intent)) {
    const s = findService(catalog, u.serviceId);
    if (!s) return out(NOT_UNDERSTOOD);
    const off = s.active === false ? ' (ahora no lo ofreces)' : '';
    const short = s.synonyms?.[0] ?? serviceName(s).toLowerCase();
    if (u.intent === 'serviceInfo') {
      return out(`${serviceName(s)}${off}: ${durationText(s.duration)} · ${s.price != null ? euros(s.price) : 'sin precio'}.\nPara cambiarlo: «${short} ${s.duration === 240 ? '3h' : '4h'}» o «${short} a ${s.price != null ? s.price + 5 : 40} €».`);
    }
    if (u.intent === 'getPrice') {
      return out(s.price != null ? `${serviceName(s)}${off}: ${euros(s.price)}.` : `${serviceName(s)} no tiene precio puesto. Si quieres, dime por ejemplo «${serviceName(s).toLowerCase()} a 30 €».`);
    }
    if (u.intent === 'getDuration') return out(s.duration ? `Ahora mismo ${serviceName(s)}${off} dura ${durationText(s.duration)}.` : `${serviceName(s)} no tiene duración puesta. Dime por ejemplo «${short} 2h».`);
    if (u.intent === 'setPrice') {
      if (u.price <= 0 || u.price > 2000) return out(`¿${euros(u.price)}? Me parece raro 🤔 Dímelo otra vez, por ejemplo «${serviceName(s).toLowerCase()} a 30 €».`);
      if (s.price === u.price) return out(`${serviceName(s)} ya está a ${euros(u.price)} 😊`);
      return confirm(
        { type: 'setPrice', serviceId: s.id, price: u.price, previous: { price: s.price ?? null }, summary: `${serviceName(s)} a ${euros(u.price)}` },
        `¿Pongo ${serviceName(s)} a ${euros(u.price)}?${s.price != null ? ` (ahora está a ${euros(s.price)})` : ''}`,
        `${serviceName(s)} ahora cuesta ${euros(u.price)}.`);
    }
    if (u.intent === 'setDuration') {
      if (u.duration < 5 || u.duration > 600) return out(`¿${u.duration} minutos? Me parece raro 🤔 Dímelo otra vez, por ejemplo «el tinte dura hora y media».`);
      if (s.duration === u.duration) return out(`${serviceName(s)} ya dura ${durationText(u.duration)} 😊`);
      return confirm(
        { type: 'setDuration', serviceId: s.id, duration: u.duration, previous: { duration: s.duration ?? null }, summary: `${serviceName(s)} dura ${durationText(u.duration)}` },
        `${s.duration ? `Ahora mismo ${serviceName(s)} dura ${durationText(s.duration)}. ` : ''}¿Lo cambio a ${durationText(u.duration)}?`,
        `Ahora ${serviceName(s)} dura ${durationText(u.duration)}${s.duration ? ` (antes ${durationText(s.duration)})` : ''}. Las citas ya reservadas mantienen su duración.`);
    }
    if (u.intent === 'disableService') {
      if (s.active === false) return out(`${serviceName(s)} ya no se ofrece 😊`);
      const booked = appointments.filter(a => a.details?.some(d => d.id === s.id) || (a.details?.length === 0 && a.service === s.group));
      const warning = booked.length ? `Ojo: ${plural(booked.length, 'cita reservada lleva', 'citas reservadas llevan')} ${serviceName(s)}:\n${booked.map(apptLineWithDay).join('\n')}\nEsas citas se mantienen.` : '';
      return confirm(
        { type: 'disableService', serviceId: s.id, active: false, previous: { active: true }, summary: `quitar ${serviceName(s)}` },
        `¿Quito ${serviceName(s)} de los servicios? Las clientas ya no podrán pedirlo.`,
        `${serviceName(s)} ya no se ofrece.`, warning);
    }
    if (s.active !== false) return out(`${serviceName(s)} ya se ofrece 😊`);
    return confirm(
      { type: 'enableService', serviceId: s.id, active: true, previous: { active: false }, summary: `volver a ofrecer ${serviceName(s)}` },
      `¿Vuelvo a ofrecer ${serviceName(s)}?`, `${serviceName(s)} vuelve a estar disponible.`);
  }

  // ---- closures and hours ----
  if (u.intent === 'closeDate') {
    if (u.date < todayISO) return out(`El ${dayName(u.date)} ya ha pasado 🤔`);
    const c = closedReason(u.date, business);
    if (c) return out(`${cap(dayText(u.date, today))} ya está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`} 😊`);
    const entry = u.reason ? { date: u.date, reason: u.reason } : u.date;
    const before = business.closedDates ?? null;
    const warning = warnList(affectedBy(appointments, d => (d === u.date ? [] : undefined)), n => `ese día tienes ${n}`);
    return confirm(
      { type: 'closeDate', date: u.date, set: { closedDates: [...(before ?? []), entry] }, previous: { closedDates: before }, summary: `cerrar ${dayText(u.date, today)}` },
      `¿${warning ? 'Cierro igualmente' : 'Cierro'} ${dayText(u.date, today)}?`, `${cap(dayText(u.date, today))} queda cerrado.`, warning);
  }
  if (u.intent === 'closeRange') {
    if (u.to < todayISO) return out('Esas fechas ya han pasado 🤔');
    const before = business.closedRanges ?? null;
    const range = { from: u.from, to: u.to, reason: u.reason };
    const warning = warnList(affectedBy(appointments, d => (d >= u.from && d <= u.to ? [] : undefined)), n => `en esos días tienes ${n}`);
    return confirm(
      { type: 'closeRange', from: u.from, to: u.to, reason: u.reason, set: { closedRanges: [...(before ?? []), range] }, previous: { closedRanges: before }, summary: `cerrar ${rangeText(u.from, u.to)}` },
      `¿${warning ? 'Cierro igualmente' : 'Cierro'} ${rangeText(u.from, u.to)} (${u.reason})?`,
      `Cerrado ${rangeText(u.from, u.to)}. Las clientas que pidan esos días sabrán que estás de ${u.reason}.`, warning);
  }
  if (u.intent === 'openDate') {
    const c = closedReason(u.date, business);
    if (!c) return out(`${cap(dayText(u.date, today))} ya abres: ${hoursText(H.dayHours(business, u.date))} 😊`);
    if (c.kind === 'weekday') {
      return out(`${cap(dayText(u.date, today))} normalmente no abres. Dime el horario de ese día, por ejemplo «el ${dayName(u.date).split(' ')[0]} abro de 10 a 14».`);
    }
    const set = {}, previous = {};
    if (c.kind === 'holiday') {
      previous.closedDates = business.closedDates ?? null;
      set.closedDates = (business.closedDates ?? []).filter(x => (typeof x === 'string' ? x : x.date) !== u.date);
    } else {
      // a day in the middle of the holidays: split the range around it
      previous.closedRanges = business.closedRanges ?? null;
      const prev = d => { const x = fromISODate(d); x.setDate(x.getDate() - 1); return iso(x); };
      const next = d => { const x = fromISODate(d); x.setDate(x.getDate() + 1); return iso(x); };
      set.closedRanges = (business.closedRanges ?? []).flatMap(r => (u.date < r.from || u.date > r.to ? [r] : [
        ...(r.from <= prev(u.date) ? [{ ...r, to: prev(u.date) }] : []),
        ...(next(u.date) <= r.to ? [{ ...r, from: next(u.date) }] : []),
      ]));
    }
    return confirm(
      { type: 'openDate', date: u.date, set, previous, summary: `abrir ${dayText(u.date, today)}` },
      `¿Abro ${dayText(u.date, today)} con el horario de siempre (${hoursText(H.dayHours(business, u.date))})?`,
      `${cap(dayText(u.date, today))} abres: ${hoursText(H.dayHours(business, u.date))}.`);
  }
  if (u.intent === 'setDayHours') {
    if (u.date < todayISO) return out(`El ${dayName(u.date)} ya ha pasado 🤔`);
    const current = H.dayHours(business, u.date);
    const intervals = newIntervals(current, u);
    if (!intervals) return out(`${cap(dayText(u.date, today))} normalmente no abres. Dime el horario completo, por ejemplo «${dayText(u.date, today).split(' (')[0]} abro de 10 a 14».`);
    if (!intervals.length) return out(`Con ese horario no quedaría nada abierto 🤔 Si quieres cerrar todo el día, dime «${dayText(u.date, today).split(' (')[0]} cierro».`);
    if (JSON.stringify(intervals) === JSON.stringify(current)) return out(`${cap(dayText(u.date, today))} ya abres ${H.intervalsText(current)} 😊`);
    const asText = intervals.map(([a, b]) => [hhmm(a), hhmm(b)]);
    const before = business.dateOverrides ?? null;
    const warning = warnList(affectedBy(appointments, d => (d === u.date ? intervals : undefined)), n => `${n} ${n.startsWith('1 ') ? 'queda' : 'quedan'} fuera de ese horario`);
    return confirm(
      { type: 'setDayHours', date: u.date, intervals: asText, set: { dateOverrides: { ...(before ?? {}), [u.date]: asText } }, previous: { dateOverrides: before }, summary: `${dayText(u.date, today)} ${H.intervalsText(intervals)}` },
      `¿${cap(dayText(u.date, today))} abro ${H.intervalsText(intervals)}?`,
      `${cap(dayText(u.date, today))} abres ${H.intervalsText(intervals)}. El resto de días, horario normal.`,
      [`Normalmente ese día abres ${hoursText(current)}.`, warning].filter(Boolean).join('\n\n'));
  }
  if (u.intent === 'setWeeklyHours') {
    const week = H.weekHours(business);
    const hours = Object.fromEntries(H.DAY_KEYS.map((k, d) => [k, week[d].map(([a, b]) => [hhmm(a), hhmm(b)])]));
    const changed = [];
    for (const d of u.days) {
      const intervals = u.closed ? [] : newIntervals(week[d], u);
      if (!intervals) return out(`Los ${H.DAY_PLURALS[d]} ahora no abres. Dime el horario completo, por ejemplo «los ${H.DAY_PLURALS[d]} abro de 10 a 14».`);
      if (!u.closed && !intervals.length) return out('Con ese horario no quedaría nada abierto 🤔 Dímelo otra vez, por ejemplo «los sábados de 9 a 14».');
      hours[H.DAY_KEYS[d]] = intervals.map(([a, b]) => [hhmm(a), hhmm(b)]);
      changed.push([d, intervals]);
    }
    const days = joinList(u.days.map(d => H.DAY_PLURALS[d]));
    if (changed.every(([d, i]) => JSON.stringify(i) === JSON.stringify(week[d]))) {
      return out(`Los ${days} ya ${changed[0][1].length ? `abres ${H.intervalsText(changed[0][1])}` : 'cierras'} 😊`);
    }
    const what = changed.every(([, i]) => !i.length) ? 'cerrado' : joinList([...new Set(changed.map(([, i]) => H.intervalsText(i)))]);
    const byDay = Object.fromEntries(changed);
    const warning = warnList(affectedBy(appointments, date => {
      if (business.dateOverrides?.[date]) return undefined; // that day has its own hours
      return byDay[H.weekdayOf(date)];
    }), n => `${n} ${n.startsWith('1 ') ? 'queda' : 'quedan'} fuera del nuevo horario`);
    return confirm(
      { type: 'setWeeklyHours', days: u.days, set: { hours }, previous: { hours: business.hours ?? null }, summary: `los ${days}: ${what}` },
      `¿A partir de ahora los ${days} ${what === 'cerrado' ? 'cierras todo el día' : `abres ${what}`}?`,
      `Horario cambiado: los ${days} ${what === 'cerrado' ? 'cerrado' : what}. ${H.hoursSummary({ ...business, hours })}`, warning);
  }

  // ---- appointments ----
  if (u.intent === 'bookManual') return bookManual({ name: u.name, date: u.date, time: u.time, serviceId: u.serviceId });
  if (u.intent === 'cancelAppointment' || u.intent === 'moveAppointment') {
    const matches = appointments.filter(a =>
      (!u.name || normalizeName(customerName(a)).includes(normalizeName(u.name))) &&
      (!u.date || a.date === u.date) && (!u.time || a.time === u.time) && a.date >= todayISO);
    const what = [u.name && `de ${u.name}`, u.date && dayText(u.date, today), u.time && `a las ${u.time}`].filter(Boolean).join(' ');
    if (!u.name && !u.date && !u.time) return out(`¿Qué cita? Dime de quién o de qué día, por ejemplo «${u.intent === 'cancelAppointment' ? 'cancela la cita de Ana del jueves' : 'mueve la de Ana del jueves a las 18:00'}».`);
    if (!matches.length) return out(`No encuentro ninguna cita ${what} 🤔`);
    const extra = { newDate: u.newDate ?? null, newTime: u.newTime ?? null };
    if (matches.length > 1) {
      newState = { ...newState, pending: { kind: 'choose', action: u.intent, ids: matches.map(a => a.id), ...extra } };
      return out(`Hay ${matches.length} citas ${what}:\n${matches.map((a, i) => `${i + 1}) ${dayName(a.date)}, ${a.time} ${customerName(a)} — ${a.name}`).join('\n')}\n¿Cuál? Dime el número.`);
    }
    return actOnAppointment(u.intent, matches[0], extra);
  }

  if (u.intent === 'undo') {
    if (!lastChange) return out('No hay ningún cambio que deshacer.');
    newState.lastTopic = 'undo';
    const sent = lastChange.type === 'replyHandover' ? ' El mensaje a la clienta ya se había enviado (eso no se puede deshacer), pero vuelve a estar en pendientes.' : '';
    return out(`Deshecho ↩️ He vuelto atrás: ${lastChange.data?.summary ?? lastChange.type}.${sent}`, { changes: [{ type: 'undo', changeId: lastChange.id, summary: lastChange.data?.summary ?? lastChange.type }] });
  }

  // a bare day after a question about the agenda was handled above; anything else is not understood
  return out(NOT_UNDERSTOOD, { fallback: true });

  // ---- helpers that use this message's data ----

  // "Tienes 39 mensajes sin contestar (te enseño 1-5):" + numbered list. Numbers stay the same until a new list.
  function showInbox(from, all, ids = inbox.map(h => h.id)) {
    const open = ids.map(id => inbox.find(h => h.id === id)).filter(Boolean);
    if (!open.length) return out('No tienes mensajes pendientes 🎉');
    const pos = h => ids.indexOf(h.id) + 1;
    const rest = all ? open : open.filter(h => pos(h) > from).slice(0, INBOX_PAGE);
    if (!rest.length) return showInbox(0, false);
    const shown = pos(rest.at(-1));
    newState = { ...newState, pending: { kind: 'inbox', ids, shown } };
    const head = from === 0 || all
      ? `Tienes ${plural(open.length, 'mensaje', 'mensajes')} sin contestar${!all && open.length > rest.length ? ` (te enseño ${rest.length})` : ''}:`
      : 'Más mensajes sin contestar:';
    const more = !all && open.some(h => pos(h) > shown);
    const tips = ['Dime un número para ver qué hago con él', more && '«ver más» o «ver todos»', '«ignora 1, 3 y 5» o «ignora todos»'].filter(Boolean);
    return out(`${head}\n${rest.map(h => `${pos(h)}) ${sender(h)}: «${h.message}»`).join('\n')}\n\n${tips.join(' · ')}.`);
  }

  // One message and what to do with it
  function showItem(h, list) {
    newState = { ...newState, pending: { kind: 'inboxItem', handoverId: h.id, after: list } };
    const before = h.before ? `\nAntes, el bot le había dicho: «${h.before.length > 140 ? h.before.slice(0, 140) + '…' : h.before}»` : '';
    return out(`${sender(h)} escribió: «${h.message}»${before}\n\n¿Qué hago?\n1. Ignorar\n2. Responder a la clienta\n3. Responder y que el bot lo conteste solo la próxima vez`);
  }

  function askReplyText(h, teach, list) {
    newState = { ...newState, pending: { kind: 'replyText', handoverId: h.id, teach, after: list } };
    return out(`Escribe lo que le contesto a ${sender(h)}${teach ? ' (y lo que contestaré a quien escriba lo mismo)' : ''}:`);
  }

  function replyToCustomer(h, text, teach, list) {
    const question = normalize(h.message);
    const learned = business.learnedAnswers ?? [];
    const change = {
      type: 'replyHandover', handoverId: h.id, customerId: h.customerId, phone: h.phone, text, teach,
      summary: `responder a ${sender(h)}${teach ? ' y aprender la respuesta' : ''}`,
      ...(teach ? { set: { learnedAnswers: [...learned.filter(l => l.question !== question), { question, text: h.message, answer: text }] } } : {}),
    };
    const short = teach && question.split(' ').length <= 3
      ? '\nOjo: es un mensaje corto. Lo contestaré igual a cualquier clienta que escriba eso, aunque hable de otra cosa.' : '';
    return confirm(change,
      `¿Le envío esto a ${sender(h)}?\n«${text}»${teach ? `\nY a partir de ahora, si alguien escribe «${h.message}», contestaré eso yo sola.${short}` : ''}`,
      `Enviado a ${sender(h)}.${teach ? ' Y aprendido 🧠' : ''}`, '', list);
  }

  // Ignore messages: one chosen from its options goes at once (that was the choice), several are confirmed
  function ignore(list, back, ask) {
    const change = { type: 'ignoreHandovers', ids: list.map(h => h.id), summary: `ignorar ${plural(list.length, 'mensaje', 'mensajes')}` };
    if (ask) {
      return confirm(change, `¿Quito ${list.length === 1 ? `el mensaje de ${sender(list[0])}` : `estos ${list.length} mensajes`} de pendientes? Siguen en el historial de cada clienta.`,
        `${list.length === 1 ? 'Mensaje ignorado' : `${list.length} mensajes ignorados`}.`, '', back && list.length < inbox.length ? back : null);
    }
    return out(`Ignorado ✅ ${UNDO_HINT}${back ? afterInbox(back, [change]) : ''}`, { changes: [change] });
  }

  // After acting on a message: how many are left and how to go on with the same numbers
  function afterInbox(list, changes = []) {
    if (!list) return '';
    const done = new Set(changes.flatMap(c => (c.type === 'ignoreHandovers' ? c.ids : c.type === 'replyHandover' ? [c.handoverId] : [])));
    const left = list.ids.filter(id => !done.has(id) && inbox.some(h => h.id === id));
    if (!left.length) return '\nNo quedan mensajes pendientes 🎉';
    newState = { ...newState, pending: { ...list, kind: 'inbox' } };
    return `\nQuedan ${left.length}. Dime otro número, «ver más» o «¿qué me han preguntado?» para ver la lista otra vez.`;
  }

  function agenda({ date, from, to, range }) {
    if (from) {
      const list = appointments.filter(a => a.date >= from && a.date <= to).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
      const label = { nextWeek: 'La semana que viene', month: 'Este mes', nextMonth: 'El mes que viene' }[range] ?? 'Esta semana';
      if (!list.length) return `${label} (${rangeText(from, to)}) no tienes citas.`;
      const days = [...new Set(list.map(a => a.date))];
      return `${label} tienes ${plural(list.length, 'cita', 'citas')}:\n` +
        days.map(d => `${cap(dayName(d))}:\n${list.filter(a => a.date === d).map(apptLine).join('\n')}`).join('\n');
    }
    const c = closedReason(date, business);
    const list = appointments.filter(a => a.date === date).sort((x, y) => x.time.localeCompare(y.time));
    const head = cap(dayText(date, today));
    if (c && !list.length) return `${head} está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}.`;
    const nowMinute = date === todayISO ? today.getHours() * 60 + today.getMinutes() : 0;
    const free = c ? [] : freeStretches(date, business, list, nowMinute);
    const freeText = free.length ? `Libre: ${free.map(([a, b]) => `de ${H.clock(a)} a ${H.clock(b)}`).join(', ')}.` : c ? '' : 'No queda ningún hueco libre.';
    if (!list.length) return `${head} no tienes citas. ${freeText}`.trim();
    return `${head} tienes ${plural(list.length, 'cita', 'citas')}:\n${list.map(apptLine).join('\n')}${freeText ? `\n${freeText}` : ''}`;
  }

  function hoursOverview() {
    const lines = [`Tu horario: ${H.hoursSummary(business)}`];
    const dates = (business.closedDates ?? []).map(c => (typeof c === 'string' ? { date: c } : c)).filter(c => c.date >= todayISO).sort((x, y) => x.date.localeCompare(y.date));
    const ranges = (business.closedRanges ?? []).filter(r => r.to >= todayISO).sort((x, y) => x.from.localeCompare(y.from));
    const overrides = Object.entries(business.dateOverrides ?? {}).filter(([d]) => d >= todayISO);
    if (dates.length) lines.push(`Cerrado: ${joinList(dates.map(c => `${dayName(c.date)}${c.reason ? ` (${c.reason})` : ''}`))}.`);
    if (ranges.length) lines.push(`Vacaciones y cierres: ${joinList(ranges.map(r => `${rangeText(r.from, r.to)}${r.reason ? ` (${r.reason})` : ''}`))}.`);
    if (overrides.length) lines.push(`Días con horario especial: ${joinList(overrides.map(([d, i]) => `${dayName(d)} ${hoursText(i.map(([a, b]) => [toMinutes(a), toMinutes(b)]))}`))}.`);
    return lines.join('\n');
  }

  // Book by hand: ask for what is missing, check the time is free, then confirm
  function bookManual(d) {
    const ask = (asking, question) => {
      newState = { ...newState, pending: { kind: 'draft', action: 'bookManual', draft: d, asking } };
      return out(question);
    };
    if (!d.name) return ask('name', '¿A nombre de quién la apunto?');
    if (!d.serviceId) return ask('serviceId', `¿Qué servicio se hace ${d.name}?`);
    if (!d.date) return ask('date', '¿Qué día?');
    if (!d.time) return ask('time', `¿A qué hora ${dayText(d.date, today)}?`);
    const s = findService(catalog, d.serviceId);
    if (!s) return ask('serviceId', `¿Qué servicio se hace ${d.name}?`);
    const duration = s.duration ?? 30;
    if (d.date < todayISO) return ask('date', `El ${dayName(d.date)} ya ha pasado 🤔 ¿Qué día?`);
    const c = closedReason(d.date, business);
    if (c) return ask('date', `${cap(dayText(d.date, today))} está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}. ¿Otro día?`);
    if (!isFree(d.date, toMinutes(d.time), duration)) {
      const wanted = d.time;
      const others = freeTimes(d.date, duration, business, isFree, toMinutes(wanted));
      d.time = null;
      return ask('time', others.length
        ? `A las ${wanted} ${dayText(d.date, today)} no hay hueco para ${s.name} (${duration} min). Libre: ${joinList(others)}. ¿A qué hora la apunto?`
        : `${cap(dayText(d.date, today))} no queda hueco para ${s.name} (${duration} min). ¿Otro día?`);
    }
    const change = {
      type: 'bookManual', name: d.name, date: d.date, time: d.time, duration, service: s.group, serviceName: s.name,
      details: [{ id: s.id, group: s.group, name: s.name, duration }], summary: `cita de ${d.name} ${dayText(d.date, today)} a las ${d.time}`,
    };
    return confirm(change, `¿Apunto a ${d.name} ${dayText(d.date, today)} a las ${d.time} para ${s.name} (${duration} min)?`,
      `${d.name} apuntada ${dayText(d.date, today)} a las ${d.time} (${s.name}).`);
  }

  function actOnAppointment(action, a, extra = {}) {
    if (action === 'cancelAppointment') {
      return confirm(
        { type: 'cancelAppointment', appointmentId: a.id, previous: { status: 'booked' }, summary: `cancelar la cita de ${customerName(a)} ${dayText(a.date, today)} a las ${a.time}` },
        `¿Cancelo la cita de ${customerName(a)} ${dayText(a.date, today)} a las ${a.time} (${a.name})?`,
        `Cita de ${customerName(a)} cancelada. Recuerda avisarla: el bot no le escribe por su cuenta.`);
    }
    return moveAppointment({ newDate: extra.newDate ?? null, newTime: extra.newTime ?? null }, a.id);
  }

  function moveAppointment(d, appointmentId) {
    const a = appointments.find(x => x.id === appointmentId);
    if (!a) return out('Esa cita ya no está en la agenda 🤔');
    const date = d.newDate ?? a.date;
    if (!d.newTime && !d.newDate) {
      newState = { ...newState, pending: { kind: 'draft', action: 'moveAppointment', appointmentId, draft: d, asking: 'time' } };
      return out(`¿A qué día y hora paso la cita de ${customerName(a)} (${dayText(a.date, today)} a las ${a.time})?`);
    }
    const time = d.newTime ?? a.time;
    const c = closedReason(date, business);
    if (c) {
      newState = { ...newState, pending: { kind: 'draft', action: 'moveAppointment', appointmentId, draft: { ...d, newDate: null }, asking: 'date' } };
      return out(`${cap(dayText(date, today))} está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}. ¿Otro día?`);
    }
    if (date === a.date && time === a.time) return out(`La cita de ${customerName(a)} ya está ${dayText(a.date, today)} a las ${a.time} 😊`);
    if (!isFree(date, toMinutes(time), a.duration, { ignoreId: a.id })) {
      const others = freeTimes(date, a.duration, business, (dt, m, dur) => isFree(dt, m, dur, { ignoreId: a.id }), toMinutes(time));
      newState = { ...newState, pending: { kind: 'draft', action: 'moveAppointment', appointmentId, draft: { newDate: date, newTime: null }, asking: 'time' } };
      return out(others.length
        ? `A las ${time} ${dayText(date, today)} no hay hueco para ${a.name} (${a.duration} min). Libre: ${joinList(others)}. ¿A qué hora la paso?`
        : `${cap(dayText(date, today))} no queda hueco para ${a.name}. ¿Otro día?`);
    }
    return confirm(
      { type: 'moveAppointment', appointmentId: a.id, date, time, previous: { date: a.date, time: a.time }, summary: `mover la cita de ${customerName(a)} a ${dayText(date, today)} a las ${time}` },
      `¿Paso la cita de ${customerName(a)} (${a.name}) de ${dayText(a.date, today)} a las ${a.time} a ${dayText(date, today)} a las ${time}?`,
      `Cita de ${customerName(a)} movida a ${dayText(date, today)} a las ${time}. Recuerda avisarla: el bot no le escribe por su cuenta.`);
  }
}

const normalizeName = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// New intervals for a day from { intervals } or { opens } / { closes }; null if the day is closed and only
// one end was given (the full hours are needed)
function newIntervals(current, { intervals, opens, closes }) {
  if (intervals) return intervals.map(([a, b]) => [toMinutes(a), toMinutes(b)]);
  if (!current.length) return null;
  let list = current.map(x => [...x]);
  if (opens) {
    // opening later drops what was before; opening earlier stretches the first interval
    const o = toMinutes(opens);
    list = list.filter(([, b]) => b > o);
    if (list.length) list[0][0] = o;
  }
  if (closes) {
    const c = toMinutes(closes);
    list = list.filter(([a]) => a < c);
    if (list.length) list[list.length - 1][1] = c;
  }
  return list.filter(([a, b]) => b > a);
}

module.exports = { respondOwner, HELP, newIntervals, freeStretches };
