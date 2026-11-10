// server/index.js — Local test UI and HTTP API: pick a salon, type as a customer, see what the bot answers.
// Usage: npm start   (then open http://localhost:3000)
//
// No dependencies. Conversations, customers and appointments are saved in the store
// (private-data/booking-bot.db, git-ignored). On first start two demo salons are created.
//
// API (JSON):
//   GET  /api/businesses                              salons
//   POST /api/message      { businessId, phone, message, today? }   one customer message -> bot reply
//   POST /api/reset        { businessId, phone }      new conversation (appointments are kept)
//   POST /api/appointments { businessId, phone, today? }            gives her an appointment, for testing
//   GET  /api/overview?businessId=&phone=              calendar, owner inbox, her messages
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore, DEFAULT_FILE } = require('../src/store');
const { seedDemoData } = require('../src/demo-data');
const { handleMessage, resetConversation, makeIsFree, normalizePhone } = require('../src/bot');

const PORT = Number(process.env.PORT) || 3000;
const PAGE = path.join(__dirname, 'public', 'index.html');
// Messages the bot did not understand. Git-ignored: what you type may contain real customer data.
const NOT_UNDERSTOOD_FILE = process.env.NOT_UNDERSTOOD_FILE || path.join(__dirname, '..', 'private-data', 'not-understood.json');

const localISO = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

