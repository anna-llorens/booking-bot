// understand-owner.js — Understands what the salon owner writes in owner mode ("el jueves cierro",
// "sube el tinte a 38", "¿qué tengo hoy?"). Pure: no store, no clock (today comes in as an option).
//
// Dates, times, services and the text normalization are the customer ones (src/understand.js), so
// "el jueves", "a las 5" or "mechas" mean the same thing for the owner as for her customers.
//
//   understandOwner(message, { today, catalog }) → { intent, ...fields }
//
// intent: greeting | howAreYou | presence | thanks | bye | dayStatus | revenue | feedback | servicesList | addService
//         | agenda | inbox | inboxMore | ignore | replyChoice | teachChoice | learnedAnswers | forgetAnswer
//         | waitlist | hours | serviceInfo | getPrice | getDuration | setPrice | setDuration
//         | disableService | enableService | closeDate | closeRange | openDate | setDayHours | setWeeklyHours
//         | bookManual | cancelAppointment | moveAppointment | help | yes | no | undo | logout | null
// A bare number ("2") comes as intent null with `number`: its meaning depends on what the bot just showed.
const {
  understand, normalize, basicNormalize, WEEKDAYS, MONTHS, NUMBER_WORDS, detectDate, detectTime, detectServices,
} = require('../understand');

const MONTH_RE = MONTHS.join('|');
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const hhmm = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

// ---- short answers and commands (the whole message) ----
const YES = /^(si|vale|ok|okey|confirmo|confirmado|adelante|hazlo|dale|perfecto|correcto|de acuerdo|claro|venga|eso)( (si|vale|por favor|gracias|hazlo|adelante|claro|perfecto))*$/;
const NO = /^(no|nop|nope|mejor no|no gracias|dejalo|olvidalo|cancela|cancelalo|nada|para|espera|no no)( (gracias|mejor|lo dejamos|dejalo|olvidalo))*$/;
const LOGOUT = /^(logout|log out|salir|salgo|cerrar sesion|salir del modo (duena|dueno)|modo (clienta|cliente))$/;
const UNDO = /^(deshacer|deshaz|deshazlo|deshaz (eso|el ultimo cambio|lo ultimo)|undo|vuelve atras|anula (el )?ultimo cambio)$/;
const HELP = /^(ayuda|help|menu|ejemplos|que (puedo|se puede) (hacer|decir|pedir|preguntar|cambiar)( aqui)?|como funciona( esto)?)$/;

// ---- the inbox: "ver más", "ignora 1, 3 y 5", "ignora todos", and the options for one message ----
const MORE = /^(ver |dame |ensename |y )?(mas|mas mensajes|siguientes|los siguientes|otros|el resto|resto|sigue)$|^(ver|leer|ensename|dame|lee|muestrame) (todos|todo|todas)( los mensajes)?$/;
const IGNORE = /^(ignora|ignorar|ignoralo|ignorala|ignoralos|ignoralas|borra|borrar|borralo|borralos|quita|quitar|quitalo|quitalos|elimina|eliminar|eliminalo|eliminalos|descarta|descartar|descartalo|archiva|archivar|archivalo)( (el|la|los|las|este|ese|esta|esa|estos|esos|mensajes?|numeros?|todos|todas|todo|de|del|y|e|\d+))*$/;
const IGNORE_SOME = /\b(borrar|ignorar|quitar|eliminar|descartar) (algunos|algunas|varios|varias|unos|unas)\b/;
const REPLY_CHOICE = /^(responder|responde|respondele|responderle|contestar|contesta|contestale|contestarle|escribirle|escribele)( (a la clienta|a ella|solo))?$/;
const TEACH_CHOICE = /^(ensenar|ensena|ensenale|aprender|aprende|responder y ensenar|contestar y ensenar|responder y aprender|las dos|ambas|las dos cosas|responder y que (el bot )?lo (conteste|responda) solo( la proxima vez)?)$/;
const LEARNED = /\b(respuestas (aprendidas|guardadas|ensenadas)|que (respuestas )?(has aprendido|te he ensenado|sabes contestar)|que has aprendido)\b/;
const FORGET = /^(olvida|olvidate de|borra|quita|elimina) (la )?(respuesta )?(aprendida |numero )?(\d{1,2})$/;

