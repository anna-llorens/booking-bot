// bot.js — The application layer: one incoming WhatsApp message in, one reply out, everything saved.
//
//   handleMessage(store, { businessId, phone, text, now })
//
//   1. loads the business (settings + catalog), the customer (by phone) and her conversation
//   2. loads her upcoming appointment, her last service ("lo de siempre") and the business calendar
//   3. calls reply.js (pure: no I/O) with all of that
//   4. saves what changed: the appointment (create / move / cancel), the conversation state,
//      both messages, and a handover to the owner's inbox when needed
//
// understand.js and reply.js never touch the store; this file is the only place that does.
const { respond, newConversation, isSimulatedBusy, closedReason, DEFAULT_BUSINESS } = require('./reply');

// A conversation idle for longer than this starts fresh (her appointments are kept, they live in the store)
const CONVERSATION_TIMEOUT_HOURS = 8;

const toISODate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// One customer = one number, however it is written: "600 111 222", "+34 600-111-222" and "0034600111222"
// all become "34600111222". Numbers without a country code are Spanish.
const DEFAULT_COUNTRY_CODE = '34';
function normalizePhone(phone) {
  let digits = String(phone).replace(/\D/g, '').replace(/^00/, '');
  if (digits.length === 9) digits = DEFAULT_COUNTRY_CODE + digits;
  return digits;
}

// The conversation state only needs the fields reply.js uses
const toStateAppointment = a => a && { id: a.id, service: a.service, name: a.name, details: a.details, duration: a.duration, date: a.date, time: a.time, notes: a.notes ?? null };

// Free if fewer than `capacity` booked appointments overlap [start, start + duration).
// `ignoreId`: her own appointment, so moving it can reuse its slot.
function makeIsFree(appointments, settings, ignoreId) {
  const capacity = settings.capacity ?? 1;
  return (date, start, duration) => {
    if (closedReason(date, settings)) return false; // weekly day off, public holiday or holidays
    if (settings.simulatedBusy && isSimulatedBusy(date, start)) return false;
    const end = start + duration;
    const overlapping = appointments.filter(a => a.id !== ignoreId && a.date === date &&
      toMinutes(a.time) < end && start < toMinutes(a.time) + a.duration);
    return overlapping.length < capacity;
  };
}

async function handleMessage(store, { businessId, phone, text, now = new Date() }) {
  const business = await store.getBusiness(businessId);
  if (!business) throw new Error(`Unknown business: ${businessId}`);
  const services = await store.listServices(businessId);
  const customer = await store.findOrCreateCustomer(businessId, normalizePhone(phone));
  const today = toISODate(now);

  // Conversation: continue it, or start fresh if it has been idle too long
  const saved = await store.getConversation(businessId, customer.id);
  const idleHours = saved ? (Date.now() - new Date(saved.updatedAt)) / 3.6e6 : Infinity;
  let state = saved && idleHours < CONVERSATION_TIMEOUT_HOURS ? saved.state : newConversation();

  // The store is the source of truth for appointments, not the conversation. She may have several:
  // the conversation keeps which one it is talking about (focusId); otherwise the soonest.
  const mine = await store.listCustomerAppointments(businessId, customer.id, today);
  const upcoming = mine.find(a => a.id === state.focusId) ?? mine[0] ?? null;
  state = { ...state, appointment: toStateAppointment(upcoming), appointments: mine.map(toStateAppointment) };
  const last = await store.getLastAppointment(businessId, customer.id, today);

  // load the calendar as far as the diary is open
  const until = new Date(now); until.setDate(until.getDate() + (business.settings.maxDaysAhead ?? DEFAULT_BUSINESS.maxDaysAhead));
  const calendar = await store.listAppointments(businessId, { from: today, to: toISODate(until) });
  // her focused appointment's own slot counts as free, so moving it can reuse it
  const isFree = makeIsFree(calendar, business.settings, upcoming?.id);

  const result = respond(text, state, {
    today: now,
    now,
    services,
    business: { ...business.settings, name: business.name },
    isFree,
    usual: last?.details?.length ? last.details : null,
  });

  // Persist what changed. Each appointment is compared with itself (by id): talking about a different one of
  // her appointments ("la del corte") is not a change.
  const after = result.state.appointment;
  const stored = after?.id ? mine.find(a => a.id === after.id) : null;
  let appointment = stored ?? null;
  let conflict = false;
  const moved = after && (!after.id || !stored || after.date !== stored.date || after.time !== stored.time || after.service !== stored.service);
  if (moved) {
    // Someone else may have taken the slot since the bot proposed it: check again against a fresh calendar
    const fresh = await store.listAppointments(businessId, { from: after.date, to: after.date });
    if (!makeIsFree(fresh, { ...business.settings, simulatedBusy: false }, after.id)(after.date, toMinutes(after.time), after.duration)) {
      conflict = true;
    } else if (stored) {
      appointment = await store.updateAppointment(businessId, stored.id, { date: after.date, time: after.time, service: after.service, name: after.name, details: after.details, duration: after.duration, notes: after.notes ?? null });
    } else {
      appointment = await store.createAppointment({ businessId, customerId: customer.id, ...after, id: undefined });
    }
  }
  if (result.state.cancelledId && mine.some(a => a.id === result.state.cancelledId)) {
    await store.cancelAppointment(businessId, result.state.cancelledId);
    if (appointment?.id === result.state.cancelledId) appointment = null;
  }

  let reply = result.reply;
  const nowMine = await store.listCustomerAppointments(businessId, customer.id, today);
  let newState = { ...result.state, cancelledId: null, appointment: toStateAppointment(appointment), appointments: nowMine.map(toStateAppointment), focusId: appointment?.id ?? null };
  if (conflict) {
    reply = 'Vaya, esa hora se acaba de ocupar 😔 ¿Te busco otra? Dime qué día te va bien.';
    newState = { ...newState, lastQuestion: 'day', proposals: [], pending: { ...result.state.pending, ...after, date: undefined, time: undefined } };
  }
  await store.saveConversation(businessId, customer.id, newState);

  // Message history and owner's inbox
  await store.addMessage({ businessId, customerId: customer.id, direction: 'in', text, intent: result.understanding.intent });
  if (reply) await store.addMessage({ businessId, customerId: customer.id, direction: 'out', text: reply });
  if (result.waitlist) await store.addToWaitlist({ businessId, customerId: customer.id, ...result.waitlist });
  if (result.handover) {
    const reason = result.understanding.intent === 'price' ? 'price' : result.understanding.offTopic ? 'off-topic' : 'not understood';
    await store.addHandover({ businessId, customerId: customer.id, message: text, reason });
  }

  return { ...result, reply, silent: result.silent && !conflict, state: newState, appointment, appointments: nowMine, customer, business: { id: business.id, name: business.name } };
}

// Starts a new conversation for this customer (her appointments are kept)
async function resetConversation(store, { businessId, phone }) {
  const customer = await store.findOrCreateCustomer(businessId, normalizePhone(phone));
  await store.deleteConversation(businessId, customer.id);
  return customer;
}

module.exports = { handleMessage, resetConversation, makeIsFree, normalizePhone, CONVERSATION_TIMEOUT_HOURS };
