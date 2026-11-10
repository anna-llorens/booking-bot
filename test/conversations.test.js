// conversations.test.js — Runs whole conversations from test/fixtures/conversations.json
// and checks what accumulates across messages (the final appointment / booking in progress / waiting list).
// Usage: node test/conversations.test.js            (summary + failures)
//        node test/conversations.test.js --verbose  (prints every turn)
const { respond, newConversation } = require('../src/reply');
const { conversations } = require('./fixtures/conversations.json');

const verbose = process.argv.includes('--verbose');
let passed = 0;

function checkTurn(expect, r) {
  const errors = [];
  if ('intent' in expect && r.understanding.intent !== expect.intent) errors.push(`intent: expected ${expect.intent}, got ${r.understanding.intent}`);
  if ('handover' in expect && r.handover !== expect.handover) errors.push(`handover: expected ${expect.handover}, got ${r.handover}`);
  if ('reply' in expect && !r.reply.includes(expect.reply)) errors.push(`reply should contain "${expect.reply}"`);
  if ('replyNot' in expect && new RegExp(expect.replyNot).test(r.reply)) errors.push(`reply should not match /${expect.replyNot}/`);
  return errors;
}

function checkFinal(expected, state) {
  const errors = [];
  if ('appointment' in expected) {
    const want = expected.appointment, got = state.appointment;
    if (want === null && got) errors.push(`appointment: expected none, got ${JSON.stringify(got)}`);
    if (want && !got) errors.push(`appointment: expected ${JSON.stringify(want)}, got none`);
    if (want && got) for (const k of Object.keys(want)) {
      if (got[k] !== want[k]) errors.push(`appointment.${k}: expected ${JSON.stringify(want[k])}, got ${JSON.stringify(got[k])}`);
    }
  }
  if (expected.pending) {
    const p = state.pending;
    for (const [k, v] of Object.entries(expected.pending)) {
      const got = k === 'detailIds' ? (p.details ?? []).map(d => d.id) : p[k];
      if (JSON.stringify(got ?? null) !== JSON.stringify(v)) errors.push(`pending.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got ?? null)}`);
    }
  }
  if ('waitlist' in expected && (state.waitlist ?? []).length !== expected.waitlist) {
    errors.push(`waitlist: expected ${expected.waitlist} entries, got ${(state.waitlist ?? []).length}`);
  }
  if (expected.lastWaitlist) {
    const last = (state.waitlist ?? []).at(-1) ?? {};
    for (const [k, v] of Object.entries(expected.lastWaitlist)) {
      if (JSON.stringify(last[k] ?? null) !== JSON.stringify(v)) errors.push(`waitlist entry ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(last[k] ?? null)}`);
    }
  }
  if ('lastQuestion' in expected && state.lastQuestion !== expected.lastQuestion) {
    errors.push(`lastQuestion: expected ${expected.lastQuestion}, got ${state.lastQuestion}`);
  }
  return errors;
}

for (const conv of conversations) {
  let state = newConversation();
  if (conv.appointment) state.appointment = conv.appointment;
  const errors = [];
  const lines = [];
  conv.messages.forEach((m, i) => {
    // conversations written before the notes question keep booking in one step unless they turn it on
    const r = respond(m.text, state, { today: new Date(m.today), business: { askForNotes: false, ...conv.business } });
    state = r.state;
    lines.push(`    > ${m.text}\n      [${r.understanding.intent}${r.handover ? ' →owner' : ''}] ${r.reply}`);
    if (m.expect) checkTurn(m.expect, r).forEach(e => errors.push(`message ${i + 1} ("${m.text}"): ${e}`));
  });
  errors.push(...checkFinal(conv.expected, state));
  if (!errors.length) passed++;
  console.log(`${errors.length ? '✗' : '✓'} ${conv.id} — ${conv.description}`);
  if (errors.length || verbose) console.log(lines.join('\n'));
  errors.forEach(e => console.log(`    ✗ ${e}`));
}

console.log(`\nConversations: ${passed}/${conversations.length}`);
process.exitCode = passed === conversations.length ? 0 : 1;
