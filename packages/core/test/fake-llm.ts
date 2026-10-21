import type { DigestBody, DigestRequest, Llm, Message, PageReview, ReviewRequest, StatePage, StateRequest } from '../src/index.js';

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
