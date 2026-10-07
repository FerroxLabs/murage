// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 7 (Opus re-review 6): the recipient scan must never return, and no later stage may show, the value of a secret field.
// The leak: a card field labelled "Card number" through aria-labelledby, with id `cc`, was read as a "cc" recipient.
import { describe, expect, it } from 'vitest';
import { h, page, runRecipientScan, realCollectFacts } from './testing/chat-dom-fixture.ts';
import { checkIntent, INTENT_LINES } from './browser-intent.ts';
import { cleanRecipients, withoutSecretValues } from './browser-recipient-safety.ts';

const CARD = '4111 1111 1111 1111'; // a published test number
const CARD_PLAIN = '4242424242424242';

/** A mail-like form: a real To field, the secret field under test, and a Send button. */
function mail(secret: ReturnType<typeof h>, label?: ReturnType<typeof h>) {
  const send = h('button', { 'aria-label': 'Send' });
  const form = h('form', {}, ...(label ? [label] : []), h('input', { name: 'to', value: 'ana@example.com' }), secret, send);
  return { send, ...page(form) };
}
const noSecret = (recipients: string[], values: string[]) => { for (const v of values) { expect(recipients.join('|')).not.toContain(v); expect(recipients.join('|').replace(/\s/g, '')).not.toContain(v.replace(/\s/g, '')); } };

const VARIANTS: { name: string; secret: string; build: () => ReturnType<typeof mail> }[] = [
  { name: 'card number labelled by aria-labelledby, id cc (the exact leak)', secret: CARD,
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl cc', value: CARD }), h('span', { id: 'cl' }, 'Card number')) },
  { name: 'card number, label by aria-labelledby only, a neutral id', secret: CARD_PLAIN,
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: CARD_PLAIN }), h('span', { id: 'cl' }, 'Card number')) },
  { name: 'cc-number autocomplete under a recipient-like name', secret: CARD,
    build: () => mail(h('input', { name: 'cc', autocomplete: 'cc-number', value: CARD })) },
  { name: 'a Luhn-valid number in a field with no secret word at all (value pattern)', secret: CARD,
    build: () => mail(h('input', { id: 'cc', name: 'cc', value: CARD })) },
  { name: 'CVC labelled by aria-labelledby, id cc', secret: '1234567',
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: '1234567' }), h('span', { id: 'cl' }, 'CVC')) },
  { name: 'one-time code labelled by aria-labelledby, id cc', secret: '4829175',
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: '4829175' }), h('span', { id: 'cl' }, 'One-time code')) },
  { name: 'password labelled by aria-labelledby, id cc', secret: '5559876543',
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: '5559876543' }), h('span', { id: 'cl' }, 'Password')) },
  { name: 'expiry labelled by aria-labelledby, id cc', secret: '12202030',
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: '12202030' }), h('span', { id: 'cl' }, 'Expiry date')) },
  { name: 'SSN labelled by aria-labelledby, id cc', secret: '078-05-1120',
    build: () => mail(h('input', { id: 'cc', 'aria-labelledby': 'cl', value: '078-05-1120' }), h('span', { id: 'cl' }, 'Social security number')) },
];

describe('round 7: the recipient scan never returns a secret field value', () => {
  for (const v of VARIANTS) {
    it(`scan: ${v.name}`, () => {
      const m = v.build();
      const out = runRecipientScan(m.send);
      expect(out.recipients).toContain('ana@example.com');
      noSecret(out.recipients, [v.secret]);
    });
    it(`facts to NOT DONE, card and digest inputs: ${v.name}`, async () => {
      const m = v.build();
      const facts = await realCollectFacts(() => m.send)(null, null, 'click', {}) as { recipients?: string[] };
      expect(facts.recipients ?? []).toContain('ana@example.com');
      expect(JSON.stringify(facts)).not.toContain(v.secret);
    });
  }

  it('the real To and Cc recipients still come through (a field id cc labelled Cc)', () => {
    const send = h('button', { 'aria-label': 'Send' });
    const m = page(h('form', {}, h('span', { id: 'l' }, 'Cc'), h('input', { id: 'cc', 'aria-labelledby': 'l', value: 'bob@example.com' }), send));
    expect(runRecipientScan(send).recipients).toEqual(['bob@example.com']);
    void m;
  });

  it('defence in depth: cleanRecipients keeps only email-like, handle-like and phone tokens, never a card, OTP or free text', () => {
    expect(cleanRecipients([CARD, CARD_PLAIN, '482917', 'hunter2', 'ana@example.com', '@ana_k', '+1 (555) 123-4567', '5551234567'])).toEqual(['ana@example.com', '@ana_k', '+1 (555) 123-4567', '5551234567']);
  });

  it('defence in depth: later stages drop a secret-shaped value but keep an odd recipient', () => {
    expect(withoutSecretValues([CARD, '482917', 'ana', 'a\u200bb@example.com'])).toEqual(['ana', 'a\u200bb@example.com']);
  });

  it('defence in depth: the intent check never prints a card number as a new recipient', () => {
    const result = checkIntent({ ownerWords: ['send this'], taskSites: new Set(['https://a.test']), readOrigins: [], counters: { hits: 0 }, typedHistory: [],
      action: { operation: 'click', origin: 'https://a.test', level: 'L3', recipients: [CARD, 'ana@example.com'], currentUrl: 'https://a.test/' } } as never);
    expect(JSON.stringify(result)).not.toContain('4111');
    void INTENT_LINES;
  });
});
