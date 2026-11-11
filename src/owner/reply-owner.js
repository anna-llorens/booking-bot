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
const { euros, fromISODate, CATEGORY_LABELS } = require('../reply/format');
const { normalize, detectServices } = require('../understand');
const { parseDuration, parsePrice, parseHours } = require('./understand-owner');

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
  '⏳ «¿quién hay en lista de espera?» · 📊 «¿qué tal ha ido el día?» · ➕ «añade un servicio» · 🗂️ «servicios»',
  '🙋 Clientas: «busca a Laura», «escribe a Laura que…» · 📊 «¿cuántas citas hemos tenido este mes?» · 🔕 «bloquea mañana de 12 a 14»',
  '↩️ «deshacer» deshace el último cambio · 👋 «salir» para salir del modo dueña',
].join('\n');
const NOT_UNDERSTOOD = 'No te he entendido 😅 Escribe *ayuda* para ver ejemplos.';
// the second time in a row: not the same words again
const NOT_UNDERSTOOD_AGAIN = 'Sigo sin entenderte 😅 Prueba con algo como «¿qué tengo hoy?», «el jueves cierro» o «queratina 4h», o escribe *ayuda*.';
const UNDO_HINT = 'Si te has equivocado, escribe *deshacer*.';
// What owner mode can't do yet, said plainly. Nothing is changed.
const ONE_BY_ONE = 'Lo que sí puedo: escribir a una clienta («escribe a Laura que…») o contestar los mensajes pendientes («¿qué me han preguntado?»).';
const NOT_SUPPORTED_REPLIES = {
  campaign: `Las campañas todavía no las hago 🙏 Para mandar publicidad hacen falta plantillas aprobadas por WhatsApp y el permiso de cada clienta. ${ONE_BY_ONE}`,
  broadcast: `Mandar el mismo mensaje a muchas clientas a la vez todavía no lo hago 🙏 Hacen falta plantillas aprobadas por WhatsApp y, si es publicidad, el permiso de cada clienta. ${ONE_BY_ONE}`,
  offer: 'Las ofertas todavía no las gestiono 🙏 Si quieres, cambia el precio un tiempo («el lavado a 15 €») y luego lo vuelves a poner.',
  writing: 'Redactar textos no lo hago: no uso IA 🙏 Si me das el texto, se lo mando a una clienta («escribe a Laura que…»).',
  content: 'Carteles y publicaciones para redes no los hago: no uso IA 🙏',
  reminder: 'Los recordatorios para ti todavía no los hago 🙏 (el bot aún no puede escribirte él solo a una hora). Lo tengo apuntado como mejora.',
  customerReminders: 'Los recordatorios automáticos a las clientas todavía no están 🙏 Necesitan plantillas de WhatsApp y un programador de envíos; es de lo próximo que hay que hacer.',
  notifications: 'Los avisos automáticos todavía no los hago 🙏 Mientras, pregúntame «¿hay alguna cancelación hoy?» o «¿qué me han preguntado?».',
  botConfig: 'Eso todavía no se puede configurar desde aquí 🙏 No he cambiado nada.',
  lists: 'Las listas (de la compra, de tareas) todavía no las guardo 🙏',
  backup: 'Las copias de seguridad no se hacen desde el chat 🙏 Los datos están guardados en el servidor.',
  history: 'Todavía no te puedo enseñar los mensajes que ha enviado el bot 🙏 En la pantalla de pruebas los ves en la conversación de cada clienta.',
  confirmations: 'Las clientas todavía no confirman sus citas (no hay recordatorios con «Confirmo»), así que no lo sé 🙏',
  seasonalHours: 'Un horario de verano todavía no lo tengo 🙏 Lo que sí puedo: cambiar el horario semanal («a partir de ahora los sábados de 9 a 14») o el de un día concreto.',
  other: 'Eso se me escapa 😅 Solo sé de tu peluquería: agenda, horarios, servicios, precios y mensajes. Escribe *ayuda* para ver ejemplos.',
};
NOT_SUPPORTED_REPLIES.external = NOT_SUPPORTED_REPLIES.chat = NOT_SUPPORTED_REPLIES.advice = NOT_SUPPORTED_REPLIES.other;
const NO_AUTO_CANCEL = 'Las citas NO se cancelan solas: avisa a esas clientas o dime «cancela la cita de …».';

// ---- free time in a day (for the agenda and for booking by hand) ----