// Saves the message in the phrase-bank format, one entry per line, so that after filling in
// "expected" it can be added with:  npm run merge private-data/not-understood.json
// The same text in the same context is saved only once (its "count" goes up).
// The whole file is rewritten each time. If it can't be parsed (e.g. you are editing it and the
// JSON is broken for a moment), nothing is written, so existing entries are never lost.
function logNotUnderstood(message, state, now, understanding, businessId) {
  let entries = [];
  let raw = null;
  try { raw = fs.readFileSync(NOT_UNDERSTOOD_FILE, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err; // no file yet: start a new one
  }
  if (raw !== null && raw.trim()) {
    try { entries = JSON.parse(raw); } catch (err) {
      console.warn(`⚠ Not saved: ${NOT_UNDERSTOOD_FILE} is not valid JSON right now (${err.message}). Fix the file; it was left untouched.`);
      return 0;
    }
    if (!Array.isArray(entries)) {
      console.warn(`⚠ Not saved: ${NOT_UNDERSTOOD_FILE} must contain a JSON array. It was left untouched.`);
      return 0;
    }
  }
  const context = {};
  if (state?.lastQuestion) context.lastQuestion = state.lastQuestion;
  if (state?.proposals?.length) context.proposals = state.proposals;
  if (state?.appointment) context.hasAppointment = true;
  const key = e => e.text + '|' + JSON.stringify(e.context ?? {});
  const entry = {
    text: message,
    expected: {},
    today: localISO(now),
    ...(Object.keys(context).length ? { context } : {}),
    source: 'test-ui',
    business: businessId,
    note: understanding.offTopic ? 'off-topic on purpose (non-booking topic)' : 'no rule matched',
  };
  const existing = entries.find(e => key(e) === key(entry));
  if (existing) existing.count = (existing.count ?? 1) + 1;
  else entries.push(entry);
  fs.mkdirSync(path.dirname(NOT_UNDERSTOOD_FILE), { recursive: true });
  fs.writeFileSync(NOT_UNDERSTOOD_FILE, `[\n${entries.map(e => '  ' + JSON.stringify(e)).join(',\n')}\n]\n`);
  return entries.length;
}

// Explains in the terminal why the bot handed a message over to the owner.
function logHandover(message, state, result, savedCount, businessId) {
  const u = result.understanding;
  const reason = u.intent === 'price'
    ? 'price question: this service has no price in the catalog'
    : u.offTopic
      ? 'off-topic on purpose: matched the non-booking topics list (NOT_BOOKING in src/understand.js)'
      : 'no rule matched: no intent regex fired and no day, time or service was found';
  const found = [
    u.service && `service=${u.service}`,
    u.date && `date=${localISO(u.date).slice(0, 10)}`,
    u.timeOfDay && `timeOfDay=${u.timeOfDay}`,
    u.time && `time=${u.time}`,
  ].filter(Boolean).join(' ') || 'nothing';
  const context = [
    state?.lastQuestion && `lastQuestion=${state.lastQuestion}`,
    state?.proposals?.length && `proposals=${state.proposals.join(',')}`,
    state?.appointment && 'hasAppointment',
  ].filter(Boolean).join(' ') || 'none';
  console.log([
    '',
    `→ HANDED TO THE OWNER (${businessId})`,
    `  message:     ${JSON.stringify(message)}`,
    `  normalized:  ${JSON.stringify(u.normalizedText)}`,
    `  intent:      ${u.intent}`,
    `  reason:      ${reason}`,
    `  found:       ${found}`,
    `  context:     ${context}`,
    `  reply:       ${!result.silent ? JSON.stringify(result.reply) : result.silentReason === 'misunderstood' ? '(none: too many messages in a row not understood)' : '(none: it would repeat the previous reply)'}`,
    savedCount ? `  saved to:    private-data/not-understood.json (${savedCount} entries)` : null,
  ].filter(l => l !== null).join('\n'));
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const store = createStore();
const toISODate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function parseNow(today) {
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error('today is not a valid date'), { status: 400 });
  return now;
}
async function requireBusiness(id) {
  const b = id && await store.getBusiness(id);
  if (!b) throw Object.assign(new Error(`unknown businessId: ${id}`), { status: 400 });
  return b;
}
function requirePhone(phone) {
  if (!phone || !normalizePhone(phone)) throw Object.assign(new Error('phone is required'), { status: 400 });
  return normalizePhone(phone);
}

// For testing: gives her an appointment on the next open day at the first free slot from 10:00
async function seedAppointment({ businessId, phone, today }) {
  const business = await requireBusiness(businessId);
  const now = parseNow(today);
  const customer = await store.findOrCreateCustomer(businessId, requirePhone(phone));
  const service = (await store.listServices(businessId))[0];
  const s = business.settings;
  const d = new Date(now);
  for (let i = 0; i < 14; i++) {
    d.setDate(d.getDate() + 1);
    if ((s.closedWeekdays ?? []).includes(d.getDay())) continue;
    const date = toISODate(d);
    const isFree = makeIsFree(await store.listAppointments(businessId, { from: date, to: date }), { ...s, simulatedBusy: false });
    for (let m = 10 * 60; m + (service.duration ?? 30) <= 19 * 60; m += 30) {
      if (!isFree(date, m, service.duration ?? 30)) continue;
      const time = `${String(m / 60 | 0).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return store.createAppointment({ businessId, customerId: customer.id, service: service.group, name: service.name,
        details: [{ id: service.id, group: service.group, name: service.name, duration: service.duration }], date, time, duration: service.duration ?? 30 });
    }
  }
  throw new Error('no free slot in the next two weeks');
}

const routes = {
  'GET /': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(PAGE).pipe(res);
  },
  'GET /api/businesses': async () => (await store.listBusinesses()).map(b => ({ id: b.id, name: b.name, settings: b.settings })),

  'POST /api/message': async (req, res, body) => {
    const { businessId, phone, message, today } = body;
    if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { status: 400 });
    await requireBusiness(businessId);
    const now = parseNow(today);
    const customer = await store.findOrCreateCustomer(businessId, requirePhone(phone));
    const before = (await store.getConversation(businessId, customer.id))?.state ?? null;
    const result = await handleMessage(store, { businessId, phone, text: message, now });
    // Saved: messages it could not handle. Not saved: made-up text ("dkfjgh") and laughs/reactions it answered.
    const worthSaving = result.understanding.intent === null && result.fallback && !result.nonsense;
    const saved = worthSaving ? logNotUnderstood(message, before, now, result.understanding, businessId) : 0;
    if (result.nonsense) console.log(`\n? MADE-UP TEXT (not saved): ${JSON.stringify(message)}`);
    if (result.handover) logHandover(message, before, result, saved, businessId);
    else if (saved) console.log(`\n? NOT UNDERSTOOD: ${JSON.stringify(message)} — saved to private-data/not-understood.json (${saved} entries)`);
    return result;
  },

  'POST /api/reset': async (req, res, { businessId, phone }) => {
    await requireBusiness(businessId);
    await resetConversation(store, { businessId, phone: requirePhone(phone) });
    return { ok: true };
  },

  'POST /api/appointments': async (req, res, body) => seedAppointment(body),

  'GET /api/overview': async (req, res, body, url) => {
    const businessId = url.searchParams.get('businessId');
    await requireBusiness(businessId);
    const phone = url.searchParams.get('phone');
    const from = toISODate(new Date(Date.now() - 86400000 * 30));
    const customer = phone && normalizePhone(phone) ? await store.findOrCreateCustomer(businessId, normalizePhone(phone)) : null;
    return {
      appointments: await store.listAppointments(businessId, { from }),
      inbox: await store.listHandovers(businessId),
      waitlist: await store.listWaitlist(businessId),
      messages: customer ? await store.listMessages(businessId, customer.id, { limit: 100 }) : [],
      customer,
    };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname === '/index.html' ? '/' : url.pathname}`];
  try {
    if (!handler) return sendJSON(res, 404, { error: 'Not found' });
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const result = await handler(req, res, raw ? JSON.parse(raw) : {}, url);
    if (!res.headersSent) sendJSON(res, 200, result);
  } catch (err) {
    if (!res.headersSent) sendJSON(res, err.status ?? 500, { error: err.message });
  }
});

require('../src/dictionary').isKnownWord('hola'); // load the word list now, not on the first message

seedDemoData(store).then(created => {
  if (created) console.log('Created the demo salons: demo-peluqueria, demo-estetica');
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Booking bot test UI: http://localhost:${PORT}`);
    console.log(`Data: ${process.env.BOOKING_DB || DEFAULT_FILE}`);
  });
});
