// sessions.js — Reads the test UI sessions (private-data/sessions/*.jsonl) as conversations, to see where the
// bot went wrong. A new session starts after 30 minutes of silence, a new conversation, or a login/logout.
//
// Usage: npm run sessions                       today's sessions
//        npm run sessions -- 2026-11-11          that day
//        npm run sessions -- --all               every day
//        npm run sessions -- --phone 600000009   one phone only
//        npm run sessions -- --owner             owner mode only
//        npm run sessions -- --problems          only sessions with something not understood or handed over
const fs = require('fs');
const path = require('path');

const DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'private-data', 'sessions');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const value = f => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const day = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10);
const phoneArg = value('--phone')?.replace(/\D/g, '');
const phone = phoneArg && phoneArg.length === 9 ? `34${phoneArg}` : phoneArg;

if (!fs.existsSync(DIR)) { console.log(`No sessions yet (${DIR}). They are saved while you use the test UI (npm start).`); process.exit(0); }
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl') && (flag('--all') || f.startsWith(day))).sort();
if (!files.length) { console.log(`No sessions for ${day}. Days with sessions: ${fs.readdirSync(DIR).map(f => f.replace('.jsonl', '')).join(', ') || 'none'}`); process.exit(0); }

const turns = files.flatMap(f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean)).filter(t => !phone || t.phone === phone).filter(t => !flag('--owner') || t.mode === 'owner' || t.event);

// split into sessions per salon + phone
const sessions = [];
const open = new Map();
for (const t of turns) {
  const key = `${t.businessId}|${t.phone}`;
  const cur = open.get(key);
  const gap = cur ? new Date(t.at) - new Date(cur.turns.at(-1).at) : Infinity;
  const restart = t.event || /^(login:owner|logout|salir|modo (duena|dueña|clienta))$/i.test((t.message ?? '').trim());
  if (!cur || gap > 30 * 60 * 1000 || (restart && cur.turns.length)) {
    const s = { key, businessId: t.businessId, phone: t.phone, turns: [] };
    sessions.push(s);
    open.set(key, s);
  }
  if (!t.event) open.get(key).turns.push(t);
}

const shown = sessions.filter(s => s.turns.length && (!flag('--problems') || s.turns.some(t => t.notUnderstood || t.handover)));
for (const s of shown) {
  const first = s.turns[0];
  const problems = s.turns.filter(t => t.notUnderstood || t.handover).length;
  console.log(`\n══ ${s.businessId} · +${s.phone} · ${first.at.slice(0, 16).replace('T', ' ')} UTC · ${s.turns.length} messages${problems ? ` · ${problems} not understood / handed over` : ''}`);
  for (const t of s.turns) {
    const mark = t.notUnderstood ? '❓' : t.handover ? '📥' : '  ';
    console.log(`${mark} ${t.mode === 'owner' ? '👑' : '🙋'} ${t.message}`);
    if (t.reply) console.log(`     🤖 ${t.reply.replace(/\n/g, '\n        ')}`);
    else console.log(`     🤖 (no reply: ${t.silent})`);
    const extra = [t.intent && `intent ${t.intent}`, t.changes && `changed: ${t.changes.join('; ')}`, t.sent && `sent to ${t.sent.map(x => '+' + x.to).join(', ')}`, t.waitingFor && `waiting for: ${t.waitingFor}`].filter(Boolean);
    if (extra.length) console.log(`        · ${extra.join(' · ')}`);
  }
}
console.log(`\n${shown.length} session(s), ${shown.reduce((n, s) => n + s.turns.length, 0)} messages${flag('--problems') ? ' (only sessions with problems)' : ''}.`);
