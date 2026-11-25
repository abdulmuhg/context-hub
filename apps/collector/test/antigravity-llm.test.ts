import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DigestSchema, jsonSchemaOf, LlmRefusal } from '@context-hub/core';
import {
  AntigravityLimitError,
  AntigravityLlm,
  AntigravitySignInError,
  AntigravityTimeoutError,
  cleanAntigravityEnv,
  FallbackLlm,
} from '../src/antigravity-llm.js';
import { ClaudeCodeLlm, ClaudeSignInError, UsageLimitError, type ClaudeRunner } from '../src/claude-llm.js';
import { tempDir } from './helpers.js';

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

const REQ = { project: 'github.com/me/alpha', title: 'Use SQLite', transcript: '[1] USER: Let us use SQLite.', part: null };
const OK_BODY = { goal: 'Use SQLite.', done: [], decisions: [], open_items: [], key_refs: [] };
const OK_STREAM = [
  JSON.stringify({ event: 'init', conversation_id: 'conv-123' }),
  JSON.stringify({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', structured_output: OK_BODY } }),
].join('\n');

describe('cleanAntigravityEnv', () => {
  it('strips GEMINI_API_KEY and GOOGLE_ API env vars while keeping others', () => {
    const cleaned = cleanAntigravityEnv({
      GEMINI_API_KEY: 'k',
      google_api_key: 'g',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
      PATH: '/bin',
      USERPROFILE: 'C:\\Users\\me',
    });
    expect(Object.keys(cleaned).sort()).toEqual(['PATH', 'USERPROFILE']);
  });
});

describe('AntigravityLlm', () => {
  it('passes stream-json flags, schema, and sends prompt on stdin', async () => {
    const { run, calls } = fakeRunner(OK_STREAM);
    const llm = new AntigravityLlm({ model: 'gemini-3.8-flash-low', effort: 'low', cmd: 'agy', run });
    const body = await llm.digest(REQ);
    expect(body.goal).toBe('Use SQLite.');
    const args = calls[0]!.args;
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'gemini-3.8-flash-low', '--effort', 'low', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']),
    );
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(jsonSchemaOf(DigestSchema));
    const msg = JSON.parse(calls[0]!.stdin);
    expect(msg.event).toBe('user');
    expect(msg.message.content).toContain('[1] USER: Let us use SQLite.');
  });

  it('cleans up temporary antigravity-cli conversation files after completion', async () => {
    const home = tempDir();
    const brain = join(home, '.gemini', 'antigravity-cli', 'brain', 'conv-123');
    const pb = join(home, '.gemini', 'antigravity-cli', 'conversations', 'conv-123.pb');
    mkdirSync(brain, { recursive: true });
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    writeFileSync(join(brain, 'note.txt'), 'temp');
    writeFileSync(pb, 'temp');

    const { run } = fakeRunner(OK_STREAM);
    const llm = new AntigravityLlm({ model: 'gemini-3.8-flash-low', effort: 'low', cmd: 'agy', run, home });
    await llm.digest(REQ);

    expect(existsSync(brain)).toBe(false);
    expect(existsSync(pb)).toBe(false);
  });

  it('maps auth, quota, refusal, and timeout errors', async () => {
    const errStream = (error: string, finishedReason?: string) =>
      JSON.stringify({ event: 'result', result: { status: 'ERROR', error, finished_reason: finishedReason } });

    await expect(new AntigravityLlm({ model: 'm', effort: 'low', cmd: 'agy', run: fakeRunner(errStream('Please sign in first')).run }).digest(REQ)).rejects.toBeInstanceOf(
      AntigravitySignInError,
    );
    await expect(new AntigravityLlm({ model: 'm', effort: 'low', cmd: 'agy', run: fakeRunner(errStream('Quota exceeded / rate limit')).run }).digest(REQ)).rejects.toBeInstanceOf(
      AntigravityLimitError,
    );
    await expect(new AntigravityLlm({ model: 'm', effort: 'low', cmd: 'agy', run: fakeRunner(errStream('blocked', 'safety')).run }).digest(REQ)).rejects.toBeInstanceOf(
      LlmRefusal,
    );
    await expect(
      new AntigravityLlm({ model: 'm', effort: 'low', cmd: 'agy', run: fakeRunner('', { status: null, timedOut: true }).run, timeoutMs: 5000 }).digest(REQ),
    ).rejects.toBeInstanceOf(AntigravityTimeoutError);
  });
});

describe('FallbackLlm', () => {
  it('switches from Claude Code to Antigravity on sign-in or usage-limit errors', async () => {
    const claudeCalls: number[] = [];
    const agyCalls: number[] = [];
    const primary = new ClaudeCodeLlm({
      model: 'claude-haiku-5-5',
      effort: 'low',
      cmd: 'claude',
      run: async () => {
        claudeCalls.push(1);
        return { status: 1, stdout: JSON.stringify({ is_error: true, result: 'You have hit your usage limit.' }), stderr: '', timedOut: false };
      },
    });
    const fallback = new AntigravityLlm({
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      cmd: 'agy',
      run: async () => {
        agyCalls.push(1);
        return { status: 0, stdout: OK_STREAM, stderr: '', timedOut: false };
      },
    });
    const llm = new FallbackLlm(primary, fallback);
    expect(llm.model).toBe('claude-haiku-5-5');
    const first = await llm.digest(REQ);
    expect(first.goal).toBe('Use SQLite.');
    expect(llm.model).toBe('gemini-3.8-flash-low');
    // Subsequent calls stay on Antigravity without calling Claude again.
    await llm.digest(REQ);
    expect(claudeCalls).toHaveLength(1);
    expect(agyCalls).toHaveLength(2);
  });

  it('switches on ClaudeSignInError too', async () => {
    const primary = new ClaudeCodeLlm({
      model: 'claude-haiku-5-5',
      effort: 'low',
      cmd: 'claude',
      run: async () => {
        throw new ClaudeSignInError();
      },
    });
    const fallback = new AntigravityLlm({
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      cmd: 'agy',
      run: async () => ({ status: 0, stdout: OK_STREAM, stderr: '', timedOut: false }),
    });
    const llm = new FallbackLlm(primary, fallback);
    const out = await llm.digest(REQ);
    expect(out.goal).toBe('Use SQLite.');
    expect(llm.model).toBe('gemini-3.8-flash-low');
  });

  it('does not swallow UsageLimitError if fallback also fails', async () => {
    const primary = new ClaudeCodeLlm({
      model: 'claude-haiku-5-5',
      effort: 'low',
      cmd: 'claude',
      run: async () => {
        throw new UsageLimitError(null);
      },
    });
    const fallback = new AntigravityLlm({
      model: 'gemini-3.8-flash-low',
      effort: 'low',
      cmd: 'agy',
      run: async () => ({ status: 1, stdout: JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'rate limit' } }), stderr: '', timedOut: false }),
    });
    const llm = new FallbackLlm(primary, fallback);
    await expect(llm.digest(REQ)).rejects.toBeInstanceOf(AntigravityLimitError);
  });
});
