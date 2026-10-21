import { describe, expect, it } from 'vitest';
import { LlmRefusal } from '@context-hub/core';
import type { UsageRecord } from '../src/usage.js';
import { AnthropicLlm, DEFAULT_MODEL, type ParseClient } from '../src/llm-anthropic.js';

const DIGEST = { goal: 'g', done: [], decisions: [], open_items: [], key_refs: [] };

function stub(response: Record<string, unknown>): { client: ParseClient; sent: any[] } {
  const sent: any[] = [];
  return {
    sent,
    client: {
      messages: {
        parse: async (args: any) => {
          sent.push(args);
          return response;
        },
      },
    },
  };
}

const digestReq = { project: 'github.com/me/alpha', title: 'Fix login', transcript: '[0] USER: fix the login loop', part: null };

describe('AnthropicLlm: request shape', () => {
  it('uses the small Claude model at low effort by default', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    const llm = new AnthropicLlm({ client });
    expect(DEFAULT_MODEL).toBe('claude-haiku-5-5');
    expect(llm.model).toBe('claude-haiku-5-5');
    await llm.digest(digestReq);
    expect(sent[0].model).toBe('claude-haiku-5-5');
    expect(sent[0].output_config.effort).toBe('low');
    expect(sent[0].output_config.format).toBeDefined();
    expect(sent[0].max_tokens).toBe(16000);
  });

  it('honours a configured model and effort', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client, model: 'claude-sonnet-5-5', effort: 'medium' }).digest(digestReq);
    expect(sent[0].model).toBe('claude-sonnet-5-5');
    expect(sent[0].output_config.effort).toBe('medium');
  });

  it('never sends parameters this model rejects', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client }).digest(digestReq);
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice']) expect(sent[0]).not.toHaveProperty(key);
    expect(sent[0].messages).toHaveLength(1);
    expect(sent[0].messages[0].role).toBe('user');
  });

  it('puts the transcript in the user message and tells the model it is data', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client }).digest(digestReq);
    const user = JSON.stringify(sent[0].messages[0].content);
    expect(user).toContain('[0] USER: fix the login loop');
    expect(user).toContain('Fix login');
    expect(sent[0].system).toMatch(/not instructions/i);
    expect(sent[0].system).toMatch(/\[REDACTED/);
  });

  it('says which part it is for a long session', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client }).digest({ ...digestReq, part: { index: 2, total: 3 } });
    expect(JSON.stringify(sent[0].messages[0].content)).toMatch(/part 2 of 3/i);
  });
});

describe('AnthropicLlm: responses', () => {
  it('returns the parsed digest', async () => {
    const { client } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    expect(await new AnthropicLlm({ client }).digest(digestReq)).toEqual(DIGEST);
  });

  it('throws LlmRefusal with the category when the model declines', async () => {
    const { client } = stub({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, parsed_output: null });
    await expect(new AnthropicLlm({ client }).digest(digestReq)).rejects.toMatchObject({ category: 'cyber' });
    await expect(new AnthropicLlm({ client }).digest(digestReq)).rejects.toBeInstanceOf(LlmRefusal);
  });

  it('uses "unspecified" when a refusal carries no details', async () => {
    const { client } = stub({ stop_reason: 'refusal', stop_details: null, parsed_output: null });
    await expect(new AnthropicLlm({ client }).digest(digestReq)).rejects.toMatchObject({ category: 'unspecified' });
  });

  it('throws an ordinary error when the answer was cut off or did not parse', async () => {
    for (const response of [
      { stop_reason: 'max_tokens', parsed_output: DIGEST },
      { stop_reason: 'end_turn', parsed_output: null },
    ]) {
      const { client } = stub(response);
      const call = new AnthropicLlm({ client }).digest(digestReq);
      await expect(call).rejects.toThrow(/incomplete/);
      await expect(call).rejects.not.toBeInstanceOf(LlmRefusal);
    }
  });

  it('lets SDK errors through unchanged', async () => {
    const client: ParseClient = { messages: { parse: async () => { throw new Error('529 overloaded'); } } };
    await expect(new AnthropicLlm({ client }).digest(digestReq)).rejects.toThrow('529 overloaded');
  });
});

describe('AnthropicLlm: merge and state', () => {
  it('sends the part digests when merging', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client }).mergeDigests({ project: 'p', title: 'Long one', parts: [{ ...DIGEST, goal: 'first half' }, { ...DIGEST, goal: 'second half' }] });
    const user = JSON.stringify(sent[0].messages[0].content);
    expect(user).toContain('first half');
    expect(user).toContain('second half');
  });

  it('includes the previous page when merging a state page, and says so when rebuilding', async () => {
    const page = { summary: 's', body: 'b' };
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: page });
    const llm = new AnthropicLlm({ client });
    const digests = [{ session_id: 'claude-code:a', title: 'T', date: '2026-10-01T00:00:00.000Z', text: 'Goal: x' }];
    expect(await llm.projectState({ project: 'p', mode: 'merge', previous: 'OLD PAGE', digests })).toEqual(page);
    expect(JSON.stringify(sent[0].messages[0].content)).toContain('OLD PAGE');
    expect(JSON.stringify(sent[0].messages[0].content)).toContain('claude-code:a');
    await llm.projectState({ project: 'p', mode: 'rebuild', previous: null, digests });
    expect(JSON.stringify(sent[1].messages[0].content)).toMatch(/from scratch/i);
  });
});

