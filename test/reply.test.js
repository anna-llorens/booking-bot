// reply.test.js — Checks a few full conversations through respond().
const assert = require('assert');
const { respond, newConversation } = require('../src/reply');

const today = new Date(2026, 10, 10, 10, 0); // Tuesday 10 Nov 2026

function chat(messages, state = newConversation()) {
  const turns = [];
  for (const m of messages) {
    const r = respond(m, state, { today });
    state = r.state;
    turns.push(r);
  }
  return turns;
}

const cases = {
  'asks for the missing service and day, then books the chosen slot': () => {
    const t = chat(['quiero cita', 'para un corte', 'el viernes por la tarde', 'la segunda']);
    assert.equal(t[0].state.lastQuestion, 'service');
    assert.equal(t[1].state.lastQuestion, 'proposal', 'with no day, it proposes the first free times instead of asking');
    assert.equal(t[1].state.proposals.length, 2);
    assert.equal(t[2].state.lastQuestion, 'proposal');
    const appt = t[3].state.appointment;
    assert.equal(appt.service, 'corte');
    assert.equal(appt.date, '2026-11-13');
    assert.equal(appt.time, t[2].state.proposals[1]);
  },
  'reschedules and then cancels an existing appointment': () => {
    const t = chat(['corte el viernes', '1', 'me la puedes cambiar al jueves?', '1', 'cancela la cita', 'sí']);
    assert.equal(t[3].state.appointment.date, '2026-11-12');
    assert.match(t[3].reply, /cambiado/);
    assert.ok(t[4].state.appointment, 'asks before cancelling');
    assert.match(t[4].reply, /anule o prefieres cambiarla/);
    assert.equal(t[5].state.appointment, null);
  },
  'refuses closed days': () => {
    const [r] = chat(['quiero cita el domingo para corte']);
    assert.match(r.reply, /cerrados/);
    assert.equal(r.state.lastQuestion, 'proposal', 'it proposes the next open day');
    assert.equal(r.state.pending.date, '2026-11-16');
  },
  'hands over prices and unrelated messages to the owner': () => {
    const t = chat(['cuanto cuesta el tinte?', 'mi perro se ha comido el sofá']);
    assert.ok(t[0].handover);
    assert.ok(t[1].handover);
  },
  'after a handover it offers more help and understands "no" and "sí"': () => {
    let t = chat(['sabes si ya han llegado mis productos?', 'no']);
    assert.match(t[0].reply, /¿Puedo ayudarte en algo más\?$/);
    assert.equal(t[1].handover, false);
    assert.match(t[1].reply, /buen día/);
    t = chat(['sabes si ya han llegado mis productos?', 'si', 'quiero cita para corte']);
    assert.match(t[1].reply, /Dime/);
    assert.equal(t[2].state.lastQuestion, 'proposal');
  },
  'understands follow-ups after opening hours and prices': () => {
    let t = chat(['abrís los sábados?', 'Y por la tarde también?']);
    assert.match(t[1].reply, /por la tarde también/);
    t = chat(['quería saber si hacéis manicura semipermanente', 'Y cuánto cuesta más o menos?', 'Genial gracias']);
    assert.match(t[0].reply, /^¡Sí, hacemos manicura semipermanente!/);
    // a price question in the middle of a booking keeps the booking going
    assert.match(t[1].reply, /precio de manicura semipermanente\. Para manicura semipermanente .* tengo/);
    t = chat(['cuanto cuesta el tinte?', 'Genial gracias']);
    assert.match(t[1].reply, /buen día/);
  },
  'proposes the first free day when any day is fine': () => {
    const [r] = chat(['corte, me da igual el día']);
    assert.equal(r.state.lastQuestion, 'proposal');
    assert.ok(r.state.pending.date);
  },
  'a side remark in the middle of a booking keeps the booking going': () => {
    const t = chat(['quería cita para peinarme el sábado', 'Tengo una boda por la noche']);
    assert.ok(t[1].handover);
    assert.equal(t[1].state.lastQuestion, 'proposal');
    assert.match(t[1].reply, /^Tomo nota/);
  },
  'when she is not sure she can come, asks whether to move or cancel': () => {
    const appt = { service: 'corte', name: 'Corte', duration: 30, date: '2026-11-11', time: '10:00' };
    let t = chat(['no se si podre ir mañana', 'mejor anúlala'], { ...newConversation(), appointment: appt });
    assert.match(t[0].reply, /cambiemos a otro día o prefieres anularla/);
    assert.equal(t[0].state.appointment.date, '2026-11-11'); // not moved yet
    assert.equal(t[1].state.appointment, null);
    t = chat(['no se si podre ir mañana', 'pásala al viernes', '1'], { ...newConversation(), appointment: appt });
    assert.equal(t[2].state.appointment.date, '2026-11-13');
  },
  'never sends the same reply twice in a row': () => {
    const t = chat(['vale', 'vale', 'vale', 'hola', 'vale']);
    assert.equal(t[0].reply, '¡Perfecto! 😊');
    assert.ok(t[1].silent && t[1].reply === '');
    assert.ok(t[2].silent);
    assert.ok(!t[3].silent);
    assert.ok(!t[4].silent, 'after a different reply it can say it again');
    let h = chat(['tenéis bizum?', 'tenéis bizum?']);
    assert.ok(h[1].silent && h[1].handover, 'same message again: silent, but the owner still gets it');
    h = chat(['tenéis bizum?', 'sabes si ya han llegado mis productos?']);
    assert.ok(!h[1].silent, 'a different question for the owner still gets its answer');
    h = chat(['oeoe', 'asdf']);
    assert.match(h[0].reply, /no te he entendido/);
    assert.ok(!h[0].handover);
    assert.match(h[1].reply, /^Sigo sin entenderte/, 'the second time it explains what it can do');
  },
  'goes silent after 2 messages in a row it does not understand': () => {
    const t = chat(['oeoe', 'hdhdhd', 'blabla', 'qwerty', 'quiero cita para corte']);
    assert.ok(!t[0].silent && !t[1].silent);
    assert.equal(t[2].silentReason, 'misunderstood');
    assert.ok(t[3].silent);
    assert.ok(!t[4].silent, 'answers again once she says something it understands');
    assert.match(t[0].reply, /no te he entendido/);
  },
  'made-up words vs. real words it does not know': () => {
    const [a] = chat(['asdf qwer']);
    assert.match(a.reply, /no te he entendido/);
    assert.ok(!a.handover, 'made-up text does not go to the owner');
    const [b] = chat(['con que nombre me tienes guardado?']);
    assert.ok(b.handover, 'a real question it cannot answer goes to the owner');
  },
  'does not mutate the state it receives': () => {
    const s = newConversation();
    respond('quiero cita para corte', s, { today });
    assert.deepEqual(s, newConversation());
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.log(`✗ ${name}\n    ${e.message}`); }
}
console.log(`\nReply tests: ${Object.keys(cases).length - failed}/${Object.keys(cases).length}`);
process.exitCode = failed ? 1 : 0;
