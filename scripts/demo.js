// demo.js — Quick look at what understand() returns for a few phrases.
// Usage: npm run demo
const { understand } = require('../src/understand');

const today = new Date(2026, 10, 10, 10, 0); // Tuesday 10 Nov 2026
const phrases = [
  'Hola! queria pedir cita para cortarme el pelo el martes por la tarde si puede ser',
  'tienes hueco mañana por la mañana para un tiente?',
  'lo de siempre el viernes a las 5 y media',
  'Buenas, necesito mechas el 14 de noviembre',
  'puedo ir pasado mañana a las 17:30 para la barba',
  'tengo que cancelar la cita del jueves',
  'me la puedes cambiar a otro dia?',
  'cuanto cuesta el tinte?',
  'a que hora abris el sabado',
  'el lunes de la semana que viene para peinarme',
  'holaaaa',
  'mi perro se ha comido el sofá',
];

for (const p of phrases) {
  const r = understand(p, { today });
  const date = r.date ? r.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '-';
  console.log(`${p}\n  → ${r.intent ?? 'NOT UNDERSTOOD'} | ${r.service ?? '-'} | ${date} | ${r.timeOfDay ?? '-'} | ${r.time ?? '-'} | missing: ${r.missing.join(', ') || '-'}\n`);
}
