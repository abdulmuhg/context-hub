import { gzipSync } from 'node:zlib';
import type { HashedSession } from '@context-hub/core';

export interface Remote {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Give up on a request after this long. Default 60 seconds. */
  timeoutMs?: number;
}

function base(remote: Remote): string {
  return remote.url.replace(/\/+$/, '');
}

async function send(remote: Remote, method: string, path: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
  const doFetch = remote.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${remote.token}` };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Encoding'] = 'gzip';
  }
  let res: Response;
  try {
    res = await doFetch(base(remote) + path, { method, headers, body, signal: AbortSignal.timeout(remote.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new Error(`could not reach ${base(remote)}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`${method} ${path}: server answered ${res.status}`);
  return res;
}

export async function putSession(remote: Remote, session: HashedSession): Promise<void> {
  const path = `/api/sessions/${session.source}/${encodeURIComponent(session.source_session_id)}`;
  await send(remote, 'PUT', path, gzipSync(Buffer.from(JSON.stringify(session), 'utf8')));
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

export async function getStatus(remote: Remote): Promise<unknown> {
  return (await send(remote, 'GET', '/api/status')).json();
}

/** Tells the server a sync run finished. Gives up after 10 seconds. */
export async function reportSyncRun(
  remote: Remote,
  r: { finished_at: string; uploaded: number; unchanged: number; errors: number },
): Promise<void> {
  await send({ ...remote, timeoutMs: 10_000 }, 'POST', '/api/sync-runs', gzipSync(Buffer.from(JSON.stringify(r), 'utf8')));
}

/** Swaps a one-time device code from the dashboard for an upload token. Needs no credential. */
export async function exchangeDeviceCode(
  url: string,
  code: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; label: string }> {
  const target = url.replace(/\/+$/, '') + '/api/devices';
  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`could not reach ${url.replace(/\/+$/, '')}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let message = `server answered ${res.status}`;
    if (res.status === 401 || res.status === 429) {
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // keep the generic message
      }
    }
    throw new Error(message);
  }
  return (await res.json()) as { token: string; label: string };
}
