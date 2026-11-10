# booking-bot

Engine for **Apunta'm**: a WhatsApp assistant for hair salons and beauty centers. It understands what customers write (book, move or cancel an appointment, ask about prices, opening hours, the address…), answers them, and keeps each salon's calendar, customers and conversations. **No AI**: rules and dictionaries in plain JavaScript, and **no dependencies** (Node's built-in SQLite and zlib).

Customers write in Spanish, so the dictionaries, rules and bot replies are in Spanish. Everything else (code, docs, file names) is in English.

- [Quick start](#quick-start)
- [How it is built](#how-it-is-built) (details in [docs/architecture.md](docs/architecture.md))
- [What the bot understands](#what-the-bot-understands)
- [How the bot behaves](#how-the-bot-behaves)
- [Salon settings](#salon-settings)
- [Data and privacy](#data-and-privacy)
- [Improving it: the phrase bank](#improving-it-the-phrase-bank)
- [Tests](#tests)
- [Limitations and next steps](#limitations-and-next-steps)

## Quick start

Requires **Node 22.13 or later**.

```bash
npm start      # test UI at http://localhost:3000 (creates private-data/booking-bot.db and two demo salons)
npm test       # phrase bank (+ holdout) + reply tests + whole conversations + database
npm run test:tz  # the same suite with the process in UTC, New York and Tokyo: must give the same result
npm run demo   # what the engine understands for a few phrases
```

### Test UI

Open http://localhost:3000 after `npm start`.

- **Salon**: pick one of the demo salons (`Peluquería Demo`, `Centro de Estética Demo`). Each has its own catalog, prices, opening hours and calendar.
- **Customer**: her WhatsApp number. Every number is a different customer with her own appointments and conversation; `600 111 222`, `+34 600111222` and `0034600111222` are the same customer.
- **Today is**: follows the real clock; change it to pretend the conversation happens on another day. **Now** goes back to the real clock.
- **Add existing appointment**: gives this customer an appointment, to try moving, cancelling or checking it.
- **New conversation**: forgets the conversation (her appointments are kept).
- **Owner mode**: type `login:owner` (demo salons only) to act as the salon owner. The header shows a purple **Modo dueña** label, the examples change, and the panel adds the salon's live settings, its catalog (services turned off are struck through) and the owner's changes. `logout` goes back to the customer. See [owner mode](docs/architecture.md#owner-mode-modo-dueña).
- **Right panel**: what the engine understood (click any bot reply to inspect that turn), the salon calendar, the owner's inbox, the waiting list, the conversation state and the raw result.

The terminal shows every message handed to the owner and why. Messages the bot couldn't handle are also saved to `private-data/not-understood.json` (see [the phrase bank](#improving-it-the-phrase-bank)). In owner mode, messages answered with "No te he entendido" go to `private-data/not-understood-owner.json` instead, in the format of `test/fixtures/owner-phrases.json`: fill in `expected` and copy them there as tests.

## How it is built

```
WhatsApp / test UI ──► server/index.js ──► src/bot.js ──► src/reply.js ──► src/understand.js
                         (HTTP API)        (loads & saves)  (what to answer)  (what she said)
                                               │
                                               ▼
                                         src/store/  (SQLite: salons, catalog, customers,
                                                       appointments, conversations, messages,
                                                       owner inbox, waiting list)
```

| Layer | File | Does | Doesn't |
|---|---|---|---|
| Understanding | `src/understand.js` | One message → intent, services, day, time of day, time… | Know anything about the conversation except what it is told (`context`) |
| Conversation | `src/reply.js` | Understanding + conversation state + salon settings + availability → reply and new state | Touch the database, the clock or the network: it is a pure function |
| Application | `src/bot.js` | Loads everything for one message, calls `reply.js`, saves the result (appointment, conversation, messages, handover, waiting list) | Decide what to answer |
| Storage | `src/store/` | Keeps the data, separated by salon | Contain any bot logic |
| Delivery | `server/` | HTTP API and the test UI | — |

**Owner mode.** When the salon owner writes (a number in `settings.ownerPhones`, or `login:owner` in the demo salons), `src/owner/` answers instead of the customer bot.
- She can see her agenda ("¿qué tengo hoy?"), close days ("el jueves cierro"), change hours ("mañana abro a las 10"), prices ("sube el tinte a 38") and services ("ya no hago permanente"), and book, cancel or move appointments ("apunta a Lucía mañana a las 10 para corte").
- Every change asks "(sí / no)" first and can be reverted with `deshacer`.
- Appointments are never cancelled on their own: the bot warns about the ones affected.
- Details are in [docs/architecture.md](docs/architecture.md#owner-mode-modo-dueña).

Every table is keyed by salon: a salon never sees another salon's customers. See [docs/architecture.md](docs/architecture.md) for the data model, the store interface, migrations, availability and how to plug in WhatsApp.

## What the bot understands

`understand(text, { today, services, context })` returns, for **one message**:

| Field | Example |
|---|---|
| `intent` | see the table below |
| `service`, `services`, `details` | `"mechas"`, `["mechas", "corte"]`, `[{ id: "mechas_californianas", name, duration }]` |
| `date`, `timeOfDay`, `time`, `times` | `2026-11-13`, `"afternoon"`, `"17:30"`, `["17:00", "18:00"]` ("¿a las 5 o a las 6?") |
| `option` | `2` for "la segunda", `-1` for "la última" |
| flags | `anyDay` ("me da igual el día"), `anyTime` ("la que tengáis libre"), `sameTime` ("a la misma hora"), `noneOfThem` ("ninguna me va bien"), `fromDate` ("el mes que viene"), `excludeDate` ("mañana no puedo"), `eventDate` ("tengo una boda el sábado"), `unsure`, `offTopic` |
| `missing`, `understood`, `normalizedText` | what's missing to book, whether it found an intent, the text after normalizing |

### Intents

| Intent | Examples | What the bot does |
|---|---|---|
| `book` | "quiero cita para corte", "tienes hueco mañana?", "uñas", "lo de siempre el viernes", "cuando tengáis un huequito" | Asks for the service if missing, then always proposes 2 concrete times |
| `choose` | "la segunda", "vale, pues la primera", "a las 17:30", "me viene mejor la de la tarde" | Books the chosen time |
| `confirm` | "sí", "vale", "perfecto", "apúntame", "sí, mañana allí estoy", "confirmado entonces", "ahora sí jajaja" | Books the single proposed time, or confirms her appointment. "Sí" + a day that isn't hers → asks before moving anything |
| `reschedule` | "¿me la cambias al jueves?", "mejor otro día", "prefiero el mes que viene", "ninguna de las dos me va bien", "hoy no llego, ¿mañana a la misma hora?" | Proposes new times; the appointment only moves when she picks one |
| `cancel` | "cancela la cita", "no puedo ir el viernes", "al final no voy" | **Always asks first**: "¿Quieres que la anule o prefieres cambiarla a otro día?" |
| `keep` | "al final sí que puedo ir", "dejamos la cita como estaba", "no la anules" | "¡Genial! La mantenemos" |
| `check` | "¿tengo cita?", "¿a qué hora era?", "tengo cita ahora", "¿me lo mandas por escrito?" | Tells her her appointment (in writing with 📅 🕒 📍 if she asks) |
| `undecided` | "luego te digo", "lo miro y te digo", "lo hablo con mi marido y te confirmo", "vale, se lo digo" | "¡Vale! Escríbeme cuando lo sepas…" — nothing is booked, open proposals are dropped |
| `waitlist` | "avísame si se libera algo antes", "si alguien cancela el jueves avísame", "lista de espera" | Adds her to the waiting list (service, day, time of day); her appointment stays as it is |
| `wait` | "espera", "un momento", "voy a mirar una cosa" | "¡Claro, tómate tu tiempo!" — nothing changes |
| `late` | "llegaré 10 minutos tarde", "voy un poco justa", "hay mucho tráfico" | "¡Gracias por avisar! Te esperamos" |
| `price` | "¿cuánto cuesta el tinte?", "¿y cortar las puntas también?", "todo junto cuánto sería?" | Answers from the catalog; no price in the catalog → the owner answers |
| `duration` | "¿cuánto dura?", "¿cuánto se tarda en las mechas?" | Answers from the catalog ("unas 2 horas") |
| `hours` | "¿abrís los sábados?", "¿y por la tarde también?", "¿abrís el 8 de diciembre?", "¿cerráis en agosto?" | Answers from the salon's settings, including public holidays and holidays |
| `info` (+ `topic`) | "¿atendéis sin cita?" (`walkIn`), "¿aceptáis bizum?" (`payment`), "¿dónde aparco?" (`parking`), "¿puedo llevar al niño?" (`children`), "¿con cuánta antelación tengo que cancelar?" (`cancellationPolicy`), "si llego tarde, ¿me la mantenéis?" (`latePolicy`) | Answers with the salon's `info` text; empty → the owner answers. A policy question never triggers the action (it doesn't cancel or flag her as late). With a booking in the same message, the booking goes on and the answer is added |
| `event` | "es que tengo una boda el sábado" | "¡Qué bien! 🎉" and only proposes days before it |
| `services` (+ `category`) | "lístame todos los servicios", "¿qué servicios tenéis?", "¿tienes precios?", "¿qué hacéis de uñas?" | Lists the salon's own catalog by category, with "desde X €" when there are prices; one category in detail if she names it. In the middle of a booking it keeps the booking |
| `help` | "¿cómo funciona la lista de espera?" | Explains it, without signing her up |
| `name` | "¿cómo se llama el centro?" | "Somos <salon name>" |
| `greeting` | "hola", "buenas", "¿qué tal?" | Greets and says what it can do |
| `thanks` | "gracias", "me encantó, sois las mejores" | Thanks back |
| `preamble` | "una pregunta", "a ver una cosita jajaja" | "¡Claro, dime!" |
| `null` | "¿hay parking?", "llámame mejor", anything else | Handed to the owner (see below) |

Service descriptions: each salon can give a service a `description` (catalog / `services` table); "¿en qué consiste?" or "¿qué es la keratina?" answers with it, and without one the stylist explains. Other situations handled by `reply.js`: "¿estáis muy ocupados?" (offers a slot), positive feedback ("funciona muy bien" → thanks), lost things ("me he dejado el paraguas" → the owner, "Lo miramos y te decimos enseguida"), only punctuation ("??????" → "¿Sí? Dime…"), laughs and emojis (😊), reactions ("qué fuerte" → "Vaya 😔"), apologies ("perdona!!" → "¡No pasa nada!"), "ya estoy en la puerta" (the owner is told), "no sé qué quiero hacerme" (helps her choose), "¿qué me recomiendas?" once a service is chosen (passed to the stylist), "ayer no pude ir" (no telling off: offers a new day and tells the owner), the address ("¿dónde estáis?"), "¿hacéis alisado?" ("¡Sí, hacemos…!"), "ya me dices cuando puedas" (waits for the salon).

**Language details it copes with:** accents and capitals, stretched letters ("holaaa"), WhatsApp spellings and abbreviations ("q", "xfa", "mñn", "kiero", "huekito", "pal"), typos in service names ("tiente", "mehcas") and in key words ("servivios", "precois", "cancelr"), as long as the misspelling isn't a real Spanish word, "uñas" vs "unas mechas", "la segunda **vez**" (not option 2), "las dos **cosas**" (not 14:00), conditional "si" vs "sí", "el miércoles que viene" said on a Tuesday (next week's: tomorrow would be "mañana"), Catalan "demà".

## How the bot behaves

**It accumulates.** `understand()` only knows one message; `reply.js` builds the booking in the conversation state (`pending`), so "quiero cita" / "para las cejas" / "el jueves" / "a las 5" become one appointment. Corrections replace only what changed ("mejor el viernes" keeps the service and time of day); "y también las cejas" adds instead of replacing; "quería decir el jueves" stays in the week being discussed.

**It proposes, it doesn't ask.** With a service it always offers 2 times on the first day that has room ("Lo primero que tengo para corte es mañana: 1) 10:00 2) 17:30. ¿Cuál te va mejor, o prefieres otro día?"). Closed or full day → it says so and offers the next one. "Ninguna" → other times that day, never repeating one, then the same times a week later.

**It respects the diary.** Opening hours per day, with split days: "por la mañana" / "por la tarde" are the morning and afternoon intervals, "a mediodía" on a split day offers the last time before the break and the first after it, a time in the break gets "a las 14:30 estamos cerrados (a mediodía cerramos de 13:30 a 16:30)", and a long service that doesn't fit before closing gets "no da tiempo a hacer tinte antes de cerrar a las 13:30". Opening-hours answers group the days ("De lunes a viernes de 9:30 a 13:30 y de 16:30 a 20:00. Sábados de 9:00 a 14:00. Domingos cerrado."). Weekly days off, public holidays (`closedDates`: "Ese día estamos cerrados (festivo) 😔") and holidays (`closedRanges`: "Del 10 al 24 de agosto estamos de vacaciones 😔") are never proposed; it offers the next open day. Nothing starts sooner than `minNoticeMinutes` from now ("Para hoy ya no me da tiempo 😔", and a time that falls inside that window by the time she says yes is not booked). Beyond `maxDaysAhead` it says how far the diary is open and offers the waiting list for that day.

**It never does something irreversible on a guess.** Cancelling always asks first. "Sí" + a day that isn't her appointment's asks before moving it. A slot taken by someone else between the proposal and her "sí" is not double-booked ("esa hora se acaba de ocupar"). "Lo hablo con mi marido y te confirmo" books nothing.

**Notes for the stylist.** Before booking it asks "¿Quieres que apunte algo especial para la cita (un diseño, alergias, si es para otra persona…)? Si no, dime «no» y lo confirmo." Whatever she answers is saved as the appointment's note ("no", "vale" → no note; a change of plans → carries on normally). Details she gives on the way ("solo las puntas", "es para mi hija", "tiene el pelo muy largo", "soy alérgica…", remarks in the middle of a booking) are collected too, shown in that question and saved. They appear in the confirmation and in the salon calendar.

**Closing a booking** repeats service, day, time and notes in one message, so she has it in writing.

**When it doesn't understand:**
- Made-up text ("oeoe", "asdf qwer", checked against a Spanish dictionary) → "Perdona, no te he entendido 😅"; the second time it explains what it can do. Not sent to the owner.
- A real message it can't handle → the owner's inbox, "Te contestaremos enseguida". In the middle of a booking it carries on with it ("Te contestaremos enseguida. Mientras, …").
- After **2 messages in a row** it doesn't understand, it stops answering (the owner still gets them).
- It never sends the same text twice in a row; if she adds something but the times on offer don't change, it says so ("Es lo que tengo 😊 …").

**Several appointments per customer.** "Mis citas" / "¿tengo cita?" lists all her upcoming appointments ("¿y la de la manicura?" filters by service or day). Booking a new service while she has another appointment is a new booking, never a change to the other one. To change or cancel, the bot works out which appointment from the service or day she mentions ("la del corte", "la del viernes") and asks "¿Cuál quieres cambiar / anular?" when it can't tell. Each appointment is updated or cancelled by its own id, so the others are never touched.

**Conversations** reset after 8 hours of silence, and an offer of times left unanswered for 3 hours is dropped (a later "hola" starts fresh). Appointments live in the database, not in the conversation. "No quiero X" drops that service and asks what she wants (or switches if she names another one).

## Salon settings

Each salon's settings live in `businesses.settings` (JSON). Anything left out takes the default from `DEFAULT_BUSINESS` in `src/reply.js`.

| Setting | Default | Meaning |
|---|---|---|
| `hours` | `null` | Hours per day, split days allowed: `{ "mon": [["09:30","13:30"],["16:30","20:00"]], …, "sat": [["09:00","14:00"]] }`. A day with no entry is closed. An appointment must fit entirely inside one interval |
| `opens`, `closes` | `"09:30"`, `"20:00"` | Used only when there is no `hours`: the same hours every open day |
| `closedWeekdays` | `[0]` | Used only when there is no `hours`: weekly days off (0 = Sunday … 6 = Saturday) |
| `closedDates` | `[]` | Public holidays: `"2026-12-08"` or `{ "date": "2026-12-26", "reason": "Sant Esteve" }` |
| `closedRanges` | `[]` | Holidays or other closures: `{ "from": "2026-08-10", "to": "2026-08-24", "reason": "vacaciones" }` |
| `dateOverrides` | `{}` | Different hours for one day: `{ "2026-11-11": [["10:00","20:00"]] }` (set from owner mode: "mañana abro a las 10") |
| `ownerPhones` | `[]` | Numbers that get owner mode instead of the customer bot |
| `devOwnerLogin` | `false` | **Testing only.** `login:owner` enters owner mode from any phone. On in the demo salons |
| `slotMinutes` | `30` | Proposals start every 30 minutes |
| `maxProposals` | `2` | Times offered at once |
| `capacity` | `1` | Appointments that may overlap (chairs / staff) |
| `minNoticeMinutes` | `120` | No appointment starts sooner than now + this |
| `maxDaysAhead` | `60` | The diary is open this many days ahead (bot.js also loads the calendar that far) |
| `address` | `null` | Answered to "¿dónde estáis?" |
| `timezone` | `"Europe/Madrid"` | The salon's time zone: messages are read in its wall-clock time, whatever zone the server runs in |
| `info` | `{}` | Answers the owner writes: `walkIn`, `payment`, `parking`, `children`, `pets`, `cancellationPolicy`, `latePolicy`. Empty ones go to the owner |
| `askForNotes` | `true` | Before booking, ask "¿quieres que apunte algo especial?" and save the answer as the appointment's note |
| `name` | — | Not a setting: `bot.js` passes the salon's name from the `businesses` table ("¿cómo se llama la peluquería?") |
| `simulatedBusy` | `false` | Demo only: also block some fake busy slots |

A complete example:

```json
{
  "hours": {
    "mon": [["09:30", "13:30"], ["16:30", "20:00"]],
    "tue": [["09:30", "13:30"], ["16:30", "20:00"]],
    "wed": [["09:30", "13:30"], ["16:30", "20:00"]],
    "thu": [["09:30", "13:30"], ["16:30", "20:00"]],
    "fri": [["09:30", "13:30"], ["16:30", "20:00"]],
    "sat": [["09:00", "14:00"]]
  },
  "closedDates": ["2026-12-08", "2026-12-25", { "date": "2026-12-26", "reason": "Sant Esteve" }],
  "closedRanges": [{ "from": "2027-08-09", "to": "2027-08-22", "reason": "vacaciones" }],
  "slotMinutes": 30,
  "maxProposals": 2,
  "capacity": 1,
  "minNoticeMinutes": 120,
  "maxDaysAhead": 60,
  "address": "Carrer Major 12, Barcelona",
  "timezone": "Europe/Madrid",
  "info": {
    "walkIn": "Trabajamos con cita previa, pero si tenemos un hueco libre te atendemos sin problema 😊",
    "payment": "Puedes pagar en efectivo, con tarjeta o con Bizum.",
    "parking": "Hay un parking público a 50 metros (Carrer Major 30) y zona azul en la misma calle.",
    "children": "¡Claro! Los peques pueden venir contigo; tenemos un rincón con cuentos para ellos.",
    "cancellationPolicy": "Te pedimos que avises con al menos 24 horas. No cobramos nada por cancelar.",
    "latePolicy": "Te esperamos hasta 15 minutos. Si llegas más tarde, puede que tengamos que cambiarte la cita."
  }
}
```

The two demo salons in `src/demo-data.js` have examples of all of these: the hair salon has split hours and Saturday mornings, the beauty center continuous hours (and leaves `parking` empty, so that question goes to the owner). Their settings are refreshed from the code on every start (unless they were changed from owner mode); real salons are never touched.

## Data and privacy

- Everything is stored in `private-data/booking-bot.db` (SQLite). `private-data/` is git-ignored: real customer data never goes into the repository.
- Each salon's data is separate (each salon is the data controller of its customers). The same phone at two salons is two different customers.
- `store.deleteCustomer()` removes a customer and everything about her (appointments, conversation, messages, handovers, waiting list): the GDPR right to erasure.
- Real WhatsApp exports also go in `private-data/`. Before adding real phrases to the test bank, remove names, phones and any personal data (the importer removes phones and emails; names must be checked by hand).
- If the repository is ever public, review `test/fixtures/phrases.json` first.

## Improving it: the phrase bank

There are two sets of labeled phrases:

| File | What it is for | In `npm test` |
|---|---|---|
| `test/fixtures/phrases.json` (bank) | Phrases the rules are tuned on. Every failure gets fixed. | Must be 100 %: a failure fails the build |
| `test/fixtures/holdout.json` (holdout) | Phrases the rules are **not** tuned on: the honest measure of how well it understands messages it hasn't seen | Reported, never fails the build |

**Holdout rule: holdout phrases are never used to tune rules.** Don't read them to write or adjust a rule. If a general rule written for other reasons happens to fix one, fine. Phrases go to the holdout by a hash of their text (`scripts/holdout.js`), never by hand: `npm run merge` sends 20 % of new phrases there (`--holdout-share 0.2`).

The current holdout (53 phrases moved from the bank) had already been used for tuning, so its 100 % is not an honest figure; it becomes one as new phrases arrive through `npm run merge`. The honest figures so far are the "before" measurements of each new batch: 59 % and 48 % on the first real chats, 8/22 on a batch of new phrases, 27/51 on synthetic conversations.

### Adding phrases

The rules are only as good as the real messages they have been tested on.

```bash
# 1. Real chats → phrases to label
node scripts/import-whatsapp.js private-data/chat.txt "Business name" --dmy > new-phrases.txt
# 2. Or take what the test UI couldn't handle: private-data/not-understood.json
# 3. Fill in "expected" on each line, then:
npm run merge new-phrases.txt        # skips lines without "expected"; 20 % go to the holdout
npm test
```

Each phrase: `{ "text": "...", "expected": { "intent": "book", "date": "2026-11-13" }, "context": { "lastQuestion": "proposal", "proposals": ["10:00"] }, "today": "...", "source": "real" }`. Only the fields in `expected` are checked; `context` says what the bot had just asked.

Labelling tips: not every "vale" is `confirm` (it can be `undecided`, or the answer to a question: add `context`); keep some `intent: null` examples ("gracias", "jajaja", "ahora te digo" must not book anything).

**The accuracy that matters** is on phrases the rules have never seen: the holdout from now on, and the "before" measurements of each batch so far.

## Tests

| File | Checks |
|---|---|
| `test/understand.test.js` + `test/fixtures/phrases.json` + `holdout.json` | Single messages (intent, topic, service, date, time…): the bank must pass 100 %, the holdout is only reported |
| `test/reply.test.js` | Short scripted conversations through `respond()` |
| `test/conversations.test.js` + `test/fixtures/conversations.json` | 43 whole conversations, optionally with salon settings: per-turn checks and the final state (appointment, booking in progress, waiting list). `--verbose` prints every turn |
| `test/store.test.js` | Database and `bot.js` end to end on an in-memory SQLite: salons kept apart, no double booking, moves update, cancel asks first, "lo de siempre" from history, phone formats, holidays, notes, GDPR delete |
| `test/owner.test.js` + `test/fixtures/owner-phrases.json` | Owner mode: 88 phrases, and whole conversations through `bot.js` (login, confirm, undo, warnings, what customers see after a change) |

`npm test` runs all five.

## Project layout

| Path | Contents |
|---|---|
| `src/understand.js` | The engine: one message → what she said |
| `src/reply.js`, `src/reply/` | The conversation: what to answer (pure). `context.js`, `rules.js`, one handler file per intent group |
| `src/bot.js` | One message in, one reply out, everything saved; applies owner-mode changes |
| `src/owner/` | Owner mode: `understand-owner.js` and `reply-owner.js` (pure) |
| `src/hours.js`, `src/timezone.js` | Opening hours (split days, per-day overrides) and the salon's wall-clock time |
| `src/store/` | Storage (SQLite) and its interface ([README](src/store/README.md)) |
| `src/catalog.json` | Sample catalog: 112 services with Spanish synonyms and durations |
| `src/demo-data.js` | The two demo salons, with sample prices |
| `src/dictionary/` | Spanish word list (MPL 1.1) and WhatsApp/salon extras ([README](src/dictionary/README.md)) |
| `server/` | HTTP API (`index.js`) and the test UI (`public/index.html`) |
| `test/` | Tests and fixtures |
| `scripts/` | `import-whatsapp.js`, `merge-phrases.js`, `build-dictionary.js`, `demo.js` |
| `docs/architecture.md` | Architecture, data model, store interface |
| `private-data/` | Database, real chats, not-understood log. **Git-ignored** |

## Limitations and next steps

- **Not connected to WhatsApp yet.** `bot.handleMessage()` is the entry point a WhatsApp Business webhook would call ([docs/architecture.md](docs/architecture.md#plugging-in-whatsapp)).
- **Reminders** (the day before with Confirmo / Cambiar / Cancelar, and the same morning) need a scheduler and WhatsApp templates; neither exists yet.
- **One person, one appointment per conversation.** "Para mi hija" is booked as if it were for whoever writes, and two appointments in one chat (mother and daughter) aren't supported: it needs a "who is it for" field.
- **One option at a time:** "el jueves por la tarde, si no el viernes por la mañana" moves from Thursday to Friday instead of offering both.
- **No staff per service:** availability is per salon, with a `capacity` of parallel appointments.
- **Owner mode is text only.** The owner manages hours, closures, prices and appointments from the chat; there is no web dashboard. Cancelling or moving an appointment doesn't message the customer (the owner tells her), and the waiting list is not notified automatically when a slot frees up.
- The demo prices are examples; durations are typical estimates to confirm with each salon.