// ---- queries ----
const INBOX = /\b(que me han (preguntado|escrito|dicho|pedido)|bandeja|mensajes (pendientes|sin (contestar|responder|leer))|preguntas (pendientes|sin contestar)|que (hay|tengo) (pendiente|sin contestar)|quien me ha escrito|pendientes de contestar)\b/;
const WAITLIST = /\b(lista de espera|quien (esta|hay) esperando|en espera)\b/;
const HOURS_QUERY = /\b(que horario tengo|cual es mi horario|mi horario|horario (actual|de ahora)|que dias (cierro|cerramos|tengo cerrado|abro|abrimos)|que cierres tengo|cuando (cierro|cerramos) por vacaciones)\b/;
const AGENDA = /^(y )?(del|este|el|todo el|de este) mes( que viene)?$|^(y )?(esta|la) semana( que viene)?$|^(el )?calendario$|^(la )?agenda$|\b(que tengo|tengo (citas|algo|gente|alguien|clientas?)|cuantas citas|cuantas clientas|citas (de|del|para|hoy|manana|esta|la|el)|agenda|quien viene|a quien tengo|que hay (hoy|manana|el|esta|la)|como (tengo|voy|va|esta) (el dia|la semana|la agenda|hoy|manana|el)|mis citas|las citas|que citas)\b|^(y )?(citas|hoy|manana)$/;
const QUESTION = /\b(cuanto|cuantos|a cuanto|que precio|precio|cuesta|vale|valen|cobro|cobramos|dura|tarda)\b/;

// ---- the day, money, small talk (greetings and thanks come from the customer bot: understand.js) ----
// "¿qué tal ha ido el día?", "¿cómo va el día?", "resumen de hoy" (not "¿cómo va la semana?": that is the agenda)
const DAY_STATUS = /\b((que tal|como) (ha ido|ha sido|va|te ha ido|me ha ido|esta yendo|llevo|llevamos|vamos|voy)( el dia| hoy| la manana| la tarde| la jornada)?|que tal (el dia|hoy|la manana|la tarde|la jornada)|resumen( del dia| de hoy)?|como va todo)\b/;
const REVENUE = /\b(cobros|cobrado|cuanto (he|hemos|llevo|llevamos) (ganado|facturado|cobrado|hecho|sacado)|facturacion|facturado|caja|ganancias|ingresos|cuanto dinero)\b/;
const FEEDBACK = /\b(te queda mucho|entrenar|no (sabes|entiendes) (nada|mucho)|eres (tonto|tonta|malo|mala|inutil)|no (sirves|funcionas)|vaya bot|que bot mas)\b/;
const PRESENCE = /^(hola )?(estas|estais|hay alguien|me (lees|oyes))( (ahi|por ahi))?$/;
const HOW_ARE_YOU = /\b(que tal( estas)?|como (estas|andas|te va|va todo)|todo bien)$/;
const BYE = /^(adios|hasta luego|hasta manana|hasta pronto|chao|chau|bye|nos vemos|buenas noches)( (gracias|guapa|bonita))?$/;
const GREET_START = /^(hola|buenas|buenos dias|buenas tardes|hey|ey)\b/;
const SERVICES_LIST = /^(los |mis |ver |ver los |lista de |que )?(servicios|catalogo|carta|tarifas|precios)( (que (tengo|hago|ofrezco|hay)|tengo|hay))?$|^(servicios|precios) de .+$/;
const ADD_SERVICE = /\b(anadir|anade|anademe|nuevo|nueva|crear|crea|creame|agregar|agrega|meter|mete) (un |el |otro |una |la )?(servicio|tratamiento)\b|\b(servicio|tratamiento) nuevo\b/;
const EXISTS = /\b(esta|estan|existe|existen|tenemos|tengo|tienes|hay|ofrecemos|ofrezco|hacemos|hago)\b/;

