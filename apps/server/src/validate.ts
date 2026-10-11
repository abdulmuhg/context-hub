import type { HashedSession, Message } from '@context-hub/core';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SOURCES = new Set(['claude-code', 'codex', 'antigravity']);

function bad(field: string, problem: string): never {
  throw new HttpError(400, `Invalid session: ${field} ${problem}`);
}

function str(o: Record<string, unknown>, field: string, where = ''): string {
  const v = o[field];
  if (typeof v !== 'string') bad(where + field, 'must be a string');
  return v as string;
}

function nullableStr(o: Record<string, unknown>, field: string, where = ''): string | null {
  const v = o[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad(where + field, 'must be a string or null');
  return v as string;
}

function parseMessage(value: unknown, i: number): Message {
  const where = `messages[${i}].`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(`messages[${i}]`, 'must be an object');
  const m = value as Record<string, unknown>;
  if (!Number.isInteger(m.seq)) bad(where + 'seq', 'must be an integer');
  const seq = m.seq as number;
  const ts = nullableStr(m, 'ts', where);
  if (m.kind === 'text') {
    if (m.role !== 'user' && m.role !== 'assistant') bad(where + 'role', 'must be user or assistant');
    return { seq, role: m.role as 'user' | 'assistant', kind: 'text', ts, text: str(m, 'text', where) };
  }
  if (m.kind === 'tool_call') {
    const status = m.tool_status;
    if (status !== 'ok' && status !== 'error') bad(where + 'tool_status', 'must be ok or error');
    return {
      seq,
      role: 'assistant',
      kind: 'tool_call',
      ts,
      tool_name: str(m, 'tool_name', where),
      tool_input: str(m, 'tool_input', where),
      tool_result: str(m, 'tool_result', where),
      tool_status: status as 'ok' | 'error',
    };
  }
  return bad(where + 'kind', 'must be text or tool_call');
}

/** Checks an uploaded body and returns it as a typed session. `source` and `id` come from the URL. */
export function parseSession(body: unknown, source: string, id: string): HashedSession {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid session: the body must be a JSON object');
  const o = body as Record<string, unknown>;

  const bodySource = str(o, 'source');
  if (!SOURCES.has(bodySource)) bad('source', 'is not a known tool');
  const bodyId = str(o, 'source_session_id');
  if (bodySource !== source || bodyId !== id) {
    throw new HttpError(400, 'Invalid session: the address and the body name different sessions');
  }
  const projectKey = str(o, 'project_key');
  if (projectKey === '') bad('project_key', 'must not be empty');
  const hash = str(o, 'content_hash');
  if (!/^[0-9a-f]{64}$/.test(hash)) bad('content_hash', 'must be a SHA-256 hex string');
  if (!Array.isArray(o.messages)) bad('messages', 'must be a list');
  const messages = (o.messages as unknown[]).map(parseMessage);
  const seen = new Set<number>();
  for (const m of messages) {
    if (m.seq < 0) bad('messages', `has a negative seq (${m.seq})`);
    if (seen.has(m.seq)) bad('messages', `has two messages with seq ${m.seq}`);
    seen.add(m.seq);
  }

  return {
    source: bodySource as HashedSession['source'],
    source_session_id: bodyId,
    account_id: nullableStr(o, 'account_id'),
    project_key: projectKey,
    parent: nullableStr(o, 'parent'),
    title: str(o, 'title'),
    cwd: nullableStr(o, 'cwd'),
    git_branch: nullableStr(o, 'git_branch'),
    started_at: nullableStr(o, 'started_at'),
    last_activity_at: nullableStr(o, 'last_activity_at'),
    messages,
    content_hash: hash,
  };
}
