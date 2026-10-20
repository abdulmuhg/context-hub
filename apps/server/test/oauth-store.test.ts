import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import {
  consumeConnectCode,
  createAuthCode,
  createConnectCode,
  createGrant,
  findToken,
  issueTokens,
  pruneClients,
  getClient,
  revokeGrant,
  saveClient,
  takeAuthCode,
} from '../src/oauth/store.js';

const T0 = '2026-10-20T10:00:00.000Z';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const grant = () => createGrant(db, { clientId: 'c1', clientName: 'Claude', scopes: ['hub.read', 'hub.save'] }, T0);
const authCode = (grantId: number) =>
  createAuthCode(
    db,
    { grantId, clientId: 'c1', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'abc', resource: 'https://h.test/mcp' },
    T0,
  );

describe('connect codes', () => {
  it('are XXXX-XXXX from the allowed alphabet, work once, and expire after 10 minutes', () => {
    const { code } = createConnectCode(db, T0);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(consumeConnectCode(db, code.toLowerCase().replace('-', ' '), T0)).toBe(true);
    expect(consumeConnectCode(db, code, T0)).toBe(false);
    const late = createConnectCode(db, T0);
    expect(consumeConnectCode(db, late.code, plus(T0, 600_001))).toBe(false);
  });

  it('are rejected when unknown', () => {
    expect(consumeConnectCode(db, 'AAAA-AAAA', T0)).toBe(false);
  });

  it('work only for their own purpose and stay usable for it', () => {
    const device = createConnectCode(db, T0, 'device').code;
    expect(consumeConnectCode(db, device, T0)).toBe(false);
    expect(consumeConnectCode(db, device, T0, 'signin')).toBe(false);
    expect(consumeConnectCode(db, device, T0, 'device')).toBe(true);
    const signin = createConnectCode(db, T0).code;
    expect(consumeConnectCode(db, signin, T0, 'device')).toBe(false);
    expect(consumeConnectCode(db, signin, T0, 'signin')).toBe(true);
  });

  it('created before the migration count as sign-in codes', () => {
    db.prepare('INSERT INTO connect_codes(hash, created_at, expires_at) VALUES (?, ?, ?)').run(
      createHash('sha256').update('AAAABBBB').digest('hex'),
      T0,
      plus(T0, 600_000),
    );
    expect(consumeConnectCode(db, 'AAAA-BBBB', T0, 'device')).toBe(false);
    expect(consumeConnectCode(db, 'AAAA-BBBB', T0)).toBe(true);
  });
});

describe('only hashes are stored', () => {
  it('keeps no raw connect code, auth code or token in any OAuth table', () => {
    const { code } = createConnectCode(db, T0);
    const g = grant();
    const ac = authCode(g);
    const { access, refresh } = issueTokens(db, g, true, T0);
    const dump = ['oauth_clients', 'connect_codes', 'oauth_grants', 'oauth_codes', 'oauth_tokens']
      .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
    for (const raw of [code, code.replace('-', ''), ac, access, refresh!]) expect(dump).not.toContain(raw);
  });
});

describe('authorization codes', () => {
  it('work once; a second use reports reused with its grant', () => {
    const g = grant();
    const ac = authCode(g);
    expect(ac).toMatch(/^chub_ac_/);
    const first = takeAuthCode(db, ac, plus(T0, 1000));
    expect(first.status).toBe('ok');
    if (first.status === 'ok') {
      expect(first.row.grantId).toBe(g);
      expect(first.row.codeChallenge).toBe('abc');
    }
    expect(takeAuthCode(db, ac, plus(T0, 2000))).toEqual({ status: 'reused', grantId: g });
  });

  it('expire after 60 s', () => {
    const ac = authCode(grant());
    expect(takeAuthCode(db, ac, plus(T0, 60_001))).toEqual({ status: 'invalid' });
    expect(takeAuthCode(db, 'chub_ac_nope', T0)).toEqual({ status: 'invalid' });
  });
});

describe('tokens', () => {
  it('issueTokens gives chub_at_/chub_rt_ prefixes, and no refresh token when withRefresh is false', () => {
    const g = grant();
    const both = issueTokens(db, g, true, T0);
    expect(both.access).toMatch(/^chub_at_[A-Za-z0-9_-]{43}$/);
    expect(both.refresh).toMatch(/^chub_rt_[A-Za-z0-9_-]{43}$/);
    const rec = findToken(db, both.access)!;
    expect(rec.kind).toBe('access');
    expect(rec.expiresAt).toBe(plus(T0, 3_600_000));
    expect(rec.grant.scopes).toEqual(['hub.read', 'hub.save']);
    expect(findToken(db, both.refresh!)!.expiresAt).toBe(plus(T0, 90 * 86_400_000));
    const only = issueTokens(db, g, false, T0);
    expect(only.refresh).toBeNull();
    expect(only.access).toMatch(/^chub_at_/);
    expect(findToken(db, 'chub_at_unknown')).toBeNull();
  });

  it('revokeGrant makes findToken report the grant revoked', () => {
    const g = grant();
    const { access } = issueTokens(db, g, true, T0);
    expect(findToken(db, access)!.grant.revokedAt).toBeNull();
    expect(revokeGrant(db, g, plus(T0, 5))).toBe(true);
    expect(findToken(db, access)!.grant.revokedAt).toBe(plus(T0, 5));
    expect(revokeGrant(db, g, plus(T0, 6))).toBe(false);
  });
});

describe('pruneClients', () => {
  it('removes DCR clients older than 30 days with no grant, and keeps ones with a grant', () => {
    const old = plus(T0, -31 * 86_400_000);
    const c = (clientId: string, kind: 'dcr' | 'cimd') => ({ clientId, kind, name: clientId, redirectUris: ['https://claude.ai/api/mcp/auth_callback'] });
    saveClient(db, c('orphan', 'dcr'), old);
    saveClient(db, c('granted', 'dcr'), old);
    saveClient(db, c('fresh', 'dcr'), T0);
    saveClient(db, c('cimd-old', 'cimd'), old);
    createGrant(db, { clientId: 'granted', clientName: 'x', scopes: ['hub.read'] }, old);
    expect(pruneClients(db, T0)).toBe(1);
    expect(getClient(db, 'orphan')).toBeNull();
    expect(getClient(db, 'granted')!.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
    expect(getClient(db, 'fresh')).not.toBeNull();
    expect(getClient(db, 'cimd-old')).not.toBeNull();
  });

  it('keeps at most 100 unused DCR clients, dropping the oldest', () => {
    for (let i = 0; i < 105; i++) {
      saveClient(db, { clientId: 'c' + i, kind: 'dcr', name: 'x', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] }, plus(T0, i * 1000));
    }
    createGrant(db, { clientId: 'c0', clientName: 'x', scopes: ['hub.read'] }, T0);
    pruneClients(db, plus(T0, 200_000));
    expect(getClient(db, 'c0')).not.toBeNull();
    expect(getClient(db, 'c1')).toBeNull();
    expect(getClient(db, 'c4')).toBeNull();
    expect(getClient(db, 'c5')).not.toBeNull();
    expect(getClient(db, 'c104')).not.toBeNull();
  });
});
