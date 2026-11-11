// understand-owner.js — Understands what the salon owner writes in owner mode ("el jueves cierro",
// "sube el tinte a 38", "¿qué tengo hoy?"). Pure: no store, no clock (today comes in as an option).
//
// Dates, times, services and the text normalization are the customer ones (src/understand.js), so
// "el jueves", "a las 5" or "mechas" mean the same thing for the owner as for her customers.
//
//   understandOwner(message, { today, catalog }) → { intent, ...fields }
//
// intent: notSupported (with `topic`: campaign, broadcast, reminder… — said clearly, nothing is changed)
//         | stats | customerInfo | cancellations | changesHistory | renameBusiness | sendMessage | wait
//         | renameService | setCategory | setDescription | bulkPrice | restorePrice | blockTime | restoreHours
//         | changeAppointmentService
//         | greeting | howAreYou | presence | thanks | bye | dayStatus | revenue | feedback | servicesList | addService
//         | agenda | inbox | inboxMore | ignore | replyChoice | teachChoice | learnedAnswers | forgetAnswer
//         | waitlist | hours | serviceInfo | getPrice | getDuration | setPrice | setDuration
//         | disableService | enableService | closeDate | closeRange | openDate | setDayHours | setWeeklyHours
//         | bookManual | cancelAppointment | moveAppointment | help | yes | no | undo | logout | null
// A bare number ("2") comes as intent null with `number`: its meaning depends on what the bot just showed.
const {
  understand, normalize, basicNormalize, WEEKDAYS, MONTHS, NUMBER_WORDS, detectDate, detectTime, detectTimeOfDay, detectServices,
} = require('../understand');

const MONTH_RE = MONTHS.join('|');
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const hhmm = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

// ---- short answers and commands (the whole message) ----
const YES = /^(si|vale|ok|okey|confirmo|confirmado|adelante|hazlo|dale|perfecto|correcto|de acuerdo|claro|venga|eso)( (si|vale|por favor|gracias|hazlo|adelante|claro|perfecto|dejalo asi|guardalo|asi))*$|^((ya )?(puedes )?(guardarlo|guardalo|guardar)|dejalo asi|asi esta bien|ahora si)$/;
const NO = /^(no|nop|nope|mejor no|no gracias|dejalo|olvidalo|cancela|cancelalo|nada|para|espera|no no)( (gracias|mejor|lo dejamos|dejalo|olvidalo|espera))*$|^(cancela|cancelalo|olvida|olvidalo) todo\b/;
const WAIT = /\b(no hagas nada|estoy pensando|dame un (momento|segundo)|espera un (momento|segundo)|luego te digo|ahora te digo)\b/;
const LOGOUT = /^(logout|log out|salir|salgo|cerrar sesion|salir del modo (duena|dueno)|modo (clienta|cliente))$/;
const UNDO = /^(deshacer|deshaz|deshazlo|deshaz (eso|el ultimo cambio|lo ultimo)|undo|vuelve atras|anula (el )?ultimo cambio)$/;
const HELP = /^(ayuda|help|menu|ejemplos|que (puedo|se puede) (hacer|decir|pedir|preguntar|cambiar)( aqui)?|como funciona( esto)?)$/;

// ---- the inbox: "ver más", "ignora 1, 3 y 5", "ignora todos", and the options for one message ----
const MORE = /^(ver |dame |ensename |y )?(mas|mas mensajes|siguientes|los siguientes|otros|el resto|resto|sigue|seguir leyendo|sigue leyendo|continua|continuar)$|^(ver|leer|ensename|dame|lee|muestrame) (todos|todo|todas)( los mensajes)?$/;
const IGNORE = /^(ignora|ignorar|ignoralo|ignorala|ignoralos|ignoralas|borra|borrar|borralo|borralos|quita|quitar|quitalo|quitalos|elimina|eliminar|eliminalo|eliminalos|descarta|descartar|descartalo|archiva|archivar|archivalo)( (el|la|los|las|este|ese|esta|esa|estos|esos|mensajes?|numeros?|todos|todas|todo|de|del|y|e|\d+))*$/;
const IGNORE_SOME = /\b(borrar|ignorar|quitar|eliminar|descartar) (algunos|algunas|varios|varias|unos|unas)\b/;
const REPLY_CHOICE = /^(responder|responde|respondele|responderle|contestar|contesta|contestale|contestarle|escribirle|escribele)( (a la clienta|a ella|solo))?$/;
const TEACH_CHOICE = /^(ensenar|ensena|ensenale|aprender|aprende|responder y ensenar|contestar y ensenar|responder y aprender|las dos|ambas|las dos cosas|responder y que (el bot )?lo (conteste|responda) solo( la proxima vez)?)$/;
const LEARNED = /\b(respuestas (aprendidas|guardadas|ensenadas)|que (respuestas )?(has aprendido|te he ensenado|sabes contestar)|que has aprendido)\b/;
const FORGET = /^(olvida|olvidate de|borra|quita|elimina) (la )?(respuesta )?(aprendida |numero )?(\d{1,2})$/;

