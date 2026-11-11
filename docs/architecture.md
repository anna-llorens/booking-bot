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

### Time zone

Messages carry a real moment (the WhatsApp timestamp). `bot.js` turns it into the salon's wall-clock time (`settings.timezone`, `Europe/Madrid` by default) with `Intl.DateTimeFormat` (`src/timezone.js`) before anything else uses it. `understand.js` and `reply.js` only see that wall-clock time and never call `new Date()` themselves: `today` is a required option. So "mañana" written at 00:30 in Madrid is right on a server in UTC, and an appointment at 10:00 stays at 10:00 across a daylight-saving change (appointments are stored as a date and a wall-clock time). `npm run test:tz` runs the whole suite in other process time zones.

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
| `services` | `(business_id, id)` | the salon's catalog: `group_id`, `category`, `name`, `duration` (min), `price` (€, optional), `description` (optional, for "¿en qué consiste?"), `synonyms` (JSON, Spanish), `active`, `position` |
| `customers` | `id`; unique `(business_id, phone)` | `phone` (international digits, e.g. `34600111222`), `name`, `created_at`, `last_seen_at` |
| `appointments` | `id` | `customer_id`, `service` (group), `name` (as shown to her), `details` (JSON: specific services), `date`, `time`, `duration`, `notes` (for the stylist), `status` (`booked` / `cancelled`) |
| `conversations` | `(business_id, customer_id)` | `state` (JSON: reply.js conversation state), `updated_at` |
| `messages` | `id` | `customer_id`, `direction` (`in` / `out`), `text`, `intent` |
| `handovers` | `id` | the owner's inbox: `customer_id`, `message`, `reason`, `status` (`open` / `done`) |
| `waitlist` | `id` | `customer_id`, `service`, `details`, `date`, `time_of_day`, `earlier`, `status` (`waiting` / `notified` / `done`) |
| `owner_changes` | `id` | what the owner changed from owner mode: `type` (`closeDate`, `setPrice`, `bookManual`…), `data` (JSON: the change as applied), `previous` (JSON: the value it replaced, to undo it), `created_at`, `undone_at` |

### Salon settings (`businesses.settings`)

```json
{
  "hours": { "mon": [["09:30", "13:30"], ["16:30", "20:00"]], …, "sat": [["09:00", "14:00"]] },  // no entry = closed
  // (or, without "hours": "opens": "09:30", "closes": "20:00", "closedWeekdays": [0])
  "slotMinutes": 30,            // proposals start every 30 minutes
  "maxProposals": 2,            // times offered at once
  "capacity": 1,                // appointments that may overlap (chairs / staff)
  "closedDates": ["2026-12-08"],                                          // public holidays
  "closedRanges": [{ "from": "2027-08-09", "to": "2027-08-22", "reason": "vacaciones" }],
  "dateOverrides": { "2026-11-11": [["10:00", "20:00"]] },               // hours for one day (owner mode)
  "ownerPhones": ["34600111222"],   // these numbers get owner mode
  "devOwnerLogin": false,           // TESTING ONLY: "login:owner" enters owner mode from any phone
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

`MIGRATIONS` in `src/store/sqlite-store.js` is a list of SQL scripts. On start, the store runs the ones not applied yet (tracked in SQLite's `user_version`), each in a transaction. **Never edit an applied migration; add a new one.** Current: 1 schema, 2 waiting list, 3 phones in international format, 4 appointment notes, 5 service descriptions, 6 `owner_changes` (owner mode).

## Availability

`bot.makeIsFree()` builds `isFree(date, start, duration)` from the salon's booked appointments: a slot is free if fewer than `capacity` appointments overlap it. The customer's own appointment is ignored, so moving it can reuse its slot. `reply.js` combines that with opening hours, closed days and "not in the past" to propose times.

`closedReason()` in `reply.js` tells whether a day is closed (weekly day off, `closedDates`, `closedRanges`); `freeSlots()`, `makeIsFree()` and the test seeding all use it. `minNoticeMinutes` and `maxDaysAhead` are applied in `freeSlots()` with the `now` option, so `reply.js` stays pure.

Opening hours come from `src/hours.js`: `settings.hours` per day (split days with a lunch break, Saturday mornings…), or `opens` / `closes` / `closedWeekdays` for salons that don't set `hours`. An appointment must fit entirely inside one open interval; `freeSlots()`, `closedReason()`, `makeIsFree()` and the "same time next week" rule all use it.

Not modelled yet: staff and which staff member does which service. They would go into `settings` (or new tables) and into `makeIsFree()`, without touching `reply.js`'s logic.

## Conversations

The conversation state (what the bot just asked, the times it proposed, the booking being built, services she asked prices for, the waiting list…) is plain JSON, stored per customer. It starts fresh after `CONVERSATION_TIMEOUT_HOURS` (8) without messages. Her appointments are not part of it: they are loaded from `appointments` on every message, so the database is always the source of truth.

## Owner mode ("modo dueña")

The salon owner manages the salon from the same WhatsApp chat: agenda, closures, opening hours, prices, services and appointments.

```
 owner message ──► bot.js handleOwner() ──► src/owner/reply-owner.js ──► src/owner/understand-owner.js
                        │   (applies the            (pure: answer +            (pure: intent + fields; reuses
                        │    confirmed changes)      changes to confirm)        understand.js dates, times, services)
                        ▼
                  store: businesses.settings, services, appointments, owner_changes
