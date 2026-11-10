// sqlite-store.js — Store backed by SQLite (Node's built-in node:sqlite, no dependencies).
// One file holds every business; every table is keyed by business_id so salons never see each other's data.
// See src/store/README.md for the interface and docs/architecture.md for the data model.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// Each entry runs once, in order. Never edit an applied migration: add a new one.
const MIGRATIONS = [
  `CREATE TABLE businesses (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     settings    TEXT NOT NULL DEFAULT '{}',   -- JSON: opens, closes, closedWeekdays, capacity, address…
     created_at  TEXT NOT NULL
   );
   CREATE TABLE services (                     -- each business's catalog
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     id          TEXT NOT NULL,
     group_id    TEXT NOT NULL,
     category    TEXT,
     name        TEXT NOT NULL,
     duration    INTEGER,                      -- minutes
     price       REAL,                         -- euros, optional
     synonyms    TEXT NOT NULL DEFAULT '[]',   -- JSON array, Spanish
     active      INTEGER NOT NULL DEFAULT 1,
     position    INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (business_id, id)
   );
   CREATE TABLE customers (
     id           INTEGER PRIMARY KEY,
     business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     phone        TEXT NOT NULL,               -- WhatsApp number, digits only
     name         TEXT,
     created_at   TEXT NOT NULL,
     last_seen_at TEXT,
     UNIQUE (business_id, phone)
   );
   CREATE TABLE appointments (
     id           INTEGER PRIMARY KEY,
     business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     service      TEXT NOT NULL,               -- service group, e.g. 'corte'
     name         TEXT NOT NULL,               -- what was booked, as shown to her
     details      TEXT NOT NULL DEFAULT '[]',  -- JSON: the specific services
     date         TEXT NOT NULL,               -- YYYY-MM-DD
     time         TEXT NOT NULL,               -- HH:MM
     duration     INTEGER NOT NULL,
     status       TEXT NOT NULL DEFAULT 'booked',   -- booked | cancelled
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );
   CREATE INDEX appointments_by_day ON appointments (business_id, date, status);
   CREATE INDEX appointments_by_customer ON appointments (business_id, customer_id, date);
   CREATE TABLE conversations (
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     state       TEXT NOT NULL,                -- JSON: reply.js conversation state
     updated_at  TEXT NOT NULL,
     PRIMARY KEY (business_id, customer_id)
   );
   CREATE TABLE messages (
     id          INTEGER PRIMARY KEY,
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     direction   TEXT NOT NULL,                -- in (customer) | out (bot)
     text        TEXT NOT NULL,
     intent      TEXT,
     created_at  TEXT NOT NULL
   );
   CREATE INDEX messages_by_customer ON messages (business_id, customer_id, id);
   CREATE TABLE handovers (                    -- the owner's inbox
     id          INTEGER PRIMARY KEY,
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     message     TEXT NOT NULL,
     reason      TEXT,
     status      TEXT NOT NULL DEFAULT 'open', -- open | done
     created_at  TEXT NOT NULL
   );
   CREATE INDEX handovers_by_status ON handovers (business_id, status);`,

  // 2: waiting list ("avísame si se libera un hueco")
  `CREATE TABLE waitlist (
     id          INTEGER PRIMARY KEY,
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     service     TEXT,                         -- service group, if she said it
     details     TEXT NOT NULL DEFAULT '[]',
     date        TEXT,                         -- YYYY-MM-DD, if she said a day
     time_of_day TEXT,                         -- morning | midday | afternoon
     earlier     INTEGER NOT NULL DEFAULT 0,   -- "antes" than her current appointment
     status      TEXT NOT NULL DEFAULT 'waiting',   -- waiting | notified | done
     created_at  TEXT NOT NULL
   );
   CREATE INDEX waitlist_by_status ON waitlist (business_id, status, date);`,

  // 3: phones in international format (bot.js normalizePhone): "600111222" -> "34600111222"
  `UPDATE customers SET phone = '34' || phone WHERE length(phone) = 9;`,

  // 4: notes for the stylist ("solo las puntas", "es para mi hija", allergies…)
  `ALTER TABLE appointments ADD COLUMN notes TEXT;`,
];

const now = () => new Date().toISOString();
const json = (v, fallback) => (v == null ? fallback : JSON.parse(v));

