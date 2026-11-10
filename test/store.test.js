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
  // these tests book in one step; the notes question has its own test
  for (const b of await store.listBusinesses()) await store.saveBusiness({ ...b, settings: { ...b.settings, askForNotes: false } });
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
    // reply.js already sees the slot is gone (calendar loaded for this message); bot.js re-checks for real races
    assert.match(r.reply, /ya no puedo darte cita|se acaba de ocupar/);
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

  'public holidays from the salon settings are closed, also for makeIsFree': async () => {
    const store = await freshStore();
    const at = new Date(2026, 10, 30, 10, 0);
    const r = await say(store, SALON, '611', 'quiero cita para corte el 8 de diciembre', at);
    assert.match(r.reply, /cerrados \(festivo\)/);
    assert.doesNotMatch(r.reply, /8 de diciembre:/);
    const { makeIsFree } = require('../src/bot');
    const settings = (await store.getBusiness(SALON)).settings;
    assert.equal(makeIsFree([], { ...settings, simulatedBusy: false })('2026-12-08', 600, 30), false);
    assert.equal(makeIsFree([], { ...settings, simulatedBusy: false })('2026-12-09', 600, 30), true);
  },

  'notes are asked before booking and saved with the appointment; the salon name is answered': async () => {
    const store = createStore(':memory:');
    await seedDemoData(store); // demo settings as shipped: askForNotes on
    await say(store, SALON, '611', 'tienes un hueco para el martes unas ?');
    assert.match((await say(store, SALON, '611', '2')).reply, /apunte algo especial/);
    assert.equal((await store.listAppointments(SALON)).length, 0, 'not booked before answering');
    await say(store, SALON, '611', 'en tono nude, porfa');
    const [a] = await store.listAppointments(SALON);
    assert.equal(a.notes, 'en tono nude, porfa');
    assert.match((await say(store, SALON, '622', 'como se llama la peluqueria?')).reply, /Somos Peluquería Demo/);
  },

  'several appointments: lists them, asks which one to change or cancel, never touches the other': async () => {
    const store = await freshStore();
    const c = await store.findOrCreateCustomer(SALON, require('../src/bot').normalizePhone('611'));
    await store.createAppointment({ businessId: SALON, customerId: c.id, service: 'corte', name: 'Corte',
      details: [{ id: 'corte', group: 'corte', name: 'Corte', duration: 30 }], date: '2026-11-11', time: '10:30', duration: 30 });
    let at = new Date(2026, 10, 10, 10);
    const s = async t => { at = new Date(at.getTime() + 60000); return (await say(store, SALON, '611', t, at)).reply; };
    await s('quiero manicura el miércoles 18');
    await s('el miercoles a las 17:30');
    await s('sí');
    assert.equal((await store.listAppointments(SALON)).length, 2, 'the haircut is untouched, the manicure is new');
    assert.match(await s('mis citas'), /Tienes 2 citas/);
    assert.match(await s('me puedes cambiar la cita?'), /¿Cuál quieres cambiar\?/);
    await s('la del corte');
    await s('el jueves a las 12');
    await s('sí');
    const list = await store.listAppointments(SALON);
    assert.deepEqual(list.map(a => `${a.name} ${a.date} ${a.time}`).sort(), ['Corte 2026-11-12 12:00', 'Manicura 2026-11-18 17:30']);
    assert.match(await s('cancela la cita'), /¿Cuál quieres anular\?/);
    await s('la de la manicura');
    await s('sí');
    assert.deepEqual((await store.listAppointments(SALON)).map(a => a.name), ['Corte']);
  },

  '"¿en qué consiste?" answers from the salon\'s service description': async () => {
    const store = await freshStore();
    await say(store, SALON, '611', 'microblading');
    assert.match((await say(store, SALON, '611', 'en que consiste?')).reply, /maquillaje semipermanente de cejas/);
  },

  'her own appointments block those times for a new booking; moving one can reuse its own time': async () => {
    const store = await freshStore();
    const { normalizePhone } = require('../src/bot');
    for (const salon of [SALON, BEAUTY]) { // BEAUTY has capacity 2: she still can't be in two places
      const c = await store.findOrCreateCustomer(salon, normalizePhone('611'));
      const svc = salon === SALON ? { service: 'corte', name: 'Corte', id: 'corte' } : { service: 'cejas', name: 'Depilación de cejas', id: 'depilacion_cejas' };
      await store.createAppointment({ businessId: salon, customerId: c.id, service: svc.service, name: svc.name,
        details: [{ id: svc.id, group: svc.service, name: svc.name, duration: 30 }], date: '2026-11-12', time: '18:00', duration: 30 });
      const at = new Date(2026, 10, 10, 10);
      const ask = salon === SALON ? 'quiero cita para tinte el jueves a las 18' : 'quiero cita para manicura el jueves a las 18';
      const r = await say(store, salon, '611', ask, at);
      assert.match(r.reply, /A las 18:00 no me queda hueco/, `${salon}: her own 18:00 appointment blocks it`);
    }
    // moving the haircut to the same day can keep 18:00 (its own slot)
    await resetConversation(store, { businessId: SALON, phone: '611' });
    const at = new Date(2026, 10, 10, 11);
    const r = await say(store, SALON, '611', 'me puedes cambiar la cita al jueves a las 18:00?', at);
    assert.doesNotMatch(r.reply, /no me queda hueco/);
  },

  'a slot taken at the last moment offers other times for the same service': async () => {
    const store = await freshStore();
    const at = new Date(2026, 10, 10, 10);
    await say(store, SALON, '611', 'tinte el jueves a las 12', at);   // offered 12:00 to 611
    await say(store, SALON, '622', 'corte el jueves a las 12', at);
    await say(store, SALON, '622', 'sí', at);                         // 622 takes it
    const r = await say(store, SALON, '611', 'sí', at);
    assert.match(r.reply, /a las 12:00 ya no puedo darte cita 😔 Para tinte el jueves/, 'other times for the same service, right away');
    assert.equal((await store.listAppointments(SALON)).length, 1, 'no double booking');
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