// ---- queries ----
const INBOX = /^(los |mis |ver |ver los |listar |lista de |leer )?mensajes$|\b(me ha escrito una clienta|no se que (contestar|contestarle|responder|responderle)|que le contesto|que me han (preguntado|escrito|dicho|pedido)|bandeja|mensajes (pendientes|sin (contestar|responder|leer))|preguntas (pendientes|sin contestar)|que (hay|tengo) (pendiente|sin contestar)|quien me ha escrito|pendientes de contestar)\b/;
const WAITLIST = /\b(lista de espera|quien (esta|hay) esperando|en espera)\b/;
const HOURS_QUERY = /^(el |mi |los )?horarios?$|\b(que horario tengo|cual es mi horario|mi horario|horario (actual|de ahora)|que dias (cierro|cerramos|tengo cerrado|abro|abrimos)|que cierres tengo|cuando (cierro|cerramos) por vacaciones)\b/;
const AGENDA = /\b(que citas tenemos|quien viene|agenda de)\b|^(y )?(del|este|el|todo el|de este) mes( que viene)?$|^(y )?(esta|la) semana( que viene)?$|^(el )?calendario$|^(la )?agenda$|\b(que tengo|tengo (citas|algo|gente|alguien|clientas?)|cuantas citas|cuantas clientas|citas (de|del|para|hoy|manana|esta|la|el)|agenda|quien viene|a quien tengo|que hay (hoy|manana|el|esta|la)|como (tengo|voy|va|esta) (el dia|la semana|la agenda|hoy|manana|el)|mis citas|las citas|que citas)\b|^(y )?(citas|hoy|manana)$/;
// "me he equivocado", "lo he ignorado sin querer", "me habías dicho que había 44": offer to undo the last change
const OOPS = /\b(sin querer|me he equivocado|me equivoque|me he colado|no queria|no era eso|me habias dicho|la he liado|recuperalos|recuperalo)\b/;
// all upcoming appointments ("todas las citas", "citas totales")
const ALL_UPCOMING = /\b(todas las citas|todas mis citas|citas totales|todas las proximas|proximas citas)\b|^todas las\b/;
// a service group named on its own ("manos y pies", "tratamientos capilares")
const GROUP_ONLY = /^(los |las )?(servicios de |tratamientos de )?(peluqueria|color|coloracion|tratamientos capilares|tratamientos|barberia|facial|faciales|estetica facial|corporal|estetica corporal|depilacion|depilaciones|manos y pies|unas|manicura y pedicura|cejas y pestanas|pestanas y cejas|cejas|pestanas|estetica)$/;
const CUSTOMERS_LIST = /^(mis |las |lista de |ver |listar )?(clientas|clientes)$|\b(que clientas tengo|lista de clientas)\b/;
const STATS = /\b(cuantas clientas|cuantos clientes|numero de clientas|clientas (registradas|en total)|cuantas citas hemos tenido|mas se reservan|mas reservad\w*|mas pedid\w*|estadisticas|resumen de la actividad|actividad del negocio|como va el negocio)\b/;
const CHANGES_HISTORY = /\b(lo que hemos cambiado|que (he|hemos) cambiado|cambios (de esta|que he|que hemos|recientes)|historial de cambios|ultimos cambios)\b/;
const RENAME_BUSINESS = /\bnombre (del|de la|de mi) (salon|peluqueria|negocio|centro|local)\b/;
const CUSTOMER_INFO = /\b(busca|buscame|telefono de|numero de telefono|movil de|cuando vino|ultima vez|ficha de|datos de|informacion de)\b/;
const CANCELLATIONS = /\b(cancelacion|cancelaciones|ha cancelado|han cancelado|ha anulado|han anulado|anulaciones)\b/;
const FREE = /\b(huecos?|hueco libre|huecos libres|tengo libre|queda libre|quedan libres|cuando no tengo (citas|nada)|cuando estoy libre)\b/;
// the catalog as a list ("¿qué servicios de uñas tenemos?", "¿cuál es el más caro?")
const LIST_NOUN = /\b(servicios?|catalogo|tratamientos|precios|tarifas|carta|tipos de corte)\b|\bpor todo\b/;
const LIST_ASK = /\b(que|cuales?|lista|listame|ensename|muestrame|dime|ver|resumen|revisar|hay|ofrecemos|ofrezco|tenemos|tengo|hacemos|todos|todas|completo|cuanto)\b/;
const CHANGE_WORDS = /\b(anade|anadir|crea|crear|cambia|cambiar|sube|subir|baja|bajar|pon|desactiva|activa|quita|quitar|elimina|borra|renombra|incorporar|ofrecer)\b/;
const ADD_VERB = /\b(anade|anadir|anademe|agrega|agregar|crea|crear|creame|incorpora|incorporar|vamos a ofrecer|quiero ofrecer|empezamos a ofrecer|vamos a empezar a hacer|empezar a hacer|pon tambien)\b/;
const RENAME_SERVICE = /\b(cambia|cambiar|cambiale|pon|ponle|renombra|renombrar)\b.*\bnombre\b|^cambia .+ por .+$/;
const SET_CATEGORY = /\b(pon|ponlo|ponla|mueve|muevelo|pasa|pasalo|cambia|mete|metelo)\b.*\b(en|dentro de|a)( la categoria( de)?| el grupo( de)?| la seccion( de)?)? (tratamientos|estetica facial|estetica corporal|facial|corporal|peluqueria|color|barberia|depilacion|unas|manicura|cejas|pestanas|otros)\b/;
const BULK_PRICE = /\btodos los (servicios|precios|tratamientos)\b|\b\d+ ?(%|por ciento)/;
const RAISE = /\b(sube|subele|subir|suban|incrementa|aumenta)\b/;
const LOWER = /\b(baja|bajale|bajar|bajen|rebaja)\b/;
const RESTORE_PRICE = /\b(precio (que tenia|de antes|anterior)|como estaba antes|al precio de antes)\b/;
const BLOCK = /\b(bloquea|bloquear|bloqueame|no permitas reservas|no aceptes (citas|reservas)|no quiero (citas|reservas))\b/;
const RESTORE_HOURS = /\b(horario (habitual|normal|de siempre)|desbloquea|desbloquear|quita el bloqueo)\b/;
const SEND_ONE = /\b(manda|mandale|mandar|envia|enviale|enviar|escribe|escribele|escribir|dile|decirle)\b/;

