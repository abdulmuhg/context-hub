import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import type { Db } from '../db.js';
import { ALLOWED_REDIRECTS, type OAuthConfig } from './config.js';
import { getClient, saveClient, type StoredClient } from './store.js';

export const MAX_CLIENT_DOC = 64 * 1024;
const CIMD_TIMEOUT_MS = 3_000;
const CIMD_CACHE_MS = 24 * 3_600_000;

export type ResolveResult = { ok: true; client: StoredClient } | { ok: false; reason: string };

export const isAllowedRedirect = (u: unknown): u is string => typeof u === 'string' && ALLOWED_REDIRECTS.includes(u);

function privateV4(a: string): boolean {
  const [p, q] = a.split('.').map(Number) as [number, number];
  return (
    p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) ||
    (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224
  );
}

export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return privateV4(a);
  if (kind !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return privateV4(mapped[1]!);
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

async function hostIsPublic(host: string, cfg: OAuthConfig): Promise<boolean> {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (isIP(h.replace(/^\[|\]$/g, '')) !== 0) return !isPrivateAddress(h);
  try {
    const addrs = await (cfg.lookup ?? ((n: string) => dns.lookup(n, { all: true })))(h);
    return addrs.length > 0 && addrs.every((x) => !isPrivateAddress(x.address));
  } catch {
    return false;
  }
}

/** Reads the body, giving up as soon as it passes the limit. Null means too large. */
async function readCapped(res: Response): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_CLIENT_DOC) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_CLIENT_DOC) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchDocument(url: URL, cfg: OAuthConfig): Promise<string | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, CIMD_TIMEOUT_MS);
  });
  const run = (async () => {
    // Redirects are not followed: a public name could bounce to an internal address.
    const res = await (cfg.fetchImpl ?? fetch)(url.href, { signal: ctrl.signal, redirect: 'manual', headers: { Accept: 'application/json' } });
    if (res.status !== 200) return null;
    return readCapped(res);
  })().catch(() => null);
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCimd(db: Db, cfg: OAuthConfig, clientId: string, now: string): Promise<ResolveResult> {
  const cached = getClient(db, clientId);
  if (cached && cached.kind === 'cimd' && new Date(now).getTime() - new Date(cached.fetchedAt).getTime() < CIMD_CACHE_MS) {
    return { ok: true, client: cached };
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, reason: 'client_id is not a valid URL' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return { ok: false, reason: 'client_id must be a plain https URL' };
  if (!(await hostIsPublic(url.hostname, cfg))) return { ok: false, reason: 'client_id points at a private or unresolvable address' };
  const text = await fetchDocument(url, cfg);
  if (text === null) return { ok: false, reason: 'client metadata document could not be fetched' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'client metadata document is not JSON' };
  }
  const d = doc as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown } | null;
  if (d === null || typeof d !== 'object' || d.client_id !== clientId) return { ok: false, reason: 'client_id in the document does not match its URL' };
  const redirects = Array.isArray(d.redirect_uris) ? d.redirect_uris.filter(isAllowedRedirect) : [];
  if (redirects.length === 0) return { ok: false, reason: 'no allowed redirect_uri in the document' };
  const name = typeof d.client_name === 'string' && d.client_name.trim() ? d.client_name.trim().slice(0, 100) : url.hostname;
  saveClient(db, { clientId, kind: 'cimd', name, redirectUris: redirects }, now);
  const saved = getClient(db, clientId);
  return saved ? { ok: true, client: saved } : { ok: false, reason: 'could not save client' };
}

export async function resolveClient(db: Db, cfg: OAuthConfig, clientId: string, now: string): Promise<ResolveResult> {
  if (clientId.startsWith('https://') || clientId.startsWith('http://')) return resolveCimd(db, cfg, clientId, now);
  const c = getClient(db, clientId);
  return c && c.kind === 'dcr' ? { ok: true, client: c } : { ok: false, reason: 'unknown client' };
}
