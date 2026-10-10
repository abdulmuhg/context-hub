import { describe, expect, it } from 'vitest';
import { sanitizeSession, type PersonalConfig, type SessionInput } from '../src/index.js';

const personal: PersonalConfig = { card: 'full', list: 'warn', entries: [] };
const secret = 'gh' + 'p_' + 'a'.repeat(36);

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  source: 'claude-code',
  source_session_id: 's1',
  account_id: 'acct',
  project_key: 'local:demo',
  parent: null,
  title: null,
  cwd: 'C:\\work\\demo',
  git_branch: 'main',
  messages: [
    { seq: 9, role: 'user', kind: 'text', ts: '2026-10-01T10:00:00Z', text: `use ${secret} please` },
    {
      seq: 9,
      role: 'assistant',
      kind: 'tool_call',
      ts: '2026-10-01T10:05:00Z',
      tool_name: 'Bash',
      tool_input: 'x'.repeat(2500),
      tool_result: 'H'.repeat(1500) + 'M'.repeat(1000) + 'T'.repeat(500),
      tool_status: 'ok',
    },
  ],
  ...over,
});

describe('sanitizeSession', () => {
  it('strips secrets from text and counts them', () => {
    const out = sanitizeSession(input(), personal);
    expect(out.session.messages[0]).toMatchObject({ text: 'use [REDACTED:github] please' });
    expect(out.secrets).toEqual({ github: 1 });
  });

  it('renumbers seq from zero', () => {
    expect(sanitizeSession(input(), personal).session.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('caps tool input at 2000 characters', () => {
    const m = sanitizeSession(input(), personal).session.messages[1];
    expect(m.kind === 'tool_call' && m.tool_input.length).toBe(2000);
  });

  it('keeps the first 1500 and last 500 characters of a long tool result', () => {
    const m = sanitizeSession(input(), personal).session.messages[1];
    if (m.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(m.tool_result.startsWith('H'.repeat(1500))).toBe(true);
    expect(m.tool_result.endsWith('T'.repeat(500))).toBe(true);
    expect(m.tool_result).not.toContain('M');
  });

  it('strips a secret before capping, so one that straddles the cap is still caught', () => {
    const straddling = 'x'.repeat(1990) + secret;
    const base = input();
    const tool = { ...base.messages[1], tool_input: straddling } as SessionInput['messages'][0];
    const out = sanitizeSession({ ...base, messages: [base.messages[0], tool] }, personal);
    const m = out.session.messages[1];
    expect(m.kind === 'tool_call' && m.tool_input).not.toContain('gh' + 'p_');
  });

  it('derives the title from the first user message, 80 characters, one line', () => {
    const long = 'fix the\nlogin   bug ' + 'y'.repeat(200);
    const base = input();
    const out = sanitizeSession(
      { ...base, messages: [{ ...base.messages[0], text: long } as SessionInput['messages'][0]] },
      personal,
    );
    expect(out.session.title).toBe(('fix the login bug ' + 'y'.repeat(200)).slice(0, 80));
  });

  it('keeps a title the tool provided, but still strips secrets from it', () => {
    const out = sanitizeSession(input({ title: `deploy ${secret}` }), personal);
    expect(out.session.title).toBe('deploy [REDACTED:github]');
  });

  it('uses a fixed title when there is no user text', () => {
    expect(sanitizeSession(input({ messages: [] }), personal).session.title).toBe('(untitled)');
  });

  it('derives start and last-activity times from the messages', () => {
    const s = sanitizeSession(input(), personal).session;
    expect(s.started_at).toBe('2026-10-01T10:00:00Z');
    expect(s.last_activity_at).toBe('2026-10-01T10:05:00Z');
  });

  it('applies the personal filter and reports findings', () => {
    const base = input();
    const out = sanitizeSession(
      { ...base, messages: [{ ...base.messages[0], text: 'card 4242424242424242' } as SessionInput['messages'][0]] },
      personal,
    );
    expect(out.session.messages[0]).toMatchObject({ text: 'card [REDACTED:card]' });
    expect(out.personal).toEqual({ card: 1 });
  });

  it('produces a stable content hash', () => {
    const a = sanitizeSession(input(), personal).session.content_hash;
    const b = sanitizeSession(input(), personal).session.content_hash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});
