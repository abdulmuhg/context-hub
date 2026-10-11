import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { contentHash, type HashedSession, type Message, type Session } from '@context-hub/core';
import { createHandler, type AppDeps } from '../src/http.js';

export const text = (seq: number, role: 'user' | 'assistant', body: string): Message => ({
  seq,
  role,
  kind: 'text',
  ts: `2026-10-0${1 + (seq % 9)}T10:00:00.000Z`,
  text: body,
});

export const tool = (seq: number, name: string, input: string, result: string): Message => ({
  seq,
  role: 'assistant',
  kind: 'tool_call',
  ts: null,
  tool_name: name,
  tool_input: input,
  tool_result: result,
  tool_status: 'ok',
});

/** A valid session with a correct content hash. Pass fields to override. */
export function makeSession(over: Partial<Session> = {}): HashedSession {
  const session: Session = {
    source: 'claude-code',
    source_session_id: 's1',
    account_id: 'acct-1',
    project_key: 'github.com/me/alpha',
    parent: null,
    title: 'Fix the login bug',
    cwd: '/work/alpha',
    git_branch: 'main',
    started_at: '2026-10-01T10:00:00.000Z',
    last_activity_at: '2026-10-01T11:00:00.000Z',
    messages: [text(0, 'user', 'the login page throws a redirect loop'), text(1, 'assistant', 'Found it in the session cookie check.')],
    ...over,
  };
  return { ...session, content_hash: contentHash(session) };
}

export function gz(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
}

export async function startServer(deps: AppDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(createHandler(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
