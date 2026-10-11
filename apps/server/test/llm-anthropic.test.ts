import { describe, expect, it } from 'vitest';
import { LlmRefusal } from '../src/llm.js';
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