// ---- changes ----
const CANCEL_V = /\b(cancela|cancelame|cancelale|anula|anulale|borra|borrale|elimina|quita|quitale)\b/;
const MOVE_V = /\b(mueve|muevela|muevele|cambia|cambiala|cambiale|pasa|pasala|pasale|retrasa|retrasala|adelanta|adelantala)\b/;
const APPT_REF = /\b(cita|citas|la de|la del|la que|el de las|la de las)\b/;
const BOOK_V = /^(apunta|apuntame|apuntale|anota|anotame|anotale|reserva|reservale|mete|metele|agendale|ponle (una )?cita|pon (una )?cita|pon a|ponme a|cita para|nueva cita)\b/;
const DISABLE = /\b(ya no (hago|hacemos|ofrezco|ofrecemos|hare|vamos a hacer)|no (hago|hacemos|ofrezco) mas|deja de (ofrecer|salir)|dejo de (hacer|ofrecer)|desactiva|quita|quitar|elimina|borra)\b/;
const ENABLE = /\b(vuelvo a (hacer|ofrecer)|volvemos a (hacer|ofrecer)|ya (hago|hacemos|ofrezco) otra vez|otra vez (hago|hacemos|ofrezco)|activa|reactiva|vuelve a (estar|salir)|anade|recupera)\b/;
const DURATION_V = /\b(dura|duran|duracion|tarda|tardo|tardamos|tardan)\b/;
const CLOSE_V = /\b(cierro|cerramos|cerrado|cerrada|cierra|no abro|no abrimos|no trabajo|no trabajamos|libre|festivo|fiesta|vacaciones|no vengo|no estoy)\b/;
const OPEN_V = /\b(abro|abrimos|abierto|abierta|abre|trabajo|trabajamos)\b/;
const WEEKLY = /\b(a partir de ahora|desde ahora|de ahora en adelante|siempre|todos los|todas las semanas|cada semana|ya no abro los|entre semana|fines? de semana|findes)\b|\blos (lunes|martes|miercoles|jueves|viernes|sabados|domingos)\b|\bde (lunes|martes|miercoles|jueves|viernes|sabado|domingo) a (lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/;

// "10", "10:30", "diez", "10 y media" → [hours, minutes]
const CLOCK = '(\\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:[:h](\\d{2}))?(?: y (media|cuarto))?';
function clockParts(m, i) {
  const h = /^\d+$/.test(m[i]) ? +m[i] : NUMBER_WORDS[m[i]];
  const min = m[i + 1] ? +m[i + 1] : m[i + 2] === 'media' ? 30 : m[i + 2] === 'cuarto' ? 15 : 0;
  return h == null || h > 23 || min > 59 ? null : [h, min];
}
// Opening times: "abro a las 4" is 16:00, "abro a las 9" is 9:00
const openingClock = ([h, m]) => hhmm((h < 7 ? h + 12 : h) * 60 + m);
// Closing times: "cierro a las 8" is 20:00, "cierro a las 2" is 14:00
const closingClock = ([h, m]) => hhmm((h <= 9 ? h + 12 : h) * 60 + m);

// "abro a las 10", "cierro a las 18", "de 10 a 14 y de 16 a 20": the hours she gives for a day
function parseHours(t) {
  const ranges = [...t.matchAll(new RegExp(`\\bde(?:sde)? (?:las |la )?${CLOCK} (?:a|hasta) (?:las |la )?${CLOCK}`, 'g'))]
    .map(m => {
      const a = clockParts(m, 1), b = clockParts(m, 4);
      if (!a || !b) return null;
      const from = openingClock(a);
      let to = hhmm(b[0] * 60 + b[1]);
      if (to <= from) to = hhmm((b[0] + 12) * 60 + b[1]);
      return [from, to];
    }).filter(Boolean);
  if (ranges.length) return { intervals: ranges };
  const open = t.match(new RegExp(`\\b(?:abro|abrimos|abre|empiezo|entro) (?:a las |a la |sobre las |desde las )?${CLOCK}\\b`));
  const close = t.match(new RegExp(`\\b(?:cierro|cerramos|cierra|termino|acabo|salgo) (?:a las |a la |sobre las )?${CLOCK}\\b`));
  const res = {};
  if (open && clockParts(open, 1)) res.opens = openingClock(clockParts(open, 1));
  if (close && clockParts(close, 1)) res.closes = closingClock(clockParts(close, 1));
  return Object.keys(res).length ? res : null;
}

// Weekdays named as a habit: "los sábados", "de lunes a viernes", "entre semana" → [6], [1..5]
function parseWeekdays(t) {
  if (/\bentre semana\b/.test(t)) return [1, 2, 3, 4, 5];
  if (/\b(fines? de semana|findes)\b/.test(t)) return [6, 0];
  const span = t.match(new RegExp(`\\bde (${WEEKDAYS.join('|')}) a (${WEEKDAYS.join('|')})\\b`));
  if (span) {
    const a = WEEKDAYS.indexOf(span[1]), b = WEEKDAYS.indexOf(span[2]);
    const days = [];
    for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b || days.length > 7) break; }
    return days;
  }
  return WEEKDAYS.map((d, i) => (new RegExp(`\\b${d}s?\\b`).test(t) ? i : -1)).filter(i => i >= 0);
}

