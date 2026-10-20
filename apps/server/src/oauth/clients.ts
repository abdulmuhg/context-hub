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

/** Parses an IPv6 literal into 16 bytes (handles :: and an embedded dotted tail). Null if malformed. */
function parseV6(a: string): number[] | null {
  let tail: number[] = [];
  let s = a;
  const dot = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dot) {
    if (isIP(dot[1]!) !== 4) return null;
    tail = dot[1]!.split('.').map(Number);
    s = s.slice(0, s.length - dot[1]!.length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string): string[] => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...(halves.length === 2 ? Array<string>(missing).fill('0') : []), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  if (bytes.length !== 16) return null;
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True for anything that is not a plain public unicast address. Fails closed on malformed input. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return privateV4(a);
  if (kind !== 6) return true;
  const b = parseV6(a);
  if (!b) return true;
  const v4 = (o: number): string => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zeros = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return privateV4(v4(12)); // ::ffff:0:0/96
  if (zeros(12)) return privateV4(v4(12)); // ::/96 (includes :: and ::1, which read as 0.x)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return privateV4(v4(12)); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(v4(2)); // 2002::/16 (6to4)
  if (b[0] === 0) return true;
  return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || b[0] === 0xff;
}

async function hostIsPublic(host: string, cfg: OAuthConfig): Promise<boolean> {
  const h = host.toLowerCase().replace(/\.$/, '');
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
