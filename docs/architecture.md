# Architecture

How booking-bot is organized so that it can hold many salons, their customers and their conversations, and how to extend it.

## Layers

```
            ┌────────────────────────────────────────────────────────────┐
 message ──►│ server/index.js   HTTP API (later: WhatsApp webhook)         │
            └──────────────┬─────────────────────────────────────────────┘
                           ▼
            ┌────────────────────────────────────────────────────────────┐
            │ src/bot.js        handleMessage(store, { businessId,        │
            │                     phone, text, now })                      │
            │  1. load salon (settings + catalog), customer, conversation  │
            │  2. load her upcoming appointment, her last one, the calendar│
            │  3. call reply.js                                            │
            │  4. save: appointment change, conversation, messages,        │
            │     owner handover, waiting list                             │
            └──────┬──────────────────────────────────────┬──────────────┘
                   ▼                                      ▼
   ┌───────────────────────────────┐        ┌───────────────────────────────┐
   │ src/reply.js  (pure)           │        │ src/store/  (SQLite)           │
   │ respond(text, state, options)  │        │ businesses, services,          │
   │  → { reply, state, handover,   │        │ customers, appointments,       │
   │      waitlist, understanding } │        │ conversations, messages,       │
   └──────────────┬────────────────┘        │ handovers, waitlist            │
                  ▼                          └───────────────────────────────┘
   ┌───────────────────────────────┐
   │ src/understand.js  (pure)      │
   │ understand(text, { today,      │
   │   services, context })         │
   └───────────────────────────────┘
```

**Why this split.** `understand.js` and `reply.js` are pure functions: same input, same output, no database, no clock, no network. That makes them fast to test with thousands of phrases and whole conversations, and it means the storage, the channel (WhatsApp, a web chat, the test UI) or the hosting can change without touching the bot's behavior. `bot.js` is the only place that reads and writes data.

### What `reply.js` gets from `bot.js`

