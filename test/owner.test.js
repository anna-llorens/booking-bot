// owner.test.js — Owner mode: the phrases (src/owner/understand-owner.js) and whole conversations through
// bot.js on an in-memory database (login, confirm, undo, and what customers see afterwards).
const assert = require('assert');
const { createStore } = require('../src/store');
const { seedDemoData } = require('../src/demo-data');
const { handleMessage, OWNER_WELCOME } = require('../src/bot');
const { understandOwner } = require('../src/owner/understand-owner');
const { instantAt } = require('../src/timezone');

// ---- phrases ----
const bank = require('./fixtures/owner-phrases.json');
const catalog = require('../src/catalog.json').services;
const [y, mo, d] = bank.today.slice(0, 10).split('-').map(Number);
const today = new Date(y, mo - 1, d, 10, 0);
let phraseFailures = 0;
for (const p of bank.phrases) {
  const u = understandOwner(p.text, { today, catalog });
  const wrong = Object.entries(p.expected).filter(([k, v]) => JSON.stringify(u[k]) !== JSON.stringify(v));
  if (wrong.length) {
    phraseFailures++;
    console.log(`✗ "${p.text}": ${wrong.map(([k, v]) => `${k} = ${JSON.stringify(u[k])}, expected ${JSON.stringify(v)}`).join('; ')}`);
  }
}
console.log(`Owner phrases: ${bank.phrases.length - phraseFailures}/${bank.phrases.length}`);

// ---- conversations ----
const now = instantAt('2026-11-10T10:00', 'Europe/Madrid'); // Tuesday 10 Nov 2026
const SALON = 'demo-peluqueria';
const OWNER = '600999000';
const CUSTOMER = '600111222';

async function freshStore(settings = {}) {
  const store = createStore(':memory:');
  await seedDemoData(store);
  for (const b of await store.listBusinesses()) {
    await store.saveBusiness({ ...b, settings: { ...b.settings, askForNotes: false, simulatedBusy: false, ...settings } });
  }
  return store;
}
const say = (store, phone, text) => handleMessage(store, { businessId: SALON, phone, text, now });
const settingsOf = async store => (await store.getBusiness(SALON)).settings;
const priceOf = async (store, id) => (await store.listServices(SALON, { includeInactive: true })).find(s => s.id === id).price;

