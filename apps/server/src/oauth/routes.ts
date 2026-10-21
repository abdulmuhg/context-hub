import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.js';
import type { AuthLimiter } from '../ratelimit.js';
import { send } from '../http.js';
import { randomBytes } from 'node:crypto';
import { isAllowedRedirect, MAX_CLIENT_DOC } from './clients.js';
import { pruneClients, saveClient } from './store.js';
import { authorize } from './authorize.js';
import { token } from './token.js';
import { authorizationServerMetadata, protectedResourceMetadata, type OAuthConfig } from './config.js';

export interface OAuthCtx {
  db: Db;
  cfg: OAuthConfig;
  limiter: AuthLimiter;
  address: string;
  readBody: () => Promise<Buffer>;
}

/** Every OAuth answer is private to the caller and must not be cached. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, body);
}

/** Reads a request body, stopping as soon as it passes the limit. Null means too large. */
async function readLimited(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Keep draining (without keeping) so the answer is not cut off by a reset connection.
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return size > max ? null : Buffer.concat(chunks);
}

async function register(req: IncomingMessage, res: ServerResponse, ctx: OAuthCtx): Promise<void> {
  const bad = (status: number, error: string, description: string): void => json(res, status, { error, error_description: description });
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return bad(400, 'invalid_client_metadata', 'The body must be application/json');
  }
  const raw = await readLimited(req, MAX_CLIENT_DOC);
  if (raw === null) return bad(413, 'invalid_client_metadata', 'The body is larger than 64 KiB');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return bad(400, 'invalid_client_metadata', 'The body is not a JSON object');
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return bad(400, 'invalid_redirect_uri', 'redirect_uris is required');
  if (!uris.every(isAllowedRedirect)) return bad(400, 'invalid_redirect_uri', 'A redirect_uri is not allowed');
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return bad(400, 'invalid_client_metadata', 'Only token_endpoint_auth_method none is supported');
  }
  const now = (ctx.cfg.now?.() ?? new Date()).toISOString();
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'Unnamed client';
  const clientId = 'dcr_' + randomBytes(16).toString('base64url');
  pruneClients(ctx.db, now);
  saveClient(ctx.db, { clientId, kind: 'dcr', name, redirectUris: uris }, now);
  json(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(now).getTime() / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

/** Handles /.well-known/* and /oauth/*. Returns true if the request was answered. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: OAuthCtx): Promise<boolean> {
  if (method === 'GET' || method === 'HEAD') {
    // Built from configuration only, never from the Host header.
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource/mcp/') {
      json(res, 200, protectedResourceMetadata(ctx.cfg));
      return true;
    }
    if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, authorizationServerMetadata(ctx.cfg));
      return true;
    }
  }
  if ((method === 'GET' || method === 'POST') && path === '/oauth/authorize') {
    await authorize(req, res, method, ctx);
    return true;
  }
  if (method === 'POST' && path === '/oauth/token') {
    await token(req, res, ctx);
    return true;
  }
  if (method === 'POST' && path === '/oauth/register') {
    await register(req, res, ctx);
    return true;
  }
  return false;
}
