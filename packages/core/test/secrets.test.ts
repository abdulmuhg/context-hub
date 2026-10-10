import { describe, expect, it } from 'vitest';
import { stripSecrets } from '../src/index.js';

// Built at run time so no secret-shaped literal is committed.
const a = (n: number) => 'a'.repeat(n);
const fakes: Record<string, string> = {
  github: 'gh' + 'p_' + a(36),
  github_pat: 'github' + '_pat_' + a(30),
  anthropic: 'sk-' + 'ant-' + a(40),
  openai: 'sk-' + 'proj-' + a(40),
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  google: 'AI' + 'za' + a(35),
  slack: 'xo' + 'xb-' + '1234567890-' + a(12),
  stripe: 'sk_' + 'live_' + a(24),
  npm: 'np' + 'm_' + a(36),
  jwt: 'ey' + 'J' + a(12) + '.' + a(12) + '.' + a(12),
};

describe('stripSecrets', () => {
  it.each([
    ['github', fakes.github, 'github'],
    ['github fine-grained', fakes.github_pat, 'github'],
    ['anthropic', fakes.anthropic, 'anthropic'],
    ['openai', fakes.openai, 'openai'],
    ['aws', fakes.aws, 'aws'],
    ['google', fakes.google, 'google'],
    ['slack', fakes.slack, 'slack'],
    ['stripe', fakes.stripe, 'stripe'],
    ['npm', fakes.npm, 'npm'],
    ['jwt', fakes.jwt, 'jwt'],
  ])('replaces a %s key', (_name, secret, type) => {
    const out = stripSecrets(`before ${secret} after`);
    expect(out.text).toBe(`before [REDACTED:${type}] after`);
    expect(out.counts[type]).toBe(1);
  });

  it('replaces a whole private key block', () => {
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${a(64)}\n${a(64)}\n-----END RSA PRIVATE KEY-----`;
    const out = stripSecrets(`key:\n${block}\ndone`);
    expect(out.text).toBe('key:\n[REDACTED:private_key]\ndone');
  });

  it('replaces the value of an Authorization header and keeps the scheme', () => {
    const out = stripSecrets('Authorization: Bearer abc.def-123');
    expect(out.text).toBe('Authorization: Bearer [REDACTED:auth_header]');
  });

  it('replaces the password in a connection string', () => {
    const out = stripSecrets('postgres://app:s3cr3t@db.example.com:5432/app');
    expect(out.text).toBe('postgres://app:[REDACTED:password]@db.example.com:5432/app');
  });

  it('replaces the value on an env line with a secret-looking name', () => {
    const out = stripSecrets('PORT=3000\nAPP_API_KEY=hunter2hunter2\nexport DB_PASSWORD: pw');
    expect(out.text).toBe('PORT=3000\nAPP_API_KEY=[REDACTED:env]\nexport DB_PASSWORD: [REDACTED:env]');
    expect(out.counts.env).toBe(2);
  });

  it('does not redact an env value twice', () => {
    const out = stripSecrets(`GITHUB_TOKEN=${fakes.github}`);
    expect(out.text).toBe('GITHUB_TOKEN=[REDACTED:github]');
    expect(out.counts.env).toBeUndefined();
  });

  it('leaves ordinary text alone', () => {
    const text = 'The author fixed the key handler in src/auth.ts and ran npm test.';
    expect(stripSecrets(text)).toEqual({ text, counts: {} });
  });
});

describe('stripSecrets with a token glued to preceding word characters', () => {
  it.each([
    ['github', fakes.github],
    ['anthropic', fakes.anthropic],
    ['google', fakes.google],
    ['slack', fakes.slack],
    ['stripe', fakes.stripe],
    ['jwt', fakes.jwt],
  ])('still redacts %s', (type, fake) => {
    const out = stripSecrets('x'.repeat(10) + fake);
    expect(out.text).toBe('x'.repeat(10) + `[REDACTED:${type}]`);
    expect(out.counts[type]).toBe(1);
  });

  it.each([
    ['an openai-shaped suffix of a longer word', 'risk-management-plan-' + 'a1-'.repeat(14)],
    ['an npm-shaped suffix of pnpm_', 'pn' + 'pm_' + a(36)],
  ])('does not redact %s', (_name, text) => {
    expect(stripSecrets(text)).toEqual({ text, counts: {} });
  });
});