const cases = {
  'login → close Thursday → sí → a customer is told it is closed': async () => {
    const store = await freshStore();
    const login = await say(store, OWNER, 'LOGIN:OWNER');
    assert.equal(login.reply, OWNER_WELCOME);
    const ask = await say(store, OWNER, 'el jueves cierro');
    assert.match(ask.reply, /¿Cierro el jueves 12 de noviembre\? \(sí \/ no\)/);
    assert.ok(!(await settingsOf(store)).closedDates.includes('2026-11-12'), 'nothing changes before "sí"');
    const done = await say(store, OWNER, 'sí');
    assert.match(done.reply, /Hecho/);
    assert.ok((await settingsOf(store)).closedDates.includes('2026-11-12'));
    const customer = await say(store, CUSTOMER, '¿el jueves abrís?');
    assert.match(customer.reply, /cerrad/);
    assert.ok(!customer.owner);
  },

  'setPrice → no → the price is unchanged': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    const ask = await say(store, OWNER, 'sube el tinte a 38');
    assert.match(ask.reply, /¿Pongo Tinte a 38 €\?/);
    const no = await say(store, OWNER, 'no');
    assert.match(no.reply, /no cambio nada/);
    assert.equal(await priceOf(store, 'tinte'), 35);
    assert.equal((await store.listOwnerChanges(SALON)).length, 0);
  },

  'closing a day with appointments warns and never cancels them': async () => {
    const store = await freshStore();
    await say(store, CUSTOMER, 'quiero cita para corte el jueves a las 10');
    await say(store, CUSTOMER, 'sí');
    const [appt] = await store.listAppointments(SALON);
    assert.equal(appt?.date, '2026-11-12', 'the customer has an appointment on Thursday');
    await say(store, OWNER, 'login:owner');
    const ask = await say(store, OWNER, 'el jueves cierro');
    assert.match(ask.reply, /Ojo: ese día tienes 1 cita/);
    assert.match(ask.reply, /NO se cancelan solas/);
    assert.match(ask.reply, /¿Cierro igualmente/);
    await say(store, OWNER, 'sí');
    assert.equal((await store.listAppointments(SALON)).length, 1, 'the appointment is still booked');
  },

  'a change, then "deshacer" puts it back': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    await say(store, OWNER, 'el tinte a 40 €');
    await say(store, OWNER, 'vale');
    assert.equal(await priceOf(store, 'tinte'), 40);
    const undo = await say(store, OWNER, 'deshacer');
    assert.match(undo.reply, /Deshecho/);
    assert.equal(await priceOf(store, 'tinte'), 35);
    assert.match((await say(store, OWNER, 'deshacer')).reply, /No hay ningún cambio/);
    const [change] = await store.listOwnerChanges(SALON);
    assert.equal(change.type, 'setPrice');
    assert.ok(change.undoneAt);
  },

  'login:owner with devOwnerLogin off is a normal customer message': async () => {
    const store = await freshStore({ devOwnerLogin: false });
    const r = await say(store, OWNER, 'login:owner');
    assert.ok(!r.owner);
    assert.notEqual(r.reply, OWNER_WELCOME);
    const next = await say(store, OWNER, 'el jueves cierro');
    assert.ok(!next.owner, 'still a customer');
  },

  'logout goes back to the customer bot': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    const out = await say(store, OWNER, 'logout');
    assert.match(out.reply, /Has salido del modo dueña/);
    const r = await say(store, OWNER, 'quiero cita para corte el viernes');
    assert.ok(!r.owner);
    assert.match(r.reply, /viernes/);
  },

  'an owner phone is in owner mode directly; "modo clienta" and "modo dueña" switch': async () => {
    const store = await freshStore({ devOwnerLogin: false, ownerPhones: ['+34 600 999 000'] });
    const r = await say(store, OWNER, '¿qué tengo hoy?');
    assert.ok(r.owner);
    assert.match(r.reply, /Hoy \(martes 10 de noviembre\)/);
    assert.match((await say(store, OWNER, 'modo clienta')).reply, /Modo clienta/);
    assert.ok(!(await say(store, OWNER, 'hola')).owner);
    assert.equal((await say(store, OWNER, 'modo dueña')).reply, OWNER_WELCOME);
  },

  'special hours for one day reach the customer bot (dateOverrides)': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    await say(store, OWNER, 'mañana abro a las 10');
    await say(store, OWNER, 'sí');
    assert.deepEqual((await settingsOf(store)).dateOverrides['2026-11-11'], [['10:00', '13:30'], ['16:30', '20:00']]);
    const r = await say(store, CUSTOMER, '¿mañana a qué hora abrís?');
    assert.match(r.reply, /de 10:00 a 13:30/);
    const early = await say(store, CUSTOMER, 'quiero corte mañana a las 9:30');
    assert.doesNotMatch(early.reply, /9:30 te va bien|¿Te apunto .*9:30/);
  },

  'weekly hours: "a partir de ahora los sábados cierro a las 13"': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    const ask = await say(store, OWNER, 'a partir de ahora los sábados cierro a las 13');
    assert.match(ask.reply, /los sábados abres de 9:00 a 13:00/);
    await say(store, OWNER, 'sí');
    assert.deepEqual((await settingsOf(store)).hours.sat, [['09:00', '13:00']]);
    assert.match((await say(store, OWNER, 'deshacer')).reply, /Deshecho/);
    assert.deepEqual((await settingsOf(store)).hours.sat, [['09:00', '14:00']]);
  },

  'a service turned off is no longer offered to customers': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    await say(store, OWNER, 'ya no hago permanente');
    await say(store, OWNER, 'sí');
    assert.ok(!(await store.listServices(SALON)).some(s => s.id === 'permanente'));
    assert.ok((await store.listServices(SALON, { includeInactive: true })).some(s => s.id === 'permanente'));
  },

  'booking by hand: a taken time offers others; the appointment is saved with her name': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    await say(store, OWNER, 'apunta a Ana mañana a las 10 para corte');
    await say(store, OWNER, 'sí');
    const taken = await say(store, OWNER, 'apunta a Lucía mañana a las 10 para corte');
    assert.match(taken.reply, /no hay hueco/);
    const ask = await say(store, OWNER, 'a las 11');
    assert.match(ask.reply, /¿Apunto a Lucía mañana \(miércoles 11 de noviembre\) a las 11:00 para Corte/);
    await say(store, OWNER, 'sí');
    const agenda = await store.listAgenda(SALON, { from: '2026-11-11', to: '2026-11-11' });
    assert.deepEqual(agenda.map(a => [a.time, a.customerName]), [['10:00', 'Ana'], ['11:00', 'Lucía']]);
    const day = await say(store, OWNER, 'citas de mañana');
    assert.match(day.reply, /10:00 Ana — Corte/);
    assert.match(day.reply, /11:00 Lucía — Corte/);
  },

  'cancel and move appointments, asking which one when there are several': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    for (const t of ['apunta a Ana el jueves a las 10 para corte', 'apunta a Ana el viernes a las 17 para corte']) {
      await say(store, OWNER, t); await say(store, OWNER, 'sí');
    }
    const which = await say(store, OWNER, 'cancela la cita de Ana');
    assert.match(which.reply, /Hay 2 citas/);
    assert.match((await say(store, OWNER, '1')).reply, /¿Cancelo la cita de Ana el jueves 12/);
    await say(store, OWNER, 'sí');
    const move = await say(store, OWNER, 'mueve la de las 17:00 del viernes a las 18:00');
    assert.match(move.reply, /¿Paso la cita de Ana/);
    await say(store, OWNER, 'sí');
    const left = await store.listAppointments(SALON);
    assert.deepEqual(left.map(a => [a.date, a.time]), [['2026-11-13', '18:00']]);
  },

  '"queratina 4h": says how long it is now and asks; "queratina" shows duration and price': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    assert.match((await say(store, OWNER, 'queratina')).reply, /Tratamiento de keratina: 2 h · sin precio/);
    const ask = await say(store, OWNER, 'queratina 4h');
    assert.match(ask.reply, /Ahora mismo Tratamiento de keratina dura 2 h\. ¿Lo cambio a 4 h\? \(sí \/ no\)/);
    assert.match((await say(store, OWNER, 'sí')).reply, /Ahora Tratamiento de keratina dura 4 h \(antes 2 h\)/);
    assert.equal((await store.listServices(SALON)).find(x => x.id === 'queratina').duration, 240);
  },

  'inbox: numbered list, one message with 3 options, reply to the customer; the reply lands in her chat': async () => {
    const store = await freshStore();
    await say(store, CUSTOMER, '¿hacéis descuento a estudiantes?');
    await say(store, '600111333', 'me dejé el paraguas el otro día, ¿lo tenéis?');
    await say(store, OWNER, 'login:owner');
    const list = await say(store, OWNER, '¿qué me han preguntado?');
    assert.match(list.reply, /Tienes 2 mensajes sin contestar:\n1\) \+34 600 111 333: «me dejé el paraguas/);
    const item = await say(store, OWNER, '2');
    assert.match(item.reply, /estudiantes.*\n[\s\S]*1\. Ignorar\n2\. Responder a la clienta\n3\. Responder y que el bot lo conteste solo/);
    assert.match((await say(store, OWNER, '2')).reply, /Escribe lo que le contesto/);
    assert.match((await say(store, OWNER, 'Sí, un 10 % con el carnet')).reply, /¿Le envío esto/);
    const sent = await say(store, OWNER, 'sí');
    assert.match(sent.reply, /Enviado[\s\S]*Quedan 1/);
    assert.deepEqual(sent.outbound.map(o => o.phone), ['34600111222']);
    const customer = await store.findOrCreateCustomer(SALON, '34600111222');
    assert.equal((await store.listMessages(SALON, customer.id)).at(-1).text, 'Sí, un 10 % con el carnet');
    assert.equal((await store.listHandovers(SALON)).length, 1, 'answered = no longer pending');
    // same numbers as the list: 1 is still the umbrella; "1" then option 1 ignores it at once
    await say(store, OWNER, '1');
    assert.match((await say(store, OWNER, '1')).reply, /Ignorado[\s\S]*No quedan mensajes/);
    assert.equal((await store.listHandovers(SALON)).length, 0);
    assert.match((await say(store, OWNER, 'deshacer')).reply, /Deshecho/);
    assert.equal((await store.listHandovers(SALON)).length, 1, 'undo puts it back');
  },

  'teach: the next customer who asks the same gets the owner\'s answer, not a handover': async () => {
    const store = await freshStore();
    await say(store, CUSTOMER, '¿tenéis tarjetas regalo?');
    await say(store, OWNER, 'login:owner');
    await say(store, OWNER, '¿qué me han preguntado?');
    await say(store, OWNER, '1');
    await say(store, OWNER, '3');
    assert.match((await say(store, OWNER, 'Sí, de 20, 30 o 50 €')).reply, /contestaré eso yo sola/);
    await say(store, OWNER, 'sí');
    const other = await say(store, '600222333', 'tenéis tarjetas regalo');
    assert.ok(!other.handover);
    assert.match(other.reply, /^Sí, de 20, 30 o 50 €/);
    assert.equal((await store.listHandovers(SALON)).length, 0);
    assert.match((await say(store, OWNER, '¿qué respuestas has aprendido?')).reply, /1\) «¿tenéis tarjetas regalo\?» → «Sí, de 20, 30 o 50 €»/);
    await say(store, OWNER, 'olvida la respuesta 1');
    await say(store, OWNER, 'sí');
    assert.ok((await say(store, '600222444', 'tenéis tarjetas regalo')).handover, 'forgotten: back to the owner');
  },

  '"ignora todos" asks first; noise ("p", "sss", "login") never reaches the inbox': async () => {
    const store = await freshStore();
    for (const t of ['p', 'sss', 'login']) {
      const r = await say(store, CUSTOMER, t);
      assert.ok(!r.handover, t);
    }
    assert.equal((await store.listHandovers(SALON)).length, 0);
    await say(store, CUSTOMER, '¿vendéis productos?');
    await say(store, '600111333', '¿tenéis tarjetas regalo?');
    await say(store, OWNER, 'login:owner');
    assert.match((await say(store, OWNER, 'ignora todos')).reply, /¿Quito estos 2 mensajes de pendientes\?/);
    await say(store, OWNER, 'sí');
    assert.equal((await store.listHandovers(SALON)).length, 0);
  },

  'owner demo data: named customers in the agenda, questions in the inbox': async () => {
    const store = await freshStore();
    const { seedOwnerDemo } = require('../src/demo-data');
    const { makeIsFree } = require('../src/bot');
    const { closedReason } = require('../src/reply');
    const r = await seedOwnerDemo(store, SALON, new Date(2026, 10, 10, 10), { makeIsFree, closedReason });
    assert.ok(r.created && r.appointments >= 8, JSON.stringify(r));
    assert.equal((await seedOwnerDemo(store, SALON, new Date(2026, 10, 10, 10), { makeIsFree, closedReason })).created, false);
    await say(store, OWNER, 'login:owner');
    assert.match((await say(store, OWNER, '¿qué tengo hoy?')).reply, /17:00 Ana García — Corte de mujer/);
    const inbox = await say(store, OWNER, '¿qué me han preguntado?');
    assert.match(inbox.reply, /Tienes 5 mensajes/);
    assert.match((await say(store, OWNER, '1')).reply, /Antes, el bot le había dicho: «Para tratamiento de keratina/);
    assert.match((await say(store, OWNER, 'citas del mes')).reply, /Este mes tienes 9 citas/);
  },

  'anything else: "No te he entendido", and nothing changes': async () => {
    const store = await freshStore();
    await say(store, OWNER, 'login:owner');
    const r = await say(store, OWNER, 'asdf qwerty');
    assert.match(r.reply, /No te he entendido 😅 Escribe \*ayuda\*/);
    assert.equal((await store.listOwnerChanges(SALON)).length, 0);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.log(`✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\nOwner conversations: ${Object.keys(cases).length - failed}/${Object.keys(cases).length}`);
  process.exitCode = failed || phraseFailures ? 1 : 0;
})();
