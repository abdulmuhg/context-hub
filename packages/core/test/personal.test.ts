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