const rowToBusiness = r => r && { id: r.id, name: r.name, settings: json(r.settings, {}), createdAt: r.created_at };
const rowToService = r => ({
  id: r.id, group: r.group_id, category: r.category, name: r.name, duration: r.duration,
  price: r.price, synonyms: json(r.synonyms, []), active: !!r.active,
});
const rowToCustomer = r => r && { id: r.id, businessId: r.business_id, phone: r.phone, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
const rowToAppointment = r => r && {
  id: r.id, businessId: r.business_id, customerId: r.customer_id, service: r.service, name: r.name,
  details: json(r.details, []), date: r.date, time: r.time, duration: r.duration, status: r.status, notes: r.notes ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
};

class SqliteStore {
  // file: path to the database file, or ':memory:'
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  close() { this.db.close(); }

  // ---- businesses & catalog ----
  async listBusinesses() {
    return this.db.prepare('SELECT * FROM businesses ORDER BY name').all().map(rowToBusiness);
  }
  async getBusiness(id) {
    return rowToBusiness(this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(id)) ?? null;
  }
  async saveBusiness({ id, name, settings = {} }) {
    this.db.prepare(`INSERT INTO businesses (id, name, settings, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, settings = excluded.settings`)
      .run(id, name, JSON.stringify(settings), now());
    return this.getBusiness(id);
  }
  async listServices(businessId) {
    return this.db.prepare('SELECT * FROM services WHERE business_id = ? AND active = 1 ORDER BY position')
      .all(businessId).map(rowToService);
  }
  // Replaces the whole catalog of a business.
  async saveServices(businessId, services) {
    this.tx(() => {
      this.db.prepare('DELETE FROM services WHERE business_id = ?').run(businessId);
      const ins = this.db.prepare(`INSERT INTO services (business_id, id, group_id, category, name, duration, price, synonyms, active, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      services.forEach((s, i) => ins.run(businessId, s.id, s.group, s.category ?? null, s.name, s.duration ?? null,
        s.price ?? null, JSON.stringify(s.synonyms ?? []), s.active === false ? 0 : 1, i));
    });
  }

  // ---- customers ----
  async findOrCreateCustomer(businessId, phone) {
    const t = now();
    this.db.prepare(`INSERT INTO customers (business_id, phone, created_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(business_id, phone) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(businessId, phone, t, t);
    return rowToCustomer(this.db.prepare('SELECT * FROM customers WHERE business_id = ? AND phone = ?').get(businessId, phone));
  }
  async updateCustomer(businessId, customerId, { name }) {
    this.db.prepare('UPDATE customers SET name = ? WHERE business_id = ? AND id = ?').run(name ?? null, businessId, customerId);
  }
  // GDPR right to erasure: removes the customer and everything about her (appointments, messages…)
  async deleteCustomer(businessId, customerId) {
    this.db.prepare('DELETE FROM customers WHERE business_id = ? AND id = ?').run(businessId, customerId);
  }

  // ---- appointments ----
  async listAppointments(businessId, { from, to, status = 'booked' } = {}) {
    return this.db.prepare(`SELECT * FROM appointments WHERE business_id = ? AND status = ?
      AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?) ORDER BY date, time`)
      .all(businessId, status, from ?? null, from ?? null, to ?? null, to ?? null).map(rowToAppointment);
  }
  // Her next booked appointment from `fromDate` on (the bot handles one at a time)
  async getUpcomingAppointment(businessId, customerId, fromDate) {
    return rowToAppointment(this.db.prepare(`SELECT * FROM appointments WHERE business_id = ? AND customer_id = ?
      AND status = 'booked' AND date >= ? ORDER BY date, time LIMIT 1`).get(businessId, customerId, fromDate)) ?? null;
  }
  // Her most recent past appointment, for "lo de siempre"
  async getLastAppointment(businessId, customerId, beforeDate) {
    return rowToAppointment(this.db.prepare(`SELECT * FROM appointments WHERE business_id = ? AND customer_id = ?
      AND status = 'booked' AND date < ? ORDER BY date DESC, time DESC LIMIT 1`).get(businessId, customerId, beforeDate)) ?? null;
  }
  async createAppointment(a) {
    const t = now();
    const r = this.db.prepare(`INSERT INTO appointments (business_id, customer_id, service, name, details, date, time, duration, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`)
      .run(a.businessId, a.customerId, a.service, a.name, JSON.stringify(a.details ?? []), a.date, a.time, a.duration, a.notes ?? null, t, t);
    return rowToAppointment(this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(r.lastInsertRowid)));
  }
  async updateAppointment(businessId, id, patch) {
    const cur = rowToAppointment(this.db.prepare('SELECT * FROM appointments WHERE business_id = ? AND id = ?').get(businessId, id));
    if (!cur) return null;
    const a = { ...cur, ...patch };
    this.db.prepare(`UPDATE appointments SET service = ?, name = ?, details = ?, date = ?, time = ?, duration = ?, notes = ?, status = ?, updated_at = ?
      WHERE business_id = ? AND id = ?`)
      .run(a.service, a.name, JSON.stringify(a.details ?? []), a.date, a.time, a.duration, a.notes ?? null, a.status, now(), businessId, id);
    return rowToAppointment(this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
  }
  async cancelAppointment(businessId, id) { return this.updateAppointment(businessId, id, { status: 'cancelled' }); }

  // ---- conversations ----
  async getConversation(businessId, customerId) {
    const r = this.db.prepare('SELECT * FROM conversations WHERE business_id = ? AND customer_id = ?').get(businessId, customerId);
    return r ? { state: json(r.state, null), updatedAt: r.updated_at } : null;
  }
  async saveConversation(businessId, customerId, state) {
    this.db.prepare(`INSERT INTO conversations (business_id, customer_id, state, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(business_id, customer_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .run(businessId, customerId, JSON.stringify(state), now());
  }
  async deleteConversation(businessId, customerId) {
    this.db.prepare('DELETE FROM conversations WHERE business_id = ? AND customer_id = ?').run(businessId, customerId);
  }

  // ---- messages & owner inbox ----
  async addMessage({ businessId, customerId, direction, text, intent = null }) {
    this.db.prepare('INSERT INTO messages (business_id, customer_id, direction, text, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(businessId, customerId, direction, text, intent, now());
  }
  async listMessages(businessId, customerId, { limit = 50 } = {}) {
    return this.db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE business_id = ? AND customer_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(businessId, customerId, limit)
      .map(r => ({ direction: r.direction, text: r.text, intent: r.intent, createdAt: r.created_at }));
  }
  async addHandover({ businessId, customerId, message, reason }) {
    this.db.prepare('INSERT INTO handovers (business_id, customer_id, message, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(businessId, customerId, message, reason ?? null, now());
  }
  async listHandovers(businessId, { status = 'open' } = {}) {
    return this.db.prepare(`SELECT h.*, c.phone FROM handovers h JOIN customers c ON c.id = h.customer_id
      WHERE h.business_id = ? AND h.status = ? ORDER BY h.id DESC`).all(businessId, status)
      .map(r => ({ id: r.id, customerId: r.customer_id, phone: r.phone, message: r.message, reason: r.reason, status: r.status, createdAt: r.created_at }));
  }
  // ---- waiting list ----
  async addToWaitlist({ businessId, customerId, service = null, details = [], date = null, timeOfDay = null, earlier = false }) {
    this.db.prepare(`INSERT INTO waitlist (business_id, customer_id, service, details, date, time_of_day, earlier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(businessId, customerId, service, JSON.stringify(details), date, timeOfDay, earlier ? 1 : 0, now());
  }
  async listWaitlist(businessId, { status = 'waiting' } = {}) {
    return this.db.prepare(`SELECT w.*, c.phone FROM waitlist w JOIN customers c ON c.id = w.customer_id
      WHERE w.business_id = ? AND w.status = ? ORDER BY w.id`).all(businessId, status)
      .map(r => ({ id: r.id, customerId: r.customer_id, phone: r.phone, service: r.service, details: json(r.details, []),
        date: r.date, timeOfDay: r.time_of_day, earlier: !!r.earlier, status: r.status, createdAt: r.created_at }));
  }

  async closeHandover(businessId, id) {
    this.db.prepare("UPDATE handovers SET status = 'done' WHERE business_id = ? AND id = ?").run(businessId, id);
  }
}

module.exports = { SqliteStore, MIGRATIONS };