// The next date with that day and month (this year, or next year if it has passed)
function futureDate(today, day, month) {
  const d = new Date(today.getFullYear(), month, day);
  if (d < addDays(today, 0)) d.setFullYear(d.getFullYear() + 1);
  return d;
}

// "del 10 al 24 de agosto", "del 28 de diciembre al 6 de enero", "del lunes al miércoles"
function parseRange(t, today) {
  let m = t.match(new RegExp(`\\b(?:del?|desde el) (\\d{1,2})(?: de (${MONTH_RE}))? (?:al|hasta el) (\\d{1,2}) de (${MONTH_RE})\\b`));
  if (m) {
    const m2 = MONTHS.indexOf(m[4]);
    const m1 = m[2] ? MONTHS.indexOf(m[2]) : (+m[1] > +m[3] ? (m2 + 11) % 12 : m2);
    const from = futureDate(today, +m[1], m1);
    const to = new Date(from.getFullYear(), m2, +m[3]);
    if (to < from) to.setFullYear(to.getFullYear() + 1);
    return { from: iso(from), to: iso(to) };
  }
  m = t.match(/\b(?:del?|desde(?: el)?) (.+?) (?:al|hasta(?: el)?) (.+)$/);
  if (m) {
    const a = detectDate(m[1], today), b = detectDate(m[2], today);
    if (a && b && b > a) return { from: iso(a), to: iso(b) };
  }
  return null;
}

// "38", "38 €", "12,50 euros" → 38 / 12.5 (from the raw text: normalize() drops the comma)
function parsePrice(message) {
  const raw = basicNormalize(message).replace(/[¿?¡!]+/g, ' ').trim().replace(/[.\s]+$/, '');
  const num = s => +s.replace(',', '.');
  let m = raw.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|euros?\b|eur\b|pavos\b)/);
  if (m) return num(m[1]);
  m = raw.match(/\b(?:a|en|por|cobro|cobra|cobramos|cuesta|vale)\s+(\d{1,4}(?:[.,]\d{1,2})?)$/);
  if (m) return num(m[1]);
  m = raw.match(/^(\d{1,4}(?:[.,]\d{1,2})?)$/);
  return m ? num(m[1]) : null;
}

// "2 horas", "hora y media", "45 minutos", "1h30", "media hora" → minutes
function parseDuration(t) {
  const n = w => (/^\d+$/.test(w) ? +w : NUMBER_WORDS[w]);
  let m = t.match(/\b(\d{1,2})h(\d{2})\b/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/\b(\d{1,2}|una|un|dos|tres|cuatro|cinco) ?(?:horas?|h)\b(?: y (media|cuarto|(\d{1,2}) ?(?:minutos|min)))?/);
  if (m) return (m[1] === 'un' ? 1 : n(m[1])) * 60 + (m[2] === 'media' ? 30 : m[2] === 'cuarto' ? 15 : m[3] ? +m[3] : 0);
  if (/\bhora y media\b/.test(t)) return 90;
  if (/\btres cuartos( de hora)?\b/.test(t)) return 45;
  if (/\bmedia hora\b/.test(t)) return 30;
  if (/\b(una|la) hora\b/.test(t)) return 60;
  m = t.match(/\b(\d{1,3}) ?(?:minutos|min|mins|m)\b/);
  return m ? +m[1] : null;
}

