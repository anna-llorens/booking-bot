// demo-data.js — Two sample businesses to try the bot with (created on first start if the store is empty).
// Real businesses are added the same way: saveBusiness() + saveServices() with their own catalog.
const SAMPLE_CATALOG = require('./catalog.json').services;

// Example prices (euros). Services without a price are handed to the owner when someone asks.
const PRICES = {
  corte: 15, corte_mujer: 22, corte_hombre: 14, corte_puntas: 10, tinte: 35, tinte_raices: 28, mechas: 60,
  peinado: 18, barba: 10, manicura: 15, manicura_semipermanente: 22, manicura_francesa: 25, pedicura: 25,
  depilacion_cejas: 8, depilacion_labio: 6, depilacion_piernas: 25, facial: 40,
};
// Example descriptions ("¿en qué consiste?"). Each salon writes its own; services without one go to the stylist.
const DESCRIPTIONS = {
  microblading: 'Es un maquillaje semipermanente de cejas: se dibujan pelo a pelo con una cuchilla muy fina y pigmento, para darles forma y densidad. Dura alrededor de un año y se recomienda un retoque al mes.',
  queratina: 'Es un tratamiento alisador: se aplica keratina en el pelo y se sella con plancha. Quita el encrespamiento y deja el pelo liso y brillante durante unos 3-4 meses.',
  manicura_semipermanente: 'Es una manicura con esmalte que se seca con lámpara: no se descascarilla y dura unas 2-3 semanas.',
  manicura_rusa: 'Es una manicura en seco, con torno, que limpia muy bien la cutícula. El esmalte queda pegado a la piel y dura más.',
  mechas_balayage: 'Son mechas pintadas a mano, más claras en las puntas, con un efecto natural y degradado.',
  laminado_cejas: 'Es un tratamiento que alisa y fija el pelo de las cejas hacia arriba para que se vean más pobladas y peinadas. Dura unas 6 semanas.',
};
const withPrices = services => services.map(s => ({
  ...s,
  ...(PRICES[s.id] != null ? { price: PRICES[s.id] } : {}),
  ...(DESCRIPTIONS[s.id] ? { description: DESCRIPTIONS[s.id] } : {}),
}));

const BEAUTY_CATEGORIES = ['estetica_facial', 'estetica_corporal', 'depilacion', 'manicura_pedicura', 'pestanas_cejas'];

const DEMO_BUSINESSES = [
  {
    id: 'demo-peluqueria',
    name: 'Peluquería Demo',
    settings: {
      // split hours (a lunch break) and Saturdays mornings only
      hours: {
        mon: [['09:30', '13:30'], ['16:30', '20:00']], tue: [['09:30', '13:30'], ['16:30', '20:00']],
        wed: [['09:30', '13:30'], ['16:30', '20:00']], thu: [['09:30', '13:30'], ['16:30', '20:00']],
        fri: [['09:30', '13:30'], ['16:30', '20:00']], sat: [['09:00', '14:00']],
      },
      slotMinutes: 30, maxProposals: 2, capacity: 1,
      address: 'Carrer Major 12, Barcelona',
      closedDates: ['2026-12-08', '2026-12-25', '2027-01-01', '2027-01-06'],
      closedRanges: [{ from: '2027-08-09', to: '2027-08-22', reason: 'vacaciones' }],
      info: {
        walkIn: 'Trabajamos con cita previa, pero si tenemos un hueco libre te atendemos sin problema 😊',
        payment: 'Puedes pagar en efectivo, con tarjeta o con Bizum.',
        parking: 'Hay un parking público a 50 metros (Carrer Major 30) y zona azul en la misma calle.',
        children: '¡Claro! Los peques pueden venir contigo; tenemos un rincón con cuentos para ellos.',
        pets: 'Si es pequeña y tranquila, puede venir contigo 🐶',
        cancellationPolicy: 'Te pedimos que avises con al menos 24 horas. No cobramos nada por cancelar, pero así podemos darle el hueco a otra clienta.',
        latePolicy: 'Te esperamos hasta 15 minutos. Si llegas más tarde intentamos atenderte, pero puede que tengamos que acortar el servicio o cambiarte la cita.',
      },
      simulatedBusy: true, // also block the simulated busy slots, so the demo calendar isn't empty
      // TESTING ONLY: lets anyone type "login:owner" to try owner mode. Never turn it on for a real salon:
      // real owners are recognized by their number (settings.ownerPhones).
      devOwnerLogin: true,
    },
    services: withPrices(SAMPLE_CATALOG),
  },
  {
    id: 'demo-estetica',
    name: 'Centro de Estética Demo',
    settings: {
      opens: '10:00', closes: '19:00', closedWeekdays: [0, 1], slotMinutes: 30, maxProposals: 2, capacity: 2,
      address: 'Avinguda Diagonal 200, Barcelona',
      closedDates: ['2026-12-08', { date: '2026-12-26', reason: 'Sant Esteve' }],
      closedRanges: [{ from: '2026-12-28', to: '2027-01-06', reason: 'vacaciones de Navidad' }],
      info: {
        walkIn: 'Solo atendemos con cita previa.',
        payment: 'Aceptamos tarjeta y efectivo (no Bizum).',
        children: 'Preferimos que vengas sin niños, por seguridad en las cabinas.',
        pets: 'Lo sentimos, no se admiten mascotas en el centro.',
        cancellationPolicy: 'Avisa con 24 horas. Si cancelas el mismo día, cobramos el 50 % del servicio.',
        latePolicy: 'Tenemos un margen de 10 minutos; a partir de ahí puede que tengamos que cambiarte la cita.',
        // parking: not filled in, so parking questions go to the owner
      },
      simulatedBusy: true,
      devOwnerLogin: true, // TESTING ONLY (see above)
    },
    services: withPrices(SAMPLE_CATALOG.filter(s => BEAUTY_CATEGORIES.includes(s.category))),
  },
];