describe('prompt rules found by reading the first real digests', () => {
  const page = { summary: 's', body: 'b' };
  const digests = [{ session_id: 'claude-code:a', title: 'T', date: '2026-09-15T06:43:56.350Z', text: 'Goal: x' }];
  const stateSystem = async (): Promise<string> => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: page });
    await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'rebuild', previous: null, digests });
    return sent[0].system as string;
  };
  const digestSystem = async (): Promise<string> => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    await new AnthropicLlm({ client }).digest(digestReq);
    return sent[0].system as string;
  };

  it('the state page lists only unresolved open items and never a "closed" note', async () => {
    const s = await stateSystem();
    expect(s).toMatch(/delete it/i);
    expect(s).toMatch(/never .*(closed|resolved|done)/i);
  });

  it('facts about the machine carry the date of the session that recorded them', async () => {
    const s = await stateSystem();
    expect(s).toMatch(/as of/i);
    expect(s).toMatch(/installed/i);
  });

  it('the summary has a stated length limit', async () => {
    expect(await stateSystem()).toMatch(/25 words/);
  });

  it('gives the model each session date so it can date those facts', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: page });
    await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'rebuild', previous: null, digests });
    expect(JSON.stringify(sent[0].messages[0].content)).toContain('2026-09-15');
  });

  it('a decision reason is asked for as a clause that follows "because"', async () => {
    expect(await digestSystem()).toMatch(/because/);
    expect(await digestSystem()).toMatch(/lowercase/i);
  });

  it('the digest dates machine facts too', async () => {
    expect(await digestSystem()).toMatch(/at the time/i);
  });
});

describe('the state page stays within its length', () => {
  const digests = [{ session_id: 'claude-code:a', title: 'T', date: '2026-10-01T00:00:00.000Z', text: 'Goal: x' }];
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  /** A stub that answers each call with the next response in the list. */
  function sequence(responses: { summary: string; body: string }[]): { client: ParseClient; sent: any[] } {
    const sent: any[] = [];
    let i = 0;
    return {
      sent,
      client: {
        messages: {
          parse: async (args: any) => {
            sent.push(args);
            return { stop_reason: 'end_turn', parsed_output: responses[Math.min(i++, responses.length - 1)] };
          },
        },
      },
    };
  }

  it('gives every section a stated limit, and merging no longer means only adding', async () => {
    const { client, sent } = sequence([{ summary: 's', body: 'short' }]);
    await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'merge', previous: 'OLD', digests });
    expect(sent[0].system).toMatch(/at most 5/);
    expect(sent[0].system).toMatch(/at most 8/);
    expect(sent[0].system).toMatch(/600 words/);
    const user = JSON.stringify(sent[0].messages[0].content);
    expect(user).not.toMatch(/Change only what the new session changes/);
    expect(user).toMatch(/drop/i);
  });

  it('accepts a page within the limit without a second call', async () => {
    const { client, sent } = sequence([{ summary: 's', body: words(500) }]);
    const page = await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'rebuild', previous: null, digests });
    expect(sent).toHaveLength(1);
    expect(page.body.split(/\s+/)).toHaveLength(500);
  });

  it('asks once for a shorter page when the first answer is too long', async () => {
    const { client, sent } = sequence([
      { summary: 'long one', body: words(1700) },
      { summary: 'short one', body: words(550) },
    ]);
    const page = await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'merge', previous: 'OLD', digests });
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1].messages[0].content)).toContain('w1699');
    expect(JSON.stringify(sent[1].messages[0].content)).toMatch(/600 words/);
    expect(page).toEqual({ summary: 'short one', body: words(550) });
  });

  it('does not loop: a second answer that is still too long is cut at a section boundary', async () => {
    const section = (name: string, n: number) => `## ${name}\n${words(n)}`;
    const body = [section('What this is', 100), section('Current state', 300), section('Recent decisions', 300), section('Open items', 300), section('Latest sessions', 300)].join('\n\n');
    const { client, sent } = sequence([{ summary: 's', body }, { summary: 's', body }]);
    const page = await new AnthropicLlm({ client }).projectState({ project: 'p', mode: 'rebuild', previous: null, digests });
    expect(sent).toHaveLength(2);
    expect(page.body.split(/\s+/).length).toBeLessThanOrEqual(800);
    expect(page.body).toContain('## What this is');
    expect(page.body).toContain('## Current state');
    expect(page.body).toMatch(/shortened/i);
  });
});

