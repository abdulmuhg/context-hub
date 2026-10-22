import { describe, expect, it } from 'vitest';
import { PromptedLlm, REVIEW_SYSTEM, type AskCall, type ReviewRequest } from '../src/index.js';

class CapturingLlm extends PromptedLlm {
  readonly model = 'capture';
  asked: AskCall[] = [];
  protected async ask<T>(call: AskCall): Promise<T> {
    this.asked.push(call);
    return { drop_open: [], drop_current: [], summary: '' } as T;
  }
}

const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  project: 'github.com/me/alpha',
  page: { summary: 's', body: '## Open items\n\n- PR #17 is open.' },
  digests: [{ session_id: 'claude-code:a', title: 't', date: '2026-10-20T10:00:00.000Z', text: 'Goal: x' }],
  ...over,
});

describe('reviewState prompt', () => {
  it('adds the git facts after the page and before the digests', async () => {
    const llm = new CapturingLlm();
    await llm.reviewState(req({ git: { text: 'PR #17 merged', as_of: '2026-10-22T10:00:00.000Z' } }));
    const user = llm.asked[0]!.user;
    expect(user).toContain('<git as_of="2026-10-22T10:00:00.000Z">\nPR #17 merged\n</git>');
    expect(user.indexOf('</page>')).toBeLessThan(user.indexOf('<git'));
    expect(user.indexOf('</git>')).toBeLessThan(user.indexOf('Session digests'));
  });

  it('has no git block without facts', async () => {
    const llm = new CapturingLlm();
    await llm.reviewState(req());
    expect(llm.asked[0]!.user).not.toContain('<git');
  });

  it('says there are no digests for an empty list', async () => {
    const llm = new CapturingLlm();
    await llm.reviewState(req({ digests: [] }));
    expect(llm.asked[0]!.user).toContain('Session digests, newest first:\n(none)');
  });

  it('tells the model to cite "git"', () => {
    expect(REVIEW_SYSTEM).toContain('"git"');
  });
});