// Things owner mode can't do yet. Said clearly (and nothing is changed) instead of "no te he entendido".
// Checked before anything else reads dates or services: "recuérdame mañana…" is not the agenda.
const NOT_SUPPORTED = [
  ['botConfig', /\b(mensajes automaticos|automaticamente|reservas automaticas|respuestas automaticas|deje de aceptar|no contestes|deja de contestar)\b/],
  ['notifications', /\b(avisame|me avise|avise|aviso automatico|alerta|notificame)\b.*\bcuando\b/],
  ['customerReminders', /\brecordatorios?\b.*\b(clientas?|citas?|antes|domingos|salgan|horas)\b|\b(el bot )?recuerde las citas\b/],
  ['reminder', /\b(recuerdame|recordarme|acuerdame|recordatorios?|avisame)\b/],
  ['campaign', /\bcampanas?\b/],
  ['broadcast', /\b(difusion|difusiones|promocion|promociones|envios)\b/],
  ['offer', /\b(oferta|ofertas|descuento|descuentos)\b/],
  ['writing', /\b(redacta|redactame|redactar|escribe algo|texto (corto|para)|prepara (un|el) mensaje|mensaje (bonito|cercano)|no parezca publicidad|felicitar)\b/],
  ['content', /\b(cartel|carteles|instagram|publicacion|post|redes sociales|facebook|tiktok|flyer)\b/],
  ['external', /\b(que tiempo|el tiempo (que|va)|va a llover|cuantos dias faltan|noticias|futbol|loteria)\b/],
  ['chat', /\b(chiste|chistes|cuentame algo|cantame|poema|adivinanza)\b/],
  ['advice', /\b(ideas|que me recomiendas|recomiendame|consejos?)\b/],
  ['lists', /\b(lista de (la compra|cosas|compras)|hazme una lista|cosas que (tengo que )?comprar)\b/],
  ['backup', /\b(copia de seguridad|backup|exporta|exportar)\b/],
  ['history', /\b(mensajes (ha|has) enviado|que ha (dicho|enviado|contestado) el bot)\b/],
  ['confirmations', /\b(no han confirmado|sin confirmar)\b/],
  ['seasonalHours', /\bhorario de (verano|invierno|navidad|navidades)\b/],
];
// several customers at once: "avisa a mis clientas", "manda un mensaje a todas las que…" (needs consent and templates)
const AUDIENCE = /\b(todas|todos|las clientas|mis clientas|los clientes|clientes habituales|las que|los que|a quien|las personas|habituales)\b/;
const SEND_MANY = /\b(manda|mandar|mandales|envia|enviar|enviales|escribe|escribir|escribeles|avisar|avisa|avisales|mensaje)\b/;
function notSupportedTopic(t, message) {
  if (/^\s*apunta\s*:/i.test(message)) return 'lists';
  for (const [topic, re] of NOT_SUPPORTED) {
    if (topic === 'offer' && SEND_MANY.test(t) && AUDIENCE.test(t)) return 'broadcast';
    if (re.test(t)) return topic;
  }
  if (SEND_MANY.test(t) && AUDIENCE.test(t)) return 'broadcast';
  return null;
}

const QUESTION = /\b(cuanto|cuantos|a cuanto|que precio|precio|cuesta|vale|valen|cobro|cobramos|dura|tarda)\b/;