| Option | Comes from | Used for |
|---|---|---|
| `today` | the message timestamp | "mañana", "el viernes", not proposing past times |
| `services` | `services` table (the salon's catalog) | recognizing services, durations, prices |
| `business` | `businesses.settings` | opening hours, closed days, capacity, address, how many times to propose |
| `isFree(date, start, duration)` | `appointments` table | proposing only free slots |
| `usual` | her last past appointment | "lo de siempre" |
| `state` | `conversations` table, with `appointment` overwritten by her real upcoming appointment | context: what the bot asked, what it proposed, the booking in progress |

### What `bot.js` does with the result

- `state.appointment` differs from her stored appointment → **create** (no id), **update** (same id: a move) or **cancel** (gone). Before creating or moving, the slot is checked again against a fresh calendar; if someone took it meanwhile, the bot says "esa hora se acaba de ocupar" instead of double-booking.
- `state` (without the appointment, which the database owns) → `conversations`.
- The customer's message and the reply → `messages`.
- `handover: true` → `handovers` (the owner's inbox), with a reason: `price`, `off-topic`, `not understood`.
- `waitlist` → `waitlist`.

## Data model

All tables (except `businesses`) have `business_id`; every query filters by it. Deleting a business or a customer cascades to everything that depends on it.

| Table | Key | Holds |
|---|---|---|
| `businesses` | `id` (text, e.g. `demo-peluqueria`) | `name`, `settings` (JSON, see below) |
| `services` | `(business_id, id)` | the salon's catalog: `group_id`, `category`, `name`, `duration` (min), `price` (€, optional), `synonyms` (JSON, Spanish), `active`, `position` |
| `customers` | `id`; unique `(business_id, phone)` | `phone` (international digits, e.g. `34600111222`), `name`, `created_at`, `last_seen_at` |
| `appointments` | `id` | `customer_id`, `service` (group), `name` (as shown to her), `details` (JSON: specific services), `date`, `time`, `duration`, `notes` (for the stylist), `status` (`booked` / `cancelled`) |
| `conversations` | `(business_id, customer_id)` | `state` (JSON: reply.js conversation state), `updated_at` |
| `messages` | `id` | `customer_id`, `direction` (`in` / `out`), `text`, `intent` |
| `handovers` | `id` | the owner's inbox: `customer_id`, `message`, `reason`, `status` (`open` / `done`) |
| `waitlist` | `id` | `customer_id`, `service`, `details`, `date`, `time_of_day`, `earlier`, `status` (`waiting` / `notified` / `done`) |

### Salon settings (`businesses.settings`)

```json
{
  "opens": "09:30", "closes": "20:00",
  "closedWeekdays": [0],        // 0 = Sunday
  "slotMinutes": 30,            // proposals start every 30 minutes
  "maxProposals": 2,            // times offered at once
  "capacity": 1,                // appointments that may overlap (chairs / staff)
  "closedDates": ["2026-12-08"],                                          // public holidays
  "closedRanges": [{ "from": "2027-08-09", "to": "2027-08-22", "reason": "vacaciones" }],
  "minNoticeMinutes": 120,      // nothing starts sooner than now + 2 h
  "maxDaysAhead": 60,           // the diary is open 60 days ahead
  "address": "Carrer Major 12, Barcelona",
  "info": { "payment": "…", "parking": "…" },   // answers the owner writes; empty → the owner answers
  "simulatedBusy": false        // demo only: also block some fake busy slots
}
```

Defaults live in `DEFAULT_BUSINESS` in `src/reply.js`; the full list is in the [README](../README.md#salon-settings).

### Identity

A customer is one phone number **per salon**. `bot.normalizePhone()` turns `600 111 222`, `+34 600-111-222` and `0034600111222` into `34600111222` (numbers without a country code are Spanish). The same person writing to two salons is two customers, which keeps each salon's data separate, as GDPR expects (each salon is the controller of its customers' data).

## The store interface

Everything the bot needs from storage is in [src/store/README.md](../src/store/README.md): async methods for salons and catalog, customers, appointments, conversations, messages, the owner's inbox and the waiting list. Today there is one implementation, `SqliteStore` (Node's built-in `node:sqlite`, one file at `private-data/booking-bot.db`, or `BOOKING_DB=...`). Tests use `createStore(':memory:')`, so they run against the real implementation.

**Moving to another database** (e.g. Postgres when several servers need to share data): write a class with the same methods, return it from `createStore()`. Nothing else changes. The methods are already async for that reason.

### Migrations

`MIGRATIONS` in `src/store/sqlite-store.js` is a list of SQL scripts. On start, the store runs the ones not applied yet (tracked in SQLite's `user_version`), each in a transaction. **Never edit an applied migration; add a new one.** Current: 1 schema, 2 waiting list, 3 phones in international format, 4 appointment notes.

## Availability

`bot.makeIsFree()` builds `isFree(date, start, duration)` from the salon's booked appointments: a slot is free if fewer than `capacity` appointments overlap it. The customer's own appointment is ignored, so moving it can reuse its slot. `reply.js` combines that with opening hours, closed days and "not in the past" to propose times.

`closedReason()` in `reply.js` tells whether a day is closed (weekly day off, `closedDates`, `closedRanges`); `freeSlots()`, `makeIsFree()` and the test seeding all use it. `minNoticeMinutes` and `maxDaysAhead` are applied in `freeSlots()` with the `now` option, so `reply.js` stays pure.

Not modelled yet: staff and which staff member does which service, breaks, different hours per day. They would go into `settings` (or new tables) and into `makeIsFree()`, without touching `reply.js`'s logic.

## Conversations

The conversation state (what the bot just asked, the times it proposed, the booking being built, services she asked prices for, the waiting list…) is plain JSON, stored per customer. It starts fresh after `CONVERSATION_TIMEOUT_HOURS` (8) without messages. Her appointments are not part of it: they are loaded from `appointments` on every message, so the database is always the source of truth.

## Plugging in WhatsApp

A WhatsApp Business (Cloud API) webhook would:

1. Receive the message, find the salon from the receiving phone number (a `whatsapp_number` → `business_id` mapping, to add to `businesses`).
2. Call `handleMessage(store, { businessId, phone: from, text, now: timestamp })`.
3. Send `result.reply` back if it isn't empty (`silent` replies are empty on purpose).
4. Notify the owner when `result.handover` is true.

Still to design: several messages arriving within seconds ("Hola" / "para alisado" / "el 12") — `understandBatch()` in `understand.js` can merge them; audio and images; reminders (a scheduled job reading tomorrow's appointments and sending a template with Confirmo / Cambiar / Cancelar buttons); notifying the waiting list when an appointment is cancelled.

## Adding a salon

```js
const { createStore } = require('./src/store');
const store = createStore();
await store.saveBusiness({ id: 'peluqueria-marta', name: 'Peluquería Marta', settings: { opens: '10:00', closes: '19:30', closedWeekdays: [0, 1] } });
await store.saveServices('peluqueria-marta', services); // same shape as src/catalog.json, with optional "price"
```

The catalog's ids and synonyms are Spanish because they are matched against what customers write; the engine's rules (`src/understand.js`) are shared by every salon.
