import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.js';
import type { AuthLimiter } from '../ratelimit.js';
import { send } from '../http.js';
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

/** Handles /.well-known/* and /oauth/*. Returns true if the request was answered. */
export async function handleOAuth(_req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: OAuthCtx): Promise<boolean> {
  if (method === 'GET' || method === 'HEAD') {
    // Built from configuration only, never from the Host header.
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, protectedResourceMetadata(ctx.cfg));
      return true;
    }
    if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, authorizationServerMetadata(ctx.cfg));
      return true;
    }
  }
  return false;
}