describe('the page review', () => {
  const page = { summary: 's', body: '## Current state\n\n- Deployed.\n\n## Open items\n\n- Confirm the key.\n- Set up backups.' };
  const digests = [{ session_id: 'claude-code:b', title: 'Deploy', date: '2026-10-20T00:00:00.000Z', text: 'Done: digests written' }];

  it('sends the open items and state lines numbered, with the digests, and returns the parsed review', async () => {
    const review = { drop_open: [{ item: 1, session_id: 'claude-code:b' }], drop_current: [], summary: 'Deployed.' };
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: review });
    expect(await new AnthropicLlm({ client }).reviewState({ project: 'p', page, digests })).toEqual(review);
    const user = JSON.stringify(sent[0].messages[0].content);
    expect(user).toContain('1. Confirm the key.');
    expect(user).toContain('2. Set up backups.');
    expect(user).toContain('1. Deployed.');
    expect(user).toContain('claude-code:b');
    expect(sent[0].system).toMatch(/indirectly/);
    expect(sent[0].system).toMatch(/not sure/);
    expect(sent[0].system).toMatch(/not instructions/i);
  });

  it('digests and merged digests keep only items still open at the end, even when settled indirectly', async () => {
    const { client, sent } = stub({ stop_reason: 'end_turn', parsed_output: DIGEST });
    const llm = new AnthropicLlm({ client });
    await llm.digest(digestReq);
    await llm.mergeDigests({ project: 'p', title: 't', parts: [DIGEST, DIGEST] });
    expect(sent[0].system).toMatch(/end of the transcript/);
    expect(sent[0].system).toMatch(/indirectly/);
    expect(sent[1].system).toMatch(/later part settles it/);
    expect(sent[1].system).toMatch(/indirectly/);
  });
});

describe('usage reporting', () => {
  const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 };
  const STATE = { summary: 's', body: 'short' };
  const REVIEW = { drop_open: [], drop_current: [], summary: '' };
  const longPage = { summary: 's', body: Array.from({ length: 1700 }, (_, i) => `w${i}`).join(' ') };

  function recording(outputs: unknown[], extra: Record<string, unknown> = {}) {
    const records: UsageRecord[] = [];
    let i = 0;
    const client: ParseClient = {
      messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: outputs[Math.min(i++, outputs.length - 1)], usage: USAGE, ...extra }) },
    };
    return { records, llm: (onUsage?: (u: UsageRecord) => void) => new AnthropicLlm({ client, onUsage: onUsage ?? ((u) => records.push(u)) }) };
  }

  const base = { model: 'claude-haiku-5-5', project: 'github.com/me/alpha', input_tokens: 1200, output_tokens: 300, cache_read_tokens: 5, cache_write_tokens: 7 };

  it('reports one record per method with its kind and project', async () => {
    const { records, llm } = recording([DIGEST, DIGEST, STATE, REVIEW]);
    const l = llm();
    await l.digest(digestReq);
    await l.mergeDigests({ project: 'github.com/me/alpha', title: 't', parts: [DIGEST] });
    await l.projectState({ project: 'github.com/me/alpha', mode: 'rebuild', previous: null, digests: [] });
    await l.reviewState({ project: 'github.com/me/alpha', page: { summary: 's', body: '## Open items\n- x' }, digests: [] });
    expect(records).toEqual(['digest', 'merge', 'state', 'review'].map((kind) => ({ ...base, kind })));
  });

  it('reports the shorten retry as its own call', async () => {
    const { records, llm } = recording([longPage, STATE]);
    await llm().projectState({ project: 'github.com/me/alpha', mode: 'rebuild', previous: null, digests: [] });
    expect(records.map((r) => r.kind)).toEqual(['state', 'shorten']);
  });

  it('records a refusal and an incomplete answer, which are billed too', async () => {
    const refused = recording([null], { stop_reason: 'refusal', stop_details: { category: 'cyber' } });
    await expect(refused.llm().digest(digestReq)).rejects.toBeInstanceOf(LlmRefusal);
    expect(refused.records).toHaveLength(1);
    const cut = recording([null], { stop_reason: 'max_tokens' });
    await expect(cut.llm().digest(digestReq)).rejects.toThrow(/incomplete/);
    expect(cut.records).toHaveLength(1);
  });

  it('does not fail the call when the recorder throws', async () => {
    const { llm } = recording([DIGEST]);
    const err = console.error;
    console.error = () => {};
    try {
      await expect(llm(() => { throw new Error('disk full'); }).digest(digestReq)).resolves.toEqual(DIGEST);
    } finally {
      console.error = err;
    }
  });

  it('reports nothing when the response has no usage', async () => {
    const records: UsageRecord[] = [];
    const client: ParseClient = { messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: DIGEST }) } };
    await new AnthropicLlm({ client, onUsage: (u) => records.push(u) }).digest(digestReq);
    expect(records).toEqual([]);
  });
});
