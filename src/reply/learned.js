// learned.js — Answers the owner taught from owner mode ("Responder y que el bot lo conteste solo").
//
// settings.learnedAnswers: [{ question, text, answer }] — `question` normalized (understand.normalize),
// `text` as the customer wrote it. A customer message is answered with one only when the bot would
// otherwise hand it to the owner, and only if it is the same message or very close (accents, case,
// small typos). No AI: anything else still goes to the owner.
const { normalize, distance } = require('../understand');

function findLearnedAnswer(message, learned = []) {
  const t = normalize(message);
  if (!t) return null;
  for (const item of learned) {
    const q = item.question;
    if (q === t) return item;
    const allowed = Math.floor(Math.max(q.length, t.length) * 0.15);
    if (Math.min(q.length, t.length) >= 8 && allowed >= 1 && distance(q, t) <= allowed) return item;
  }
  return null;
}

// The handover reply with the owner's answer instead of "Te contestaremos enseguida":
// "Te contestaremos enseguida. Mientras, para corte tengo…" → "<answer> Para corte tengo…"
const HANDOVER_OPENING = /^(Perdona, me he liado 😅 )?(Te contestaremos enseguida\.|Lo miramos y te decimos enseguida 😊)\s*(Mientras, )?/;
function withLearnedAnswer(reply, answer) {
  if (!HANDOVER_OPENING.test(reply ?? '')) return answer;
  const rest = reply.replace(HANDOVER_OPENING, '').trim();
  return rest ? `${answer} ${rest[0].toUpperCase()}${rest.slice(1)}` : answer;
}

module.exports = { findLearnedAnswer, withLearnedAnswer };
