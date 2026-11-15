import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAdmin, type AdminIo } from '../src/admin.js';
import { recordUsage } from '../src/usage.js';
import { openDb } from '../src/db.js';
import { consumeConnectCode, createGrant, issueTokens } from '../src/oauth/store.js';
import { upsertSession } from '../src/store.js';
import { addToWaitlist, countWaitlist } from '../src/waitlist.js';
import { checkCredential, verifyToken } from '../src/tokens.js';
import { makeSession } from './helpers.js';

let io: AdminIo;
let out: string[];
let err: string[];
const NOW = new Date('2026-10-11T00:00:00.000Z');

beforeEach(() => {
  out = [];
  err = [];
  io = { db: openDb(':memory:'), out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW };
});

describe('hub-admin token', () => {
  it('create prints a token that then verifies with the chosen scope', async () => {
    expect(await runAdmin(['token', 'create', '--label', 'claude-code-pc', '--scope', 'read'], io)).toBe(0);
    const token = /chub_[A-Za-z0-9_-]+/.exec(out.join('\n'))![0];
    expect(verifyToken(io.db, token, NOW.toISOString())).toMatchObject({ scope: 'read' });
    expect(out.join('\n')).toMatch(/shown only once/i);
  });

  it('create refuses a missing label or an unknown scope', async () => {
    expect(await runAdmin(['token', 'create', '--scope', 'read'], io)).toBe(1);
    expect(await runAdmin(['token', 'create', '--label', 'x', '--scope', 'admin'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/ingest or read/);
  });

  it('list shows labels and scopes but never a token or hash', async () => {
    await runAdmin(['token', 'create', '--label', 'collector', '--scope', 'ingest'], io);
    const token = /chub_[A-Za-z0-9_-]+/.exec(out.join('\n'))![0];
    out = [];
    expect(await runAdmin(['token', 'list'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/1\s+ingest\s+collector/);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('revoke stops the token and reports a second attempt as an error', async () => {
    await runAdmin(['token', 'create', '--label', 'x', '--scope', 'read'], io);
    const token = /chub_[A-Za-z0-9_-]+/.exec(out.join('\n'))![0];
    expect(await runAdmin(['token', 'revoke', '1'], io)).toBe(0);
    expect(verifyToken(io.db, token, NOW.toISOString())).toBeNull();
    expect(await runAdmin(['token', 'revoke', '1'], io)).toBe(1);
    expect(await runAdmin(['token', 'revoke', 'abc'], io)).toBe(1);
  });
});

describe('hub-admin backup', () => {
  it('writes a copy that opens and holds the same data', async () => {
    upsertSession(io.db, makeSession(), NOW.toISOString());
    const target = join(mkdtempSync(join(tmpdir(), 'hub-backup-')), 'copy.sqlite');
    expect(await runAdmin(['backup', target], io)).toBe(0);
    expect(existsSync(target)).toBe(true);
    const copy = openDb(target);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    copy.close();
  });

  it('needs a file name', async () => {
    expect(await runAdmin(['backup'], io)).toBe(1);
  });
});

describe('hub-admin connect-code', () => {
  it('connect-code prints one code and its expiry', async () => {
    expect(await runAdmin(['connect-code'], io)).toBe(0);
    const text = out.join('\n');
    expect(text.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g)).toHaveLength(1);
    expect(text).toContain('2026-10-11T00:10:00.000Z');
    expect(text).toMatch(/one use/);
    expect((io.db.prepare('SELECT COUNT(*) AS n FROM connect_codes').get() as { n: number }).n).toBe(1);
  });
});

describe('hub-admin device-code', () => {
  it('prints one device code that connects a computer and does not sign in a browser', async () => {
    expect(await runAdmin(['device-code'], io)).toBe(0);
    const text = out.join('\n');
    const codes = text.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g) ?? [];
    expect(codes).toHaveLength(1);
    expect(text).toMatch(/hub login/);
    expect(text).toMatch(/one use/);
    const row = io.db.prepare('SELECT purpose FROM connect_codes').get() as { purpose: string };
    expect(row.purpose).toBe('device');
    // Refused where a sign-in code goes, and still good for its own purpose afterwards.
    expect(consumeConnectCode(io.db, codes[0]!, NOW.toISOString(), 'signin')).toBe(false);
    expect(consumeConnectCode(io.db, codes[0]!, NOW.toISOString(), 'device')).toBe(true);
  });
});

describe('hub-admin usage', () => {
  it('prints usage for an unknown command', async () => {
    expect(await runAdmin(['dance'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: hub-admin/);
  });
});

describe('hub-admin oauth', () => {
  const grant = (name = 'Claude') => createGrant(io.db, { clientId: 'dcr_x', clientName: name, scopes: ['hub.read', 'hub.save'] }, NOW.toISOString());

  it('list says so when there are none', async () => {
    expect(await runAdmin(['oauth', 'list'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/no .*sign-ins/i);
  });

  it('list shows id, client, scopes, dates and state, and nothing secret', async () => {
    const id = grant('Claude Desktop');
    const { access, refresh } = issueTokens(io.db, id, true, NOW.toISOString());
    grant('Other');
    await runAdmin(['oauth', 'revoke', '2'], io);
    out = [];
    expect(await runAdmin(['oauth', 'list'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/1\s+Claude Desktop\s+hub\.read hub\.save\s+created 2026-10-11\s+last used never\s+active/);
    expect(text).toMatch(/2\s+Other .*revoked 2026-10-11/);
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh!);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toContain('chub_');
  });

  it('revoke ends the grant so its tokens stop working, and reports unknown or repeated ids', async () => {
    const id = grant();
    const { access } = issueTokens(io.db, id, false, NOW.toISOString());
    expect(checkCredential(io.db, access, NOW.toISOString())).toMatchObject({ kind: 'oauth' });
    expect(await runAdmin(['oauth', 'revoke', String(id)], io)).toBe(0);
    expect(out.join('\n')).toContain(`Sign-in ${id} revoked`);
    expect(checkCredential(io.db, access, NOW.toISOString())).toBe('dead');
    expect(await runAdmin(['oauth', 'revoke', String(id)], io)).toBe(1);
    expect(await runAdmin(['oauth', 'revoke', '99'], io)).toBe(1);
    expect(await runAdmin(['oauth', 'revoke', 'abc'], io)).toBe(1);
    expect(await runAdmin(['oauth', 'revoke'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/oauth list/);
  });
});

describe('hub-admin usage', () => {
  const call = (at: string, over: Partial<Parameters<typeof recordUsage>[1]> = {}) =>
    recordUsage(io.db, { model: 'claude-haiku-5-5', kind: 'digest', project: 'github.com/me/alpha', input_tokens: 10_000, output_tokens: 1_000, cache_read_tokens: 0, cache_write_tokens: 0, ...over }, at);

  it('prints a line per day, the breakdowns and the count over 100K', async () => {
    call('2026-10-11T12:00:00.000Z', { kind: 'review' });
    call('2026-10-11T13:00:00.000Z', { input_tokens: 150_000 });
    call('2026-10-10T12:00:00.000Z', { project: 'local:beta' });
    call('2026-10-01T12:00:00.000Z'); // outside --days 2
    expect(await runAdmin(['usage', '--days', '2'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/2026-10-10 +1 calls +10000 in +1000 out +\$0\.00/);
    expect(text).toMatch(/2026-10-11 +2 calls +160000 in/);
    expect(text).not.toContain('2026-10-01');
    expect(text).toMatch(/By kind\n(.*\n)*.*review/);
    expect(text).toMatch(/By project\n(.*\n)*.*github\.com\/me\/alpha/);
    expect(text).toContain('local:beta');
    expect(text).toContain('over the 100K price step: 1 call');
  });

  it('defaults to 7 days and rejects a bad --days', async () => {
    expect(await runAdmin(['usage'], io)).toBe(0);
    expect(out.filter((l) => /^2026-10-\d\d /.test(l))).toHaveLength(7);
    expect(await runAdmin(['usage', '--days', '0'], io)).toBe(1);
  });

  it('shows tokens and a dash for the cost of a model with no known price', async () => {
    call('2026-10-11T12:00:00.000Z', { model: 'some-other-model' });
    await runAdmin(['usage', '--days', '1'], io);
    expect(out.join('\n')).toMatch(/2026-10-11 +1 calls +10000 in +1000 out +—/);
  });
});

describe('hub-admin setup', () => {
  it('prints a sign-in code and both install lines carrying a computer code', async () => {
    io.publicUrl = 'https://hub.example.com';
    expect(await runAdmin(['setup'], io)).toBe(0);
    const text = out.join('\n');
    const codes = text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/g)!;
    expect(new Set(codes).size).toBe(2);
    expect(text).toContain('curl -fsSL https://hub.example.com/install | sh -s -- --code ');
    expect(text).toContain('irm https://hub.example.com/install.ps1 | iex');
    expect(text).toContain('https://hub.example.com/login');
    expect(text).toMatch(/10 minutes/);
  });

  it('without a public address prints both codes and the hub login hint', async () => {
    expect(await runAdmin(['setup'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/Sign-in code: /);
    expect(text).toMatch(/Computer code: /);
    expect(text).toContain('hub login');
    expect(text).not.toContain('curl');
  });

  it('the sign-in code it prints signs a browser in once', async () => {
    await runAdmin(['setup'], io);
    const code = /Sign-in code: (\S+)/.exec(out.join('\n'))![1]!;
    expect(consumeConnectCode(io.db, code, NOW.toISOString())).toBe(true);
    expect(consumeConnectCode(io.db, code, NOW.toISOString())).toBe(false);
  });
});

describe('hub-admin waitlist', () => {
  it('waitlist lists addresses with a count, and remove deletes one', async () => {
    addToWaitlist(io.db, 'ada@example.com', NOW.toISOString());
    expect(await runAdmin(['waitlist'], io)).toBe(0);
    expect(out.join('\n')).toContain('ada@example.com');
    expect(out.join('\n')).toMatch(/1 on the waitlist/);
    expect(await runAdmin(['waitlist', 'remove', 'ADA@example.com'], io)).toBe(0);
    expect(countWaitlist(io.db)).toBe(0);
    expect(await runAdmin(['waitlist', 'remove', 'ada@example.com'], io)).toBe(1);
  });
});
