import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isResource, TTL } from './config.js';
import { findToken, issueTokens, revokeGrant, rotateRefresh, takeAuthCode } from './store.js';
import type { OAuthCtx } from './routes.js';
import { send } from '../http.js';

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  send(res, status, body);
}

const fail = (res: ServerResponse, error: string, description: string): void => reply(res, 400, { error, error_description: description });

function pkceMatches(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /oauth/token. Failures here are never counted by the failed-login limiter. */
export async function token(req: IncomingMessage, res: ServerResponse, ctx: OAuthCtx): Promise<void> {
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return fail(res, 'invalid_request', 'The body must be application/x-www-form-urlencoded');
  }
  let body: Buffer;
  try {
    body = await ctx.readBody();
  } catch {
    // Too large, or marked gzip but not decompressible.
    return fail(res, 'invalid_request', 'The request body could not be read');
  }
  const form = new URLSearchParams(body.toString('utf8'));
  const now = (ctx.cfg.now?.() ?? new Date()).toISOString();
  const grantType = form.get('grant_type');
  const resource = form.get('resource');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return fail(res, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  }
  if (resource !== null && !isResource(ctx.cfg, resource)) return fail(res, 'invalid_target', 'The resource is not this server');

  if (grantType === 'authorization_code') {
    const taken = takeAuthCode(ctx.db, form.get('code') ?? '', now);
    if (taken.status === 'invalid') return fail(res, 'invalid_grant', 'The code is invalid or expired');
    if (taken.status === 'reused') {
      // A second use of a code is the theft signal: end everything issued from it.
      revokeGrant(ctx.db, taken.grantId, now);
      return fail(res, 'invalid_grant', 'The code was already used');
    }
    const row = taken.row;
    if (form.get('client_id') !== row.clientId || form.get('redirect_uri') !== row.redirectUri) {
      return fail(res, 'invalid_grant', 'The code was issued to a different client or redirect_uri');
    }
    if (!pkceMatches(form.get('code_verifier') ?? '', row.codeChallenge)) return fail(res, 'invalid_grant', 'The code_verifier does not match');
    const grant = ctx.db.prepare('SELECT scopes, revoked_at FROM oauth_grants WHERE id = ?').get(row.grantId) as
      | { scopes: string; revoked_at: string | null }
      | undefined;
    if (!grant || grant.revoked_at !== null) return fail(res, 'invalid_grant', 'The grant was revoked');
    const scopes = grant.scopes.split(' ');
    const withRefresh = scopes.includes('offline_access');
    const issued = issueTokens(ctx.db, row.grantId, withRefresh, now);
    return reply(res, 200, {
      access_token: issued.access,
      token_type: 'Bearer',
      expires_in: TTL.access / 1000,
      ...(issued.refresh ? { refresh_token: issued.refresh } : {}),
      scope: scopes.join(' '),
    });
  }

  const old = findToken(ctx.db, form.get('refresh_token') ?? '');
  if (!old || old.kind !== 'refresh' || old.grant.clientId !== form.get('client_id') || old.grant.revokedAt !== null) {
    return fail(res, 'invalid_grant', 'The refresh token is invalid');
  }
  if (old.replacedAt !== null) {
    // Already rotated: a retry of a lost response inside the grace window is fine, anything later is theft.
    if (new Date(now).getTime() - new Date(old.replacedAt).getTime() >= TTL.grace) {
      revokeGrant(ctx.db, old.grantId, now);
      return fail(res, 'invalid_grant', 'The refresh token was already used');
    }
  }
  if (old.expiresAt <= now) return fail(res, 'invalid_grant', 'The refresh token has expired');
  // rotateRefresh cancels the pair handed out for the earlier, possibly lost, answer.
  const pair = rotateRefresh(ctx.db, old, now);
  reply(res, 200, {
    access_token: pair.access,
    token_type: 'Bearer',
    expires_in: TTL.access / 1000,
    refresh_token: pair.refresh,
    scope: old.grant.scopes.join(' '),
  });
}
