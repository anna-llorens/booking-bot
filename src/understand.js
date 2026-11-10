// understand.js — Understands customer messages without AI (rules + dictionaries).
// Returns what the customer wants (intent), which service, which day, time of day and time,
// and which data is still missing before the bot can propose slots.
//
// Customers write in Spanish, so every dictionary and regex below matches Spanish text
// (already lowercased and without accents, see normalize()).

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUMBER_WORDS = { una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
const ORDINALS = { primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, ultima: -1 };

// Common WhatsApp abbreviations and misspellings -> correct word.
// Extend this list with whatever shows up in messages that were not understood.
const REPLACEMENTS = {
  q: 'que', k: 'que', xq: 'porque', x: 'por', xa: 'para', pa: 'para', tb: 'tambien',
  xfa: 'por favor', porfa: 'por favor', pf: 'por favor',
  mnn: 'manana', mna: 'manana', mñn: 'manana',
  lun: 'lunes', mier: 'miercoles', mierc: 'miercoles', jue: 'jueves', juev: 'jueves',
  vier: 'viernes', vie: 'viernes', sab: 'sabado', dom: 'domingo', finde: 'fin de semana',
  bienes: 'viernes', juebes: 'jueves', jeves: 'jueves', savado: 'sabado', sabdo: 'sabado',
  miercole: 'miercoles', lune: 'lunes',
  cits: 'cita', cta: 'cita', zita: 'cita', alisaso: 'alisado',
  ueco: 'hueco', guecos: 'huecos', kiero: 'quiero', kieres: 'quieres', aora: 'ahora',
  ago: 'hago', aser: 'hacer', cortame: 'cortarme', peindo: 'peinado', ola: 'hola',
  dema: 'manana', // Catalan "demà" (tomorrow)
  hol: 'hola', oli: 'hola', macota: 'mascota', mascotas: 'mascota', perrito: 'perro',
  psible: 'posible', posbile: 'posible', okk: 'ok', okkk: 'ok',
  holita: 'hola', holi: 'hola', holis: 'hola', holiwi: 'hola', wenas: 'buenas', wenos: 'buenos',
  huekito: 'huequito', hueko: 'hueco', huekillo: 'huequillo', pal: 'para el', tardee: 'tarde', mananaa: 'manana',
};

// Real Spanish words (from the dictionary), but not words we know are typos of a service ("tiente" is a
// form of "tentar", but here it is almost always "tinte"). Loaded lazily to keep this file standalone.
const TYPO_EVEN_IF_REAL = new Set(['tiente']);
const isRealWord = w => !TYPO_EVEN_IF_REAL.has(w) && require('./dictionary').isSpanishWord(w);

// Service catalog: each business will have its own (see catalog.json).
const SAMPLE_CATALOG = require('./catalog.json').services;

function basicNormalize(t) {
  return t.toLowerCase().replace(/ñ/g, 'n').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Accepts the catalog as a list or the old shape { corte: ['corte', ...] }
function prepareCatalog(catalog) {
  const list = Array.isArray(catalog)
    ? catalog
    : Object.entries(catalog).map(([id, synonyms]) => ({ id, group: id, synonyms }));
  return list.map(s => ({ ...s, synonyms: s.synonyms.map(basicNormalize) }));
}
const catalogCache = new WeakMap();
function preparedCatalog(catalog) {
  if (!catalogCache.has(catalog)) catalogCache.set(catalog, prepareCatalog(catalog));
  return catalogCache.get(catalog);
}

// Messages that are not about appointments: handed to the owner (intent null).
const NOT_BOOKING = /\b(foto|fotos|champu|producto|productos|paraguas|partido|he llegado|estoy en la puerta|estoy fuera|es normal|quien|donde estais|direccion|instagram|tarjetas? regalo|hac(eis|es) tambien|ofreceis|curso|estudiar|feliz|felicidades|recomendado|cambio de look|dia mas|escaparate|gafas|os llamo|te llamo|llamare|movil|telefono|llamar|buscando trabajo|disfraz|carnaval|secador\w*|facebook|hace (hoy|un dia|sol|frio|calor))\b|^ja(ja)+$/;

// Short confirmations ("vale", "sí", 👍): they only count if they don't bring a new day.
const FAREWELL = /^(hasta (manana|luego|el|la|entonces|pronto)|nos vemos|adios|chao|chau|bye|un beso|besos|besitos)\b/;
// "apúntame", "resérvamelo" on their own: yes to what the bot proposed
const CONFIRM_SHORT = /^ahora si( que si)?( (ja|je)\w*)?$|^(mejor |pues |vale |si |ok )?(esa|ese|esa misma|esa hora)( me va bien| entonces| porfa| por favor)?$|^(te|os) (lo )?confirmo( que si| que voy| que vengo| la cita)?$|^(apuntame|apuntamelo|apuntadme|reservame|reservamelo|reservalo|reservadmelo|cogemelo)( entonces| pues| porfa| por favor| ya)?$/;
const CONFIRM = /^(si+|vale+|nos vemos|hasta (el|la|luego|manana|entonces)|ok|okey|okis|perfect|confirmo|perfecto|genial|de acuerdo|claro|estupendo|por supuesto|me parece bien|confirmad[oa]|confirmamos|me va bien|me viene bien|alli estare|👍|👌|✅)(\b|\s|$)/;

// Choosing one of the times the bot proposed
const CHOOSE = /(^|me quedo con |pues |prefiero |mejor |elijo |reservadme |^vale |^ok |^si |^entonces |^(no )?espera )(la |el )?(opcion )?(numero )?(?<op>primera|primero|segunda|segundo|tercera|tercero|cuarta|ultima|[1-9](?=$| opcion| por favor| me | gracias))(?! vez)(\b|$)|\b(la|el) de las \w+|^a las \w+( y (media|cuarto))? entonces/;

// Order matters: the first match wins.
const INTENTS = [
  // "¿tengo cita?", "tenía cita mañana" (the whole message, so "tengo cita pero llegaré tarde" is not caught)
  // "¿al final tengo que ir por la tarde?": asking about her own appointment
  ['check', /^(y )?(al final )?(tengo|tenia) que (ir|venir|estar) (por la (manana|tarde)|a las \w+|hoy|manana|el \w+|al final)\b/],
  // "¿me lo mandas por escrito?": resend her appointment
  ['check', /\b(me )?(lo|la) (mandas|mandais|envias|enviais|pasas|pasais|escribes|escribis|puedes mandar|puedes enviar|podeis mandar|podeis enviar)\b.*\b(por escrito|por aqui|por whatsapp|por mensaje|olvide|recordar)\b|\bpor escrito\b|\bpara que no se me olvide\b/],
  ['check', /^(hola |buenas |oye )?(tengo|tenia) (una )?cita (ahora|ahora mismo|en un rato|dentro de un rato|esta (tarde|manana)|hoy)\b(?!.*\b(llegar|llego|llegare|retraso|tarde)\b)|\b(tengo|tenia) (una )?(cita|hora) (apuntada|reservada|cogida|pedida)\b|\bcreo que (tengo|tenia) (cita|hora)\b/],
  // "mis citas", "ver mis citas", "¿qué citas tengo?"
  ['check', /^(las |mis |ver |ver las |ver mis )?(citas|reservas)( porfa| por favor| please)?$|^(ver |ensename |dime |cuales son |cuales son |consultar )?(mis|las mis) (citas|reservas)\b|\b(que|cuantas) (citas|reservas) tengo\b|\bmis (citas|reservas)\b/],
  ['check', /^(y )?(tengo|tenia|tendria) (alguna |una )?(citas?|horas?|algo (apuntado|reservado))( (para )?(hoy|manana|pasado manana|esta semana|el \w+( \d{1,2})?))?$/],
  ['check', /\b(a que hora (tengo|era|voy|tenia|tiene)|cuando (tenia|tengo|era)|que dia (tenia|tengo|era)|tenia (cita|hora)|me recuerdas|me podeis recordar|tengo (cita|hora) .*verdad|tengo algo apuntado|sigue en pie|si tengo (cita|hora|reservad\w*)|no recuerdo|me lo podeis mirar|cuando tengo|habiamos quedado|me disteis|me dieron|sigo teniendo|sigue reservad\w*|me confirmais si|si tengo cita)\b/],
  ['hours', /\b(horarios?|a que hora (abr|cerr)\w*|hasta que hora|abiert[oa]s?|cerrad[oa]s?|abr(is|en|e|iran|ireis)|cerrais|trabaj(ais|an)|(estais|seguis|esta) trabajando|descans\w*|todavia estais|seguis abiertos|a que hora (empez|termin|acab)\w*)\b/],
  ['price', /\b(precios?|tarifas?|cuanto|cuantos|a cuanto|cobr\w+|caro|barato|cuest\w*|coste|costaria)\b/],
  ['late', /\bllegare (sobre|a las|en)\b|\bllego (en \d+|tarde)\b|\bvoy (con|un poco de) retraso\b|\bme retraso\b|\bvoy de camino\b|\b(voy|vamos) a llegar (un )?(poco |poquito |pelin |pelito |algo )?tarde\b|\b(ya )?(estoy|voy) llegando\b|\b(como|unos|sobre) \d+ (min\w*)\b|\bminut(illos|itos)\b|\bllegare (unos |como )?\d+ min\w*|\b(voy|ire|llego|vamos) (un poco |muy |algo )?(justa|justo|justas|apurada|con prisa)\b|\bhay (mucho|un monton de) trafico\b|\b(estoy|voy) (en un|en el) atasco\b|\bno encuentro aparcamiento\b/],
  ['choose', CHOOSE],
  ['cancel', /\b(cancel\w*|anul\w*|borra\w*|desapunta\w*)|\bquit\w*( (la|mi|su|el))? (cita|reserva|hora|hueco)\b/],
  ['reschedule', /\bprefier\w* (el |la |otro |otra )?(mes|semana|dia|hora)\b|\b(el )?(mes que viene|proximo mes)\b|\b(cambi\w*|mover\w*|muev\w*|aplaz\w*|retras\w*|adelant\w*|pasarla|pasala|pasas?|pasa\w* (al|a otro|para)|otro dia|otra hora|en vez de|en vez del|en lugar de|en lugar del|mejor otr[ao]|llegare (un poco )?tarde|me va fatal|me (va|viene|vendria|iria) mejor|pero (podria|puede) ser|dejar la cita|no me (viene|va) bien|(podrias|puedes|puede ser|hay algo) antes|antes de las)\b|\bpasa\w*\b.*\bcita\b|\bcita\b.*\bpasa\w*|\bpasa\w*\b.*\b(al|a la|a las|para el)\b/],
  ['cancel', /\b(no (puedo|podre|voy a poder) (ir|acudir|venir|asistir)|no ire|no voy\b|ya no (necesito|quiero|hace falta))/],
  // compliments go before 'book' so "me gustó mucho el color" is not read as asking for a tinte
  ['thanks', /\b(me (gusto|gustaron|encanto|encantaron) (mucho|muchisimo|un monton)|me (encanta|encantan|ha encantado|han encantado)|sois (las|los|unas|unos) mejores|(quede|estoy|he quedado) (encantada|muy contenta|contentisima)|que bien me (dejaste|dejasteis|quedo|ha quedado))\b/],
  ['book', /^(el |mi )?pelo$|^peluqueria$|\b(cita|hora|reserv\w*|pedir|quer\w*|quier\w*|quisiera|necesit\w*|hueco|huecos|huequito|huequillo|sitio|libre|puedo ir|lo de siempre|lo mismo|me atiend\w*|me apunt\w*|me coge\w*|cogerme|apuntar\w*|concertar|me gustaria|hacerme|ponerme|(que|cuando) (dia )?tienes|para el fin de semana)\b/],
  ['greeting', /^(muy )?(hol+a+|buenas|buenos dias|buenas tardes|buenas noches|ey)\b|^(y )?(que tal|como (estas|estais|esta|va|vais|te va|os va|andas|andais)|todo bien|(estas|estais|esta usted) bien|que tal (estas|estais|todo|va))\b|^(hola )?(estas|estais|esta usted|hay alguien|alguien|me (lees|oyes|leeis))( (ahi|por ahi|ahora))?$/],
  ['thanks', /\b(gracias|grax|mil gracias|muy amable|que amable)\b/],
];

function normalize(text) {
  const t = text
    .toLowerCase()
    .replace(/ñ/g, 'n')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/([a-z])\1{2,}/g, '$1')                  // "holaaa" -> "hola"
    .replace(/[¿?¡!.,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.split(' ').map(w => REPLACEMENTS[w] ?? keywordTypo(w) ?? w).join(' ');
}

// Typos in the bot's own key words ("servivios", "precois", "horaio", "cancelr"): a word of 6+ letters that
// doesn't exist in Spanish and is one letter away from a key word is read as that key word.
const KEYWORDS = ['servicios', 'servicio', 'precios', 'precio', 'horario', 'horarios', 'cancelar', 'cambiar', 'reservar',
  'peluqueria', 'depilacion', 'tratamientos', 'disponible', 'manana', 'semana', 'viernes', 'miercoles', 'sabado', 'jueves'];
function keywordTypo(w) {
  if (w.length < 6 || KEYWORDS.includes(w) || !/^[a-z]+$/.test(w)) return null;
  const close = KEYWORDS.find(k => Math.abs(k.length - w.length) <= 1 && distance(w, k) <= 1);
  return close && !isRealWord(w) ? close : null;
}

// Edit distance (with swapped letters), to accept typos ("tiente" -> "tinte", "precois" -> "precios")
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // two letters swapped ("precois") count as one typo
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const ANY_DAY = /\b(no tengo (preferencia|prisa)( de dia)?|el dia que (os|te) (venga|vaya) (mejor|bien)|me da igual (el|que) dia|me da igual cuando|cualquier dia|cuando (tengais|tengas|podais|puedas|sea|querais|quieras)|lo antes posible|lo mas pronto|(el )?primer hueco|esta semana)\b/;

// Not sure she can make it: "no sé si podré ir mañana", "igual no puedo ir", "a lo mejor no llego"
const UNSURE = /\b(no (se|estoy segura|lo tengo claro|tengo claro) si (podre|puedo|voy a poder|llego|llegare|me da tiempo|me dara tiempo|ire|vendre)|(igual|a lo mejor|puede que|quizas|quiza|tal vez) no (puedo|pueda|podre|llego|llegue|llegare|vaya|ire|vengo|venga|me da tiempo))\b/;

// Words that mean a change, so "sí, el jueves" + one of these is not a plain yes
const CHANGE_WORDS = /\b(cambi\w*|pasa\w*|mejor|otro|otra|prefier\w*|prefer\w*|mov\w*|muev\w*|antes|despues|adelant\w*|retras\w*|en vez|en lugar)\b/;

const EXPLICIT_BOOKING = /\b(pedir|reservar|coger|quiero|queria|quisiera|necesito)( coger| pedir| reservar)? (una )?(cita|hora)\b/;

// "una pregunta", "ah y una cosa": a lead-in; the real question comes in the next message
const PREAMBLE = /^(hola |buenas |ah |oye |y |a ver |mira )*((queria|quiero) (preguntarte|preguntaros|comentarte|comentaros)( algo| una cosa| una cosita| una duda)?|una pregunta|una preguntita|una duda|una cosita|una cosa|otra cosa|otra pregunta|y una cosa|te (queria|quiero) (preguntar|comentar)( algo| una cosa)?|os (queria|quiero) (preguntar|comentar)( algo| una cosa)?)( (ja|je)\w*)?$/;

// "la cita del viernes entonces confirmada", "pues lo confirmo"
const CONFIRM_AT_END = /\b(confirmad[oa]|lo confirmo|te lo confirmo|confirmo|queda confirmad[oa])$/;

// Any time is fine: "a la hora que os venga bien", "me da igual la hora"
// Not decided yet: "luego te digo", "lo miro y te digo", "lo hablo con mi marido y te confirmo", "ya te escribo".
// Future or conditional "te confirmo" is not a confirmation.
const UNDECIDED = /\b(se lo (digo|dire|comento|pregunto|consulto)|le (pregunto|consulto)|(lo|se lo) consulto|luego (te|os) (lo |la )?(digo|escribo|confirmo|cuento|aviso)|ya (te|os) (lo |la )?(digo|dire|escribo|escribire|aviso|avisare|confirmo|confirmare|cuento|contare)|(te|os) (lo |la )?(digo|dire|confirmo|escribo) (algo|luego|mas tarde|manana|cuando|en cuanto)|y (te|os) (lo |la )?(digo|confirmo|aviso|escribo|cuento)( algo)?$|lo miro( con| y|$)|lo (hablo|hablare|consulto|consultare|comento|comentare|miro) con|(lo )?tengo que (hablar|mirar|pensar|consultar)(lo)?|(me )?lo (pienso|pensare|voy a pensar)|dejame (que lo|pensarlo|mirarlo|verlo)|(todavia|aun) no (se|lo se|lo tengo claro|tengo claro)|no puedo mirarlo|ya (lo )?(veremos|vere))\b/;

// Questions about how the salon works, answered from the salon's "info" settings. A policy question
// ("¿con cuánta antelación tengo que cancelar?", "si llego tarde, ¿me la mantenéis?") is not the action itself.
const INFO_TOPICS = [
  ['walkIn', /\b(sin cita|sin reserva|sin pedir (cita|hora)|hay que pedir (cita|hora)|hace falta (pedir )?(cita|hora)|tengo que (pedir cita|reservar|coger cita)|hay que reservar|por orden de llegada|(puedo|se puede) (ir|pasar|pasarme|presentarme|venir) (directamente|sin))\b/],
  ['payment', /\b(bizum|efectivo|en metalico|datafono|(pagar|pago|pagais|pagan|cobrais|cobran) (con|en|por) (tarjeta|bizum|efectivo|movil)|(aceptais|admitis|cogeis|vale) (tarjeta|bizum|efectivo)|se puede pagar|como se paga|formas? de pago|metodos? de pago|con tarjeta)\b(?! regalo)/],
  ['parking', /\b(parking|aparc\w*|donde (dejo|puedo dejar|dejar) el coche|sitio para el coche|zona azul)\b/],
  ['children', /\b(llevar|traer|ir con|venir con|vengo con|voy con|vendre con|ire con) (al|a la|a los|a las|el|la|los|las|mi|mis|a mi|a mis)? ?(nino|nina|ninos|ninas|crio|cria|crios|crias|bebe|bebes|hijo|hija|hijos|hijas|peque|peques|carrito)\b|\bpueden? (venir|entrar|estar|acompanarme) (los |las |el |la |mi |mis )?(ninos|ninas|nino|nina|crios|peques|hijo|hija|hijos|hijas|bebe)\b|^(puede|pueden) venir (mi|mis) (hijo|hija|hijos|hijas)$/],
  ['pets', /\b(mascota|perro|perra|gato|gata)\b.*\b(traer|llevar|venir|entrar|admit\w*|dej\w*|pued\w*)\b|\b(traer|llevar|ir con|venir con|entrar con) (a )?(mi|el|la)? ?(mascota|perro|perra|gato|gata)\b/],
  ['cancellationPolicy', /\b(con cuanta antelacion|cuanto (tiempo )?antes|con cuanto tiempo) (tengo que|hay que|se puede|puedo|debo|teneis que)?\s*(cancelar|anular|avisar|cambiar)|\bsi (cancelo|anulo|no voy|no vengo|no aparezco|falto|no me presento|cancelara|cancelase)\b.*\b(cobr\w*|pag\w*|pasa algo|penaliz\w*)|\b(politica|condiciones) de (cancelacion|anulacion)\b|\bpenalizacion\b|\bse cobra (si|la cancelacion|por cancelar)/],
  ['latePolicy', /\bsi (llego|llegara|llegase|me retraso|me retrasara|me retrasase)\b.*\b(mantene\w*|mantien\w*|mantendr\w*|guarda\w*|espera\w*|pierdo|perderia|pasa algo|atende\w*|atend\w*)\b|\bcuanto (tiempo|rato) (me )?(esperais|esperas|guardais)\b|\b(margen|tolerancia) (de|si llego|para llegar)\b/],
];
// "¿cómo funciona la lista de espera?": an explanation, not a request to be added
const HOW_WAITLIST = /\b(como|que es|para que (es|sirve)|en que consiste)\b.*\b(lista de espera|waiting list|wating list|waitlist|lista)\b/;

const infoTopics = t => INFO_TOPICS.filter(([, re]) => re.test(t)).map(([topic]) => topic);
// A real booking request in the same message wins over an info question ("¿me das cita el sábado? ¿aceptáis bizum?")
const BOOKING_REQUEST = /\b(me (das|dais|puedes dar|podeis dar|coges|cogeis|apuntas|apuntais|reservas|reservais) (cita|hora|hueco)?|quiero (cita|hora|reservar)|queria (cita|hora|pedir|reservar|coger)|cita para|hueco para|reservame|reservadme|apuntame|(?<!(falta|que|necesario|obligatorio) )pedir (cita|hora))\b/;

// "¿qué servicios tenéis?", "lístame todos los servicios", "¿tienes precios?": the salon's catalog
// "¿cómo se llama la peluquería?", "¿cuál es vuestro nombre?"
const NAME_QUESTION = /\b(como se llama(n)? (el centro|la peluqueria|el salon|el negocio|la tienda|esto|vuestro \w+|tu \w+)|como os llamais|cual es (el|vuestro) nombre|nombre del (centro|negocio|salon|local|peluqueria))\b/;

const SERVICES_LIST = /^(los |todos los |vuestros |tus )?(servicios|tratamientos|lista|carta|catalogo)( porfa| por favor| please)?$|\b(lista(r|me|nos|d|do)?( de)? (los |todos los |vuestros |tus )?(servicios|precios|tratamientos)|(que|cuales|cuantos) (servicios|tratamientos)( \w+){0,2} (teneis|tienes|haceis|haces|ofreceis|hay)|(todos )?(los|vuestros|tus) servicios|carta de servicios|catalogo|lista de precios|(teneis|tienes|hay) (una )?(lista|carta)|(teneis|tienes) precios|que (precios|tarifas) (teneis|tienes|hay))\b|^(y )?que (haceis|ofreceis)( (de|en) \w+)?$|\bque (haceis|ofreceis) (de|en) \w+/;
// Category asked about: "¿qué tratamientos faciales tenéis?", "precios de uñas"
const SERVICE_CATEGORIES = [
  ['peluqueria', /\b(pelo|peluqueria|cortes?|peinados?)\b/],
  ['coloracion', /\b(color|coloracion|tintes?|mechas)\b/],
  ['tratamientos_capilares', /\b(tratamientos? (capilares?|para el pelo)|keratina|queratina)\b/],
  ['barberia', /\b(barba|barberia|hombres?|caballeros?)\b/],
  ['estetica_facial', /\b(facial(es)?|cara|cutis)\b/],
  ['estetica_corporal', /\b(corporal(es)?|cuerpo|masajes?)\b/],
  ['depilacion', /\b(depilacion|depilar|cera|laser)\b/],
  ['manicura_pedicura', /\b(unas|manicuras?|pedicuras?|manos|pies)\b/],
  ['pestanas_cejas', /\b(pestanas|cejas)\b/],
];

// A polite no to the offer: "gracias, otro día", "en otro momento", "más adelante", "déjalo", "no, gracias".
// ("otro día" on its own, or "¿me lo pasas a otro día?", is still asking for another day.)
const DECLINE = /^(vale |ok |bueno |pues |nada )?(gracias|muchas gracias|mil gracias)? ?(pero )?(mejor )?(ya )?(en )?(otro (dia|rato|momento)|mas adelante|en otra ocasion)( gracias| entonces| ya| si eso)?$|^(vale |ok |bueno |pues )?(en otro momento|mas adelante|dejalo|dejalo estar|lo dejamos|lo dejo|lo dejo (para otro dia|para mas adelante)|mejor no|ahora no|de momento no|por ahora no|no gracias|no,? gracias|no hace falta|ya si eso|no quiero( nada)?|no lo quiero|no puedo|no me interesa|no me apetece|paso)( gracias| entonces| ya| ya esta| asi esta bien| de momento| ahora)?$/;

// Wants to hear if a slot frees up: "avísame si queda algo antes", "si alguien cancela…", "lista de espera".
// "Si alguien cancela" is about someone else, never a cancellation of hers.
const WAITLIST = /\blista de espera\b|\bsi (alguien|alguna|algun cliente|alguna clienta|otra persona|otra clienta|os|te|se) (cancela|cancelan|anula|anulan|libera|liberan|falla|fallan|deja|quita)\b|\b(avis\w*|escrib\w*|llam\w*|di(me|dnos)|me (dices|decis)) (me |nos )?(si|cuando) (se )?(queda|quedara|libera|liberara|sale|saliera|hay|hubiera|cancela|cancelan|anula)\b|\bsi (se libera|queda libre|quedara libre|sale) (algun|algo|alguna|un|una|hueco|sitio)\b|\b(avis\w*) (me |nos )?(si|cuando) .*\b(hueco|sitio|libre|antes|cancel\w*)\b/;

// "ninguna de las dos", "ninguna me va bien": none of the proposed times
const NONE_OF_THEM = /^(no )?(ninguna|ninguno)\b|\bninguna de (las|los|esas|estas)\b|\b(no me (va|viene|cuadra) (bien )?ninguna|ninguna (me|nos) (va|viene|cuadra))\b/;

// "a la misma hora": the time she already had / was offered
const NEXT_MONTH = /\b(el )?(mes que viene|proximo mes|mes siguiente)\b/;

// "espera", "un momento", "voy a mirar una cosa": she is checking something; keep everything as it is
const WAIT = /^(uy |ay |bueno |vale |ah |no |oye )*(espera|esperame|esperad|un momento|un momentito|un segundo|un seg|dame un (momento|segundo)|dejame (ver|mirar|que mire)|deja que (mire|lo mire|compruebe)|voy a mirar|espera que (mire|miro|lo miro|voy a mirar|compruebo|pregunto))\b(?!.*\b(primera|segunda|tercera|ultima|otra)\b)/;

// "al final sí que puedo ir", "dejamos la cita como estaba": she keeps her appointment
const KEEP = /\b(al final si (que )?(puedo|voy|ire|podre|llego)|(dejamos|deja|dejala|mantenemos|mantengo|mantenla|la mantengo|la dejamos) (la cita )?(como (estaba|esta)|igual|asi)|no (la )?(anules|canceles|cambies|quites)|mejor no (la )?(anules|canceles|cambies)|al final no (la )?(anules|canceles|cambies)|olvida lo de (anular|cancelar|cambiar))\b/;

// "¿cuánto dura?", "¿cuánto se tarda?": how long a service takes (from the catalog)
const DURATION = /\b(cuanto (dura|duran|tarda|tardais|tardas|se tarda|tiempo)|cuanto rato|duracion|cuantas horas|cuanto se tarda)\b/;

// "tengo una boda el sábado": the day of an event, not the day she wants the appointment
const EVENT = /\b(tengo|hay|es|tenemos|voy a) (una|un|la|el|mi) (boda|comunion|bautizo|evento|fiesta|cena|graduacion|viaje|cumpleanos|cumple|celebracion|sesion de fotos)\b|\b(boda|comunion|bautizo|graduacion) (es )?(el|este|esta|del)\b/;

// "mañana no puedo", "el viernes no me va bien": that day is out
const NOT_THIS_DAY = /\b(no (puedo|podre|me va|me viene|me cuadra)( bien)?|imposible)\b/;

const SAME_TIME = /\b(a la|la) misma hora\b|\bmisma hora\b/;

// She'll be there: "allí estaré", "sin falta", "cuenta conmigo" (even with the day: "sí, mañana allí estoy")
const ATTENDING = /\b(alli|ahi) (estare|estoy|estaremos|voy|ire)\b|\bsin falta\b|\bcuenta conmigo\b|\bcontad conmigo\b/;

// "si no os importa…", "si alguien…", "si puede ser…": a conditional "si", not a yes
const CONDITIONAL_SI = /^si (no|alguien|puede|pudiera|pudieras|quieres|quereis|os|te|hay|tienes|teneis|es|fuera|fuese|se|tuvierais|tuvieras)\b/;

const ANY_TIME = /\b(la que (tengais|tengas|haya) (libre|disponible)|cualquiera( de (las|los) (dos|tres))?|me da igual (cual|la que sea|la hora)|la que sea|(como|lo que|cuando) (os|te) (venga|vaya) (mejor|bien)|a la hora que (os|te) (venga|vaya) (bien|mejor)|la (hora )?que (os|te) (venga|vaya) (bien|mejor)|cuando (os|te) (venga|vaya) (bien|mejor)|me da igual la hora|cualquier hora|a cualquier hora)\b/;

function detectIntent(t, raw = '', today) {
  // "sí, …" / "Sí" (accent or comma) is a yes; "si no os importa…" (no accent) is a condition
  const conditional = CONDITIONAL_SI.test(t) && !/^\s*¡?s[ií]+\s*[,.!]/i.test(raw) && !/^\s*¡?sí/i.test(raw);
  if (NAME_QUESTION.test(t)) return 'name';
  if (SERVICES_LIST.test(t)) return 'services';
  // salon info questions first: "¿puedo llevar al niño? no tengo con quién dejarlo" has "quién" (off-topic list)
  if (infoTopics(t).length && !BOOKING_REQUEST.test(t) && !WAITLIST.test(t)) return 'info';
  if (NOT_BOOKING.test(t) && !EXPLICIT_BOOKING.test(t)) return null;
  t = t.replace(/\bcambio de (color|look|imagen|estilo)\b/g, 'tinte');
  t = t.replace(/\bpasar(me|nos|se|te)? (a|por) (pedir|coger|hacer|reservar|ver)\b/g, 'ir $2 $3'); // "pasarme a pedir cita" = visit, not move
  if (HOW_WAITLIST.test(t)) return 'help';
  if (WAITLIST.test(t)) return 'waitlist';
  if (infoTopics(t).length && !BOOKING_REQUEST.test(t)) return 'info';
  if (FAREWELL.test(t)) return 'confirm';
  if (UNSURE.test(t)) return 'reschedule'; // reply.js asks whether to move or cancel it
  if (UNDECIDED.test(t)) return 'undecided';
  if (DECLINE.test(t) && !/^otro (dia|rato|momento)$/.test(t)) return 'undecided';
  if (NONE_OF_THEM.test(t)) return 'reschedule'; // reply.js offers other times
  // "vale, pues la primera": the choice wins over the "vale"
  if (detectOption(t)) return 'choose';
  if (CONFIRM_SHORT.test(t)) return 'confirm';
  if (PREAMBLE.test(t)) return 'preamble';
  if (WAIT.test(t)) return 'wait';
  if (KEEP.test(t)) return 'keep';
  if (DURATION.test(t)) return 'duration';
  if (CONFIRM_AT_END.test(t) && !detectTimeOfDay(t) && !/\d/.test(t)) return 'confirm';
  // "si puede ser por la mañana" is not a yes: it brings a new day or time of day
  const yes = CONFIRM.test(t) && !conditional;
  if (yes && !detectDate(t, today) && !detectTimeOfDay(t) && !/\d/.test(t) && !EXPLICIT_BOOKING.test(t)) return 'confirm';
  if (ATTENDING.test(t) && !CHANGE_WORDS.test(t)) return 'confirm';
  for (const [name, regex] of INTENTS) if (regex.test(t)) return name;
  return null;
}

// Returns the services in the order they appear.
// If a more specific phrase contains another ("mechas californianas" ⊃ "mechas"), the specific one wins.
// Typos ("tiente") are only accepted when there is no exact match at all.
const TYPO_TOLERANT = new Set(['corte', 'tinte', 'barba', 'mechas', 'peinado', 'recogido', 'cejas']);

// Ordinary words that look like a service and must not be confused with one ("venir" ≈ "tenir")
const COMMON_WORDS = new Set(['venir', 'tener', 'poner', 'coste', 'carta', 'parte', 'norte', 'color', 'mucho', 'muchas', 'barca', 'pelas', 'calor']);

function detectServices(t, catalog) {
  if (/lo de (siempre|la otra vez|la ultima vez)|lo mismo|\bcomo (la otra vez|la ultima vez|siempre|el otro dia)\b/.test(t)) {
    return [{ id: 'LAST', group: 'LAST', name: 'The usual' }];
  }
  const cat = preparedCatalog(catalog);
  const padded = ` ${t} `;
  const found = [];
  for (const service of cat) {
    for (const s of service.synonyms) {
      let i = padded.indexOf(` ${s} `);
      while (i >= 0) {
        found.push({ start: i, end: i + s.length, service });
        i = padded.indexOf(` ${s} `, i + 1);
      }
    }
  }
  // After normalizing, "uñas" and "unas" ("some") are the same word. With no other service in the
  // message, a bare "unas" at the end or before a date/time word means "uñas" ("cita para unas",
  // "unas para el viernes"); "unas mechas" or "unas gafas" are left alone.
  if (!found.length) {
    const m = padded.match(/ (unas)(?= (?:para|el|la|los|las|por|a|y|de|manana|hoy|pasado|este|esta|si|que|porfa|por favor)\b| $)/);
    const manicure = m && cat.find(s => s.id === 'manicura');
    if (manicure) found.push({ start: m.index + 1, end: m.index + 1 + m[1].length, service: manicure });
  }
  if (!found.length) {
    let pos = 0;
    for (const w of t.split(' ')) {
      // A real Spanish word is not a typo: "avisar" is not "alisar", "muchas" is not "mechas"
      if (w.length >= 5 && !COMMON_WORDS.has(w) && !isRealWord(w)) {
        for (const service of cat) {
          const ok = service.synonyms.some(s => !s.includes(' ') && s.length >= 5 &&
            (s.length >= 6 || TYPO_TOLERANT.has(s)) && distance(w, s) <= (s.length >= 10 ? 2 : 1)); // long words: 2 typos ("depelicacion")
          if (ok) { found.push({ start: pos, end: pos + w.length, service }); break; }
        }
      }
      pos += w.length + 1;
    }
  }
  // drop matches that sit inside a longer one
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  for (const f of found) {
    if (!chosen.some(x => f.start < x.end && x.start < f.end)) chosen.push(f);
  }
  chosen.sort((a, b) => a.start - b.start);
  const seen = new Set();
  const list = chosen.map(f => f.service).filter(s => !seen.has(s.id) && seen.add(s.id));
  // if she says "depilarme las piernas", the generic "depilación" is redundant
  return list.filter(s => !(s.id === s.group && list.some(o => o !== s && o.group === s.group)));
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function futureDate(today, day, month) {
  const d = new Date(today.getFullYear(), month, day);
  if (d < addDays(today, 0)) {
    // already past: same day next month (if she only said "el 14") or next year
    if (month === today.getMonth()) d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

function detectDate(t, today) {
  if (/\bpasado manana\b/.test(t)) return addDays(today, 2);
  // "mañana" as a day ("tomorrow"), but not "por la mañana" / "esta mañana" ("in the morning")
  // "hoy o mañana": whichever is said first wins
  const withoutSlot = t.replace(/\b(la|esta) manana\b/g, '');
  const posToday = t.search(/\b(hoy|esta manana|esta tarde)\b/);
  const posTomorrow = withoutSlot.search(/\bmanana\b/);
  if (posToday >= 0 && (posTomorrow < 0 || posToday < posTomorrow)) return addDays(today, 0);
  if (posTomorrow >= 0) return addDays(today, 1);

  // "14/11" or "14-11"
  let m = t.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
  if (m) return futureDate(today, +m[1], +m[2] - 1);

  // "14 de noviembre"
  m = t.match(new RegExp(`\\b(\\d{1,2}) de (${MONTHS.join('|')})\\b`));
  if (m) return futureDate(today, +m[1], MONTHS.indexOf(m[2]));

  // "el sábado 21": the number wins
  m = t.match(new RegExp(`\\b(${WEEKDAYS.join('|')}) (\\d{1,2})\\b(?! ?(:|y |h\\b))`));
  if (m) return futureDate(today, +m[2], today.getMonth());

  // "el martes", "el lunes 16", "el viernes de la semana que viene"
  const weekday = WEEKDAYS.findIndex(d => new RegExp(`\\b${d}\\b`).test(t));
  if (weekday >= 0) {
    // "los domingos" is a general question, not a specific day
    if (new RegExp(`\\blos ${WEEKDAYS[weekday]}s?\\b`).test(t)) return null;
    let n = (weekday - today.getDay() + 7) % 7;
    if (n === 0) n = 7; // "el martes" said on a Tuesday = next one
    // "la semana que viene" (next week): if that day still falls this week, jump to the next
    // "el miércoles que viene" said on a Tuesday: if she meant tomorrow she'd say "mañana", so it's next week's
    if (n === 1 && new RegExp(`\\b${WEEKDAYS[weekday]} que viene\\b`).test(t)) n += 7;
    if (/semana que viene|proxima semana|semana siguiente/.test(t)) {
      const untilMonday = (8 - today.getDay()) % 7 || 7;
      if (n < untilMonday) n += 7;
    }
    return addDays(today, n);
  }

  // "el 14", "del 14", "el dia 27"
  m = t.match(/\b(el|del|al|para el) (dia )?(\d{1,2})\b(?! ?(:|y |h\b|de la))/);
  if (m) return futureDate(today, +m[3], today.getMonth());

  // "la semana que viene" with no day: Monday of next week
  // (but not in a goodbye: "hasta la semana que viene", "nos vemos la semana que viene")
  if (/\b(la )?(semana que viene|proxima semana|semana siguiente)\b/.test(t) &&
      !/\b(hasta|nos vemos) (la )?(semana que viene|proxima semana|semana siguiente)\b/.test(t)) {
    return addDays(today, (8 - today.getDay()) % 7 || 7);
  }
  return null;
}

function detectTimeOfDay(t) {
  if (/\b(por|de|esta|a) la manana\b|\blas mananas\b|\bprimera hora\b|\besta manana\b/.test(t)) return 'morning';
  if (/\bdespues de comer\b|\blas tardes\b/.test(t)) return 'afternoon';
  if (/\bmediodia\b/.test(t)) return 'midday';
  if (/\b(la|por la|esta|a la) tarde\b|\bultima hora\b|^tarde$|\btarde$/.test(t)) return 'afternoon';
  return null;
}

// "¿a las 5 o a las 6?", "a las 9 o 9 y media": every time she offers, in order
function detectTimes(t, timeOfDay) {
  const pieces = t.split(/ o (?=(a las |las |sobre las |\d|una |dos |tres |cuatro |cinco |seis |siete |ocho |nueve |diez |once |doce ))/).filter(x => x && !/^(a las |las |sobre las |\d|una |dos |tres |cuatro |cinco |seis |siete |ocho |nueve |diez |once |doce )$/.test(x));
  if (pieces.length < 2) return [];
  const times = pieces.map((p, i) => detectTime(i && /^(\d|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/.test(p) ? `a las ${p}` : p, timeOfDay)).filter(Boolean);
  return [...new Set(times)];
}

// "martes o miércoles", "el jueves o el viernes": every day she offers, in order
function detectDates(t, today) {
  const pieces = t.split(/ o (?=(?:el |la |para el |\d|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|pasado))/).filter(Boolean);
  if (pieces.length < 2) return [];
  const dates = pieces.map(p => detectDate(p, today)).filter(Boolean);
  return dates.filter((d, i) => dates.findIndex(x => x.getTime() === d.getTime()) === i);
}

function detectTime(t, timeOfDay) {
  // "ninguna de las dos", "las dos cosas", "cualquiera de las tres": counting, not a time
  t = t.replace(/^de (las|los) (dos|tres)\b|\b(ninguna|ninguno|cualquiera|alguna|una|uno) de (las|los) (dos|tres)\b|\b(las|los) (dos|tres|2|3) (cosas|opciones|horas|citas|servicios)\b/g, ' ');
  let h = null, min = 0;
  let m = t.match(/\b(\d{1,2})[:h.](\d{2})\b/);                         // 17:30, 5.30
  if (m) { h = +m[1]; min = +m[2]; }
  if (h === null) {
    m = t.match(/\b(\d{1,2}) ?h\b/);                                    // 17h, 10 h
    if (m) h = +m[1];
  }
  if (h === null) {
    // "a las 5", "sobre las 6", "a eso de las 11", "hacia las 7 y media"
    m = t.match(/\b(a|sobre|hacia|eso de|de|para|por) las (\d{1,2}|\w+)( y (media|cuarto))?\b/);
    if (m) {
      h = /^\d+$/.test(m[2]) ? +m[2] : NUMBER_WORDS[m[2]] ?? null;
      if (m[4] === 'media') min = 30;
      if (m[4] === 'cuarto') min = 15;
    }
  }
  if (h === null) {
    m = t.match(/\b(y |sobre |a |hacia |eso de )?la (1[0-9]|2[0-3]|[1-9])( o asi)?\b(?! de)/); // "y la 13 o así", "sobre la 1"
    if (m && (m[1] || m[3])) h = +m[2];
  }
  if (h === null && /^\d{1,2}$/.test(t.trim()) && +t.trim() >= 9 && +t.trim() <= 21) h = +t.trim(); // "13"
  if (h === null || h > 23 || min > 59) return null;
  // In an appointment business "a las 5" almost always means 5 pm
  if (h >= 1 && h <= 8 && timeOfDay !== 'morning') h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function detectOption(t) {
  const m = t.match(CHOOSE);
  const op = m?.groups?.op;
  if (!op) return null;
  return /^\d$/.test(op) ? +op : ORDINALS[op];
}

// When rescheduling, two dates/times appear: the old one and the new one.
// Keep the part of the message that talks about the NEW one.
function newPart(t) {
  const days = WEEKDAYS.join('|');
  const cleaned = t
    .replace(/\ben (vez|lugar) del? (las |la |a las )?\S+( y (media|cuarto))?/g, ' ')
    .replace(new RegExp(`\\bque el (${days}|\\d{1,2})\\b`, 'g'), ' ');
  const markers = [' al ', ' para el ', ' por el ', ' mejor ', ' a la ', ' a las ', ' pasar a ', ' pasarla a '];
  let pos = -1;
  for (const mk of markers) pos = Math.max(pos, cleaned.lastIndexOf(mk));
  return { chunk: pos >= 0 ? cleaned.slice(pos) : cleaned, cleaned };
}

// context (optional): what the bot knows about the conversation
//   lastQuestion: 'proposal' | 'service' | 'day' | 'timeOfDay' | 'time' | null
//   proposals: times the bot just offered, e.g. ['09:45', '13:00']
//   hasAppointment: true if the customer already has an appointment booked
// `today` is required: the date always comes from outside (bot.js gives the salon's wall-clock time)
function understand(message, { today, services = SAMPLE_CATALOG, context = {} } = {}) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new TypeError('understand(): pass { today } as a valid Date');
  const t = normalize(message);
  let intent = detectIntent(t, message, today);
  const list = detectServices(t, services);
  // When rescheduling, day, time of day and time are searched first in the NEW part of the message
  let chunk = t, cleaned = t;
  if (intent === 'reschedule') ({ chunk, cleaned } = newPart(t));
  let date = detectDate(chunk, today) ?? detectDate(cleaned, today);

  const timeOfDay = detectTimeOfDay(chunk) ?? detectTimeOfDay(cleaned);
  const time = detectTime(chunk, timeOfDay) ?? detectTime(cleaned, timeOfDay);
  const result = {
    intent,
    service: list[0]?.group ?? null,                       // general service of the first one mentioned
    services: [...new Set(list.map(s => s.group))],        // all of them ("tinte y corte")
    details: list.map(s => ({ id: s.id, group: s.group, name: s.name, duration: s.duration ?? null })), // specific ones
    totalDuration: list.reduce((n, s) => n + (s.duration ?? 0), 0) || null,
    date,
    timeOfDay,
    time,
    option: intent === 'choose' ? detectOption(t) : null,
    // any day is fine: "me da igual el día", "cuando tengáis un hueco", "esta semana"
    anyDay: ANY_DAY.test(t) || NEXT_MONTH.test(t),
    // "el mes que viene": any day from the 1st of next month
    fromDate: NEXT_MONTH.test(t) ? new Date(today.getFullYear(), today.getMonth() + 1, 1) : null,
    anyTime: ANY_TIME.test(t),
    sameTime: SAME_TIME.test(t),
    times: detectTimes(t, timeOfDay),
    dates: detectDates(t, today),
    noneOfThem: NONE_OF_THEM.test(t),
    unsure: UNSURE.test(t),
    declined: DECLINE.test(t) && !/^otro (dia|rato|momento)$/.test(t),
    // info questions in the message: the first one is the topic of an 'info' intent; with a booking, all are answered too
    infoTopics: infoTopics(t),
  };
  // A compliment that also asks for a day or time ("me encantó, ¿repetimos el viernes?") is a booking
  if (result.intent === 'thanks' && (result.date || result.time || EXPLICIT_BOOKING.test(t))) result.intent = 'book';
  // A greeting or unclear message that mentions a day, time or service means she wants an appointment
  if (!NOT_BOOKING.test(t) && (!result.intent || result.intent === 'greeting')) {
    // A service on its own ("corte", "uñas") also counts: in a salon chat it means "I want that"
    if (result.date || result.time || result.timeOfDay || result.service || result.anyDay || result.anyTime) {
      result.intent = 'book';
    }
  }
  if (context.hasAppointment && ['book', 'reschedule'].includes(result.intent) && CONFIRM.test(t) && !CONDITIONAL_SI.test(t) &&
      result.date && !result.time && !result.service && !CHANGE_WORDS.test(t) && !UNSURE.test(t)) {
    result.intent = 'confirm'; // "sí, mañana allí estoy": reply.js checks the day is really hers
  }
  result.normalizedText = t;
  if (result.intent === 'info') result.topic = result.infoTopics[0];
  // a category named on its own ("manos y pies", "lo de cejas"), e.g. right after the services list
  result.category = SERVICE_CATEGORIES.find(([, re]) => re.test(t))?.[0] ?? null;
  if (result.intent === 'services') {
    result.withPrices = /\b(precios?|tarifas?|cuesta|cuestan|cuanto)\b/.test(t);
  }
  // "tengo una boda el sábado": the date is the event's, not the appointment's
  if (result.date && EVENT.test(t) && !result.service && !EXPLICIT_BOOKING.test(t) && !/\b(cita|hueco|para el|me (podeis|puedes) coger)\b/.test(t)) {
    result.eventDate = result.date; result.date = null;
    if (result.intent === 'book' && !result.service && !result.time) result.intent = 'event';
  }
  // "mañana no puedo", "aunque el viernes no puedo" (with no appointment of hers): that day is out
  const booking = ['proposal', 'day', 'time', 'timeOfDay'].includes(context.lastQuestion);
  if (result.date && NOT_THIS_DAY.test(t) && booking && !context.hasAppointment && !result.time && !/\b(cancel|anul)\w*/.test(t)) {
    const clauses = message.split(/[,.;:!?¡¿]+|\s+pero\s+/i).map(normalize).filter(Boolean);
    const out = clauses.find(c => NOT_THIS_DAY.test(c) && detectDate(c, today));
    const other = clauses.filter(c => c !== out).map(c => detectDate(c, today)).find(Boolean);
    if (out) { result.excludeDate = detectDate(out, today); result.date = other ?? null; result.intent = 'reschedule'; }
  }
  applyContext(result, context);
  // Rescheduling with two days in separate clauses ("hoy al final no llego, ¿mañana a la misma hora?"):
  // the new one is the last clause that has a day.
  if (result.intent === 'reschedule') {
    const clauses = message.split(/[,.;:!?¡¿]+|\s+pero\s+/i).map(normalize).filter(Boolean);
    const withDate = clauses.map(c => detectDate(c, today)).filter(Boolean);
    if (withDate.length > 1) result.date = withDate.at(-1);
  }
  result.missing = result.intent === 'book'
    ? ['service', 'date'].filter(k => !result[k])
    : [];
  result.understood = result.intent !== null;
  // intent null for two reasons: a known non-booking topic (photos, parking…) or no rule matched
  result.offTopic = NOT_BOOKING.test(t) && !EXPLICIT_BOOKING.test(t);
  result.normalizedText = t; // handy for reviewing messages that were not understood
  return result;
}

// Short answers ("tarde", "9:45", "o el lunes") can only be understood knowing what the bot asked
function applyContext(r, { lastQuestion = null, proposals = [], hasAppointment = false } = {}) {
  const fixed = ['confirm', 'cancel', 'check', 'price', 'hours', 'late', 'thanks', 'preamble', 'undecided', 'waitlist', 'wait', 'keep', 'duration', 'event', 'info', 'services', 'help', 'name'];
  if (fixed.includes(r.intent)) return;
  const anything = r.time || r.date || r.timeOfDay;
  if (lastQuestion === 'proposal') {
    // "la de la tarde" (pointing at one of the offered times) when only one of them is in the afternoon.
    // A plain "por la tarde" only narrows the search: it doesn't pick anything.
    if (!r.time && !r.date && r.timeOfDay && !r.noneOfThem &&
        /\b(la|el|esa|ese|esta|este) de (por )?(la |a )?(manana|tarde|mediodia)\b/.test(r.normalizedText ?? '')) {
      const [from, to] = { morning: [0, 14 * 60], midday: [13 * 60, 16 * 60], afternoon: [15 * 60, 24 * 60] }[r.timeOfDay];
      const fits = proposals.filter(p => { const [h, m] = p.split(':').map(Number); return h * 60 + m >= from && h * 60 + m < to; });
      if (fits.length === 1) { r.intent = 'choose'; r.time = fits[0]; r.understood = true; return; }
    }
    if ((r.time && proposals.includes(r.time)) || r.option) r.intent = 'choose';
    else if (anything || r.intent === 'reschedule') r.intent = 'reschedule';
  } else if (['day', 'timeOfDay', 'time'].includes(lastQuestion) && anything) {
    r.intent = 'choose';
  } else if (lastQuestion === 'service' && r.service) {
    r.intent = 'book';
  } else if (hasAppointment && anything && (r.intent === null || r.intent === 'book') && !r.service &&
             !/\b(quiero|queria|quisiera|necesito|otra cita|nueva cita|otra hora|tambien)\b/.test(r.normalizedText ?? '')) {
    // she has an appointment and only says a day/time: she means moving it. With a service or "quiero…" it is a
    // new booking ("quiero manicura el miércoles 18" while she already has a haircut)
    r.intent = 'reschedule';
  }
  r.understood = r.intent !== null;
}

// Customers write in several consecutive messages ("Hola" / "para alisado" / "el 12").
// Joins those that arrive less than `seconds` apart and understands them as one.
// messages: [{ text, date: Date }]
function understandBatch(messages, { seconds = 90, ...options } = {}) {
  const groups = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && (m.date - last.end) / 1000 <= seconds) {
      last.texts.push(m.text);
      last.end = m.date;
    } else {
      groups.push({ texts: [m.text], start: m.date, end: m.date });
    }
  }
  return groups.map(g => ({
    texts: g.texts,
    ...understand(g.texts.join('. '), { ...options, today: options.today ?? g.start }),
  }));
}

module.exports = { understand, understandBatch, normalize, REPLACEMENTS };
