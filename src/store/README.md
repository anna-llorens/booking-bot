# Store interface

Everything `src/bot.js` and `server/index.js` need from storage. All methods are `async`. Every method that touches salon data takes a `businessId` and only returns that salon's data.

Implementation today: `SqliteStore` (`sqlite-store.js`). Get one with `createStore(file?)` from `index.js` (default `private-data/booking-bot.db`, or `BOOKING_DB`; `':memory:'` for tests). A new implementation (e.g. Postgres) only has to provide these methods.

## Salons and catalog

| Method | Returns |
|---|---|
| `listBusinesses()` | `[{ id, name, settings, createdAt }]` |
| `getBusiness(id)` | business or `null` |
| `saveBusiness({ id, name, settings })` | the business (insert or update) |
| `listServices(businessId, { includeInactive = false })` | active services (or all, for owner mode): `[{ id, group, category, name, duration, price, synonyms, active, description }]` |
| `updateService(businessId, id, { price?, duration?, active?, name?, synonyms?, category?, description? })` | the service, or `null` |
| `addService(businessId, service)` / `deleteService(businessId, id)` | — owner mode: a new service at the end of the catalog (and undoing it) |
| `saveServices(businessId, services)` | replaces the salon's whole catalog |

## Customers

| Method | Returns |
|---|---|
| `findOrCreateCustomer(businessId, phone)` | `{ id, businessId, phone, name, createdAt, lastSeenAt }` — `phone` already normalized (`bot.normalizePhone`) |
| `listCustomers(businessId, today)` | every customer with `visits`, `last` and `next` appointment (owner mode) |
| `findOrCreateManualCustomer(businessId, name)` | a customer with no phone, booked by the owner (phone `manual:<name>`, one per name) |
| `updateCustomer(businessId, customerId, { name })` | — |
| `deleteCustomer(businessId, customerId)` | — removes her and everything about her (GDPR erasure) |

## Appointments

| Method | Returns |
|---|---|
| `listAppointments(businessId, { from?, to?, status = 'booked' })` | `[{ id, customerId, service, name, details, date, time, duration, status, … }]` by date and time |
| `listAgenda(businessId, { from?, to?, status = 'booked' })` | like `listAppointments`, plus `customerName` and `customerPhone` (owner mode) |
| `getUpcomingAppointment(businessId, customerId, fromDate)` | her next booked appointment from that day, or `null` |
| `listCustomerAppointments(businessId, customerId, fromDate)` | all her booked appointments from that day, soonest first |
| `getLastAppointment(businessId, customerId, beforeDate)` | her most recent past appointment (for "lo de siempre"), or `null` |
| `createAppointment({ businessId, customerId, service, name, details, date, time, duration })` | the appointment |
| `updateAppointment(businessId, id, patch)` | the appointment, or `null` |
| `cancelAppointment(businessId, id)` | the appointment with `status: 'cancelled'` |

## Conversations and messages

| Method | Returns |
|---|---|
| `getConversation(businessId, customerId)` | `{ state, updatedAt }` or `null` |
| `saveConversation(businessId, customerId, state)` | — |
| `deleteConversation(businessId, customerId)` | — |
| `addMessage({ businessId, customerId, direction: 'in' \| 'out', text, intent? })` | — |
| `listMessages(businessId, customerId, { limit = 50 })` | oldest first: `[{ direction, text, intent, createdAt }]` |

## Owner inbox and waiting list

| Method | Returns |
|---|---|
| `addHandover({ businessId, customerId, message, reason })` | — |
| `listHandovers(businessId, { status = 'open' })` | newest first, with the customer's `phone`, `customerName` and `before` (the bot's message just before hers) |
| `closeHandover(businessId, id)` | — |
| `reopenHandover(businessId, id)` | — back to `open` (owner mode «deshacer») |
| `addToWaitlist({ businessId, customerId, service, details, date, timeOfDay, earlier })` | — |
| `listWaitlist(businessId, { status = 'waiting' })` | oldest first, with the customer's `phone` |

## Owner-mode changes

| Method | Returns |
|---|---|
| `addOwnerChange({ businessId, type, data, previous })` | the new change's `id` |
| `getLastOwnerChange(businessId)` | the newest change not undone yet, or `null` |
| `listOwnerChanges(businessId, { limit = 20 })` | newest first, with `undoneAt` |
| `markOwnerChangeUndone(businessId, id)` | — |

## Schema changes

Add a script to `MIGRATIONS` in `sqlite-store.js`. Never edit one that has already run. See [docs/architecture.md](../../docs/architecture.md#migrations).
