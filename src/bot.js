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
// Owner mode: when the salon owner writes (a phone in settings.ownerPhones, or "login:owner" in testing),
// src/owner/reply-owner.js answers instead of reply.js, and this file applies the changes she confirms
// (closures, hours, prices, appointments) and records each one in owner_changes so "deshacer" can revert it.
//
// understand.js and reply.js never touch the store; this file is the only place that does.
const { respond, newConversation, isSimulatedBusy, closedReason, DEFAULT_BUSINESS } = require('./reply');
const { respondOwner } = require('./owner/reply-owner');
const { salonNow } = require('./timezone');
const { dayHours, fitsInside } = require('./hours');

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

// Free if fewer than `capacity` booked appointments overlap [start, start + duration), and the customer has
// none of her own at that time (she can't be in two places, whatever the capacity).
// isFree(date, start, duration, { ignoreId }): ignoreId = the appointment being moved, so it can reuse its slot.
function makeIsFree(appointments, settings, own = []) {
  const capacity = settings.capacity ?? 1;
  return (date, start, duration, { ignoreId = null } = {}) => {
    if (closedReason(date, settings)) return false; // weekly day off, public holiday or holidays
    if (!fitsInside(dayHours(settings, date), start, duration)) return false; // inside one open interval (split days)
    if (settings.simulatedBusy && isSimulatedBusy(date, start)) return false;
    const end = start + duration;
    const overlaps = a => a.id !== ignoreId && a.date === date && toMinutes(a.time) < end && start < toMinutes(a.time) + a.duration;
    if (own.some(overlaps)) return false;
    return appointments.filter(overlaps).length < capacity;
  };
}

