// format.js — Dates, times, service names and other small text helpers for the replies. Pure.
const H = require('../hours');

const euros = n => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;

const TIME_OF_DAY_RANGES = {     // [from, to) in minutes since midnight
  morning: [0, 14 * 60],
  midday: [13 * 60, 16 * 60],
  afternoon: [15 * 60, 24 * 60],
};

const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const toHHMM = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

const toISODate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromISODate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function formatDate(iso, today) {
  const d = fromISODate(iso);
  const diff = Math.round((d - fromISODate(toISODate(today))) / 86400000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  const weekday = d.toLocaleDateString('es-ES', { weekday: 'long' });
  const month = d.toLocaleDateString('es-ES', { month: 'long' });
  return `el ${weekday} ${d.getDate()} de ${month}`;
}

// Name to show for a detected service. If she only named the general service ("manicura", "uñas"),
// don't claim a variant she didn't ask for: "Manicura básica" becomes "Manicura".
function displayName(d) {
  return d.id && d.id === d.group ? d.name.replace(/ b[aá]sic[oa]$/i, '') : d.name;
}

function serviceLabel(p) {
  if (p.service === 'LAST') return 'lo de siempre';
  if (p.details?.length) {
    // nail art on top of another manicure: "manicura semipermanente con dibujos"
    const others = p.details.filter(d => d.id !== 'nail_art');
    if (others.length && others.length < p.details.length) {
      const names = others.map(d => displayName(d).toLowerCase());
      return (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]) + ' con dibujos';
    }
    const names = p.details.map(d => displayName(d).toLowerCase());
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0];
  }
  return p.service;
}

function listTimes(times) {
  if (times.length === 1) return `a las ${times[0]}`;
  return times.map((t, i) => `${i + 1}) ${t}`).join('  ');
}

// Details worth writing down for the stylist: "solo las puntas", "es para mi hija", "soy alérgica…",
// "tengo el pelo muy largo", "un diseño de flores", "sin secador". The whole message is kept as the note.
const NOTE_HINT = /\b(solo (las puntas|un poco|sanear|arreglar|retocar|las raices|el flequillo|repasar)|(es|seria|sera|son) para (mi|mis) \w+|para mi (hija|hijo|hijas|hijos|madre|padre|marido|mujer|pareja|novio|novia|amiga|hermana|hermano|abuela|suegra|nieta|sobrina)|alergi\w*|alergic\w*|sensibl\w*|embarazad\w*|piel (sensible|atopica|seca|grasa)|(tengo|tiene) el (pelo|cabello)|(pelo|cabello) (muy |bastante )?(largo|corto|rizado|liso|fino|grueso|tenido|danado|seco)|diseno|dibuj\w*|en (color|tono) \w+|color (nude|rojo|rosa|blanco|negro|granate|burdeos|natural)|(con|sin) (secado|secador|lavado|plancha|ondas|flequillo)|flequillo|como en la foto|te (mando|paso|envio) (una )?foto|no me (cortes|quites|toques)|poco a poco|que no (me |le |te )?(corte|quite|toque|pinte)s?)\b/;

const noteFrom = (message, t) => NOTE_HINT.test(t) ? message.trim().replace(/\s+/g, ' ').slice(0, 200) : null;

// "¿Qué día…" → "¿qué día…" (skips the opening ¿ / ¡)
const lowerFirst = s => s.replace(/^([¿¡]?)(\p{L})/u, (_, p, c) => p + c.toLowerCase());

// A few of the salon's own general services, from different categories, as examples in questions:
// "corte, tinte, mechas, manicura" for a hair salon, "limpieza facial, depilación, manicura…" for a beauty center.
const COMMON_SERVICES = ['corte', 'tinte', 'mechas', 'manicura', 'depilacion', 'facial', 'peinado', 'pedicura', 'masaje', 'barba'];

function serviceExamples(services, max = 4) {
  const rank = s => { const i = COMMON_SERVICES.indexOf(s.group); return i < 0 ? COMMON_SERVICES.length : i; };
  const general = services.filter(s => s.id === s.group).sort((a, b) => rank(a) - rank(b));
  return general.slice(0, max).map(s => displayName(s).toLowerCase());
}

// Groups consecutive weekdays (Monday → Sunday) with the same text: [{ days: 'de lunes a viernes', text }]
function groupWeekdays(textByDay) {
  const groups = [];
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const text = textByDay[d];
    if (text == null) continue;
    const last = groups.at(-1);
    if (last && last.text === text && last.days.at(-1) === (d === 0 ? 6 : d - 1)) last.days.push(d); else groups.push({ text, days: [d] });
  }
  return groups.map(g => ({ text: g.text, days: g.days.length === 1 ? `los ${H.DAY_PLURALS[g.days[0]]}`
    : g.days.length === 2 ? `los ${H.DAY_PLURALS[g.days[0]]} y ${H.DAY_PLURALS[g.days[1]]}` : `de ${H.DAY_NAMES[g.days[0]]} a ${H.DAY_NAMES[g.days.at(-1)]}` }));
}

module.exports = { euros, TIME_OF_DAY_RANGES, toMinutes, toHHMM, toISODate, fromISODate, formatDate, displayName, serviceLabel, listTimes, NOTE_HINT, noteFrom, lowerFirst, COMMON_SERVICES, serviceExamples, groupWeekdays };
