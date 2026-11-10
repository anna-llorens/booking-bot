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