// `now` is the real moment the message arrived (WhatsApp timestamp). It is turned into the salon's
// wall-clock time (settings.timezone, Europe/Madrid by default) before anything else uses it.
async function handleMessage(store, { businessId, phone, text, now: instant }) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new TypeError('handleMessage(): pass { now } as a valid Date');
  const business = await store.getBusiness(businessId);
  if (!business) throw new Error(`Unknown business: ${businessId}`);
  const services = await store.listServices(businessId);
  const customer = await store.findOrCreateCustomer(businessId, normalizePhone(phone));
  const now = salonNow(instant, business.settings.timezone ?? DEFAULT_BUSINESS.timezone);
  const today = toISODate(now);

  // Conversation: continue it, or start fresh if it has been idle too long
  const saved = await store.getConversation(businessId, customer.id);
  const idleHours = saved ? (Date.now() - new Date(saved.updatedAt)) / 3.6e6 : Infinity;
  let state = saved && idleHours < CONVERSATION_TIMEOUT_HOURS ? saved.state : newConversation();

  // The store is the source of truth for appointments, not the conversation. She may have several:
  // the conversation keeps which one it is talking about (focusId); otherwise the soonest.
  const mine = await store.listCustomerAppointments(businessId, customer.id, today);
  const upcoming = mine.find(a => a.id === state.focusId) ?? mine[0] ?? null;
  // The owner (or a tester after "login:owner") gets owner mode instead of the customer bot
  const owner = await handleOwner(store, { business, customer, state, text, now, today });
  if (owner) return owner;

  state = { ...state, appointment: toStateAppointment(upcoming), appointments: mine.map(toStateAppointment) };
  const last = await store.getLastAppointment(businessId, customer.id, today);

  // load the calendar as far as the diary is open
  const until = new Date(now); until.setDate(until.getDate() + (business.settings.maxDaysAhead ?? DEFAULT_BUSINESS.maxDaysAhead));
  const calendar = await store.listAppointments(businessId, { from: today, to: toISODate(until) });
  // reply.js passes { ignoreId } only when moving an appointment, so it can reuse its own slot
  const isFree = makeIsFree(calendar, business.settings, mine);

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
    if (!makeIsFree(fresh, { ...business.settings, simulatedBusy: false }, mine)(after.date, toMinutes(after.time), after.duration, { ignoreId: after.id })) {
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
  let newState = { ...result.state, ...(state.ownerMode !== undefined ? { ownerMode: state.ownerMode } : {}), cancelledId: null, appointment: toStateAppointment(appointment), appointments: nowMine.map(toStateAppointment), focusId: appointment?.id ?? null };
  if (conflict) {
    // keep what she was booking (service, day): "sí" looks for other times for that same service
    reply = 'Vaya, esa hora ya no está libre 😔 ¿Te busco otra?';
    const { id, name, time, notes, ...rest } = after;
    newState = { ...newState, lastQuestion: 'offerBooking', proposals: [], mode: after.id ? 'reschedule' : 'book',
      pending: { ...result.state.pending, ...rest, notesAsked: true, ...(notes ? { notes: [notes] } : {}) } };
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

// ---- owner mode ----

const OWNER_WELCOME = 'Hola 👋 Modo dueña activado. Puedes preguntarme por tu agenda o cambiar horarios, cierres y precios. Escribe *ayuda* para ver ejemplos.';
const DEV_LOGIN = 'login:owner'; // testing only: works only with settings.devOwnerLogin = true
const SETTINGS_CHANGES = ['closeDate', 'closeRange', 'openDate', 'setDayHours', 'setWeeklyHours'];
const CATALOG_CHANGES = { setPrice: 'price', setDuration: 'duration', disableService: 'active', enableService: 'active' };

class SlotTaken extends Error {}

// settings + { key: value }; a null value removes the key (it did not exist before)
function withSettings(settings, values) {
  const next = { ...settings };
  for (const [k, v] of Object.entries(values ?? {})) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}

// Returns the owner-mode reply, or null when the message is for the customer bot
async function handleOwner(store, { business, customer, state, text, now, today }) {
  const settings = business.settings;
  const isOwnerPhone = (settings.ownerPhones ?? []).map(normalizePhone).includes(customer.phone);
  const command = text.trim().toLowerCase();
  const devLogin = command === DEV_LOGIN && settings.devOwnerLogin === true;
  // owner phones are in owner mode unless they chose "modo clienta"; testers only while devOwnerLogin is on
  const allowed = isOwnerPhone || settings.devOwnerLogin === true;
  const ownerMode = allowed && (state.ownerMode ?? isOwnerPhone);

  const finish = async (newState, reply, intent, extra = {}) => {
    await store.saveConversation(business.id, customer.id, newState);
    await store.addMessage({ businessId: business.id, customerId: customer.id, direction: 'in', text, intent: `owner:${intent ?? 'unknown'}` });
    if (reply) await store.addMessage({ businessId: business.id, customerId: customer.id, direction: 'out', text: reply });
    return {
      reply, silent: !reply, owner: true, ownerMode: newState.ownerMode, changes: [], handover: false, fallback: false,
      understanding: { intent: `owner:${intent ?? 'unknown'}`, normalizedText: command }, state: newState,
      appointment: null, appointments: [], customer, business: { id: business.id, name: business.name }, ...extra,
    };
  };

  if (!ownerMode) {
    const enter = devLogin || (isOwnerPhone && /^(modo due[ñn][ao]|login:owner)$/.test(command));
    return enter ? finish({ ...state, ownerMode: true, owner: {} }, OWNER_WELCOME, 'login') : null;
  }
  if (devLogin || /^modo due[ñn][ao]$/.test(command)) return finish({ ...state, ownerMode: true, owner: {} }, OWNER_WELCOME, 'login');

  const catalog = await store.listServices(business.id, { includeInactive: true });
  const appointments = await store.listAgenda(business.id, { from: today });
  const result = respondOwner(text, state.owner ?? {}, {
    today: now,
    business: { ...settings, name: business.name },
    catalog,
    appointments,
    inbox: await store.listHandovers(business.id),
    waitlist: await store.listWaitlist(business.id),
    lastChange: await store.getLastOwnerChange(business.id),
    isFree: makeIsFree(appointments, { ...settings, simulatedBusy: false }),
  });
  const intent = result.understanding.intent;

  if (result.logout) {
    const reply = isOwnerPhone
      ? 'Modo clienta 👤 Ahora te contesto como a una clienta, para que pruebes el bot. Escribe *modo dueña* para volver.'
      : 'Has salido del modo dueña 👋 Ahora te contesto como a una clienta.';
    return finish({ ...newConversation(), ownerMode: false }, reply, 'logout');
  }

  let reply = result.reply;
  const applied = [];
  for (const change of result.changes) {
    try {
      applied.push(await applyOwnerChange(store, business.id, change));
    } catch (err) {
      if (!(err instanceof SlotTaken)) throw err;
      reply = 'Vaya, esa hora se acaba de ocupar 😔 No he cambiado nada. Dime otra hora.';
    }
  }
  return finish({ ...state, ownerMode: true, owner: result.state }, reply, intent, { changes: applied });
}

// Applies one confirmed change and records it (owner_changes) with what it replaced
async function applyOwnerChange(store, businessId, change) {
  if (change.type === 'undo') return undoOwnerChange(store, businessId, change.changeId);
  const business = await store.getBusiness(businessId);
  const settings = business.settings;
  let data = change;
  let previous = change.previous ?? null;
  if (SETTINGS_CHANGES.includes(change.type)) {
    // what is replaced is read now, not when the question was asked
    previous = Object.fromEntries(Object.keys(change.set).map(k => [k, settings[k] ?? null]));
    await store.saveBusiness({ ...business, settings: withSettings(settings, change.set) });
  } else if (CATALOG_CHANGES[change.type]) {
    const key = CATALOG_CHANGES[change.type];
    await store.updateService(businessId, change.serviceId, { [key]: change[key] });
  } else if (change.type === 'bookManual' || change.type === 'moveAppointment') {
    // someone may have booked that time since the question: check again
    const day = await store.listAppointments(businessId, { from: change.date, to: change.date });
    const current = change.appointmentId ? (await store.listAgenda(businessId, {})).find(a => a.id === change.appointmentId) : null;
    const duration = change.duration ?? current?.duration;
    const free = makeIsFree(day, { ...settings, simulatedBusy: false });
    if (!free(change.date, toMinutes(change.time), duration, { ignoreId: change.appointmentId ?? null })) throw new SlotTaken();
    if (change.type === 'bookManual') {
      const customer = await store.findOrCreateManualCustomer(businessId, change.name);
      const a = await store.createAppointment({
        businessId, customerId: customer.id, service: change.service, name: change.serviceName, details: change.details,
        date: change.date, time: change.time, duration: change.duration,
      });
      data = { ...change, appointmentId: a.id };
    } else {
      await store.updateAppointment(businessId, change.appointmentId, { date: change.date, time: change.time });
    }
  } else if (change.type === 'cancelAppointment') {
    await store.cancelAppointment(businessId, change.appointmentId);
  } else {
    throw new Error(`Unknown owner change: ${change.type}`);
  }
  const id = await store.addOwnerChange({ businessId, type: change.type, data, previous });
  return { ...data, id, previous };
}

// "deshacer": reverts the last change not undone yet
async function undoOwnerChange(store, businessId, changeId) {
  const c = await store.getLastOwnerChange(businessId);
  if (!c || c.id !== changeId) return { type: 'undo', changeId, skipped: true };
  if (SETTINGS_CHANGES.includes(c.type)) {
    const business = await store.getBusiness(businessId);
    await store.saveBusiness({ ...business, settings: withSettings(business.settings, c.previous) });
  } else if (CATALOG_CHANGES[c.type]) {
    await store.updateService(businessId, c.data.serviceId, c.previous);
  } else if (c.type === 'bookManual') {
    await store.cancelAppointment(businessId, c.data.appointmentId);
  } else if (c.type === 'cancelAppointment') {
    await store.updateAppointment(businessId, c.data.appointmentId, { status: 'booked' });
  } else if (c.type === 'moveAppointment') {
    await store.updateAppointment(businessId, c.data.appointmentId, c.previous);
  }
  await store.markOwnerChangeUndone(businessId, c.id);
  return { type: 'undo', changeId, undid: c.type };
}

// Starts a new conversation for this customer (her appointments are kept)
async function resetConversation(store, { businessId, phone }) {
  const customer = await store.findOrCreateCustomer(businessId, normalizePhone(phone));
  await store.deleteConversation(businessId, customer.id);
  return customer;
}

module.exports = { handleMessage, resetConversation, makeIsFree, normalizePhone, CONVERSATION_TIMEOUT_HOURS, OWNER_WELCOME };
