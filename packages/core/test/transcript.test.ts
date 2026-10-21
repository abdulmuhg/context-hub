import { describe, expect, it } from 'vitest';
import { DigestSchema, LlmRefusal, StateSchema, type DigestBody } from '../src/index.js';
import { renderDigest, renderLines, splitParts, TOOL_FIELD_CAP } from '../src/index.js';
import { FakeLlm, text, tool } from './fake-llm.js';

describe('renderLines', () => {
  it('numbers each message by its seq and labels the speaker', () => {
    expect(renderLines([text(0, 'user', 'fix login'), text(1, 'assistant', 'On it.')])).toEqual(['[0] USER: fix login', '[1] ASSISTANT: On it.']);
  });

  it('renders a tool call on one line with its status', () => {
    const failed = { ...tool(2, 'Bash', 'pnpm test', '2 failed'), tool_status: 'error' as const };
    expect(renderLines([tool(1, 'Read', 'src/a.ts', 'contents'), failed])).toEqual([
      '[1] TOOL Read(src/a.ts) -> ok: contents',
      '[2] TOOL Bash(pnpm test) -> error: 2 failed',
    ]);
  });

  it('cuts long tool input and output but never message text', () => {
    const long = 'x'.repeat(TOOL_FIELD_CAP * 3);
    const [line] = renderLines([tool(0, 'Bash', long, long)]);
    expect(line!.length).toBeLessThan(TOOL_FIELD_CAP * 2 + 100);
    expect(line).toContain('…');
    expect(renderLines([text(0, 'user', long)])[0]).toBe(`[0] USER: ${long}`);
  });

  it('keeps a multi-line message as one entry', () => {
    expect(renderLines([text(0, 'user', 'line one\nline two')])).toEqual(['[0] USER: line one\nline two']);
  });
});

describe('splitParts', () => {
  it('returns one part when everything fits', () => {
    expect(splitParts(['aaa', 'bbb'], 100)).toEqual(['aaa\nbbb']);
  });

  it('splits between lines and never exceeds the limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(30));
    const parts = splitParts(lines, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join('\n')).toBe(lines.join('\n'));
  });

  // Review Focus 1
  it('cuts a single line that is longer than the limit, losing nothing', () => {
    const huge = 'h'.repeat(250);
    const parts = splitParts(['before', huge, 'after'], 100);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join('').replace(/\n/g, '')).toBe('before' + huge + 'after');
  });

  it('returns no parts for no lines', () => {
    expect(splitParts([], 100)).toEqual([]);
  });

  it('rejects a limit too small to make progress', () => {
    expect(() => splitParts(['a'], 0)).toThrow(/limit/);
  });
});

describe('renderDigest', () => {
  const body: DigestBody = {
    goal: 'Stop the login redirect loop.',
    done: [{ text: 'Patched the cookie check', seq: 4 }, { text: 'Added a test', seq: null }],
    decisions: [{ what: 'Drop Redis', why: 'hit rate under 5%', seq: 9 }],
    open_items: [{ text: 'Deploy to staging', seq: null }],
    key_refs: ['src/auth.ts', 'pnpm test'],
  };

  it('writes each section with message positions where given', () => {
    expect(renderDigest(body)).toBe(
      [
        'Goal: Stop the login redirect loop.',
        'Done:',
        '- Patched the cookie check (#4)',
        '- Added a test',
        'Decisions:',
        '- Drop Redis — because hit rate under 5% (#9)',
        'Open:',
        '- Deploy to staging',
        'Refs: src/auth.ts, pnpm test',
      ].join('\n'),
    );
  });

  it('leaves out empty sections', () => {
    expect(renderDigest({ goal: 'Explore.', done: [], decisions: [], open_items: [], key_refs: [] })).toBe('Goal: Explore.');
  });
});

describe('schemas and errors', () => {
  it('DigestSchema accepts a digest and rejects a missing goal', () => {
    const ok = { goal: 'g', done: [{ text: 't', seq: null }], decisions: [{ what: 'w', why: 'y', seq: 1 }], open_items: [], key_refs: [] };
    expect(DigestSchema.safeParse(ok).success).toBe(true);
    expect(DigestSchema.safeParse({ ...ok, goal: undefined }).success).toBe(false);
  });

  it('StateSchema needs a summary and a body', () => {
    expect(StateSchema.safeParse({ summary: 's', body: 'b' }).success).toBe(true);
    expect(StateSchema.safeParse({ summary: 's' }).success).toBe(false);
  });

  it('LlmRefusal carries the category', () => {
    const e = new LlmRefusal('cyber');
    expect(e).toBeInstanceOf(Error);
    expect(e.category).toBe('cyber');
  });
});

describe('FakeLlm', () => {
  it('records calls, returns deterministic output and fails once when told to', async () => {
    const llm = new FakeLlm();
    const body = await llm.digest({ project: 'p', title: 'T', transcript: '[0] USER: hi', part: null });
    expect(body.goal).toBe('digest of T');
    expect(llm.calls).toEqual([{ kind: 'digest', req: { project: 'p', title: 'T', transcript: '[0] USER: hi', part: null } }]);
    llm.failWith = new Error('boom');
    await expect(llm.digest({ project: 'p', title: 'T', transcript: '', part: null })).rejects.toThrow('boom');
    await expect(llm.digest({ project: 'p', title: 'T', transcript: '', part: null })).resolves.toBeDefined();
  });
});

describe('renderDigest: decision punctuation', () => {
  it('drops a full stop between the decision and its reason, and after the reason', () => {
    const body: DigestBody = { goal: 'g', done: [], decisions: [{ what: 'Kept the branch.', why: 'commit 41727a6 is not in main.', seq: 19 }], open_items: [], key_refs: [] };
    expect(renderDigest(body)).toBe('Goal: g\nDecisions:\n- Kept the branch — because commit 41727a6 is not in main (#19)');
  });

  it('leaves punctuation inside the text alone', () => {
    const body: DigestBody = { goal: 'g', done: [], decisions: [{ what: 'Use v1.2 of the API', why: 'v2.0 dropped the endpoint', seq: null }], open_items: [], key_refs: [] };
    expect(renderDigest(body)).toBe('Goal: g\nDecisions:\n- Use v1.2 of the API — because v2.0 dropped the endpoint');
  });
});