// Words that are never a customer's name
const NOT_A_NAME = new Set([
  'a', 'al', 'de', 'del', 'el', 'la', 'las', 'los', 'lo', 'para', 'por', 'en', 'con', 'que', 'y', 'o', 'mi', 'su', 'tu',
  'un', 'una', 'cita', 'citas', 'hoy', 'manana', 'pasado', 'semana', 'proxima', 'nombre', 'esta', 'este', 'otra', 'otro',
  'senora', 'senor', 'clienta', 'cliente', ...WEEKDAYS, ...MONTHS,
]);
const isNameWord = (word, catalogWords) => {
  const w = normalize(word);
  return w && /^[a-z]+$/.test(w) && !NOT_A_NAME.has(w) && !catalogWords.has(w) && !NUMBER_WORDS[w];
};
const capital = s => s.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

// The customer's name: "apunta a Lucía…", "la cita de Ana del jueves", "a nombre de Marta López"
function parseName(message, catalog, { afterVerb = false } = {}) {
  const catalogWords = new Set(catalog.flatMap(s => s.synonyms.map(normalize)).flatMap(s => s.split(' ')));
  const words = message.replace(/[¿?¡!.,;:]/g, ' ').split(/\s+/).filter(Boolean);
  const take = start => {
    const name = [];
    for (let i = start; i < words.length && name.length < 3; i++) {
      if (!isNameWord(words[i], catalogWords)) break;
      // a second word only if it is capitalized ("Marta López"), so "Lucía corte" is just "Lucía"
      if (name.length && !/^[A-ZÁÉÍÓÚÑ]/.test(words[i])) break;
      name.push(words[i]);
    }
    return name.length ? capital(name.join(' ')) : null;
  };
  const lower = words.map(w => normalize(w));
  const byName = lower.findIndex((w, i) => w === 'nombre' && lower[i - 1] === 'a' && lower[i + 1] === 'de');
  if (byName >= 0) return take(byName + 2);
  if (afterVerb) {
    // "apunta a Lucía", "apunta Lucía", "reserva para Lucía"
    let i = 1;
    if (['una', 'cita'].includes(lower[i])) i++;
    if (lower[i] === 'cita') i++;
    if (['a', 'para'].includes(lower[i])) i++;
    const name = take(i);
    if (name) return name;
  }
  // "de Ana", "a Ana", "para Ana": a capitalized word after one of those
  for (let i = 0; i < words.length - 1; i++) {
    if (['de', 'a', 'para'].includes(lower[i]) && /^[A-ZÁÉÍÓÚÑ]/.test(words[i + 1])) {
      const name = take(i + 1);
      if (name) return name;
    }
  }
  // lowercase "la cita de ana": the word right after "cita de" / "la de"
  const m = lower.join(' ').match(/\b(?:cita de|la de|a) ([a-z]+)\b/);
  if (m && isNameWord(m[1], catalogWords)) return capital(m[1]);
  return null;
}

// The service named in the message (the most specific one: "corte de hombre" → corte_hombre)
function parseService(t, catalog) {
  const found = detectServices(t, catalog).filter(s => s.id !== 'LAST');
  return found[0]?.id ?? null;
}

// Where the old appointment ends and the new day/time starts: "mueve la de las 17:00 del viernes | a las 18:00"
function splitMove(t) {
  const verb = t.match(MOVE_V);
  const start = verb ? verb.index + verb[0].length : 0;
  const rest = t.slice(start);
  const re = / (a las|a la|al|a|para el|para las|para la|para) /g;
  let m;
  while ((m = re.exec(rest))) {
    if (m.index === 0 && m[1] === 'a') continue; // "cambia a Ana…": that "a" introduces the name
    return { old: t.slice(0, start + m.index), next: rest.slice(m.index + 1) };
  }
  return { old: t, next: '' };
}

function agendaRange(t, today) {
  if (/\b(mes que viene|proximo mes|mes siguiente)\b/.test(t)) {
    const first = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { from: iso(first), to: iso(new Date(first.getFullYear(), first.getMonth() + 1, 0)), range: 'nextMonth' };
  }
  if (/\b(este mes|del mes|el mes|de mes|en el mes|todo el mes)\b/.test(t)) {
    return { from: iso(today), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)), range: 'month' };
  }
  if (/\b(semana que viene|proxima semana|semana siguiente)\b/.test(t)) {
    const monday = addDays(today, (8 - today.getDay()) % 7 || 7);
    return { from: iso(monday), to: iso(addDays(monday, 6)), range: 'nextWeek' };
  }
  if (/\b(esta semana|la semana|en la semana|de la semana)\b/.test(t)) {
    return { from: iso(today), to: iso(addDays(today, (7 - today.getDay()) % 7)), range: 'week' };
  }
  const d = detectDate(t, today) ?? today;
  return { date: iso(d) };
}

