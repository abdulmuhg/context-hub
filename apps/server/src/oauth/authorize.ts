import type { IncomingMessage, ServerResponse } from 'node:http';
import { resourceUrl, type HubScope } from './config.js';
import { resolveClient, isAllowedRedirect } from './clients.js';
import { consumeConnectCode, createAuthCode, createGrant } from './store.js';
import { errorPage, signInPage } from './page.js';
import type { OAuthCtx } from './routes.js';

const PARAMS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

function redirect(res: ServerResponse, url: URL): void {
  res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

/** GET and POST /oauth/authorize. Everything is validated from scratch on both. */
export async function authorize(req: IncomingMessage, res: ServerResponse, method: string, ctx: OAuthCtx): Promise<void> {
  let form: URLSearchParams | null = null;
  let source: URLSearchParams;
  if (method === 'POST') {
    form = new URLSearchParams((await ctx.readBody()).toString('utf8'));
    source = form;
  } else {
    source = new URL(req.url ?? '/', 'http://local').searchParams;
  }
  const p: Record<string, string | undefined> = {};
  for (const k of PARAMS) p[k] = source.get(k) ?? undefined;

  const now = (ctx.cfg.now?.() ?? new Date()).toISOString();

  // The browser address is checked first: client resolution can cost a DNS lookup and an HTTPS fetch.
  if (ctx.limiter.isBlocked(ctx.address)) return errorPage(res, 429, 'Too many wrong codes. Try again in 15 minutes.');

  // 1. Client and redirect_uri. Any failure is an error page, never a redirect.
  if (!p.client_id) return errorPage(res, 400, 'The request does not say which app is asking.');
  const resolved = await resolveClient(ctx.db, ctx.cfg, p.client_id, now);
  if (!resolved.ok) return errorPage(res, 400, `The app that sent you here could not be verified (${resolved.reason}).`);
  const client = resolved.client;
  const redirectUri = p.redirect_uri;
  if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return errorPage(res, 400, 'The address this app wants to return to is not allowed.');
  }

  // 2. Protocol errors go back to the (now trusted) redirect_uri with the original state.
  const fail = (error: string): void => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (p.state !== undefined) u.searchParams.set('state', p.state);
    redirect(res, u);
  };
  if (p.response_type !== 'code') return fail('unsupported_response_type');
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return fail('invalid_request');
  if (p.resource !== undefined && p.resource !== resourceUrl(ctx.cfg)) return fail('invalid_target');

  const hidden: Record<string, string> = {};
  for (const k of PARAMS) if (p[k] !== undefined) hidden[k] = p[k]!;
  const view = { clientName: client.name, redirectHost: new URL(redirectUri).host, hidden };

  if (form === null) return signInPage(res, { ...view, wrongCode: false, saveTicked: true });

  // 3. The connect code. A blocked address is refused before the code is tried.
  if (!consumeConnectCode(ctx.db, form.get('code') ?? '', now)) {
    ctx.limiter.recordFailure(ctx.address);
    return signInPage(res, { ...view, wrongCode: true, saveTicked: form.get('save') === 'on' });
  }

  // Unknown scopes are dropped: every grant reads, saving needs the ticked box.
  const scopes: HubScope[] = ['hub.read'];
  if (form.get('save') === 'on') scopes.push('hub.save');
  if ((p.scope ?? '').split(/\s+/).includes('offline_access')) scopes.push('offline_access');
  const grantId = createGrant(ctx.db, { clientId: client.clientId, clientName: client.name, scopes }, now);
  const code = createAuthCode(
    ctx.db,
    { grantId, clientId: client.clientId, redirectUri, codeChallenge: p.code_challenge, resource: resourceUrl(ctx.cfg) },
    now,
  );
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  if (p.state !== undefined) u.searchParams.set('state', p.state);
  u.searchParams.set('iss', ctx.cfg.publicUrl.replace(/\/+$/, ''));
  redirect(res, u);
}
