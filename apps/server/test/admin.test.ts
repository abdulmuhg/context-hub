import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAdmin, type AdminIo } from '../src/admin.js';
import { openDb } from '../src/db.js';
import { upsertSession } from '../src/store.js';
import { verifyToken } from '../src/tokens.js';
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

describe('hub-admin usage', () => {
  it('prints usage for an unknown command', async () => {
    expect(await runAdmin(['dance'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: hub-admin/);
  });
});
