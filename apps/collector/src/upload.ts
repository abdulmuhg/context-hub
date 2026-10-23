import { gzipSync } from 'node:zlib';
import { TRIGGER_HEADER, type HashedSession, type Trigger, type UploadDigest } from '@context-hub/core';

import { BadCodeError, HttpStatusError, plainReason, UnreachableError } from './errors.js';

export interface Remote {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Give up on a request after this long. Default 60 seconds. */
  timeoutMs?: number;
  /** What started this run, sent with every request so the hub's activity log can show it. */
  trigger?: Trigger;
}

function base(remote: Remote): string {
  return remote.url.replace(/\/+$/, '');
}

/** Sends a request and returns the answer whatever its status. Throws only when the server cannot be reached. */
async function request(remote: Remote, method: string, path: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
  const doFetch = remote.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${remote.token}` };
  if (remote.trigger) headers[TRIGGER_HEADER] = remote.trigger;
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Encoding'] = 'gzip';
  }
  let res: Response;
  try {
    res = await doFetch(base(remote) + path, { method, headers, body, signal: AbortSignal.timeout(remote.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new UnreachableError(base(remote), plainReason(e));
  }
  return res;
}

async function send(remote: Remote, method: string, path: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
  const res = await request(remote, method, path, body);
  if (!res.ok) throw new HttpStatusError(method, path, res.status);
  return res;
}

const gz = (value: unknown): Uint8Array<ArrayBuffer> => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
const sessionPath = (ref: { source: string; id: string }): string => `/api/sessions/${ref.source}/${encodeURIComponent(ref.id)}`;

/** Uploads a session, with the summary written for it when there is one. */
export async function putSession(remote: Remote, session: HashedSession, digest?: UploadDigest): Promise<void> {
  const path = sessionPath({ source: session.source, id: session.source_session_id });
  await send(remote, 'PUT', path, gz(digest === undefined ? session : { ...session, digest }));
}

/** Saves a summary for a session already on the hub. 'moved' means the session changed since the summary was written. */
export async function putDigest(remote: Remote, ref: { source: string; id: string }, hash: string, digest: UploadDigest): Promise<'saved' | 'moved'> {
  const path = `${sessionPath(ref)}/digest`;
  const res = await request(remote, 'PUT', path, gz({ hash, digest }));
  if (res.status === 409) return 'moved';
  if (!res.ok) throw new HttpStatusError('PUT', path, res.status);
  return 'saved';
}

/** A stored session with its cleaned messages, as the hub holds it. */
export async function getSession(remote: Remote, ref: { source: string; id: string }): Promise<HashedSession> {
  return ((await (await send(remote, 'GET', sessionPath(ref))).json()) as { session: HashedSession }).session;
}

export interface ProjectDigestEntry {
  source: string;
  id: string;
  content_hash: string;
  last_activity_at: string | null;
  status: 'pending' | 'ok' | 'failed' | 'refused' | null;
  model: string | null;
  written_by: string | null;
  summary_to_follow: boolean;
}

/** The main sessions of a project with who wrote each summary. */
/**
 * A tracked project the hub does not have (nothing uploaded yet, or emptied when its sessions
 * moved to another project) has no summaries: an empty list, not an error that stops the sync.
 */
export async function listProjectDigests(remote: Remote, key: string): Promise<ProjectDigestEntry[]> {
  const path = `/api/projects/${encodeURIComponent(key)}/digests`;
  const res = await request(remote, 'GET', path);
  if (res.status === 404) return [];
  if (!res.ok) throw new HttpStatusError('GET', path, res.status);
  return ((await res.json()) as { sessions: ProjectDigestEntry[] }).sessions;
}

export async function deleteRemote(
  remote: Remote,
  target: { project: string } | { source: string; id: string },
): Promise<void> {
  const path =
    'project' in target
      ? `/api/projects/${encodeURIComponent(target.project)}`
      : `/api/sessions/${target.source}/${encodeURIComponent(target.id)}`;
  await send(remote, 'DELETE', path);
}

export async function requestConnectCode(remote: Remote): Promise<{ code: string; expires_at: string }> {
  return (await (await send(remote, 'POST', '/api/connect-code')).json()) as { code: string; expires_at: string };
}

export interface HubStatus {
  projects?: number;
  sessions?: number;
  /** True when the hub has a model key and writes summaries for computers that cannot. */
  server_summaries?: boolean;
  /** Projects whose state page is dirty, missing or behind. */
  pages_needed?: string[];
  /** Sessions a computer still owes a summary for after re-cleaning. */
  summaries_owed?: number;
  /** The hub's name for the token that asked. */
  label?: string;
  [key: string]: unknown;
}

export async function getStatus(remote: Remote): Promise<HubStatus> {
  return (await send(remote, 'GET', '/api/status')).json() as Promise<HubStatus>;
}

/**
 * Tells the server a sync run finished. Gives up after 10 seconds. `pages_left` is sent only when
 * the run checked every tracked project's page: it replaces what the hub last heard from this computer.
 */
export async function reportSyncRun(
  remote: Remote,
  r: { finished_at: string; uploaded: number; unchanged: number; errors: number; pages_left?: { project: string; reason: string }[] },
): Promise<void> {
  await send({ ...remote, timeoutMs: 10_000 }, 'POST', '/api/sync-runs', gz(r));
}

/** Swaps a one-time device code from the dashboard for an upload token. Needs no credential. */
export async function exchangeDeviceCode(
  url: string,
  code: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
  /** This computer's current token for the same hub: sent so the hub retires it once the new one is issued. */
  retireToken?: string,
): Promise<{ token: string; label: string }> {
  const target = url.replace(/\/+$/, '') + '/api/devices';
  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(retireToken ? { Authorization: `Bearer ${retireToken}` } : {}) },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new UnreachableError(url.replace(/\/+$/, ''), plainReason(e));
  }
  if (res.status === 401) throw new BadCodeError();
  if (!res.ok) throw new HttpStatusError('POST', '/api/devices', res.status);
  return (await res.json()) as { token: string; label: string };
}

export interface PageInputsResult {
  page: { summary: string; body: string; version: number; rebuilt_at: string; dirty: boolean; digests_through: number } | null;
  /** Every ok digest of the project, oldest first. */
  digests: { session_id: string; title: string; date: string | null; text: string; saved_seq: number }[];
  /** The newest saved_seq among the digests. A page saved with it covers all of them. */
  through: number;
}

const projectPath = (key: string): string => `/api/projects/${encodeURIComponent(key)}`;

/** What it takes to write a project's state page: the current page and every digest. */
export async function getPageInputs(remote: Remote, key: string): Promise<PageInputsResult> {
  return (await (await send(remote, 'GET', `${projectPath(key)}/page-inputs`)).json()) as PageInputsResult;
}

/** Saves a page. Not ok means someone saved one since it was read: read again and redo it. */
export async function putPage(
  remote: Remote,
  key: string,
  page: { summary: string; body: string; model: string; base_version: number | null; through: number; full_rebuild: boolean },
): Promise<{ ok: true; version: number } | { ok: false }> {
  const path = `${projectPath(key)}/page`;
  const res = await request(remote, 'PUT', path, gz(page));
  if (res.status === 409) return { ok: false };
  if (!res.ok) throw new HttpStatusError('PUT', path, res.status);
  return { ok: true, version: ((await res.json()) as { version: number }).version };
}

/** Removes the page of a project that has no summaries left. */
export async function deletePage(remote: Remote, key: string): Promise<void> {
  await send(remote, 'DELETE', `${projectPath(key)}/page`);
}
