import { describe, expect, it } from 'vitest';
import { filterPersonal, luhn, type PersonalConfig } from '../src/index.js';

const CARD = '4242424242424242'; // public test number, passes Luhn
const cfg = (over: Partial<PersonalConfig> = {}): PersonalConfig => ({
  card: 'warn',
  list: 'warn',
  entries: [],
  ...over,
});

describe('luhn', () => {
  it('accepts a valid number and rejects a changed one', () => {
    expect(luhn(CARD)).toBe(true);
    expect(luhn('4242424242424243')).toBe(false);
  });
});

describe('filterPersonal: cards', () => {
  it('warn reports but leaves the text unchanged', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg());
    expect(out).toEqual({ text: `card ${CARD} ok`, findings: { card: 1 } });
  });

  it('partial keeps the last four digits', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg({ card: 'partial' }));
    expect(out.text).toBe('card [CARD ····4242] ok');
  });

  it('full replaces the number', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg({ card: 'full' }));
    expect(out.text).toBe('card [REDACTED:card] ok');
  });

  it('off neither changes nor reports', () => {
    expect(filterPersonal(CARD, cfg({ card: 'off' }))).toEqual({ text: CARD, findings: {} });
  });

  it('finds a number written with spaces or dashes', () => {
    expect(filterPersonal('4242 4242 4242 4242', cfg({ card: 'full' })).text).toBe('[REDACTED:card]');
    expect(filterPersonal('4242-4242-4242-4242', cfg({ card: 'full' })).text).toBe('[REDACTED:card]');
  });

  it('leaves a 16-digit number that fails Luhn alone', () => {
    const text = 'order 4242424242424243';
    expect(filterPersonal(text, cfg({ card: 'full' }))).toEqual({ text, findings: {} });
  });

  it('does not match digits inside a longer number', () => {
    const text = `id 9${CARD}9`;
    expect(filterPersonal(text, cfg({ card: 'full' })).findings).toEqual({});
  });
});

describe('filterPersonal: personal list', () => {
  const phone = { label: 'phone', value: '0812-3456-7890' };

  it('matches the same digits written with other separators', () => {
    const out = filterPersonal('call 0812 3456 7890 now', cfg({ list: 'full', entries: [phone] }));
    expect(out).toEqual({ text: 'call [REDACTED:phone] now', findings: { phone: 1 } });
  });

  it('partial keeps the last four digits and shows the label', () => {
    const out = filterPersonal('call 081234567890', cfg({ list: 'partial', entries: [phone] }));
    expect(out.text).toBe('call [PERSONAL:phone ····7890]');
  });

  it('treats a different prefix as a different value', () => {
    const text = 'call +62 812 3456 7890';
    expect(filterPersonal(text, cfg({ list: 'full', entries: [phone] })).findings).toEqual({});
  });

  it('matches text values without regard to case', () => {
    const entry = { label: 'home-address', value: 'Jalan Mawar 12' };
    const out = filterPersonal('ship to JALAN MAWAR 12 please', cfg({ list: 'full', entries: [entry] }));
    expect(out.text).toBe('ship to [REDACTED:home-address] please');
  });

  it('masks a value shorter than 8 characters completely under partial', () => {
    const entry = { label: 'pin', value: '4821' };
    const out = filterPersonal('pin 4821', cfg({ list: 'partial', entries: [entry] }));
    expect(out.text).toBe('pin [REDACTED:pin]');
  });

  it('lets an entry level override the list level', () => {
    const entry = { ...phone, level: 'full' as const };
    const out = filterPersonal('081234567890', cfg({ list: 'warn', entries: [entry] }));
    expect(out.text).toBe('[REDACTED:phone]');
  });

  it('treats regex characters in a value literally', () => {
    const entry = { label: 'handle', value: 'a.b(c)+d' };
    expect(filterPersonal('x axb(c)+d y', cfg({ list: 'full', entries: [entry] })).findings).toEqual({});
    expect(filterPersonal('x a.b(c)+d y', cfg({ list: 'full', entries: [entry] })).text).toBe('x [REDACTED:handle] y');
  });
});