// Creates the demo salons on first start. On later starts it only refreshes the demo salons' settings and
// catalog (so new settings such as holidays reach an existing database); real salons are never touched.
// A demo salon changed from owner mode is not refreshed either, so those changes survive a restart.
async function seedDemoData(store) {
  if ((await store.listBusinesses()).length) {
    for (const b of DEMO_BUSINESSES) {
      if (!(await store.getBusiness(b.id))) continue;
      if ((await store.listOwnerChanges(b.id, { limit: 1 })).length) continue;
      await store.saveBusiness(b);
      await store.saveServices(b.id, b.services);
    }
    return false;
  }
  for (const b of DEMO_BUSINESSES) {
    await store.saveBusiness(b);
    await store.saveServices(b.id, b.services);
  }
  return true;
}

// ---- owner-mode demo data: named customers, appointments this week, questions in the inbox, a waiting list ----

const OWNER_DEMO_CUSTOMERS = [
  ['34600100001', 'Ana García'], ['34600100002', 'Marta López'], ['34600100003', 'Lucía Pérez'],
  ['34600100004', 'Carmen Ruiz'], ['34600100005', 'Laura Sánchez'],
];
// [customer index, service id, open day (0 = today), time wanted]
const OWNER_DEMO_APPOINTMENTS = [
  [0, 'corte_mujer', 0, '17:00'], [1, 'tinte', 0, '18:00'], [2, 'manicura_semipermanente', 1, '10:00'],
  [3, 'mechas', 1, '16:30'], [4, 'corte', 2, '11:00'], [0, 'peinado', 2, '18:30'], [1, 'pedicura', 3, '10:30'],
  [2, 'queratina', 4, '09:30'], [3, 'depilacion_cejas', 4, '12:00'],
];
// [customer index, what the bot had said, her message (handed to the owner)]
const OWNER_DEMO_INBOX = [
  [3, '¡Hola! 😊 ¿En qué te puedo ayudar? Te puedo dar cita, cambiarla o anularla.', '¿hacéis descuento a estudiantes?'],
  [4, '¡Perfecto! Te apunto para corte. ¡Hasta entonces! 😊', '¿vendéis productos?'],
  [0, '¡A ti! 😊', 'me dejé el paraguas el otro día, ¿lo tenéis?'],
  [1, '¡Hola! 😊 ¿En qué te puedo ayudar? Te puedo dar cita, cambiarla o anularla.', '¿tenéis tarjetas regalo?'],
  [2, 'Para tratamiento de keratina tengo: 1) 09:30  2) 16:30. ¿Cuál te va mejor?', '¿se puede lavar el pelo al día siguiente?'],
];

