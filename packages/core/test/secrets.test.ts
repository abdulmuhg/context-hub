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
    const block = `${'-----BEGIN ' + 'RSA PRIVATE KEY-----'}\n${a(64)}\n${a(64)}\n${'-----END ' + 'RSA PRIVATE KEY-----'}`;
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

describe('stripSecrets: final review fixes', () => {
  const hdr = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const ftr = '-----END ' + 'RSA PRIVATE KEY-----';

  // Changed in review: the fallback used to redact to the end of the text, which
  // deleted the rest of any message that merely quoted a key header. It now takes
  // the key material only and keeps what follows.
  it('redacts the key material of an unterminated private key block and keeps what follows', () => {
    const out = stripSecrets(`key:\n${hdr}\n${a(64)}\n${a(64)}\n(truncated)`);
    expect(out.text).toBe('key:\n[REDACTED:private_key]\n(truncated)');
    expect(out.text).not.toContain(a(64));
    expect(out.counts).toEqual({ private_key: 1 });
  });

  it('counts a complete block once and keeps the text after it', () => {
    const out = stripSecrets(`${hdr}\n${a(64)}\n${ftr}\nafter`);
    expect(out.text).toBe('[REDACTED:private_key]\nafter');
    expect(out.counts).toEqual({ private_key: 1 });
  });

  it('redacts a PGP private key block', () => {
    const out = stripSecrets(`x ${'-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----'}\n${a(40)}\n${'-----END ' + 'PGP PRIVATE KEY BLOCK-----'} y`);
    expect(out.text).toBe('x [REDACTED:private_key] y');
  });

  it('redacts a connection-string password containing a slash', () => {
    const out = stripSecrets('postgres://app:pa/ss@db.example.com:5432/app');
    expect(out.text).toBe('postgres://app:[REDACTED:password]@db.example.com:5432/app');
  });

  it('redacts a connection-string password containing an at sign', () => {
    const out = stripSecrets('postgres://u:p@ss@db.example.com/app');
    expect(out.text).toBe('postgres://u:[REDACTED:password]@db.example.com/app');
  });

  it('leaves URLs without a password and redacted markers alone', () => {
    for (const text of [
      'see https://example.com:8080/path and git@github.com:me/x.git',
      'postgres://app:[REDACTED:password]@db.example.com/app',
    ]) {
      expect(stripSecrets(text)).toEqual({ text, counts: {} });
    }
  });

  it('consumes a quoted env value with spaces', () => {
    expect(stripSecrets('API_KEY="hunter2 and more words"').text).toBe('API_KEY=[REDACTED:env]');
    expect(stripSecrets("API_KEY='hunter2 and more words'").text).toBe('API_KEY=[REDACTED:env]');
    expect(stripSecrets('API_KEY=hunter2 and').text).toBe('API_KEY=[REDACTED:env] and');
  });

  it('does not double-redact a quoted env value already redacted by a specific rule', () => {
    const out = stripSecrets(`API_KEY="${fakes.github}"`);
    expect(out.text).toBe('API_KEY="[REDACTED:github]"');
    expect(out.counts).toEqual({ github: 1 });
  });

  it('redacts a JSON or dict style Authorization header', () => {
    expect(stripSecrets('{"Authorization": "Bearer abc.def-123"}').text).toBe(
      '{"Authorization": "Bearer [REDACTED:auth_header]"}',
    );
    expect(stripSecrets("'Authorization': 'Basic dXNlcjpwYXNz'").text).toBe(
      "'Authorization': 'Basic [REDACTED:auth_header]'",
    );
  });

  it('is idempotent over every new shape', () => {
    const text = [
      `${hdr}\n${a(20)}\n(truncated)`,
      'postgres://u:p@ss@db.example.com/app',
      'postgres://app:pa/ss@db.example.com/app',
      'API_KEY="hunter2 and more words"',
      `API_KEY="${fakes.github}"`,
      '{"Authorization": "Bearer abc.def-123"}',
    ].join('\n');
    const once = stripSecrets(text);
    const twice = stripSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.counts).toEqual({});
  });
});

describe('stripSecrets: review fixes', () => {
  const header = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

  it.each([
    ['a Vite dev URL', 'GET http://localhost:5173/@vite/client 200'],
    ['a port followed by a path with an at sign', 'open http://127.0.0.1:3000/users/me@example.com/edit'],
    ['a bare host and port', 'listening on http://localhost:8080'],
  ])('leaves %s alone', (_name, text) => {
    expect(stripSecrets(text)).toEqual({ text, counts: {} });
  });

  it('redacts a password when the user name is empty', () => {
    const out = stripSecrets('redis://:hunter2@cache:6379');
    expect(out.text).toBe('redis://:[REDACTED:password]@cache:6379');
  });

  it('stays fast on input built to make the URL rule backtrack', () => {
    const start = performance.now();
    stripSecrets('a://x:'.repeat(40000));
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('keeps the text after a sentence that only mentions a key header', () => {
    const text = `Look for a line "${header}" in the file.\n\nNext step: run the deploy.\nThen tell the user.`;
    expect(stripSecrets(text).text).toBe(
      'Look for a line "[REDACTED:private_key]" in the file.\n\nNext step: run the deploy.\nThen tell the user.',
    );
  });

  it('still redacts the body of a key block that was cut off before its END line', () => {
    const out = stripSecrets(`key:\n${header}\nProc-Type: 4,ENCRYPTED\n\n${a(64)}\n${a(64)}\n${a(20)}`);
    expect(out.text).toBe('key:\n[REDACTED:private_key]');
  });

  it('redacts a cut-off key block written with escaped newlines, as inside JSON', () => {
    const out = stripSecrets(`{"key":"${header}\\n${a(64)}\\n${a(64)}`);
    expect(out.text).toBe('{"key":"[REDACTED:private_key]');
  });
});
