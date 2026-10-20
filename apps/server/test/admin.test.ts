import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAdmin, type AdminIo } from '../src/admin.js';
import { openDb } from '../src/db.js';
import { consumeConnectCode, createGrant, issueTokens } from '../src/oauth/store.js';
import { upsertSession } from '../src/store.js';
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