// ---- the day, money, small talk (greetings and thanks come from the customer bot: understand.js) ----
// "¿qué tal ha ido el día?", "¿cómo va el día?", "resumen de hoy" (not "¿cómo va la semana?": that is the agenda)
const DAY_STATUS = /\b((que tal|como) (ha ido|ha sido|va|te ha ido|me ha ido|esta yendo|llevo|llevamos|vamos|voy)( el dia| hoy| la manana| la tarde| la jornada)?|que tal (el dia|hoy|la manana|la tarde|la jornada)|resumen( del dia| de hoy)?|como va todo|cuanto tiempo llevo( abiert[oa]| trabajando)?)\b/;
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
const CANCEL_V = /\b(cancela|cancelar|cancelame|cancelale|anula|anular|anulale|borra|borrar|borrale|elimina|eliminar|quita|quitale)\b/;
const MOVE_V = /\b(mueve|muevela|muevele|mover|cambia|cambiala|cambiale|cambiar|pasa|pasala|pasale|pasar|retrasa|retrasala|adelanta|adelantala)\b/;
const APPT_REF = /\b(cita|citas|la de|la del|la que|el de las|la de las|la hora de)\b/;
const BOOK_V = /^(quiero |puedes |me )?(apunta|apuntame|apuntale|apuntar|anota|anotame|anotale|anotar|reserva|reservale|reservar|mete|metele|agendale|ponle (una )?cita|pon (una )?cita|pon a|ponme a|cita para|nueva cita|anade a|anademe a|anade una cita|anadir a|anadir una cita)\b/;
const DISABLE = /\b(ya no (lo |la |los |las )?(hago|hacemos|ofrezco|ofrecemos|hare|vamos a hacer)|(ya )?no se ofrece|no (hago|hacemos|ofrezco) mas|deja de (ofrecer|salir)|dejo de (hacer|ofrecer)|desactiva|quita|quitar|elimina|borra)\b/;
const ENABLE = /\b(vuelvo a (hacer|ofrecer)|volvemos a (hacer|ofrecer)|ya (hago|hacemos|ofrezco) otra vez|otra vez (hago|hacemos|ofrezco)|activa|reactiva|vuelve a (estar|salir)|recupera)\b/;
const DURATION_V = /\b(dura|duran|duracion|tarda|tardo|tardamos|tardan)\b/;
const CLOSE_V = /\b(cierro|cerramos|cerraremos|cerrar|cerrado|cerrada|cierra|no abro|no abrimos|no abriremos|no (vamos|voy) a abrir|no trabajo|no trabajamos|no (puedo|voy a) trabajar|libre|festivo|fiesta|vacaciones|no vengo|no estoy)\b/;
const OPEN_V = /\b(abro|abrimos|abriremos|abrire|abrir|abierto|abierta|abre|trabajo|trabajamos)\b/;
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
  const open = t.match(new RegExp(`\\b(?:abro|abrimos|abriremos|abrire|abre|empiezo|empezamos|entro) (?:a las |a la |sobre las |desde las )?${CLOCK}\\b`));
  const close = t.match(new RegExp(`\\b(?:cierro|cerramos|cerraremos|cerrare|cierra|termino|acabo|salgo) (?:a las |a la |sobre las )?${CLOCK}\\b`));
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
  'senora', 'senor', 'clienta', 'cliente', 'nueva', 'nuevo', 'hermana', 'madre', 'hija', 'amiga', 'vez', 'favor',
  'todas', 'todos', 'whatsapp', ...WEEKDAYS, ...MONTHS,
]);
const isNameWord = (word, catalogWords) => {
  const w = normalize(word);
  return w && /^[a-z]+$/.test(w) && !NOT_A_NAME.has(w) && !catalogWords.has(w) && !NUMBER_WORDS[w];
};
const capital = s => s.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

