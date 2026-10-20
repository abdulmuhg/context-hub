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
