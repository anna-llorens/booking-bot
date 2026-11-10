// demo-data.js — Two sample businesses to try the bot with (created on first start if the store is empty).
// Real businesses are added the same way: saveBusiness() + saveServices() with their own catalog.
const SAMPLE_CATALOG = require('./catalog.json').services;

// Example prices (euros). Services without a price are handed to the owner when someone asks.
const PRICES = {
  corte: 15, corte_mujer: 22, corte_hombre: 14, corte_puntas: 10, tinte: 35, tinte_raices: 28, mechas: 60,
  peinado: 18, barba: 10, manicura: 15, manicura_semipermanente: 22, manicura_francesa: 25, pedicura: 25,
  depilacion_cejas: 8, depilacion_labio: 6, depilacion_piernas: 25, facial: 40,
};
const withPrices = services => services.map(s => (PRICES[s.id] != null ? { ...s, price: PRICES[s.id] } : s));

const BEAUTY_CATEGORIES = ['estetica_facial', 'estetica_corporal', 'depilacion', 'manicura_pedicura', 'pestanas_cejas'];

const DEMO_BUSINESSES = [
  {
    id: 'demo-peluqueria',
    name: 'Peluquería Demo',
    settings: {
      opens: '09:30', closes: '20:00', closedWeekdays: [0], slotMinutes: 30, maxProposals: 2, capacity: 1,
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
    },
    services: withPrices(SAMPLE_CATALOG.filter(s => BEAUTY_CATEGORIES.includes(s.category))),
  },
];

// Creates the demo salons on first start. On later starts it only refreshes the demo salons' settings and
// catalog (so new settings such as holidays reach an existing database); real salons are never touched.
async function seedDemoData(store) {
  if ((await store.listBusinesses()).length) {
    for (const b of DEMO_BUSINESSES) {
      if (!(await store.getBusiness(b.id))) continue;
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

module.exports = { DEMO_BUSINESSES, seedDemoData };
