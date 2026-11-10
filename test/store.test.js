// store.test.js — The SQLite store and bot.js end to end, on an in-memory database.
const assert = require('assert');
const { createStore } = require('../src/store');
const { MIGRATIONS } = require('../src/store/sqlite-store');
const { seedDemoData } = require('../src/demo-data');
const { handleMessage, resetConversation } = require('../src/bot');

const now = new Date(2026, 10, 10, 10, 0); // Tuesday 10 Nov 2026
const SALON = 'demo-peluqueria';
const BEAUTY = 'demo-estetica';

async function freshStore() {
  const store = createStore(':memory:');
  await seedDemoData(store);
  return store;
}
const say = (store, businessId, phone, text, at = now) => handleMessage(store, { businessId, phone, text, now: at });

const cases = {
  'runs every migration and seeds the demo salons once': async () => {
    const store = await freshStore();
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.deepEqual((await store.listBusinesses()).map(b => b.id).sort(), [BEAUTY, SALON]);
    assert.equal(await seedDemoData(store), false, 'does not seed twice');
    assert.ok((await store.listServices(BEAUTY)).every(s => s.id !== 'corte'), 'each salon has its own catalog');
  },

  'a booking is saved and survives a new conversation': async () => {
    const store = await freshStore();
    await say(store, SALON, '600 111 222', 'quiero cita para corte el viernes');
    await say(store, SALON, '600111222', 'la primera');
    await resetConversation(store, { businessId: SALON, phone: '600111222' });
    const r = await say(store, SALON, '+34 600-111-222', 'tengo cita?');
    assert.match(r.reply, /viernes 13 de noviembre/);
    assert.equal((await store.listAppointments(SALON)).length, 1);
  },

  'salons never see each other’s customers or appointments': async () => {
    const store = await freshStore();
    await say(store, SALON, '600111222', 'quiero cita para corte el viernes');
    await say(store, SALON, '600111222', 'la primera');
    const r = await say(store, BEAUTY, '600111222', 'tengo cita?');
    assert.match(r.reply, /no tienes ninguna cita/);
    assert.equal((await store.listAppointments(BEAUTY)).length, 0);
  },

  'two customers can’t get the same slot (capacity 1)': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'corte el viernes a las 10');
    await say(store, SALON, '611', 'sí');
    const r = await say(store, SALON, '622', 'corte el viernes a las 10');
    assert.match(r.reply, /A las 10:00 no me queda hueco/);
  },

  'a slot taken between the proposal and her answer is not double-booked': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'corte el viernes a las 10'); // offered 10:00 to 611
    await say(store, SALON, '622', 'corte el viernes a las 10');
    await say(store, SALON, '622', 'sí');                          // 622 takes it first
    const r = await say(store, SALON, '611', 'sí');
    assert.match(r.reply, /se acaba de ocupar/);
    assert.equal((await store.listAppointments(SALON)).length, 1);
  },

  'moving an appointment updates it instead of creating a second one': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'corte el viernes');
    await say(store, SALON, '611', 'la primera');
    await say(store, SALON, '611', 'me la puedes cambiar al lunes?');
    await say(store, SALON, '611', '1');
    const list = await store.listAppointments(SALON);
    assert.equal(list.length, 1);
    assert.equal(list[0].date, '2026-11-16');
  },

  'cancelling asks first, then marks it cancelled': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'corte el viernes');
    await say(store, SALON, '611', 'la primera');
    await say(store, SALON, '611', 'cancela la cita');
    assert.equal((await store.listAppointments(SALON)).length, 1, 'not cancelled yet');
    await say(store, SALON, '611', 'sí');
    assert.equal((await store.listAppointments(SALON)).length, 0);
    assert.equal((await store.listAppointments(SALON, { status: 'cancelled' })).length, 1);
  },

  '"lo de siempre" uses her last appointment': async () => {
    const store = await freshStore();
    const customer = await store.findOrCreateCustomer(SALON, '611');
    await store.createAppointment({ businessId: SALON, customerId: customer.id, service: 'mechas', name: 'Mechas',
      details: [{ id: 'mechas', group: 'mechas', name: 'Mechas', duration: 120 }], date: '2026-10-20', time: '10:00', duration: 120 });
    const r = await say(store, SALON, '611', 'lo de siempre el viernes');
    assert.match(r.reply, /Para mechas el viernes/);
  },

  'prices and the address come from the salon': async () => {
    const store = await freshStore();
    assert.match((await say(store, SALON, '611', 'cuanto cuesta un corte?')).reply, /Corte: 15 €/);
    assert.match((await say(store, BEAUTY, '611', 'dónde estáis?')).reply, /Diagonal 200/);
    assert.match((await say(store, BEAUTY, '612', 'abrís los lunes?')).reply, /de martes a sábado/);
  },

  'waiting list, owner inbox and message history are saved': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'si alguien cancela el jueves avísame');
    await say(store, SALON, '611', 'sabes si han llegado mis productos?');
    const waitlist = await store.listWaitlist(SALON);
    assert.equal(waitlist.length, 1);
    assert.equal(waitlist[0].date, '2026-11-12');
    assert.equal((await store.listHandovers(SALON)).length, 1);
    const customer = await store.findOrCreateCustomer(SALON, '611');
    assert.equal((await store.listMessages(SALON, customer.id)).length, 4); // 2 in, 2 out
  },

  'deleting a customer removes everything about her (GDPR)': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'corte el viernes');
    await say(store, SALON, '611', 'la primera');
    const customer = await store.findOrCreateCustomer(SALON, '611');
    await store.deleteCustomer(SALON, customer.id);
    assert.equal((await store.listAppointments(SALON)).length, 0);
    assert.equal(await store.getConversation(SALON, customer.id), null);
    assert.equal((await store.listMessages(SALON, customer.id)).length, 0);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.log(`✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\nStore tests: ${Object.keys(cases).length - failed}/${Object.keys(cases).length}`);
  process.exitCode = failed ? 1 : 0;
})();