```

**Who is the owner.**
- A phone in `settings.ownerPhones` (e.g. `["34600111222"]`) is in owner mode directly. It writes *modo clienta* to try the bot as a customer and *modo dueña* to go back.
- `login:owner` (any case) enters owner mode from any phone, but only if `settings.devOwnerLogin` is `true`. **This is for testing only**: it is on in the two demo salons and off by default. With it off, `login:owner` is an ordinary customer message.
- `logout` or `salir` leaves owner mode.
- The mode is kept in the conversation state (`ownerMode`); the owner's own state (what is waiting for confirmation) is in `state.owner`.

**Same split as the customer bot.**
- `understand-owner.js` and `reply-owner.js` are pure.
- `reply-owner.js` never changes anything: it returns `{ reply, state, changes }`, and `changes` is only non-empty after the owner confirms.
- `bot.js` applies each change and records it in `owner_changes`.

**Every change asks first:** "¿Cierro el jueves 12 de noviembre? (sí / no)". Queries (agenda, inbox, prices) don't ask. Anything doubtful is not applied: missing data is asked for ("¿A qué hora?"), and anything not understood gets "No te he entendido 😅 Escribe *ayuda* para ver ejemplos."

**Appointments are never cancelled by a closure or an hours change.** Before confirming, the bot lists the appointments affected and says "Las citas NO se cancelan solas…"; the owner cancels or moves them herself.

**Undo.** `deshacer` reverts the last change not undone yet (and again for the one before):
- Settings changes store the previous value of each key they replace (`null` = the key did not exist).
- Catalog changes store the previous price, duration or `active` flag.
- A manual booking is undone by cancelling it, a cancellation by booking it again, and a move by moving it back.

| Intent | Example | Effect |
|---|---|---|
| `agenda` | "¿qué tengo hoy?", "citas de mañana", "¿cuántas citas tengo esta semana?", "citas del mes" | Time, customer, service and duration; a day ends with its free stretches |
| `inbox` | "¿qué me han preguntado?", then a number; "ver más", "ver todos" | Numbered list of open handovers (5 at a time). One message shows what the bot had said before it and three options: **1. Ignorar**, **2. Responder a la clienta**, **3. Responder y que el bot lo conteste solo** |
| `ignore` | "ignora 1, 3 y 5", "ignora todos" | Closes those handovers (several are confirmed; option 1 on one message is applied at once). Undo reopens them |
| `replyChoice`, `teachChoice` | option 2 / 3, or "responder", "las dos" | Asks for the text, confirms, then saves it as a message to that customer (`outbound` in the result, for the WhatsApp channel) and closes the handover. With 3, also adds it to `settings.learnedAnswers` |
| `learnedAnswers`, `forgetAnswer` | "¿qué respuestas has aprendido?", "olvida la respuesta 2" | The answers the bot now gives on its own |
| `waitlist` | "¿quién hay en lista de espera?" | The waiting list |
| `serviceInfo` | "queratina" | Duration and price of that service |
| `hours` | "¿qué horario tengo?" | Weekly hours, upcoming closures and special days |
| `closeDate`, `closeRange`, `openDate` | "el jueves cierro", "cierro del 10 al 24 de agosto por vacaciones", "al final el jueves abro" | `closedDates`, `closedRanges` (re-opening a day inside a range splits it) |
| `setDayHours` | "mañana abro a las 10", "el viernes de 10 a 14" | `dateOverrides` for that day |
| `setWeeklyHours` | "a partir de ahora los sábados cierro a las 14", "los lunes ya no abro" | `hours` (written out in full if the salon still used `opens`/`closes`) |
| `getPrice`, `setPrice`, `getDuration`, `setDuration` | "¿cuánto cobro por las mechas?", "sube el tinte a 38", "queratina 4h", "el tinte dura 2 horas" | The service's `price` / `duration` |
| `disableService`, `enableService` | "ya no hago permanente", "vuelvo a hacer permanente" | The service's `active` flag (inactive services are not offered to customers) |
| `bookManual` | "apunta a Lucía mañana a las 10 para corte" | An appointment for a customer with no phone (one per name, phone `manual:lucia`); a taken time offers others |
| `cancelAppointment`, `moveAppointment` | "cancela la cita de Ana del jueves", "mueve la de las 17:00 del viernes a las 18:00" | Asks which one if several match. The customer is not messaged: the owner tells her |
| `greeting`, `howAreYou`, `presence`, `thanks`, `bye` | "hola", "¿qué tal?", "¿estás?", "gracias", "adiós" | Read with the customer bot's rules (understand.js). "Hola" and "¿qué tal?" add a short summary of the day |
| `dayStatus` | "¿qué tal ha ido el día?", "resumen de hoy" | "De momento llevas 4 de 6 citas. Ahora mismo estás con… La siguiente, a las…", then messages waiting and the waiting list |
| `revenue` | "cobros", "¿cuánto he ganado hoy?" | Honest: what is charged at the till (with extras such as shampoo or masks) is not visible to the bot; it gives only a floor from the catalog prices |
| `servicesList` | "servicios", "servicios de color" | The catalog by group, or one group with durations and prices |
| `addService` | "añade un servicio", "añade el servicio lavado con masaje, 45 min, 20 €" | Asks for what is missing (name, duration, price or «sin precio»), then adds it in the group «Otros» with its name as synonym. Undo deletes it |
| `feedback` | "te queda mucho por entrenar" | Admits it and points to *ayuda* |
| `renameService`, `setCategory`, `setDescription` | "cambia corte de pelo por corte de señora", "pon el alisado en tratamientos", "cambia la descripción de la manicura" | The service's name (the old one stays as a synonym), group or description |
| `bulkPrice`, `restorePrice` | "sube todos los servicios un 5 %", "todos los tratamientos 4 euros más", "vuelve a poner el corte al precio de antes" | Many prices at once (rounded to 50 cents, undone in one go); a price back to what it was |
| `setPrice` (relative) | "sube el corte 2 euros", "quiero subir el precio del corte" → "¿A cuánto lo pongo?" | |
| `blockTime`, `restoreHours` | "bloquea mañana de 12 a 14", "no permitas reservas el viernes por la tarde", "desbloquea el sábado" | That day's hours without that time (`dateOverrides`), or back to the usual hours |
| `hours` (one day / weekday) | "¿abrimos los sábados?", "¿a qué hora cerramos hoy?" | |
| `agenda` filters | "¿quién viene a las cinco?", "¿qué huecos quedan mañana por la tarde?", "citas de mechas esta semana", then "solo las de la tarde", "¿cuántas son?" | Follow-ups narrow the last list |
| `cancellations`, `customerInfo`, `stats`, `changesHistory` | "¿hay alguna cancelación hoy?", "busca a Laura", "¿cuántas citas hemos tenido este mes?", "¿qué hemos cambiado esta semana?" | Read only |
| `sendMessage` | "dile a Ana que ya tenemos huecos", "manda un mensaje a Lucía para recordarle su cita" | One customer by name: her text (or a reminder of her next appointment), confirmed, then sent like an inbox reply |
| `changeAppointmentService`, `cancelAppointment` (all) | "la cita de Ana es para tinte, no para corte", "cancela todas las citas del jueves" | |
| `renameBusiness` | "quiero cambiar el nombre del salón" | |
| `nameCustomer`, `customersList` | "el 600 000 000 es María", "clientas" | A name for a customer known only by her number; the customers with appointments |
| `notSupported` | campaigns, broadcasts to many, offers, reminders, automatic notices, writing texts, posters, lists, backups, the weather, jokes | Said plainly with what it can do instead. Checked before anything else, so "recuérdame mañana…" is not the agenda and "avisa a mis clientas de que el viernes no abrimos" is not a closure. Nothing is changed |

Small safety rules learned from real sessions:
- A **bare number** is never a price ("3" after a misunderstanding); a price needs "€", "euros" or "ponlo a…".
- A **pasted list** (bullets or several times) is never an order.
- **Inside a menu** (one inbox message, a list of appointments), a message it doesn't understand keeps the menu and says what it expects.
- **"Ignora todos"** says how many she hasn't seen yet; "ignora estos" is only the page she saw.
- **"Sin querer"**, "me he equivocado", "me habías dicho…" offers to undo the last change.
- After cancelling one appointment from a list, the list comes back ("¿Cancelo otra?"); "todas" cancels the whole list.
- A greeting is short; the day's summary comes with «resumen».

Orders can come in several messages: a question the bot asks waits for the answer (`pending.kind = 'draft'`), and a correction before "sí" ("mejor 15 euros", "ponlo en tratamientos capilares", "a partir de esta semana") rebuilds the question (`pending.redo`).
| `help`, `yes`, `no`, `undo`, `logout` | "ayuda", "sí", "no", "deshacer", "salir" | — |

A message not understood twice in a row gets a different reply the second time ("Sigo sin entenderte…"), like the customer bot.

**Learned answers.** `settings.learnedAnswers` is a list of `[{ question, text, answer }]`, where `question` is normalized.
- The customer bot uses one (`src/reply/learned.js`) only when it would otherwise hand the message over, and only for the same message or a very close one (accents, case, typos up to 15 % of the length; no AI).
- Her answer replaces "Te contestaremos enseguida", and a booking in progress carries on after it.

**Noise never reaches the inbox.** One or two letters ("p"), one letter repeated ("sss"), "login", and made-up words get "Perdona, no te he entendido" instead of a handover.

**Demo data.** `seedOwnerDemo()` in `src/demo-data.js` (the test UI's **Owner demo data** button, `POST /api/demo/owner`) adds to a salon, once:
- 5 named customers;
- appointments over the next open days;
- 5 questions in the inbox, each with the bot's message before it;
- 2 people on the waiting list.

`settings.dateOverrides` (`{ "2026-11-11": [["10:00","20:00"]] }`) wins over the weekly hours for that one day. It is read in `hours.dayHours()`, so free slots, `closedReason` and the customer's hours answers all respect it.

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