// The customer's name: "apunta a Lucía…", "la cita de Ana del jueves", "a nombre de Marta López"
function parseName(message, catalog, { afterVerb = false, anyCapital = false } = {}) {
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
    let i = ['quiero', 'puedes', 'me'].includes(lower[0]) ? 2 : 1;
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
  if (anyCapital) {
    for (let i = 1; i < words.length; i++) if (/^[A-ZÁÉÍÓÚÑ]/.test(words[i])) { const n = take(i); if (n) return n; }
  }
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

// "estética" covers several catalog groups; anything else is a customer-bot category ("uñas", "color"…)
function categoryOf(message, t, today, catalog) {
  const c = understand(message, { today, services: catalog }).category;
  if (c) return c;
  if (/\bestetica facial\b/.test(t)) return 'estetica_facial';
  if (/\bestetica\b/.test(t)) return 'estetica';
  if (/\btratamientos\b/.test(t)) return 'tratamientos_capilares';
  return null;
}

// The name of a new service: "añade el servicio de alisado de keratina" → "alisado de keratina"
function newServiceName(message) {
  const m = message.match(/(añad\w*|anad\w*|agreg\w*|cre[ae]\w*|incorpor\w*|ofrecer|empezar a hacer|pon también|pon tambien|nuevo servicio|servicio nuevo)\s*/i);
  if (!m) return null;
  const rest = message.slice(m.index + m[0].length)
    .replace(/^(también\s+|tambien\s+)?((el|la|los|las|un|una|otro|otra)\s+)?((nuevo|nueva)\s+)?(servicio\b\s*((nuevo|nueva)\b\s*)?)?((de|llamado|llamada|que se llam[ae])\s+)?/i, '');
  const name = rest.split(/[,;:]|\s\d/)[0].trim().replace(/[.!?¿¡]+$/, '');
  return name || null;
}

// Text in the raw message after a marker, keeping accents: "Cambia corte de pelo por corte de señora"
const after = (message, re) => { const m = message.match(re); return m ? message.slice(m.index + m[0].length).trim().replace(/[.!?¿¡]+$/, '') : null; };

function understandOwner(message, { today, catalog = [] } = {}) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new TypeError('understandOwner(): pass { today } as a valid Date');
  const t = normalize(message);
  // "hola, ¿qué tengo hoy?": the greeting is answered too (reply-owner puts "¡Hola!" before the answer)
  const base = { text: message, normalizedText: t, greeting: GREET_START.test(t) };
  const r = fields => ({ ...base, ...fields });
  const date = detectDate(t, today);
  const asked = /\?/.test(message) || /^(que|cual|cuales|cuando|cuanto|cuantos|cuantas|a que hora|donde|dime si|ensename|muestrame)\b/.test(t);

  // 1. short commands
  if (LOGOUT.test(t)) return r({ intent: 'logout', asCustomer: /\bclient/.test(t) });
  if (UNDO.test(t)) return r({ intent: 'undo' });
  if (HELP.test(t) || /\b(que puedo hacer|que se puede hacer)\b/.test(t)) return r({ intent: 'help' });
  if (YES.test(t)) return r({ intent: 'yes' });
  if (NO.test(t)) return r({ intent: 'no' });
  if (WAIT.test(t)) return r({ intent: 'wait' });
  // a pasted list (bullets, several times): never an order
  if (/[•·]/.test(message) || (message.match(/\b\d{1,2}:\d{2}\b/g)?.length ?? 0) >= 3) return r({ intent: 'pasted' });
  if (OOPS.test(t)) return r({ intent: 'oops' });
  if (/^(resume|resumeme|resumen|hazme un resumen)$/.test(t)) return r({ intent: 'dayStatus' });
  if (/^(cancelar|cancelar citas?|cancelar una cita|anular citas?|borrar citas?)$/.test(t)) return r({ intent: 'cancelAppointment', name: null, date: null, time: null, all: false });

  // 2. the inbox
  if (MORE.test(t)) return r({ intent: 'inboxMore', all: /\b(todos|todo|todas)\b/.test(t) });
  if (FORGET.test(t) && /\b(olvida|respuesta)/.test(t)) return r({ intent: 'forgetAnswer', number: +t.match(FORGET)[5] });
  if (IGNORE.test(t)) {
    return r({ intent: 'ignore', numbers: [...t.matchAll(/\d+/g)].map(m => +m[0]), all: /\b(todos|todas|todo)\b/.test(t), shown: /\b(estos|esos|estas|esas)\b/.test(t) });
  }
  if (IGNORE_SOME.test(t)) return r({ intent: 'ignore', numbers: [], all: false, ask: true });
  if (REPLY_CHOICE.test(t)) return r({ intent: 'replyChoice' });
  if (TEACH_CHOICE.test(t)) return r({ intent: 'teachChoice' });
  if (LEARNED.test(t)) return r({ intent: 'learnedAnswers' });
  if (INBOX.test(t)) return r({ intent: 'inbox' });

  if (CUSTOMERS_LIST.test(t)) return r({ intent: 'customersList' });
  if (GROUP_ONLY.test(t)) return r({ intent: 'servicesList', category: categoryOf(message, t, today, catalog) });
  if (/^(listamelos|listalos|ensenamelos|dimelos|muestramelos|ponlos)( todos)?$|^(todos los servicios|lista completa|el catalogo entero)$/.test(t)) return r({ intent: 'servicesList', all: true });
  // "el 600 000 000 es María", "ponle nombre María al 600000000"
  const NAME = '([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)';
  let named = message.match(new RegExp(`(\\+?\\d[\\d ]{7,}\\d)\\s*(?:es|se llama)\\s+${NAME}`));
  if (!named) {
    const m2 = message.match(new RegExp(`ponle (?:de )?nombre\\s+${NAME}\\s+al?\\s+(\\+?\\d[\\d ]{7,}\\d)`, 'i'));
    if (m2) named = [m2[0], m2[2], m2[1]];
  }
  if (named) return r({ intent: 'nameCustomer', phone: named[1].replace(/\D/g, ''), name: capital(named[2].toLowerCase()) });

  // 3. what owner mode can't do yet
  const topic = notSupportedTopic(t, message);
  if (topic) return r({ intent: 'notSupported', topic });

  // 4. the business: feedback, stats, money, history, customers
  const range = /\bsemana\b/.test(t) ? 'week' : /\bmes\b/.test(t) ? 'month' : null;
  if (FEEDBACK.test(t)) return r({ intent: 'feedback' });
  if (DAY_STATUS.test(t) && (!date || iso(date) === iso(today)) && !/\b(semana|mes)\b/.test(t) && !LIST_NOUN.test(t)) return r({ intent: 'dayStatus' });
  if (STATS.test(t)) return r({ intent: 'stats', range });
  if (REVENUE.test(t)) return r({ intent: 'revenue', range });
  if (CHANGES_HISTORY.test(t)) return r({ intent: 'changesHistory' });
  if (/\bcomo (os llamais|nos llamamos|se llama (el salon|la peluqueria|mi negocio|el negocio))\b/.test(t)) return r({ intent: 'businessName' });
  if (RENAME_BUSINESS.test(t)) return r({ intent: 'renameBusiness', name: after(message, /\b(?:a|por)\s+(?=[A-ZÁÉÍÓÚÑ"«])/) });
  const name = parseName(message, catalog);
  if (CUSTOMER_INFO.test(t)) {
    // "busca a la clienta María García", "¿cuándo vino Laura?": any capitalized name
    const who = parseName(message.replace(/\b(a )?(la|el) client[ae]\b/i, ''), catalog, { anyCapital: true });
    if (who) return r({ intent: 'customerInfo', name: who });
  }
  if (CANCELLATIONS.test(t)) return r({ intent: 'cancellations', date: iso(date ?? today) });

  // 5. the catalog: lists, names, groups, descriptions, new services, prices for many
  const services = detectServices(t, catalog).filter(s => s.id !== 'LAST');
  const service = services[0]?.id ?? null;
  const price = parsePrice(message);
  const duration = parseDuration(t);
  const category = categoryOf(message, t, today, catalog);
  const sort = /\bmas (largos?|largo|tiempo)\b|\bduran mas\b/.test(t) ? 'duration' : /\bmas caros?\b/.test(t) ? 'priceDesc' : /\bmas baratos?\b/.test(t) ? 'priceAsc' : null;
  const status = /\b(desactivad\w*|inactiv\w*)\b/.test(t) ? 'inactive' : /\bactivos\b/.test(t) ? 'active' : null;
  const maxPrice = +(t.match(/\bmenos de (\d+)/)?.[1] ?? 0) || null;
  if (BULK_PRICE.test(t) && (RAISE.test(t) || LOWER.test(t) || /\b(cambia|cambiar)\b/.test(t))) {
    const percent = +(t.match(/\b(\d+) ?(%|por ciento)/)?.[1] ?? 0) || null;
    const sign = LOWER.test(t) ? -1 : 1;
    return r({ intent: 'bulkPrice', category, percent: percent && sign * percent, change: !percent && price != null ? sign * price : null });
  }
  if (LIST_NOUN.test(t) && LIST_ASK.test(t) && !CHANGE_WORDS.test(t) && !DISABLE.test(t) && !ENABLE.test(t) && (!service || category || sort || status || maxPrice)) {
    return r({ intent: 'servicesList', category, sort, status, maxPrice, withPrices: /\b(precios|tarifas|cobramos|cuanto|caro|caros|barato|baratos)\b/.test(t) || !!maxPrice });
  }
  if (SERVICES_LIST.test(t)) return r({ intent: 'servicesList', category, withPrices: /\bprecios\b/.test(t) });
  if (RENAME_SERVICE.test(t)) {
    const target = after(message, /\bnombre\s+(?:de\s+)?/i) ?? after(message, /^\s*cambia\s+/i) ?? '';
    const parts = target.split(/\s+por\s+|\s+a\s+(?!.*\s+a\s+)/i);
    const old = parts.length > 1 ? parts[0] : target;
    const id = detectServices(normalize(old), catalog).filter(x => x.id !== 'LAST')[0]?.id ?? null;
    return r({ intent: 'renameService', serviceId: id, name: parts.length > 1 ? parts.at(-1).toLowerCase() : null });
  }
  if (SET_CATEGORY.test(t)) {
    const where = t.slice(t.search(/\b(en|dentro de) /));
    return r({ intent: 'setCategory', serviceId: detectServices(t.slice(0, t.search(/\b(en|dentro de) /)), catalog)[0]?.id ?? null, category: categoryOf(where, where, today, catalog) });
  }
  if (/\bdescripcion\b/.test(t)) return r({ intent: 'setDescription', serviceId: service });
  if ((ADD_VERB.test(t) || ADD_SERVICE.test(t)) && !/\b(anade|anadir|anademe) (a|una cita)\b/.test(t) && !/\bcita\b/.test(t) && !detectTime(t)) {
    return r({ intent: 'addService', name: newServiceName(message), duration: parseDuration(t), price: parsePrice(message) });
  }
  if (RESTORE_PRICE.test(t)) return r({ intent: 'restorePrice', serviceId: service });
  if (WAITLIST.test(t)) return r({ intent: 'waitlist' });

  // 6. questions about opening hours ("¿abrimos los sábados?", "¿a qué hora cerramos hoy?")
  const weekdaysNamed = new RegExp(`\\blos (${WEEKDAYS.join('|')})s?\\b`).test(t) ? parseWeekdays(t) : [];
  if (HOURS_QUERY.test(t) || (asked && /\b(abr\w*|cerr\w*|horarios?|festivos?|dia libre|abiert[oa]s?|empezamos)\b/.test(t) && !/\b(cambia|cambiar|pon|quiero)\b/.test(t) && !FREE.test(t))) {
    return r({ intent: 'hours', ...(weekdaysNamed.length ? { days: weekdaysNamed } : date ? { date: iso(date) } : {}) });
  }

  // 7. appointments and messages to one customer
  if (SEND_ONE.test(t) && name && !RENAME_SERVICE.test(t)) {
    const content = after(message, /\b(?:dile|decirle|recordarle|avisarle|mándale|mandale)\s+(?:a\s+\S+\s+)?que\s+/i) ?? after(message, /\b(?:y\s+)?dile\s+que\s+/i);
    return r({ intent: 'sendMessage', name, content, reminder: /\brecordar/.test(t) });
  }
  if (/\b(la cita de|la de) [a-z]+ es (para|de)\b/.test(t)) {
    const what = t.match(/\bes (?:para|de) (.+?)(?:,| no |$)/)?.[1] ?? '';
    return r({ intent: 'changeAppointmentService', name, serviceId: detectServices(what, catalog).filter(x => x.id !== 'LAST')[0]?.id ?? null });
  }
  if (CANCEL_V.test(t) && APPT_REF.test(t)) {
    return r({ intent: 'cancelAppointment', name, date: date && iso(date), time: detectTime(t), all: /\btodas\b|\blas citas (de|del)\b/.test(t) });
  }
  if (MOVE_V.test(t) && (APPT_REF.test(t) || /\b(a|la cita de) [a-z]+ (del?|a|al|para)\b/.test(t)) && !(service && price != null)) {
    const { old, next } = splitMove(t);
    const oldDate = detectDate(old, today);
    const newDate = next && detectDate(next, today);
    return r({
      intent: 'moveAppointment', name, date: oldDate && iso(oldDate), time: detectTime(old),
      newDate: newDate ? iso(newDate) : null, newTime: next ? detectTime(next) : null,
    });
  }
  if (BOOK_V.test(t) && !/^apunta(me)? que\b/.test(t)) {
    return r({ intent: 'bookManual', name: parseName(message, catalog, { afterVerb: true }), date: date && iso(date), time: detectTime(t), serviceId: service, timeOfDay: detectTimeOfDay(t) });
  }

  // 8. one service: price, duration, on and off
  const agendaLike = /\bcitas?\b/.test(t) && (AGENDA.test(t) || /\btengo (alguna|algun|una) cita\b/.test(t));
  if (/\btodos los servicios de\b/.test(t) && DISABLE.test(t)) return r({ intent: 'disableService', category });
  if (service && !agendaLike) {
    const asking = /\?/.test(message) || /^(cuanto|a cuanto|que precio|cual es el precio|precio)\b/.test(t);
    if (asking && EXISTS.test(t) && !QUESTION.test(t)) return r({ intent: 'serviceInfo', serviceId: service, serviceIds: services.map(x => x.id) });
    if (DURATION_V.test(t) && duration && !asking) return r({ intent: 'setDuration', serviceId: service, duration });
    if (DURATION_V.test(t) && !duration && /\b(cambia|cambiar|modifica|pon|ponle)\b/.test(t)) return r({ intent: 'setDuration', serviceId: service, duration: null });
    if (DURATION_V.test(t) && (asking || !duration) && /\b(cuanto|cuantos|que)\b/.test(t)) return r({ intent: 'getDuration', serviceId: service });
    // "queratina 4h", "la queratina son 4 horas", "ponle 3 horas a la queratina"
    if (duration && price == null && !asking && !date) return r({ intent: 'setDuration', serviceId: service, duration });
    // "quiero subir el precio del corte", "cambia el precio de las mechas": ask how much
    if (price == null && !asking && (RAISE.test(t) || LOWER.test(t) || /\b(cambia|cambiar|modifica|actualiza)\b.*\bprecio\b/.test(t))) return r({ intent: 'setPrice', serviceId: service, price: null });
    if (price != null && !asking) {
      // "sube el corte 2 euros" (by how much) vs "sube el tinte a 38" (to how much)
      const relative = (RAISE.test(t) || LOWER.test(t)) && !/\b(a|en) \d/.test(basicNormalize(message));
      return relative ? r({ intent: 'setPrice', serviceId: service, change: (LOWER.test(t) ? -1 : 1) * price }) : r({ intent: 'setPrice', serviceId: service, price });
    }
    if (/\b(precio|cuesta|cobro|cobramos|vale)\b.*\b(mal|equivocado|raro)\b/.test(t)) return r({ intent: 'getPrice', serviceId: service });
    if (QUESTION.test(t) && price == null) return r({ intent: 'getPrice', serviceId: service, ...(services.length > 1 ? { serviceIds: services.map(x => x.id) } : {}) });
    if (ENABLE.test(t)) return r({ intent: 'enableService', serviceId: service });
    if (DISABLE.test(t)) return r({ intent: 'disableService', serviceId: service });
    // just the service ("queratina", "la manicura?"): its duration and price
    if (!date && t.split(' ').length <= 4 && !CLOSE_V.test(t) && !OPEN_V.test(t)) return r({ intent: 'serviceInfo', serviceId: service });
  }
  if (DISABLE.test(t) && /\bservicio\b/.test(t)) return r({ intent: 'disableService', serviceId: null });
  if (QUESTION.test(t) && /\b(cobramos|cobro|cuesta|precio)\b/.test(t) && price == null) return r({ intent: 'getPrice', serviceId: null });

  // 9. free time, blocks, closures and opening hours
  const timeOfDay = /\btoda la manana\b/.test(t) ? 'morning' : /\btoda la tarde\b/.test(t) ? 'afternoon' : detectTimeOfDay(t);
  const hours = parseHours(t);
  if (FREE.test(t) && !BLOCK.test(t)) {
    // "huecos libres", "dame los próximos huecos": the next days if no day was said
    const when = date || /\b(semana|mes)\b/.test(t) ? agendaRange(t, today) : { from: iso(today), to: iso(addDays(today, 6)), range: 'next' };
    return r({ intent: 'agenda', ...when, timeOfDay, free: true });
  }
  if (BLOCK.test(t)) {
    return r({ intent: 'blockTime', date: iso(date ?? today), from: hours?.intervals?.[0]?.[0] ?? null, to: hours?.intervals?.[0]?.[1] ?? null, timeOfDay: hours ? null : timeOfDay });
  }
  if (RESTORE_HOURS.test(t)) return r({ intent: 'restoreHours', date: date ? iso(date) : null });
  const closing = CLOSE_V.test(t) || /\bno abro\b/.test(t);
  const span = (closing || /\b(fuera|me voy)\b/.test(t)) && parseRange(t, today);
  if (span) {
    const reason = /\bvacaciones\b/.test(t) ? 'vacaciones' : t.match(/\bpor (reformas|obras|formacion|un curso|una boda|baja|enfermedad|mudanza)\b/)?.[1] ?? 'vacaciones';
    return r({ intent: 'closeRange', ...span, reason });
  }
  if (WEEKLY.test(t) && (closing || OPEN_V.test(t) || hours || /\bhorario\b/.test(t))) {
    const days = parseWeekdays(t);
    if (days.length) {
      const closedAllDay = !hours && /\b(no abro|no abrimos|no trabajo|no trabajamos|cerrado|cerrada|cerrar|libres?|descanso)\b|\bcierro$/.test(t);
      const part = !hours && !closedAllDay && OPEN_V.test(t) && timeOfDay ? { part: timeOfDay } : {};
      return r({ intent: 'setWeeklyHours', days, ...(closedAllDay ? { closed: true } : hours ?? {}), ...part });
    }
  }
  if (date && /\b(retrasa|retrasar|adelanta|adelantar)\b/.test(t) && /\b(apertura|abrir|abro|cierre|cerrar)\b/.test(t)) {
    const minutes = (duration ?? 30) * (/\badelant/.test(t) ? -1 : 1);
    return r({ intent: 'setDayHours', date: iso(date), ...(/\b(cierre|cerrar)\b/.test(t) ? { closesShift: minutes } : { opensShift: minutes }) });
  }
  if (date && hours) return r({ intent: 'setDayHours', date: iso(date), ...hours });
  // "el viernes 27 abrimos solo por la mañana", "mañana cierro por la tarde", "el miércoles cerramos al mediodía"
  if (date && timeOfDay && (closing || (OPEN_V.test(t) && /\bsolo\b/.test(t)))) {
    const part = closing ? (timeOfDay === 'morning' ? 'afternoon' : 'morning') : timeOfDay;
    return r({ intent: 'setDayHours', date: iso(date), part });
  }
  if (date && /\b(cambia|cambiar|modifica)\b.*\bhorario\b/.test(t)) return r({ intent: 'setDayHours', date: iso(date) });
  if (date && /\b(no abro|no abrimos|no abriremos|no (vamos|voy) a abrir|no trabajo|no trabajamos|no (puedo|voy a) trabajar)\b/.test(t)) return r({ intent: 'closeDate', date: iso(date) });
  if (date && OPEN_V.test(t)) return r({ intent: 'openDate', date: iso(date) });
  if (date && closing) return r({ intent: 'closeDate', date: iso(date), reason: /\bfestivo|fiesta\b/.test(t) ? 'festivo' : null });

  // 10. the agenda, with filters
  if (ALL_UPCOMING.test(t)) return r({ intent: 'agenda', from: iso(today), to: iso(addDays(today, 60)), range: 'upcoming' });
  if (AGENDA.test(t) || /\b(que tenemos|primeras citas|tengo (alguna|algun|una) cita|organizame la agenda|que tengo que hacer)\b/.test(t)) {
    const fromTime = /\ba partir de las\b/.test(t) ? detectTime(t.replace(/\ba partir de las\b/, 'a las')) : null;
    return r({ intent: 'agenda', ...agendaRange(t, today), timeOfDay, fromTime, time: fromTime ? null : detectTime(t), serviceId: service });
  }

  // 11. small talk, read like the customer bot reads it; bare pieces (a follow-up, an answer)
  if (PRESENCE.test(t)) return r({ intent: 'presence' });
  if (BYE.test(t)) return r({ intent: 'bye' });
  const customer = understand(message, { today, services: catalog });
  if (customer.intent === 'greeting') return r({ intent: HOW_ARE_YOU.test(t) ? 'howAreYou' : 'greeting' });
  if (customer.intent === 'thanks') return r({ intent: 'thanks' });

  const number = t.match(/^(?:el |la |numero |opcion )?(\d{1,2})$/);
  return r({
    intent: null, number: number ? +number[1] : null, date: date && iso(date), time: detectTime(t), serviceId: service, price, duration,
    name: parseName(message, catalog, { afterVerb: false }), timeOfDay, category,
    closed: /^(cerrado|cerrada|cierro|cerramos|cerrado todo el dia)$/.test(t),
    // a price only if she says it is one: "mejor 15 euros", "ponlo a 15" (never a bare "3")
    price: /€|\beuros?\b|\b(ponlo|ponla|mejor|precio|a) \d/.test(basicNormalize(message)) ? price : null,
  });
}

module.exports = { understandOwner, parseHours, parsePrice, parseDuration, parseRange, parseName, newServiceName };
