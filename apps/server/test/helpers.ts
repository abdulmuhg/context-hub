import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { contentHash, type HashedSession, type Message, type Session } from '@context-hub/core';
import { createHandler, type AppDeps } from '../src/http.js';
import type { DigestBody } from '../src/digest-store.js';
import type { DigestRequest, Llm, ReviewRequest, StatePage, StateRequest } from '../src/llm.js';
import type { PageReview } from '../src/page-review.js';

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

/** A stand-in for the model: deterministic output, a record of every call, and one-shot failure. */
export class FakeLlm implements Llm {
  readonly model = 'fake-model';
  calls: { kind: 'digest' | 'merge' | 'state'; req: unknown }[] = [];
  /** Thrown by the next call, then cleared. */
  failWith: Error | null = null;
  /** Runs at the start of each digest call. Tests use it to change the database mid-call. */
  onDigest: (() => void) | null = null;

  private step(kind: 'digest' | 'merge' | 'state', req: unknown): void {
    this.calls.push({ kind, req });
    if (this.failWith) {
      const e = this.failWith;
      this.failWith = null;
      throw e;
    }
  }

  async digest(req: DigestRequest): Promise<DigestBody> {
    this.onDigest?.();
    this.step('digest', req);
    const suffix = req.part ? ` part ${req.part.index}/${req.part.total}` : '';
    return { goal: `digest of ${req.title}${suffix}`, done: [{ text: `read ${req.transcript.length} chars`, seq: 0 }], decisions: [], open_items: [], key_refs: [] };
  }

  async mergeDigests(req: { project: string; title: string; parts: DigestBody[] }): Promise<DigestBody> {
    this.step('merge', req);
    return { goal: `merged ${req.parts.length} parts of ${req.title}`, done: req.parts.flatMap((p) => p.done), decisions: [], open_items: [], key_refs: [] };
  }

  async projectState(req: StateRequest): Promise<StatePage> {
    this.step('state', req);
    return {
      summary: `${req.project}: ${req.mode} of ${req.digests.length}`,
      body: [`mode=${req.mode}`, `previous=${req.previous === null ? 'none' : 'yes'}`, ...req.digests.map((d) => `- ${d.session_id}`)].join('\n'),
    };
  }

  /** Kept apart from `calls` so tests that count page calls are unaffected. */
  reviews: ReviewRequest[] = [];
  /** The next review's answer. Default: drop nothing, keep the summary. */
  nextReview: PageReview | Error | null = null;

  async reviewState(req: ReviewRequest): Promise<PageReview> {
    this.reviews.push(req);
    const answer = this.nextReview;
    this.nextReview = null;
    if (answer instanceof Error) throw answer;
    return answer ?? { drop_open: [], drop_current: [], summary: '' };
  }
}
