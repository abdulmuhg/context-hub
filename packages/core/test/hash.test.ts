import { describe, expect, it } from 'vitest';
import { contentHash, type Session } from '../src/index.js';

const base: Session = {
  source: 'claude-code',
  source_session_id: 's1',
  account_id: null,
  project_key: 'local:demo',
  parent: null,
  title: 'Demo',
  cwd: null,
  git_branch: null,
  started_at: null,
  last_activity_at: null,
  messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello' }],
};

describe('contentHash', () => {
  it('is a 64-character hex string', () => {
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as Session;
    expect(contentHash(reordered)).toBe(contentHash(base));
  });

  it('changes when the project key changes', () => {
    expect(contentHash({ ...base, project_key: 'local:other' })).not.toBe(contentHash(base));
  });

  it('changes when a message changes', () => {
    const changed: Session = {
      ...base,
      messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello!' }],
    };
    expect(contentHash(changed)).not.toBe(contentHash(base));
  });
});