describe('filterPersonal: cards next to other numbers', () => {
  const full = cfg({ card: 'full' });

  it('masks a card followed by an expiry or CVV', () => {
    expect(filterPersonal('4242 4242 4242 4242 12/28', full).text).toBe('[REDACTED:card] 12/28');
    expect(filterPersonal('4242 4242 4242 4242 123', full).text).toBe('[REDACTED:card] 123');
  });

  it('masks a card preceded by a short number', () => {
    expect(filterPersonal('id 10 4242424242424242', full).text).toBe('id 10 [REDACTED:card]');
  });

  it('masks every level, not only full', () => {
    const t = '4242-4242-4242-4242 123';
    expect(filterPersonal(t, cfg({ card: 'partial' })).text).toBe('[CARD ····4242] 123');
    expect(filterPersonal(t, cfg({ card: 'warn' })).findings).toEqual({ card: 1 });
  });
});

describe('filterPersonal: plus-prefixed values', () => {
  const intl = { label: 'phone-intl', value: '+62 812 3456 7890' };
  const local = { label: 'phone', value: '0812-3456-7890' };

  it('matches an entry that starts with a plus', () => {
    const out = filterPersonal('call +62-812-3456-7890 now', cfg({ list: 'full', entries: [intl] }));
    expect(out).toEqual({ text: 'call [REDACTED:phone-intl] now', findings: { 'phone-intl': 1 } });
  });

  it('does not match the same digits without the plus', () => {
    const out = filterPersonal('call 62 812 3456 7890', cfg({ list: 'full', entries: [intl] }));
    expect(out.findings).toEqual({});
  });

  it('keeps the local and international forms distinct', () => {
    const out = filterPersonal('081234567890', cfg({ list: 'full', entries: [intl, local] }));
    expect(out).toEqual({ text: '[REDACTED:phone]', findings: { phone: 1 } });
  });
});

describe('filterPersonal: overlapping matches', () => {
  const phone = { label: 'phone', value: '0812-3456-7890' };

  it('does not match inside a marker written by an earlier entry', () => {
    const tail = { label: 'tail', value: '7890' };
    const out = filterPersonal('call 081234567890', cfg({ list: 'partial', entries: [phone, tail] }));
    expect(out.text).toBe('call [PERSONAL:phone ····7890]');
    expect(out.findings).toEqual({ phone: 1 });
  });

  it('does not match a text entry inside marker text', () => {
    const word = { label: 'word', value: 'phone' };
    const out = filterPersonal('call 081234567890', cfg({ list: 'full', entries: [phone, word] }));
    expect(out.text).toBe('call [REDACTED:phone]');
  });

  it('lets the longer value win whatever the entry order', () => {
    const short = { label: 'short', value: '3456-7890' };
    const out = filterPersonal('081234567890', cfg({ list: 'full', entries: [short, phone] }));
    expect(out).toEqual({ text: '[REDACTED:phone]', findings: { phone: 1 } });
  });

  it('prefers the stronger level on a tie', () => {
    const a = { label: 'a', value: 'secret', level: 'warn' as const };
    const b = { label: 'b', value: 'SECRET', level: 'full' as const };
    const out = filterPersonal('a secret b', cfg({ entries: [a, b] }));
    expect(out).toEqual({ text: 'a [REDACTED:b] b', findings: { b: 1 } });
  });

  it('lets a card inside a longer personal value be masked once', () => {
    const wrapped = { label: 'acct', value: 'acct 4242 4242 4242 4242', level: 'full' as const };
    const out = filterPersonal('x acct 4242 4242 4242 4242 y', cfg({ card: 'full', entries: [wrapped] }));
    expect(out).toEqual({ text: 'x [REDACTED:acct] y', findings: { acct: 1 } });
  });
});

describe('filterPersonal: long digit lists and level precedence', () => {
  it('handles thousands of space-separated digits quickly', () => {
    // Some windows may pass Luhn and be masked; the point is that it finishes fast and never throws.
    const text = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join(' ');
    const t0 = Date.now();
    const out = filterPersonal(text, cfg({ card: 'full' }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(typeof out.text).toBe('string');
  });

  it('lets a warn card hit yield to a stronger entry nested inside it', () => {
    const entry = { label: 'pin', value: '4242', level: 'full' as const };
    const out = filterPersonal('pay 4242 4242 4242 4242 now', cfg({ card: 'warn', entries: [entry] }));
    expect(out.text).toBe('pay [REDACTED:pin] [REDACTED:pin] [REDACTED:pin] [REDACTED:pin] now');
    expect(out.findings).toEqual({ pin: 4 });
  });
});