function understandOwner(message, { today, catalog = [] } = {}) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new TypeError('understandOwner(): pass { today } as a valid Date');
  const t = normalize(message);
  // "hola, ¿qué tengo hoy?": the greeting is answered too (reply-owner puts "¡Hola!" before the answer)
  const base = { text: message, normalizedText: t, greeting: GREET_START.test(t) };
  const r = fields => ({ ...base, ...fields });
  const date = detectDate(t, today);

  if (LOGOUT.test(t)) return r({ intent: 'logout', asCustomer: /\bclient/.test(t) });
  if (UNDO.test(t)) return r({ intent: 'undo' });
  if (HELP.test(t)) return r({ intent: 'help' });
  if (YES.test(t)) return r({ intent: 'yes' });
  if (NO.test(t)) return r({ intent: 'no' });

  if (MORE.test(t)) return r({ intent: 'inboxMore', all: /\b(todos|todo|todas)\b/.test(t) });
  if (FORGET.test(t) && /\b(olvida|respuesta)/.test(t)) return r({ intent: 'forgetAnswer', number: +t.match(FORGET)[5] });
  if (IGNORE.test(t)) {
    return r({ intent: 'ignore', numbers: [...t.matchAll(/\d+/g)].map(m => +m[0]), all: /\b(todos|todas|todo)\b/.test(t) });
  }
  if (IGNORE_SOME.test(t)) return r({ intent: 'ignore', numbers: [], all: false, ask: true });
  if (REPLY_CHOICE.test(t)) return r({ intent: 'replyChoice' });
  if (TEACH_CHOICE.test(t)) return r({ intent: 'teachChoice' });
  if (LEARNED.test(t)) return r({ intent: 'learnedAnswers' });
  if (INBOX.test(t)) return r({ intent: 'inbox' });
  if (FEEDBACK.test(t)) return r({ intent: 'feedback' });
  if (REVENUE.test(t)) return r({ intent: 'revenue' });
  if (DAY_STATUS.test(t) && (!date || iso(date) === iso(today)) && !/\b(semana|mes)\b/.test(t)) return r({ intent: 'dayStatus' });
  if (ADD_SERVICE.test(t)) {
    // "añade el servicio lavado con masaje, 45 min, 20 €": what comes after "servicio" is its name
    const name = message.replace(/^.*?\b(servicio|tratamiento)\b( nuevo)?( que se llama| llamado)?\s*/i, '').split(/[,;:]|\s\d/)[0].trim().replace(/[.!?¿¡]+$/, '');
    return r({ intent: 'addService', name: name || null, duration: parseDuration(t), price: parsePrice(message) });
  }
  if (SERVICES_LIST.test(t)) return r({ intent: 'servicesList', category: understand(message, { today, services: catalog }).category });
  if (WAITLIST.test(t)) return r({ intent: 'waitlist' });
  if (HOURS_QUERY.test(t)) return r({ intent: 'hours' });

  const service = parseService(t, catalog);
  const price = parsePrice(message);
  const duration = parseDuration(t);

  // appointments: cancel, move, book by hand
  if (CANCEL_V.test(t) && APPT_REF.test(t)) {
    return r({ intent: 'cancelAppointment', name: parseName(message, catalog), date: date && iso(date), time: detectTime(t) });
  }
  if (MOVE_V.test(t) && (APPT_REF.test(t) || /\b(a|la cita de) [a-z]+ (del?|a|al|para)\b/.test(t)) && !(service && price != null)) {
    const { old, next } = splitMove(t);
    const oldDate = detectDate(old, today);
    const newDate = next && detectDate(next, today);
    return r({
      intent: 'moveAppointment', name: parseName(message, catalog), date: oldDate && iso(oldDate), time: detectTime(old),
      newDate: newDate ? iso(newDate) : null, newTime: next ? detectTime(next) : null,
    });
  }
  if (BOOK_V.test(t)) {
    return r({ intent: 'bookManual', name: parseName(message, catalog, { afterVerb: true }), date: date && iso(date), time: detectTime(t), serviceId: service });
  }

  // the catalog: prices, durations, services on and off
  if (service) {
    const asking = /\?/.test(message) || /^(cuanto|a cuanto|que precio|cual es el precio|precio)\b/.test(t);
    // "lavado + secado a mano, ¿ese servicio está?": each service named, with its duration and price
    if (asking && EXISTS.test(t) && !QUESTION.test(t)) {
      return r({ intent: 'serviceInfo', serviceId: service, serviceIds: detectServices(t, catalog).filter(s => s.id !== 'LAST').map(s => s.id) });
    }
    if (DURATION_V.test(t) && duration && !asking) return r({ intent: 'setDuration', serviceId: service, duration });
    if (DURATION_V.test(t) && (asking || !duration) && /\b(cuanto|cuantos|que)\b/.test(t)) return r({ intent: 'getDuration', serviceId: service });
    // "queratina 4h", "la queratina son 4 horas", "ponle 3 horas a la queratina"
    if (duration && price == null && !asking && !date) return r({ intent: 'setDuration', serviceId: service, duration });
    if (price != null && !asking) return r({ intent: 'setPrice', serviceId: service, price });
    if (QUESTION.test(t) && price == null) return r({ intent: 'getPrice', serviceId: service });
    if (ENABLE.test(t)) return r({ intent: 'enableService', serviceId: service });
    if (DISABLE.test(t)) return r({ intent: 'disableService', serviceId: service });
    // just the service ("queratina", "la manicura?"): its duration and price
    if (!date && t.split(' ').length <= 4 && !CLOSE_V.test(t) && !OPEN_V.test(t)) return r({ intent: 'serviceInfo', serviceId: service });
  }

  // closures and opening hours
  const closing = CLOSE_V.test(t) || /\bno abro\b/.test(t);
  const range = (closing || /\b(fuera|me voy)\b/.test(t)) && parseRange(t, today);
  if (range) {
    const reason = /\bvacaciones\b/.test(t) ? 'vacaciones' : t.match(/\bpor (reformas|obras|formacion|un curso|una boda|baja|enfermedad|mudanza)\b/)?.[1] ?? 'vacaciones';
    return r({ intent: 'closeRange', ...range, reason });
  }
  const hours = parseHours(t);
  if (WEEKLY.test(t) && (closing || OPEN_V.test(t) || hours || /\bhorario\b/.test(t))) {
    const days = parseWeekdays(t);
    if (days.length) {
      const closedAllDay = !hours && /\b(no abro|no abrimos|no trabajo|no trabajamos|cerrado|cerrada|libres?|descanso)\b|\bcierro$/.test(t);
      return r({ intent: 'setWeeklyHours', days, ...(closedAllDay ? { closed: true } : hours ?? {}) });
    }
  }
  if (date && hours) return r({ intent: 'setDayHours', date: iso(date), ...hours });
  if (date && /\b(no abro|no abrimos|no trabajo|no trabajamos)\b/.test(t)) return r({ intent: 'closeDate', date: iso(date) });
  if (date && OPEN_V.test(t)) return r({ intent: 'openDate', date: iso(date) });
  if (date && closing) return r({ intent: 'closeDate', date: iso(date), reason: /\bfestivo|fiesta\b/.test(t) ? 'festivo' : null });

  if (AGENDA.test(t)) return r({ intent: 'agenda', ...agendaRange(t, today) });

  // bare pieces: a follow-up ("¿y mañana?") or the answer to a question the bot asked
  // small talk, read like the customer bot reads it
  if (PRESENCE.test(t)) return r({ intent: 'presence' });
  if (BYE.test(t)) return r({ intent: 'bye' });
  const customer = understand(message, { today, services: catalog });
  if (customer.intent === 'greeting') return r({ intent: HOW_ARE_YOU.test(t) ? 'howAreYou' : 'greeting' });
  if (customer.intent === 'thanks') return r({ intent: 'thanks' });

  const number = t.match(/^(?:el |la |numero |opcion )?(\d{1,2})$/);
  return r({
    intent: null, number: number ? +number[1] : null, date: date && iso(date), time: detectTime(t), serviceId: service, price, duration,
    name: parseName(message, catalog, { afterVerb: false }),
  });
}

module.exports = { understandOwner, parseHours, parsePrice, parseDuration, parseRange, parseName };
