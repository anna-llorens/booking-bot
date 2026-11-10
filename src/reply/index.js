// reply/ — Turns what understand() found into the bot's answer, keeping the conversation state.
//
// It is pure: no database, no clock, no network. Everything it needs comes in as options (business settings,
// catalog, availability, the customer's usual service, today's date), and everything it decides comes out in
// the returned state. src/bot.js loads those inputs from the store and saves the result.
//
//   context.js   what she said + state + settings, and the shared steps (propose times, book, cancel…)
//   rules.js     what runs before the handlers (answers to the bot's open questions, topic follow-ups…)
//   handlers/    one file per intent or group of intents
//   format.js, slots.js   pure helpers (dates and names; free times)
const { createContext } = require('./context');
const { runRules } = require('./rules');
const { DEFAULT_BUSINESS, newConversation, MAX_MISUNDERSTOOD } = require('./conversation');
const { isSimulatedBusy, closedReason } = require('./slots');
const { serviceLabel } = require('./format');

const HANDLERS = Object.assign({},
  require('./handlers/book'),
  require('./handlers/reschedule'),
  require('./handlers/cancel'),
  require('./handlers/check'),
  require('./handlers/info'),
  require('./handlers/services'),
  require('./handlers/waitlist'),
  require('./handlers/smalltalk'),
);

// Same reply as the previous one ("vale" → "¡Perfecto! 😊" over and over): the bot stays silent.
// The message is still processed (and still handed to the owner if needed); only the text is not sent.
// A new question for the owner ("¿hay parking?" after "¿tenéis bizum?") still gets its answer
// even if the text is the same, unless she sent the very same message again.
// After MAX_MISUNDERSTOOD messages in a row it didn't understand, the bot stops answering
// (the owner still gets them and they are still logged) until she says something it understands.

function respond(message, state = newConversation(), options = {}) {
  const previousReply = state?.lastReply ?? null;
  const previousMessage = state?.lastMessage ?? null;
  const result = computeReply(message, state, options);
  const misunderstood = result.fallback ? (state?.misunderstood ?? 0) + 1 : 0;
  result.state.misunderstood = misunderstood;
  if (misunderstood > MAX_MISUNDERSTOOD) {
    result.state.lastMessage = result.understanding.normalizedText;
    return { ...result, reply: '', silent: true, silentReason: 'misunderstood' };
  }
  const sameMessage = result.understanding.normalizedText === previousMessage;
  result.state.lastMessage = result.understanding.normalizedText;
  if (result.reply && result.reply === previousReply && (sameMessage || !result.handover)) {
    // She said something new ("después de comer", "esta semana a poder ser") but the times on offer are the
    // same: say so instead of going silent. Silence is only for a repeated message or a bare "vale".
    const bare = ['confirm', 'thanks', 'greeting', 'preamble', null].includes(result.understanding.intent);
    if (!sameMessage && !bare && result.state.lastQuestion === 'proposal') {
      const u = result.understanding;
      const reply = `${u.date || u.timeOfDay || u.anyDay || u.anyTime || u.time ? 'Es lo que tengo 😊' : '¡Perfecto! 😊'} ${result.reply}`;
      result.state.lastReply = reply;
      return { ...result, reply, silent: false };
    }
    return { ...result, reply: '', silent: true, silentReason: 'repeated' };
  }
  result.state.lastReply = result.reply;
  return { ...result, silent: false };
}

// Options: see createContext in context.js (today, services, business, isFree, usual, now)
function computeReply(message, state, options) {
  const ctx = createContext(message, state, options);
  const early = runRules(ctx);
  if (early) return early;
  return (HANDLERS[ctx.topic] ?? HANDLERS.default)(ctx);
}

module.exports = { respond, newConversation, DEFAULT_BUSINESS, isSimulatedBusy, serviceLabel, closedReason };