// Free stretches of a day as [[from, to]], in minutes: open, with fewer than `capacity` appointments, and long
// enough for an appointment (slotMinutes; a 15-minute gap is no use)
function freeStretches(date, business, appointments, fromMinute = 0) {
  const capacity = business.capacity ?? 1;
  const shortest = business.slotMinutes ?? 30;
  const busy = appointments.filter(a => a.date === date).map(a => [toMinutes(a.time), toMinutes(a.time) + a.duration]);
  const out = [];
  for (const [a, b] of H.dayHours(business, date)) {
    let start = null;
    for (let m = Math.max(a, fromMinute); m <= b; m += 5) {
      const free = m < b && busy.filter(([x, y]) => x <= m && m < y).length < capacity;
      if (free && start === null) start = m;
      if (!free && start !== null) { if (m - start >= shortest) out.push([start, m]); start = null; }
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
  const {
    today, business = {}, catalog = [], appointments = [], inbox = [], waitlist = [], lastChange = null, isFree = () => true,
    customers = [], history = [], cancelled = [], recentChanges = [],
  } = options;
  const u = understandOwner(message, { today, catalog });
  const todayISO = iso(today);
  const pending = state.pending ?? null;
  let newState = { ...state, pending: null, lastFallback: false, lastTopic: u.intent ?? state.lastTopic ?? null, lastServiceId: u.serviceId ?? state.lastServiceId ?? null };
  // "de el viernes" → "del viernes", "a el jueves" → "al jueves"
  const tidy = text => text.replace(/\bde el\b/g, 'del').replace(/\ba el\b/g, 'al');
  // "hola, ¿qué tengo hoy?": "¡Hola! 😊" before the answer
  const SMALL_TALK = ['greeting', 'howAreYou', 'presence', 'thanks', 'bye', 'dayStatus'];
  // (not when she is answering a question: "Hola Carmen, …" is the text for the customer)
  const hi = text => (u.greeting && text && !SMALL_TALK.includes(u.intent) && !state.pending ? `¡Hola! 😊 ${text}` : text);
  const out = (reply, extra = {}) => ({ reply: hi(tidy(reply)), state: newState, changes: [], understanding: u, ...extra });

  // Ask before changing anything: "¿Cierro el jueves 12 de noviembre? (sí / no)"
  const confirm = (change, question, done, warning = '', after = null) => {
    newState = { ...newState, pending: { kind: 'confirm', changes: [change], done, after, question } };
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
    // a correction before "sí": "mejor 15 euros", "ponlo en tratamientos capilares", "a partir de esta semana"
    const redo = pending.redo;
    if (redo?.action === 'setPrice' && u.price != null && (!u.serviceId || u.serviceId === redo.serviceId) && ['setPrice', null].includes(u.intent)) {
      return setPriceFor(findService(catalog, redo.serviceId), u.price);
    }
    if (redo?.action === 'addService' && (!u.intent || u.intent === 'serviceInfo' || u.intent === 'setCategory')) {
      const d = fillService({ ...redo.draft }, u, message);
      if (JSON.stringify(d) !== JSON.stringify(redo.draft)) return addService(d);
    }
    if (redo?.action === 'dayHours' && /\b(a partir de (ahora|esta semana|la semana que viene|hoy)|todas las semanas|cada semana|siempre|desde ahora)\b/.test(u.normalizedText)) {
      return weeklyHoursFlow({ days: [H.weekdayOf(redo.date)], intervals: redo.intervals });
    }
    if (redo?.action === 'dayHours' && !u.intent && u.timeOfDay) return out(`Sí, eso es: ${pending.question} (sí / no)`, { state: (newState = { ...newState, pending }) });
    if (redo?.action === 'sendMessage' && !u.intent && message.trim().length > 3) return sendMessage({ ...redo.draft, text: message.trim() });
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
  const giveUp = u.intent === 'no' || /^(cancela|cancelar|dejalo|nada|olvidalo|da igual)$/.test(u.normalizedText);
  if (pending?.kind === 'draft' && pending.action === 'addService' && !['undo', 'help', 'logout', 'yes'].includes(u.intent)) {
    if (giveUp) return out('Vale, no lo añado 👍');
    return addService(fillService({ ...pending.draft }, u, message, pending.asking));
  }
  // the other questions the bot asks to finish a change ("¿A cuánto lo pongo?", "¿Qué le escribo a Laura?"…)
  const DRAFTS = {
    setPrice: () => (u.price != null ? setPriceFor(findService(catalog, pending.draft.serviceId), u.price) : null),
    setDuration: () => {
      const raw = u.normalizedText.match(/^\d{1,3}$/) ? +u.normalizedText : null;
      const minutes = u.duration ?? (raw >= 5 ? raw : null);
      return minutes ? setDurationFor(findService(catalog, pending.draft.serviceId), minutes) : null;
    },
    renameService: () => renameService(pending.asking === 'serviceId' ? { ...pending.draft, serviceId: u.serviceId } : { ...pending.draft, name: cleanText(message).replace(/^(que se llame|ponle|llamalo|llámalo)\s+/i, '') }),
    setCategory: () => setCategory(pending.asking === 'serviceId' ? { ...pending.draft, serviceId: u.serviceId } : { ...pending.draft, category: u.category }),
    setDescription: () => setDescription(pending.asking === 'serviceId' ? { ...pending.draft, serviceId: u.serviceId } : { ...pending.draft, text: cleanText(message) }),
    renameBusiness: () => renameBusiness(cleanText(message)),
    sendMessage: () => sendMessage(pending.asking === 'who' ? { ...pending.draft, name: cleanText(message) } : { ...pending.draft, text: message.trim() }),
    dayHours: () => (u.intent === 'closeDate' || /^(cerrado|cerramos|cierro|todo el dia cerrado)$/.test(u.normalizedText)
      ? closeDay(pending.draft.date)
      : parseHours(u.normalizedText) || u.timeOfDay ? dayHoursFlow({ date: pending.draft.date, ...(parseHours(u.normalizedText) ?? { part: /\bcerrad|cierr/.test(u.normalizedText) ? (u.timeOfDay === 'morning' ? 'afternoon' : 'morning') : u.timeOfDay }) }, true) : null),
    weeklyHours: () => (parseHours(u.normalizedText) ? weeklyHoursFlow({ days: pending.draft.days, ...parseHours(u.normalizedText) }) : null),
    bulkPrice: () => {
      const percent = +(u.normalizedText.match(/\b(\d+) ?(%|por ciento)/)?.[1] ?? 0) || null;
      const sign = /\b(baja|bajalos|bajar|menos)\b/.test(u.normalizedText) ? -1 : 1;
      return percent || u.price != null ? bulkPrice({ ...pending.draft, percent: percent && sign * percent, change: !percent ? sign * u.price : null }) : null;
    },
  };
  if (pending?.kind === 'draft' && DRAFTS[pending.action] && !['undo', 'help', 'logout', 'yes'].includes(u.intent)) {
    if (giveUp) return out('Vale, lo dejamos 👍');
    const res = DRAFTS[pending.action]();
    if (res) return res;
    if (!u.intent) return out(`${pending.question ?? 'No te he entendido 😅'}`, { state: (newState = { ...newState, pending }) });
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
    return out(u.intent === 'yes' ? (state.lastTopic === 'no' || state.lastTopic === 'setPrice' ? 'Vale, lo dejo como está 👍' : 'No tengo nada pendiente de confirmar 😊 ¿Qué necesitas?') : 'Vale 👍');
  }

  // ---- queries ----
  if (u.intent === 'help') return out(HELP);

  // ---- small talk, like the customer bot, with the day's summary ----
  if (u.intent === 'greeting') {
    const h = today.getHours();
    return out(`${h >= 6 && h < 14 ? '¡Buenos días!' : h >= 14 && h < 21 ? '¡Buenas tardes!' : '¡Hola!'} 😊 ${daySummary(true)} ¿En qué te ayudo?`);
  }
  if (u.intent === 'howAreYou') return out(`¡Muy bien, gracias! 😊 ¿Y tú? ${daySummary(true)}`);
  if (u.intent === 'presence') return out('¡Aquí estoy! 😊 ¿En qué te ayudo?');
  if (u.intent === 'thanks') return out('¡De nada! 😊');
  if (u.intent === 'bye') return out('¡Hasta luego! 👋 Cuando quieras, aquí estoy.');
  if (u.intent === 'dayStatus') return out(daySummary(false));
  if (u.intent === 'feedback') return out('Tienes razón, todavía estoy aprendiendo 😅 Lo que no entiendo lo guardo para que me enseñen. Mientras, escribe *ayuda* para ver lo que sé hacer.');
  if (u.intent === 'revenue') return out(revenue(u.range));
  if (u.intent === 'servicesList') return out(servicesList(u));
  if (u.intent === 'addService') return addService({ name: u.name, duration: u.duration, price: u.price, priceAsked: u.price != null });
  if (u.intent === 'notSupported') return out(NOT_SUPPORTED_REPLIES[u.topic] ?? NOT_SUPPORTED_REPLIES.other);
  if (u.intent === 'wait') return out('Vale, aquí estoy cuando quieras 😊');
  if (u.intent === 'businessName') return out(`Tu salón se llama «${business.name}». Para cambiarlo: «quiero cambiar el nombre del salón».`);
  if (u.intent === 'stats') return out(stats(u.range));
  if (u.intent === 'changesHistory') return out(changesHistory());
  if (u.intent === 'renameBusiness') return renameBusiness(u.name);
  if (u.intent === 'customerInfo') return out(customerInfo(u.name));
  if (u.intent === 'cancellations') return out(cancellationsOn(u.date));
  if (u.intent === 'renameService') return renameService({ serviceId: u.serviceId, name: u.name });
  if (u.intent === 'setCategory') return setCategory({ serviceId: u.serviceId, category: u.category });
  if (u.intent === 'setDescription') return setDescription({ serviceId: u.serviceId });
  if (u.intent === 'bulkPrice') return bulkPrice({ category: u.category, percent: u.percent, change: u.change });
  if (u.intent === 'restorePrice') return restorePrice(u.serviceId);
  if (u.intent === 'sendMessage') return sendMessage({ name: u.name, content: u.content, reminder: u.reminder });
  if (u.intent === 'blockTime') return blockTime(u);
  if (u.intent === 'restoreHours') return restoreHours(u.date);
  if (u.intent === 'changeAppointmentService') {
    const matches = appointments.filter(a => u.name && normalizeName(customerName(a)).includes(normalizeName(u.name)));
    if (!u.name) return out('¿De quién es la cita? Por ejemplo «la cita de Ana es para tinte».');
    if (!matches.length) return out(`No encuentro ninguna cita de ${u.name} 🤔`);
    if (matches.length > 1) {
      newState = { ...newState, pending: { kind: 'choose', action: 'changeAppointmentService', ids: matches.map(a => a.id), serviceId: u.serviceId } };
      return out(`${u.name} tiene ${matches.length} citas:\n${matches.map((a, i) => `${i + 1}) ${dayName(a.date)}, ${a.time} — ${apptService(a)}`).join('\n')}\n¿Cuál? Dime el número.`);
    }
    return changeService(matches[0], u.serviceId);
  }
  // follow-ups without a verb: "mejor 15 euros" (the last service), "solo las de la tarde" (the last agenda)
  if (!u.intent && u.price != null && !u.serviceId && state.lastServiceId && !u.date && !u.time) return setPriceFor(findService(catalog, state.lastServiceId), u.price);
  if (!u.intent && state.lastTopic === 'agenda' && state.lastAgenda && (u.timeOfDay || u.serviceId || /\b(cuantas|total)\b/.test(u.normalizedText))) {
    const q = { ...state.lastAgenda, ...(u.timeOfDay ? { timeOfDay: u.timeOfDay } : {}), ...(u.serviceId ? { serviceId: u.serviceId } : {}), count: /\b(cuantas|total)\b/.test(u.normalizedText) };
    newState.lastTopic = 'agenda';
    newState.lastAgenda = { ...q, count: false };
    return out(agenda(q));
  }
  if (u.intent === 'agenda' || (!u.intent && u.date && state.lastTopic === 'agenda')) {
    newState.lastTopic = 'agenda';
    const q = { ...(u.from ? { from: u.from, to: u.to, range: u.range } : { date: u.date ?? todayISO }), time: u.time ?? null, fromTime: u.fromTime ?? null, timeOfDay: u.timeOfDay ?? null, serviceId: u.serviceId ?? null, free: !!u.free };
    newState.lastAgenda = q;
    return out(agenda(q));
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
  if (u.intent === 'hours') return out(hoursAnswer(u));

  // ---- catalog ----
  if (['serviceInfo', 'getPrice', 'getDuration', 'setPrice', 'setDuration', 'disableService', 'enableService'].includes(u.intent)) {
    if (u.intent === 'disableService' && u.category) return disableGroup(u.category);
    if (u.intent === 'getPrice' && u.serviceIds?.length > 1) {
      const list = u.serviceIds.map(id => findService(catalog, id)).filter(Boolean);
      return out(list.map(x => `• ${serviceName(x)}: ${x.price != null ? euros(x.price) : 'sin precio'}`).join('\n'));
    }
    const s = findService(catalog, u.serviceId);
    if (!s && u.intent === 'getPrice') return out('¿De qué servicio? Por ejemplo «¿cuánto cobro por el corte?».');
    if (!s && u.intent === 'disableService') return out('No encuentro ese servicio en tu catálogo 🤔 Escribe «servicios» para ver la lista.');
    if (!s) return out(NOT_UNDERSTOOD);
    const off = s.active === false ? ' (ahora no lo ofreces)' : '';
    const short = s.synonyms?.[0] ?? serviceName(s).toLowerCase();
    if (u.intent === 'serviceInfo' && u.serviceIds?.length > 1) {
      const list = u.serviceIds.map(id => findService(catalog, id)).filter(Boolean);
      return out(`Sí, los tienes:\n${list.map(x => `• ${serviceName(x)}: ${durationText(x.duration)} · ${x.price != null ? euros(x.price) : 'sin precio'}${x.active === false ? ' (desactivado)' : ''}`).join('\n')}`);
    }
    if (u.intent === 'serviceInfo') {
      return out(`${serviceName(s)}${off}: ${durationText(s.duration)} · ${s.price != null ? euros(s.price) : 'sin precio'}.\nPara cambiarlo: «${short} ${s.duration === 240 ? '3h' : '4h'}» o «${short} a ${s.price != null ? s.price + 5 : 40} €».`);
    }
    if (u.intent === 'getPrice') {
      return out(s.price != null ? `${serviceName(s)}${off}: ${euros(s.price)}.` : `${serviceName(s)} no tiene precio puesto. Si quieres, dime por ejemplo «${serviceName(s).toLowerCase()} a 30 €».`);
    }
    if (u.intent === 'getDuration') return out(s.duration ? `Ahora mismo ${serviceName(s)}${off} dura ${durationText(s.duration)}.` : `${serviceName(s)} no tiene duración puesta. Dime por ejemplo «${short} 2h».`);
    if (u.intent === 'setPrice') {
      if (u.change != null) {
        if (s.price == null) return out(`${serviceName(s)} no tiene precio puesto. Dime cuánto, por ejemplo «${short} a 30 €».`);
        return setPriceFor(s, Math.max(0, s.price + u.change));
      }
      if (u.price == null) return askDraft('setPrice', { serviceId: s.id }, `¿A cuánto lo pongo? ${s.price != null ? `Ahora ${serviceName(s)} está a ${euros(s.price)}.` : `${serviceName(s)} no tiene precio.`}`);
      return setPriceFor(s, u.price);
    }
    if (u.intent === 'setDuration') {
      if (!u.duration) return askDraft('setDuration', { serviceId: s.id }, `${s.duration ? `Ahora mismo ${serviceName(s)} dura ${durationText(s.duration)}. ` : ''}¿Cuánto tiene que durar? (por ejemplo «1 h 30» o «45 min»)`);
      return setDurationFor(s, u.duration);
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
  if (u.intent === 'setDayHours') return dayHoursFlow(u);
  if (u.intent === 'setWeeklyHours') return weeklyHoursFlow(u);

  // ---- appointments ----
  if (u.intent === 'bookManual') return bookManual({ name: u.name, date: u.date, time: u.time, serviceId: u.serviceId, timeOfDay: u.timeOfDay });
  if (u.intent === 'cancelAppointment' && u.all && u.date) {
    const list = appointments.filter(a => a.date === u.date);
    if (!list.length) return out(`${cap(dayText(u.date, today))} no tienes citas.`);
    return confirm({ type: 'cancelAppointments', ids: list.map(a => a.id), summary: `cancelar las ${list.length} citas ${dayText(u.date, today)}` },
      `¿Cancelo ${list.length === 1 ? 'esta cita' : `estas ${list.length} citas`} ${dayText(u.date, today)}?\n${list.map(apptLine).join('\n')}\nEl bot no avisa a las clientas: avísalas tú (o dime «escribe a Ana que…»).`,
      `${plural(list.length, 'cita cancelada', 'citas canceladas')}.`);
  }
  return appointmentsAndRest();

  // the day's hours: { intervals } | { opens } | { closes } | { part } | { opensShift } | { closesShift }, or nothing → ask
  function dayHoursFlow(u, keepAsking = false) {
    if (u.date < todayISO) return out(`El ${dayName(u.date)} ya ha pasado 🤔`);
    const current = H.dayHours(business, u.date);
    if (!u.intervals && !u.opens && !u.closes && !u.part && !u.opensShift && !u.closesShift) {
      return askDraft('dayHours', { date: u.date }, `¿Qué horario pongo ${dayText(u.date, today)}? Ahora: ${hoursText(current)}. Por ejemplo «de 10 a 14», «solo por la mañana» o «cerrado».`);
    }
    if (u.part) {
      if (!current.length) return askDraft('dayHours', { date: u.date }, `${cap(dayText(u.date, today))} normalmente no abres. ¿De qué hora a qué hora? (por ejemplo «de 9 a 14»)`);
      const part = H.timeOfDayIntervals(current, u.part === 'midday' ? 'morning' : u.part);
      if (!part.length) return out(`${cap(dayText(u.date, today))} por la ${u.part === 'morning' ? 'mañana' : 'tarde'} no abres 🤔 Horario: ${hoursText(current)}.`);
      u = { ...u, intervals: part.map(([a, b]) => [hhmm(a), hhmm(b)]) };
    }
    if (u.opensShift && current.length) u = { ...u, opens: hhmm(current[0][0] + u.opensShift) };
    if (u.closesShift && current.length) u = { ...u, closes: hhmm(current.at(-1)[1] + u.closesShift) };
    const intervals = newIntervals(current, u);
    if (!intervals) return out(`${cap(dayText(u.date, today))} normalmente no abres. Dime el horario completo, por ejemplo «${dayText(u.date, today).split(' (')[0]} abro de 10 a 14».`);
    if (!intervals.length) return out(`Con ese horario no quedaría nada abierto 🤔 Si quieres cerrar todo el día, dime «${dayText(u.date, today).split(' (')[0]} cierro».`);
    if (JSON.stringify(intervals) === JSON.stringify(current)) {
      // answering "¿qué horario pongo?": that is already the hours, so the real change is still to come
      if (keepAsking) return askDraft('dayHours', { date: u.date }, `Ahora ${dayText(u.date, today)} ya abres ${H.intervalsText(current)}. ¿Qué horario pongo? Por ejemplo «de 9 a 13».`);
      return out(`${cap(dayText(u.date, today))} ya abres ${H.intervalsText(current)} 😊`);
    }
    const asText = intervals.map(([a, b]) => [hhmm(a), hhmm(b)]);
    const before = business.dateOverrides ?? null;
    const warning = warnList(affectedBy(appointments, d => (d === u.date ? intervals : undefined)), n => `${n} ${n.startsWith('1 ') ? 'queda' : 'quedan'} fuera de ese horario`);
    const res = confirm(
      { type: 'setDayHours', date: u.date, intervals: asText, set: { dateOverrides: { ...(before ?? {}), [u.date]: asText } }, previous: { dateOverrides: before }, summary: `${dayText(u.date, today)} ${H.intervalsText(intervals)}` },
      `¿${cap(dayText(u.date, today))} abro ${H.intervalsText(intervals)}?`,
      `${cap(dayText(u.date, today))} abres ${H.intervalsText(intervals)}. El resto de días, horario normal.`,
      [`Normalmente ese día abres ${hoursText(current)}.`, warning].filter(Boolean).join('\n\n'));
    newState.pending.redo = { action: 'dayHours', date: u.date, intervals: asText };
    return res;
  }

  function weeklyHoursFlow(u) {
    const week = H.weekHours(business);
    if (u.part && !u.closed && !u.intervals && !u.opens && !u.closes) {
      // "a partir de ahora abrimos los sábados por la mañana"
      const missing = u.days.filter(d => !H.timeOfDayIntervals(week[d], u.part).length);
      if (!missing.length) return out(`Los ${joinList(u.days.map(d => H.DAY_PLURALS[d]))} ya abres por la ${u.part === 'morning' ? 'mañana' : 'tarde'}: ${joinList(u.days.map(d => hoursText(week[d])))} 😊`);
      return askDraft('weeklyHours', { days: u.days }, `¿De qué hora a qué hora abres los ${joinList(u.days.map(d => H.DAY_PLURALS[d]))}? (por ejemplo «de 9 a 14»)`);
    }
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

  function appointmentsAndRest() {
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
    const msg = lastChange.type === 'sendMessage' ? ' El mensaje ya se había enviado: eso no se puede deshacer.' : sent;
    return out(`Deshecho ↩️ He vuelto atrás: ${lastChange.data?.summary ?? lastChange.type}.${msg}`, { changes: [{ type: 'undo', changeId: lastChange.id, summary: lastChange.data?.summary ?? lastChange.type }] });
  }

  // a bare day after a question about the agenda was handled above; anything else is not understood
  const again = state.lastFallback;
  newState.lastFallback = true;
  return out(again ? NOT_UNDERSTOOD_AGAIN : NOT_UNDERSTOOD, { fallback: true });
  }

  // ---- helpers that use this message's data ----

  // "De momento llevas 4 de 6 citas. Ahora mismo: … La siguiente, a las 17:00 con Ana García (Corte de mujer)."
  function daySummary(short) {
    const nowMinute = today.getHours() * 60 + today.getMinutes();
    const list = appointments.filter(a => a.date === todayISO).sort((x, y) => x.time.localeCompare(y.time));
    const end = a => toMinutes(a.time) + a.duration;
    const done = list.filter(a => end(a) <= nowMinute);
    const current = list.find(a => toMinutes(a.time) <= nowMinute && nowMinute < end(a));
    const next = list.find(a => toMinutes(a.time) > nowMinute);
    const withWho = a => `a las ${a.time} con ${customerName(a)} (${apptService(a)})`;
    const parts = [];
    const c = closedReason(todayISO, business);
    if (!list.length) parts.push(c ? `Hoy está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}.` : 'Hoy no tienes citas.');
    else if (done.length === list.length) parts.push(`Hoy ya has terminado: ${plural(list.length, 'cita', 'citas')} 💪`);
    else if (!done.length && !current) parts.push(`Hoy tienes ${plural(list.length, 'cita', 'citas')}; la primera, ${withWho(next)}.`);
    else {
      parts.push(done.length ? `De momento llevas ${done.length} de ${plural(list.length, 'cita', 'citas')}.` : `Hoy tienes ${plural(list.length, 'cita', 'citas')}.`);
      if (current) parts.push(`Ahora mismo estás con ${customerName(current)} (${apptService(current)}, hasta las ${hhmm(end(current))}).`);
      parts.push(next ? `La siguiente, ${withWho(next)}.` : 'Es la última del día.');
    }
    if (!next && !short) {
      const tomorrow = appointments.filter(a => a.date > todayISO).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
      if (tomorrow.length) {
        const day = tomorrow[0].date;
        const that = tomorrow.filter(a => a.date === day);
        parts.push(`${cap(dayText(day, today).replace(/ \(.*\)$/, ''))} tienes ${plural(that.length, 'cita', 'citas')}; la primera, ${withWho(that[0])}.`);
      }
    }
    if (inbox.length) parts.push(`Tienes ${plural(inbox.length, 'mensaje', 'mensajes')} sin contestar («¿qué me han preguntado?»).`);
    if (waitlist.length && !short) parts.push(`${plural(waitlist.length, 'persona', 'personas')} en lista de espera.`);
    return parts.join(' ');
  }

  // What was charged is not known: it is paid at the till, with extras. Only a floor from the catalog prices.
  function revenue(range) {
    const [from, to] = range === 'week' ? weekBounds() : range === 'month' ? [`${todayISO.slice(0, 8)}01`, iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))] : [todayISO, todayISO];
    const when = range === 'week' ? 'de esta semana' : range === 'month' ? 'de este mes' : 'de hoy';
    const list = [...history, ...appointments].filter(a => a.date >= from && a.date <= to);
    const till = 'Lo que se cobra en caja (y los extras, como champú, mascarillas o tratamientos) yo no lo veo.';
    if (!list.length) return `No hay citas ${when}. ${till}`;
    let sum = 0, unknown = 0;
    for (const a of list) {
      const prices = (a.details?.length ? a.details : [{ id: a.service }]).map(d => findService(catalog, d.id)?.price ?? catalog.find(s => s.group === d.group && s.id === s.group)?.price);
      if (prices.some(p => p == null)) unknown++;
      sum += prices.reduce((n, p) => n + (p ?? 0), 0);
    }
    return `No lo sé con exactitud: ${till.charAt(0).toLowerCase()}${till.slice(1)} Con los precios de la carta, ${list.length === 1 ? 'la cita' : `las ${list.length} citas`} ${when} suman como mínimo ${euros(sum)}${unknown ? ` (${plural(unknown, 'cita no tiene', 'citas no tienen')} precio en la carta)` : ''}.`;
  }

  // The catalog by group, or one group in detail; filters: status, sort, maxPrice, withPrices
  function servicesList({ category = null, status = null, sort = null, maxPrice = null, withPrices = false } = {}) {
    const label = c => CATEGORY_LABELS[c ?? 'otros'] ?? c;
    const line = x => `• ${serviceName(x)}: ${durationText(x.duration)} · ${x.price != null ? euros(x.price) : 'sin precio'}${x.active === false ? ' (desactivado)' : ''}`;
    const ESTETICA = ['estetica_facial', 'estetica_corporal', 'depilacion', 'manicura_pedicura', 'pestanas_cejas'];
    const inGroup = x => !category || (category === 'estetica' ? ESTETICA.includes(x.category) : x.category === category);
    const groupName = category === 'estetica' ? '🧖 Estética' : label(category);
    if (status === 'inactive') {
      const off = catalog.filter(x => x.active === false && inGroup(x));
      return off.length ? `Servicios desactivados (${off.length}):\n${off.map(line).join('\n')}\nPara volver a ofrecer uno: «vuelvo a hacer …».` : 'No tienes ningún servicio desactivado 😊';
    }
    let list = catalog.filter(x => x.active !== false && inGroup(x));
    if (sort || maxPrice) {
      if (maxPrice) list = list.filter(x => x.price != null && x.price < maxPrice);
      if (sort === 'duration') list = list.filter(x => x.duration).sort((a, b) => b.duration - a.duration);
      if (sort === 'priceDesc') list = list.filter(x => x.price != null).sort((a, b) => b.price - a.price);
      if (sort === 'priceAsc') list = list.filter(x => x.price != null).sort((a, b) => a.price - b.price);
      if (maxPrice) list.sort((a, b) => a.price - b.price);
      if (!list.length) return maxPrice ? `No tienes ningún servicio por menos de ${euros(maxPrice)}.` : 'No tengo precios o duraciones para comparar 🤔';
      const head = sort === 'duration' ? 'Los que más duran' : sort === 'priceDesc' ? 'Los más caros' : sort === 'priceAsc' ? 'Los más baratos' : `Por menos de ${euros(maxPrice)}`;
      return `${head}:\n${list.slice(0, maxPrice ? 15 : 5).map(line).join('\n')}`;
    }
    if (category) {
      if (!list.length) return `No tienes servicios de ${groupName.replace(/^\S+ /, '').toLowerCase()}.`;
      if (list.length <= 20) return `${groupName}:\n${list.map(line).join('\n')}`;
      // too long for WhatsApp: one line per group, the priced ones first
      const groups = [...new Set(list.map(x => x.category))];
      return `${groupName} (${list.length} servicios):\n${groups.map(c => {
        const inC = list.filter(x => x.category === c).sort((a, b) => (a.price == null) - (b.price == null));
        return `${label(c)} (${inC.length}): ${inC.slice(0, 5).map(x => `${serviceName(x)}${x.price != null ? ` ${euros(x.price)}` : ''}`).join(', ')}${inC.length > 5 ? '…' : ''}`;
      }).join('\n')}\n\nPara ver un grupo entero: «servicios de ${groups[0] === 'estetica_facial' ? 'facial' : 'depilación'}».`;
    }
    if (withPrices) {
      const priced = list.filter(x => x.price != null);
      const order = Object.keys(CATEGORY_LABELS);
      const cats = [...new Set(priced.map(x => x.category ?? 'otros'))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const lines = cats.map(c => `${label(c)}: ${priced.filter(x => (x.category ?? 'otros') === c).map(x => `${serviceName(x)} ${euros(x.price)}`).join(', ')}`);
      const without = list.length - priced.length;
      return `Tus precios:\n${lines.join('\n')}${without ? `\n\n${plural(without, 'servicio no tiene', 'servicios no tienen')} precio. Ojo: es la carta; lo que se cobra en caja (extras) no lo veo.` : ''}`;
    }
    const order = Object.keys(CATEGORY_LABELS);
    const cats = [...new Set(catalog.map(x => x.category ?? 'otros'))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const lines = cats.map(c => `• ${label(c)}: ${catalog.filter(x => (x.category ?? 'otros') === c && x.active !== false).length}`);
    const off = catalog.length - list.length;
    return `Tienes ${plural(list.length, 'servicio', 'servicios')}${off ? ` (y ${off} desactivados)` : ''}:\n${lines.join('\n')}\n\nPara ver un grupo: «servicios de color». Un servicio: «queratina». Uno nuevo: «añade un servicio».`;
  }

  // ---- small builders for changes (each one asks before changing) ----

  function cleanText(m) { return m.trim().replace(/^[«"']|[»"']$/g, '').replace(/[.!¡]+$/, '').trim(); }

  // a question the bot needs answered to finish a change; the answer comes back through DRAFTS
  function askDraft(action, draft, question, asking = null) {
    newState = { ...newState, pending: { kind: 'draft', action, draft, asking, question } };
    return out(question);
  }

  function setPriceFor(sv, price) {
    if (!sv) return out(NOT_UNDERSTOOD);
    if (price <= 0 || price > 2000) return out(`¿${euros(price)}? Me parece raro 🤔 Dímelo otra vez, por ejemplo «${serviceName(sv).toLowerCase()} a 30 €».`);
    if (sv.price === price) return out(`${serviceName(sv)} ya está a ${euros(price)} 😊`);
    const res = confirm(
      { type: 'setPrice', serviceId: sv.id, price, previous: { price: sv.price ?? null }, summary: `${serviceName(sv)} a ${euros(price)}` },
      `¿Pongo ${serviceName(sv)} a ${euros(price)}?${sv.price != null ? ` (ahora está a ${euros(sv.price)})` : ''}`,
      `${serviceName(sv)} ahora cuesta ${euros(price)}.`);
    newState.pending.redo = { action: 'setPrice', serviceId: sv.id };
    return res;
  }

  function setDurationFor(sv, minutes) {
    if (minutes < 5 || minutes > 600) return out(`¿${minutes} minutos? Me parece raro 🤔 Dímelo otra vez, por ejemplo «el tinte dura hora y media».`);
    if (sv.duration === minutes) return out(`${serviceName(sv)} ya dura ${durationText(minutes)} 😊`);
    return confirm(
      { type: 'setDuration', serviceId: sv.id, duration: minutes, previous: { duration: sv.duration ?? null }, summary: `${serviceName(sv)} dura ${durationText(minutes)}` },
      `${sv.duration ? `Ahora mismo ${serviceName(sv)} dura ${durationText(sv.duration)}. ` : ''}¿Lo cambio a ${durationText(minutes)}?`,
      `Ahora ${serviceName(sv)} dura ${durationText(minutes)}${sv.duration ? ` (antes ${durationText(sv.duration)})` : ''}. Las citas ya reservadas mantienen su duración.`);
  }

  function renameService(d) {
    if (!d.serviceId) return askDraft('renameService', d, '¿Qué servicio quieres renombrar?', 'serviceId');
    const sv = findService(catalog, d.serviceId);
    if (!d.name) return askDraft('renameService', d, `¿Cómo quieres que se llame «${serviceName(sv)}»?`, 'name');
    const name = d.name[0].toUpperCase() + d.name.slice(1);
    if (normalize(name) === normalize(sv.name)) return out(`Ya se llama «${sv.name}» 😊`);
    return confirm(
      { type: 'renameService', serviceId: sv.id, patch: { name, synonyms: [...new Set([...(sv.synonyms ?? []), normalize(name)])] }, previous: { name: sv.name, synonyms: sv.synonyms ?? [] }, summary: `«${sv.name}» pasa a llamarse «${name}»` },
      `¿Cambio «${sv.name}» por «${name}»? Las clientas podrán pedirlo con los dos nombres.`, `Ahora se llama «${name}».`);
  }

  function setCategory(d) {
    if (!d.serviceId) return askDraft('setCategory', d, '¿Qué servicio cambio de grupo?', 'serviceId');
    const sv = findService(catalog, d.serviceId);
    if (!d.category || !CATEGORY_LABELS[d.category]) {
      return askDraft('setCategory', d, `¿A qué grupo paso «${serviceName(sv)}»? ${Object.values(CATEGORY_LABELS).join(' · ')}`, 'category');
    }
    if (sv.category === d.category) return out(`«${serviceName(sv)}» ya está en ${CATEGORY_LABELS[d.category]} 😊`);
    return confirm(
      { type: 'setCategory', serviceId: sv.id, patch: { category: d.category }, previous: { category: sv.category ?? null }, summary: `«${serviceName(sv)}» a ${CATEGORY_LABELS[d.category]}` },
      `¿Paso «${serviceName(sv)}» al grupo ${CATEGORY_LABELS[d.category]}?`, `«${serviceName(sv)}» ahora está en ${CATEGORY_LABELS[d.category]}.`);
  }

  function setDescription(d) {
    if (!d.serviceId) return askDraft('setDescription', d, '¿De qué servicio cambio la descripción?', 'serviceId');
    const sv = findService(catalog, d.serviceId);
    if (!d.text) {
      return askDraft('setDescription', d, `Escribe la descripción de «${serviceName(sv)}» (lo que contestaré cuando una clienta pregunte «¿en qué consiste?»). ${sv.description ? `Ahora: «${sv.description}»` : 'Ahora no tiene.'}`, 'text');
    }
    return confirm(
      { type: 'setDescription', serviceId: sv.id, patch: { description: d.text }, previous: { description: sv.description ?? null }, summary: `descripción de «${serviceName(sv)}»` },
      `¿Pongo esta descripción a «${serviceName(sv)}»?\n«${d.text}»`, 'Descripción guardada.');
  }

  function renameBusiness(name) {
    if (!name) return askDraft('renameBusiness', {}, `¿Qué nombre le pongo? Ahora es «${business.name ?? 'sin nombre'}».`);
    return confirm({ type: 'renameBusiness', name, summary: `el salón pasa a llamarse «${name}»` },
      `¿Cambio el nombre del salón de «${business.name}» a «${name}»? Es lo que contesto cuando preguntan cómo os llamáis.`, `Ahora os llamáis «${name}».`);
  }

  // a new service: whatever she gives in any message (name, duration, price, group)
  function fillService(d, uu, msg, asking = null) {
    const raw = msg.trim().replace(/[.!¡]+$/, '');
    const number = /^\d{1,4}([.,]\d{1,2})?$/.test(raw) ? +raw.replace(',', '.') : null;
    const said = /^(se llama(r[aá])?|se va a llamar|ll[aá]malo|el nombre es|ponle de nombre)\s+/i;
    if (asking === 'name' || said.test(raw)) d.name = raw.replace(said, '');
    const minutes = parseDuration(uu.normalizedText) ?? (asking === 'duration' && number >= 5 ? number : null);
    if (minutes) d.duration = minutes;
    const price = /\b(cuesta|vale|precio|euros?|€)\b/.test(uu.normalizedText + ' ' + msg) || asking === 'price' ? parsePrice(msg) ?? (asking === 'price' ? number : null) : null;
    if (price != null) { d.price = price; d.priceAsked = true; }
    if (asking === 'price' && /^(sin precio|no|nada|ninguno|no tiene|depende)$/.test(uu.normalizedText)) { d.price = null; d.priceAsked = true; }
    if (/\b(ponlo|ponla|en|dentro de|grupo|categoria)\b/.test(uu.normalizedText) && uu.category && CATEGORY_LABELS[uu.category]) d.category = uu.category;
    return d;
  }

  // one or more appointments of hers move to another service ("la cita de Ana es para tinte, no para corte")
  function changeService(a, serviceId) {
    const sv = findService(catalog, serviceId);
    if (!sv) return out(`¿Para qué servicio es la cita de ${customerName(a)}?`);
    const duration = sv.duration ?? a.duration;
    if (!isFree(a.date, toMinutes(a.time), duration, { ignoreId: a.id })) {
      return out(`Con ${sv.name} (${durationText(duration)}) la cita de ${customerName(a)} ${dayText(a.date, today)} a las ${a.time} se solaparía con otra 🤔 Muévela primero («mueve la de ${customerName(a).split(' ')[0]} a las …»).`);
    }
    return confirm(
      { type: 'changeAppointmentService', appointmentId: a.id, patch: { service: sv.group, name: sv.name, details: [{ id: sv.id, group: sv.group, name: sv.name, duration }], duration },
        previous: { service: a.service, name: a.name, details: a.details ?? [], duration: a.duration }, summary: `la cita de ${customerName(a)} pasa a ${sv.name}` },
      `¿Cambio la cita de ${customerName(a)} (${dayText(a.date, today)} a las ${a.time}) de ${apptService(a)} a ${sv.name} (${durationText(duration)})?`,
      `La cita de ${customerName(a)} ahora es para ${sv.name}.`);
  }

  // prices of many services at once: a percent or a fixed amount, rounded to 50 cents
  function bulkPrice(d) {
    const ESTETICA = ['estetica_facial', 'estetica_corporal', 'depilacion', 'manicura_pedicura', 'pestanas_cejas'];
    const targets = catalog.filter(x => x.active !== false && x.price != null && (!d.category || (d.category === 'estetica' ? ESTETICA.includes(x.category) : x.category === d.category)));
    const group = d.category ? ` de ${(d.category === 'estetica' ? '🧖 Estética' : CATEGORY_LABELS[d.category] ?? d.category)}` : '';
    if (!targets.length) return out(`Ninguno de tus servicios${group} tiene precio todavía 🤔 Ponles precio uno a uno, por ejemplo «${catalog.find(x => !d.category || x.category === d.category)?.synonyms?.[0] ?? 'corte'} a 30 €».`);
    if (!d.percent && !d.change) return askDraft('bulkPrice', d, `¿Cuánto cambio los ${targets.length} precios${group}? Por ejemplo «un 5 %», «2 euros más» o «baja un 10 %».`);
    const round = p => Math.max(0, Math.round(p * 2) / 2);
    const items = targets.map(x => ({ serviceId: x.id, patch: { price: round(d.percent ? x.price * (1 + d.percent / 100) : x.price + d.change) }, previous: { price: x.price } }));
    const how = d.percent ? `${d.percent > 0 ? 'un' : 'bajo un'} ${Math.abs(d.percent)} %` : `${d.change > 0 ? '+' : '−'}${euros(Math.abs(d.change))}`;
    const examples = items.slice(0, 4).map(i => `${serviceName(findService(catalog, i.serviceId))} ${euros(i.previous.price)} → ${euros(i.patch.price)}`).join(', ');
    return confirm({ type: 'bulkPrice', items, summary: `${items.length} precios${group} ${how}` },
      `¿Cambio ${plural(items.length, 'precio', 'precios')}${group} (${how})? Por ejemplo: ${examples}${items.length > 4 ? '…' : '.'} Los servicios sin precio no cambian.`,
      `${plural(items.length, 'precio cambiado', 'precios cambiados')}.`);
  }

  // "vuelve a poner el corte al precio que tenía antes": the price before the last change of that service
  function restorePrice(serviceId) {
    const sv = findService(catalog, serviceId);
    if (!sv) return out('¿De qué servicio? Por ejemplo «vuelve a poner el corte al precio de antes».');
    for (const c of recentChanges) {
      if (c.undoneAt) continue;
      const prev = c.type === 'setPrice' && c.data?.serviceId === sv.id ? c.previous?.price
        : c.type === 'bulkPrice' ? c.data?.items?.find(i => i.serviceId === sv.id)?.previous?.price : undefined;
      if (prev !== undefined && prev !== null) return setPriceFor(sv, prev);
    }
    return out(`No tengo ningún cambio de precio de ${serviceName(sv)} 🤔 Ahora está a ${sv.price != null ? euros(sv.price) : 'sin precio'}.`);
  }

  // all the services of a group off at once
  function disableGroup(category) {
    const list = catalog.filter(x => x.active !== false && x.category === category);
    if (!list.length) return out(`No tienes servicios activos de ${CATEGORY_LABELS[category] ?? category}.`);
    return confirm({ type: 'disableServices', items: list.map(x => ({ serviceId: x.id, patch: { active: false }, previous: { active: true } })), summary: `desactivar ${CATEGORY_LABELS[category] ?? category}` },
      `¿Desactivo los ${list.length} servicios de ${CATEGORY_LABELS[category] ?? category}? Las clientas ya no podrán pedirlos. Las citas ya reservadas se mantienen.`,
      `${list.length} servicios desactivados.`);
  }

  // closing a whole day (also from a question about one day's hours)
  function closeDay(date) {
    const c = closedReason(date, business);
    if (c) return out(`${cap(dayText(date, today))} ya está cerrado 😊`);
    const before = business.closedDates ?? null;
    const warning = warnList(affectedBy(appointments, x => (x === date ? [] : undefined)), n => `ese día tienes ${n}`);
    return confirm({ type: 'closeDate', date, set: { closedDates: [...(before ?? []), date] }, previous: { closedDates: before }, summary: `cerrar ${dayText(date, today)}` },
      `¿${warning ? 'Cierro igualmente' : 'Cierro'} ${dayText(date, today)}?`, `${cap(dayText(date, today))} queda cerrado.`, warning);
  }

  // "bloquea mañana de 12 a 14", "no permitas reservas el viernes por la tarde": that day's hours without that time
  function blockTime({ date, from, to, timeOfDay }) {
    const current = H.dayHours(business, date);
    if (!current.length || closedReason(date, business)) return out(`${cap(dayText(date, today))} ya está cerrado 😊`);
    const cut = from && to ? [[toMinutes(from), toMinutes(to)]] : timeOfDay ? H.timeOfDayIntervals(current, timeOfDay) : null;
    if (!cut) return closeDay(date);
    const left = current.flatMap(([a, b]) => cut.reduce((parts, [x, y]) => parts.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, x], [y, q]].filter(([m, n]) => n - m >= 15))), [[a, b]]));
    if (JSON.stringify(left) === JSON.stringify(current)) return out(`${cap(dayText(date, today))} a esa hora ya no abres 😊 Horario: ${hoursText(current)}.`);
    if (!left.length) return closeDay(date);
    const asText = left.map(([a, b]) => [hhmm(a), hhmm(b)]);
    const before = business.dateOverrides ?? null;
    const what = from && to ? `de ${H.clock(toMinutes(from))} a ${H.clock(toMinutes(to))}` : timeOfDay === 'morning' ? 'por la mañana' : timeOfDay === 'afternoon' ? 'por la tarde' : 'a mediodía';
    const warning = warnList(affectedBy(appointments, x => (x === date ? left : undefined)), n => `${n} ${n.startsWith('1 ') ? 'cae' : 'caen'} en ese rato`);
    return confirm(
      { type: 'setDayHours', date, intervals: asText, set: { dateOverrides: { ...(before ?? {}), [date]: asText } }, previous: { dateOverrides: before }, summary: `bloquear ${dayText(date, today)} ${what}` },
      `¿Bloqueo ${dayText(date, today)} ${what}? Ese día quedaría abierto ${H.intervalsText(left)}.`,
      `Bloqueado: ${dayText(date, today)} ${what}. Las clientas no podrán reservar a esa hora.`, warning);
  }

  // back to the usual hours for a day with special hours or a block
  function restoreHours(date) {
    const overrides = Object.entries(business.dateOverrides ?? {}).filter(([d]) => d >= todayISO);
    if (!date) {
      return out(overrides.length ? `Días con horario especial: ${joinList(overrides.map(([d]) => dayName(d)))}. ¿Cuál vuelvo a dejar normal? Por ejemplo «vuelve a poner el horario habitual del ${dayName(overrides[0][0]).split(' ')[0]}».` : 'Todos los días tienen su horario de siempre 😊');
    }
    if (!business.dateOverrides?.[date]) return out(`${cap(dayText(date, today))} ya tiene el horario de siempre: ${hoursText(H.dayHours(business, date))} 😊`);
    const rest = Object.fromEntries(Object.entries(business.dateOverrides).filter(([d]) => d !== date));
    const usual = H.dayHours({ ...business, dateOverrides: rest }, date);
    return confirm(
      { type: 'setDayHours', date, set: { dateOverrides: Object.keys(rest).length ? rest : null }, previous: { dateOverrides: business.dateOverrides }, summary: `horario de siempre ${dayText(date, today)}` },
      `¿Vuelvo a poner el horario de siempre ${dayText(date, today)} (${hoursText(usual)})?`, `${cap(dayText(date, today))} vuelve a su horario: ${hoursText(usual)}.`);
  }

  // a message to one customer, by name: her text, a reminder of her next appointment, or ask
  function sendMessage(d) {
    const key = normalizeName(d.name ?? '');
    const found = d.customerId ? customers.filter(c => c.id === d.customerId) : customers.filter(c => c.name && normalizeName(c.name).split(' ').concat(normalizeName(c.name)).some(w => w === key || normalizeName(c.name).startsWith(key)));
    const reachable = found.filter(c => c.phone && !c.phone.startsWith('manual:'));
    if (!found.length) return out(`No encuentro a ninguna clienta que se llame ${d.name} 🤔 Solo conozco el nombre de las que lo han dicho o que has apuntado tú.`);
    if (!reachable.length) return out(`${found[0].name} no tiene WhatsApp guardado: la apuntaste a mano 🤔`);
    if (reachable.length > 1) {
      return askDraft('sendMessage', { ...d, name: null }, `Tengo ${reachable.length} clientas con ese nombre: ${joinList(reachable.map(c => `${c.name} (${formatPhone(c.phone)})`))}. ¿A cuál? Dime el nombre completo.`, 'who');
    }
    const c = reachable[0];
    const first = c.name.split(' ')[0];
    let text = d.text;
    if (!text && d.reminder) {
      if (!c.next) return askDraft('sendMessage', { ...d, customerId: c.id }, `${c.name} no tiene ninguna cita próxima 🤔 ¿Qué le escribo?`, 'text');
      text = `Hola ${first} 😊 Te recordamos tu cita ${dayText(c.next.date, today).replace(/^el /, 'del ').replace(/^(hoy|mañana)/, 'de $1')} a las ${c.next.time} (${c.next.name}). ¡Te esperamos!`;
    }
    if (!text && d.content) {
      const body = d.content.replace(/\bsus\b/gi, 'tus').replace(/\bsu\b/gi, 'tu').replace(/\ble\b/gi, 'te');
      text = `Hola ${first} 😊 ${body[0].toUpperCase()}${body.slice(1)}${/[.!?]$/.test(body) ? '' : '.'}`;
    }
    if (!text) return askDraft('sendMessage', { ...d, customerId: c.id }, `¿Qué le escribo a ${c.name}?`, 'text');
    const res = confirm({ type: 'sendMessage', customerId: c.id, phone: c.phone, text, summary: `mensaje a ${c.name}` },
      `¿Le envío esto a ${c.name} (${formatPhone(c.phone)})?\n«${text}»\nSi prefieres otro texto, escríbemelo.`, `Enviado a ${c.name}.`);
    newState.pending.redo = { action: 'sendMessage', draft: { customerId: c.id } };
    return res;
  }

  // ---- business data ----

  function weekBounds() {
    const d = fromISODate(todayISO);
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return [iso(monday), iso(sunday)];
  }

  function stats(range) {
    const all = [...history, ...appointments];
    const [from, to] = range === 'week' ? weekBounds() : [`${todayISO.slice(0, 8)}01`, iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))];
    const label = range === 'week' ? 'Esta semana' : 'Este mes';
    const inRange = all.filter(a => a.date >= from && a.date <= to);
    const done = inRange.filter(a => a.date < todayISO).length;
    const gone = cancelled.filter(a => a.date >= from && a.date <= to).length;
    const counts = {};
    for (const a of all) counts[apptService(a)] = (counts[apptService(a)] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, k]) => `${n} (${k})`);
    const people = customers.filter(c => c.visits > 0);
    return [
      `📊 Tienes ${plural(people.length, 'clienta', 'clientas')} con alguna cita${people.filter(c => c.next).length ? ` (${people.filter(c => c.next).length} con cita próxima)` : ''}.`,
      `${label}: ${plural(inRange.length, 'cita', 'citas')} (${done} ya hechas, ${inRange.length - done} por venir)${gone ? ` y ${plural(gone, 'anulada', 'anuladas')}` : ''}.`,
      top.length ? `Lo más reservado (últimos 3 meses y lo que viene): ${top.join(', ')}.` : '',
    ].filter(Boolean).join('\n');
  }

  function changesHistory() {
    const since = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7));
    const list = recentChanges.filter(c => (c.createdAt ?? '').slice(0, 10) >= since);
    if (!list.length) return 'Esta semana no has cambiado nada desde aquí.';
    return `Cambios de los últimos 7 días:\n${list.map(c => `• ${c.data?.summary ?? c.type}${c.undoneAt ? ' (deshecho)' : ''}`).join('\n')}`;
  }

  function customerInfo(name) {
    const key = normalizeName(name);
    const found = customers.filter(c => c.name && normalizeName(c.name).includes(key));
    if (!found.length) return `No tengo ninguna clienta con el nombre «${name}» 🤔 Solo conozco el nombre de las que lo han dicho o que has apuntado tú.`;
    if (found.length > 1) return `Tengo ${found.length}: ${joinList(found.slice(0, 6).map(c => `${c.name} (${formatPhone(c.phone) ?? 'sin teléfono'})`))}. ¿Cuál? Dime el nombre completo.`;
    const c = found[0];
    return [
      `${c.name} · ${formatPhone(c.phone) ?? 'sin teléfono (la apuntaste a mano)'}`,
      `Última visita: ${c.last ? `${dayName(c.last.date)} (${c.last.name})` : 'todavía ninguna'}`,
      `Próxima cita: ${c.next ? `${dayText(c.next.date, today)} a las ${c.next.time} (${c.next.name})` : 'ninguna'}`,
      `${plural(c.visits, 'cita', 'citas')} en total.`,
    ].join('\n');
  }

  function cancellationsOn(date) {
    const list = cancelled.filter(a => a.date === date || (a.updatedAt ?? '').slice(0, 10) === date);
    if (!list.length) return `${cap(dayText(date, today).replace(/ \(.*\)$/, ''))} no se ha anulado ninguna cita 🎉`;
    return `Citas anuladas ${dayText(date, today).replace(/ \(.*\)$/, '')}:\n${list.map(a => `• ${customerName(a)} — ${apptService(a)} (era ${dayText(a.date, today).replace(/ \(.*\)$/, '')} a las ${a.time})`).join('\n')}`;
  }

  // "¿abrimos los sábados?", "¿a qué hora cerramos hoy?", or the whole picture
  function hoursAnswer({ date, days }) {
    if (date) {
      const c = closedReason(date, business);
      const special = business.dateOverrides?.[date] ? ' (horario especial)' : '';
      return c ? `${cap(dayText(date, today))} está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}.` : `${cap(dayText(date, today))} abres ${H.intervalsText(H.dayHours(business, date))}${special}.`;
    }
    if (days?.length) {
      const week = H.weekHours(business);
      return days.map(d => (week[d].length ? `Los ${H.DAY_PLURALS[d]} abres ${H.intervalsText(week[d])}.` : `Los ${H.DAY_PLURALS[d]} cierras.`)).join(' ');
    }
    return hoursOverview();
  }

  // A new service: name, duration, price (or none), then confirm
  function addService(d) {
    const ask = (asking, question) => {
      newState = { ...newState, pending: { kind: 'draft', action: 'addService', draft: d, asking } };
      return out(question);
    };
    if (!d.name) return ask('name', '¿Cómo se llama el servicio nuevo?');
    // already in the catalog: same name, or a synonym that is the whole name ("keratina")
    const found = detectServices(normalize(d.name), catalog).find(s => s.id !== 'LAST');
    const same = catalog.find(s => normalize(s.name) === normalize(d.name)) ??
      (found && catalog.find(s => s.id === found.id)?.synonyms?.some(x => normalize(x) === normalize(d.name)) ? catalog.find(s => s.id === found.id) : null);
    if (same) {
      return out(same.active === false
        ? `Ya lo tienes, pero desactivado: ${serviceName(same)}. Para volver a ofrecerlo: «vuelvo a hacer ${(same.synonyms?.[0] ?? serviceName(same)).toLowerCase()}».`
        : `Ya lo tienes: ${serviceName(same)}, ${durationText(same.duration)} · ${same.price != null ? euros(same.price) : 'sin precio'}.`);
    }
    const name = d.name[0].toUpperCase() + d.name.slice(1);
    const known = [d.price != null && euros(d.price), d.category && CATEGORY_LABELS[d.category]].filter(Boolean).join(' · ');
    if (!d.duration) return ask('duration', `¿Cuánto dura «${name}»${known ? ` (${known})` : ''}? (por ejemplo «45 min» o «1 h 30»)`);
    if (!d.priceAsked) return ask('price', `¿Qué precio tiene «${name}» (${durationText(d.duration)})? (o «sin precio»)`);
    const key = normalize(name);
    let id = key.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'servicio';
    while (catalog.some(s => s.id === id)) id += '_2';
    const service = { id, group: id, category: d.category ?? 'otros', name, duration: d.duration, price: d.price ?? null, synonyms: [key] };
    const res = confirm(
      { type: 'addService', service, summary: `añadir ${name}` },
      `¿Añado «${name}» (${durationText(d.duration)} · ${d.price != null ? euros(d.price) : 'sin precio'} · ${CATEGORY_LABELS[service.category]})? Las clientas podrán pedirlo escribiendo «${name.toLowerCase()}».`,
      `«${name}» añadido a tus servicios.`);
    newState.pending.redo = { action: 'addService', draft: d };
    return res;
  }

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

  function agenda({ date, from, to, range, time = null, fromTime = null, timeOfDay = null, serviceId = null, free = false, count = false }) {
    const partOf = (d, a) => {
      if (!timeOfDay) return true;
      const part = H.timeOfDayIntervals(H.dayHours(business, d), timeOfDay);
      return part.some(([x, y]) => toMinutes(a.time) >= x && toMinutes(a.time) < y);
    };
    const sv = serviceId ? findService(catalog, serviceId) : null;
    const keep = a => (!time || a.time === time) && (!fromTime || a.time >= fromTime) && partOf(a.date, a) &&
      (!sv || a.details?.some(x => x.id === sv.id || x.group === sv.group) || a.service === sv.group);
    const filters = [timeOfDay && ({ morning: 'por la mañana', afternoon: 'por la tarde', midday: 'a mediodía' }[timeOfDay]), sv && `de ${sv.name.toLowerCase()}`, fromTime && `a partir de las ${fromTime}`, time && `a las ${time}`].filter(Boolean).join(' ');
    if (free) {
      const days = date ? [date] : (() => { const ds = []; for (let d = fromISODate(from); iso(d) <= to; d.setDate(d.getDate() + 1)) ds.push(iso(d)); return ds; })();
      const lines = days.map(d => {
        if (closedReason(d, business)) return null;
        const part = timeOfDay ? H.timeOfDayIntervals(H.dayHours(business, d), timeOfDay) : null;
        const stretches = freeStretches(d, business, appointments.filter(a => a.date === d), d === todayISO ? today.getHours() * 60 + today.getMinutes() : 0)
          .flatMap(([a, b]) => (part ? part.map(([x, y]) => [Math.max(a, x), Math.min(b, y)]).filter(([m, n]) => n - m >= (business.slotMinutes ?? 30)) : [[a, b]]));
        return stretches.length ? `${cap(dayText(d, today))}${filters ? ` ${filters}` : ''}: ${stretches.map(([a, b]) => `de ${H.clock(a)} a ${H.clock(b)}`).join(', ')}` : `${cap(dayText(d, today))}${filters ? ` ${filters}` : ''}: nada libre`;
      }).filter(Boolean);
      return lines.length ? `Huecos libres:\n${lines.join('\n')}` : 'Esos días está cerrado.';
    }
    if (from) {
      const list = appointments.filter(a => a.date >= from && a.date <= to && keep(a)).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
      const label = { nextWeek: 'La semana que viene', month: 'Este mes', nextMonth: 'El mes que viene' }[range] ?? 'Esta semana';
      if (count) return `${label}${filters ? ` ${filters}` : ''}: ${plural(list.length, 'cita', 'citas')} en total.`;
      if (!list.length) return `${label} (${rangeText(from, to)}) no tienes citas${filters ? ` ${filters}` : ''}.`;
      const days = [...new Set(list.map(a => a.date))];
      const perDay = days.map(d => [d, list.filter(a => a.date === d).length]);
      const most = Math.max(...perDay.map(([, n]) => n));
      const top = perDay.filter(([, n]) => n === most);
      return `${label} tienes ${plural(list.length, 'cita', 'citas')}${filters ? ` ${filters}` : ''}:\n` +
        days.map(d => `${cap(dayName(d))}:\n${list.filter(a => a.date === d).map(apptLine).join('\n')}`).join('\n') +
        (days.length > 1 && top.length < days.length ? `\n${top.length === 1 ? `El día con más citas: ${dayName(top[0][0])} (${most}).` : `Los días con más citas: ${joinList(top.map(([d]) => dayName(d)))} (${most} cada uno).`}` : days.length > 1 ? `\nTodos los días tienen ${plural(most, 'cita', 'citas')}.` : '');
    }
    const c = closedReason(date, business);
    const list = appointments.filter(a => a.date === date && keep(a)).sort((x, y) => x.time.localeCompare(y.time));
    const head = cap(dayText(date, today));
    if (count) return `${head}${filters ? ` ${filters}` : ''}: ${plural(list.length, 'cita', 'citas')} en total.`;
    if (c && !list.length) return `${head} está cerrado${c.kind === 'weekday' ? '' : ` (${c.reason})`}.`;
    if (filters) return list.length ? `${head} ${filters}:\n${list.map(apptLine).join('\n')}` : `${head} ${filters} no tienes ninguna cita.`;
    const nowMinute = date === todayISO ? today.getHours() * 60 + today.getMinutes() : 0;
    const freeNow = c ? [] : freeStretches(date, business, list, nowMinute);
    const freeText = freeNow.length ? `Libre: ${freeNow.map(([a, b]) => `de ${H.clock(a)} a ${H.clock(b)}`).join(', ')}.` : c ? '' : 'No queda ningún hueco libre.';
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
    for (let d = new Date(today), i = 0; i < 60; i++, d.setDate(d.getDate() + 1)) {
      if (closedReason(iso(d), business)) { lines.push(`Próximo día cerrado: ${dayText(iso(d), today)}.`); break; }
    }
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
    if (!d.time && d.timeOfDay && d.serviceId) {
      const sv = findService(catalog, d.serviceId);
      const part = H.timeOfDayIntervals(H.dayHours(business, d.date), d.timeOfDay);
      const free = freeTimes(d.date, sv?.duration ?? 30, { ...business, slotMinutes: business.slotMinutes ?? 30 }, (dt, m, dur) => part.some(([a, b]) => m >= a && m + dur <= b) && isFree(dt, m, dur), null, 3);
      return ask('time', free.length ? `¿A qué hora? ${cap(dayText(d.date, today))} por la ${d.timeOfDay === 'morning' ? 'mañana' : 'tarde'} tienes libre: ${joinList(free)}.` : `${cap(dayText(d.date, today))} por la ${d.timeOfDay === 'morning' ? 'mañana' : 'tarde'} no queda hueco. ¿Otra hora u otro día?`);
    }
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
    if (action === 'changeAppointmentService') return changeService(a, extra.serviceId);
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
      date === a.date
        ? `¿Paso la cita de ${customerName(a)} (${a.name}) ${dayText(a.date, today)} de las ${a.time} a las ${time}?`
        : `¿Paso la cita de ${customerName(a)} (${a.name}) de ${dayText(a.date, today)} a las ${a.time} a ${dayText(date, today)} a las ${time}?`,
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