// Names for demo customers known only by their number (the ones typed in the test UI)
const DEMO_NAMES = ['María Gómez', 'Elena Torres', 'Sofía Navarro', 'Paula Romero', 'Julia Molina', 'Clara Ortiz', 'Irene Vidal',
  'Noelia Castro', 'Rosa Iglesias', 'Alba Serrano', 'Nuria Delgado', 'Eva Morales', 'Silvia Rubio', 'Teresa Blanco', 'Lorena Prieto'];

// Fills a demo salon for trying owner mode ("¿qué tengo hoy?", "¿qué me han preguntado?"). `now` is the salon's
// wall-clock time (a Date). Runs once per salon: if the demo customers exist already, it does nothing.
async function seedOwnerDemo(store, businessId, now, { makeIsFree, closedReason }) {
  const business = await store.getBusiness(businessId);
  if (!business) throw new Error(`Unknown business: ${businessId}`);
  // every time: a name for the customers that only have a number, so the agenda reads like a real one
  let named = 0;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const taken = new Set((await store.listCustomers(businessId, today)).map(c => c.name).filter(Boolean));
  for (const c of await store.listCustomers(businessId, today)) {
    if (c.name || c.phone.startsWith('manual:')) continue;
    const name = DEMO_NAMES.find(n => !taken.has(n));
    if (!name) break;
    await store.updateCustomer(businessId, c.id, { name });
    taken.add(name);
    named++;
  }
  const known = (await store.listAgenda(businessId, {})).some(a => a.customerPhone === OWNER_DEMO_CUSTOMERS[0][0]);
  if (known) return { created: false, named };
  const customers = [];
  for (const [phone, name] of OWNER_DEMO_CUSTOMERS) {
    const c = await store.findOrCreateCustomer(businessId, phone);
    await store.updateCustomer(businessId, c.id, { name });
    customers.push({ ...c, name });
  }
  const services = await store.listServices(businessId);
  const settings = { ...business.settings, simulatedBusy: false };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // the next open days, from today
  const openDays = [];
  for (let d = new Date(now); openDays.length < 6; d.setDate(d.getDate() + 1)) if (!closedReason(iso(d), settings)) openDays.push(iso(d));
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  let booked = 0;
  for (const [who, serviceId, day, wanted] of OWNER_DEMO_APPOINTMENTS) {
    const s = services.find(x => x.id === serviceId) ?? services.find(x => x.group === serviceId.split('_')[0]);
    if (!s) continue; // not in this salon's catalog
    const date = openDays[day];
    const duration = s.duration ?? 30;
    const isFree = makeIsFree(await store.listAppointments(businessId, { from: date, to: date }), settings);
    // the time wanted, or the next free one that day
    for (let m = toMin(wanted); m < 22 * 60; m += 30) {
      if (!isFree(date, m, duration)) continue;
      await store.createAppointment({ businessId, customerId: customers[who].id, service: s.group, name: s.name,
        details: [{ id: s.id, group: s.group, name: s.name, duration }], date, time: hhmm(m), duration });
      booked++;
      break;
    }
  }
  for (const [who, before, message] of OWNER_DEMO_INBOX) {
    const customerId = customers[who].id;
    await store.addMessage({ businessId, customerId, direction: 'out', text: before });
    await store.addMessage({ businessId, customerId, direction: 'in', text: message });
    await store.addMessage({ businessId, customerId, direction: 'out', text: 'Te contestaremos enseguida. ¿Puedo ayudarte en algo más?' });
    await store.addHandover({ businessId, customerId, message, reason: 'not understood' });
  }
  const tinte = services.find(x => x.group === 'tinte') ?? services[0];
  await store.addToWaitlist({ businessId, customerId: customers[1].id, service: tinte.group, details: [{ id: tinte.id, group: tinte.group, name: tinte.name }], date: openDays[1], timeOfDay: 'morning' });
  await store.addToWaitlist({ businessId, customerId: customers[4].id, earlier: true });
  return { created: true, appointments: booked, inbox: OWNER_DEMO_INBOX.length, waitlist: 2, named };
}

module.exports = { DEMO_BUSINESSES, seedDemoData, seedOwnerDemo };
