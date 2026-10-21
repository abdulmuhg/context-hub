import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DigestSchema, jsonSchemaOf, LlmRefusal, type AskCall } from '@context-hub/core';
import { ClaudeCodeLlm, ClaudeSignInError, ClaudeTimeoutError, cleanEnv, UsageLimitError, type ClaudeRunner } from '../src/claude-llm.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

interface Call {
  cmd: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function fakeRunner(stdout: string, over: { status?: number | null; stderr?: string; timedOut?: boolean } = {}): { run: ClaudeRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ClaudeRunner = async (cmd, args, stdin, env, timeoutMs) => {
    calls.push({ cmd, args, stdin, env, timeoutMs });
    return { status: over.status ?? 0, stdout, stderr: over.stderr ?? '', timedOut: over.timedOut ?? false };
  };
  return { run, calls };
}

const llm = (run: ClaudeRunner, over: { model?: string; effort?: string; timeoutMs?: number } = {}) =>
  new ClaudeCodeLlm({ model: over.model ?? 'claude-sonnet-5-5', effort: over.effort ?? 'low', cmd: 'claude', run, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) });

/** Exposes the protected call, to send a prompt of our own. */
class Probe extends ClaudeCodeLlm {
  send<T>(call: AskCall): Promise<T> {
    return this.ask<T>(call);
  }
}

const REQ = { project: 'github.com/me/alpha', title: 'Use SQLite', transcript: '[1] USER: Let us use SQLite for the hub.', part: null };

describe('cleanEnv', () => {
  it('drops ANTHROPIC_ and CLAUDE variables only', () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDECODE: '1',
      PATH: '/bin',
      HOME: '/home/me',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    };
    expect(Object.keys(cleanEnv(env)).sort()).toEqual(['APPDATA', 'HOME', 'PATH', 'USERPROFILE']);
  });

  it('matches names without regard to case, as Windows does', () => {
    expect(cleanEnv({ anthropic_api_key: 'k', Claude_Config: 'x', Path: 'p' })).toEqual({ Path: 'p' });
  });
});

describe('ClaudeCodeLlm', () => {
  it('passes the schema as one argv entry that parses back to the digest schema', async () => {
    const { run, calls } = fakeRunner(fixture('claude-ok'));
    await llm(run).digest(REQ);
    const args = calls[0]!.args;
    expect(args.filter((a) => a === '--json-schema')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(jsonSchemaOf(DigestSchema));
  });

  it('passes the prompt and schema as single argv entries', async () => {
    const { run, calls } = fakeRunner(fixture('claude-ok'));
    const system = 'Say "hi"\nthen \'bye\' and `stop`\r\nend';
    await new Probe({ model: 'm', effort: 'low', cmd: 'claude', run }).send({ system, user: 'u', schema: DigestSchema, kind: 'digest', project: null });
    const args = calls[0]!.args;
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(system);
    expect(args).toContain('--json-schema');
  });

  it('sends the transcript on stdin, never in argv', async () => {
    const { run, calls } = fakeRunner(fixture('claude-ok'));
    await llm(run).digest(REQ);
    expect(calls[0]!.stdin).toContain('[1] USER: Let us use SQLite for the hub.');
    expect(calls[0]!.args.join('\n')).not.toContain('Let us use SQLite');
  });

  it('uses the configured model and effort, and never --bare', async () => {
    const { run, calls } = fakeRunner(fixture('claude-ok'));
    await llm(run, { model: 'claude-sonnet-5-5', effort: 'medium' }).digest(REQ);
    const args = calls[0]!.args;
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'claude-sonnet-5-5', '--effort', 'medium']);
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json', '--no-session-persistence', '--safe-mode', '--strict-mcp-config']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--bare');
    expect(calls[0]!.cmd).toBe('claude');
  });

  it('starts claude with a clean environment', async () => {
    const { run, calls } = fakeRunner(fixture('claude-ok'));
    process.env.ANTHROPIC_AUTH_TOKEN = 'secret';
    process.env.CLAUDE_CODE_SIMPLE = '1';
    try {
      await llm(run).digest(REQ);
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.CLAUDE_CODE_SIMPLE;
    }
    expect(Object.keys(calls[0]!.env).filter((k) => /^(ANTHROPIC|CLAUDE)/i.test(k))).toEqual([]);
  });

  it('returns structured_output from the ok fixture', async () => {
    const { run } = fakeRunner(fixture('claude-ok'));
    const body = await llm(run).digest(REQ);
    expect(body.goal).toBe('Use SQLite for the hub.');
    expect(body.decisions).toHaveLength(1);
  });

  it('throws LlmRefusal for a refusal', async () => {
    const { run } = fakeRunner(fixture('claude-refusal'));
    await expect(llm(run).digest(REQ)).rejects.toBeInstanceOf(LlmRefusal);
  });

  it('throws ClaudeSignInError when claude is not signed in', async () => {
    const { run } = fakeRunner(fixture('claude-not-logged-in'), { status: 1 });
    await expect(llm(run).digest(REQ)).rejects.toBeInstanceOf(ClaudeSignInError);
  });

  it('throws UsageLimitError with the reset time when the limit is reached', async () => {
    const { run } = fakeRunner(fixture('claude-usage-limit'), { status: 1 });
    const err = await llm(run)
      .digest(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect((err as UsageLimitError).resetsAt).toBe(new Date(1792580400 * 1000).toISOString());
  });

  it('throws UsageLimitError without a reset time when the text carries none', async () => {
    const { run } = fakeRunner(JSON.stringify({ is_error: true, result: 'You have hit your usage limit.' }));
    const err = await llm(run)
      .digest(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect((err as UsageLimitError).resetsAt).toBeNull();
  });

  it('throws on a timeout', async () => {
    const { run } = fakeRunner('', { status: null, timedOut: true });
    const err = await llm(run, { timeoutMs: 5000 }).digest(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeTimeoutError);
    expect((err as Error).message).toBe('Claude Code did not answer within 5s');
  });

  it('throws when the answer has no structured output, or is not JSON', async () => {
    await expect(llm(fakeRunner(JSON.stringify({ is_error: false, result: 'hi' })).run).digest(REQ)).rejects.toThrow(/structured output/);
    await expect(llm(fakeRunner('oops', { status: 2, stderr: 'boom' }).run).digest(REQ)).rejects.toThrow(/boom/);
  });

  it('builds the same prompts as the server for a state page', async () => {
    const { run, calls } = fakeRunner(JSON.stringify({ is_error: false, structured_output: { summary: 's', body: '## What this is\n\nx' } }));
    const page = await llm(run).projectState({ project: 'p', mode: 'rebuild', previous: null, digests: [{ session_id: 'a', title: 't', date: null, text: 'Goal: x' }] });
    expect(page.summary).toBe('s');
    expect(calls[0]!.stdin).toContain('<session id="a"');
  });
});
