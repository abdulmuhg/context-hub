import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonSchemaOf, LlmRefusal, PromptedLlm, type AskCall } from '@context-hub/core';

/** Claude Code settings and the host's sign-in must never reach a summary run: it uses the owner's stored login only. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Windows treats variable names without regard to case.
    if (/^(ANTHROPIC_|CLAUDE)/i.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The path of the `claude` program, or null. On Windows only a real `.exe` is
 * accepted, because a `.cmd` shim cannot be started without a shell, and a
 * shell would mangle the prompt and schema arguments.
 */
export function findClaude(): string | null {
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? null;
    }
    const found = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return found === '' ? null : found;
  } catch {
    return null;
  }
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ClaudeRunner = (cmd: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<RunResult>;

/**
 * Where `claude` runs. An empty folder of our own, so no project's settings or
 * permission rules are read, whatever folder a sync was started from.
 */
function workDir(): string {
  const dir = join(tmpdir(), 'context-hub-summaries');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Starts a program without a shell, so arguments with quotes and newlines arrive byte for byte. */
export const spawnRunner: ClaudeRunner = (cmd, args, stdin, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, env, cwd: workDir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    // A program that exits early closes the pipe; that surfaces through its exit status.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });

/** The usage limit of the Claude plan was reached. Nothing more can be summarized until it resets. */
export class UsageLimitError extends Error {
  constructor(readonly resetsAt: string | null) {
    super(resetsAt === null ? 'the Claude usage limit was reached' : `the Claude usage limit was reached (resets ${resetsAt})`);
  }
}

/** Claude Code has no usable sign-in on this computer. */
export class ClaudeSignInError extends Error {
  constructor() {
    super('Claude Code is not signed in. Run: claude');
  }
}

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  stop_details?: { category?: string };
  api_error_status?: number | null;
  structured_output?: unknown;
}

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication/i;
const LIMIT = /usage limit|limit reached|rate limit/i;

/** "Claude AI usage limit reached|1792580400" carries the reset time as epoch seconds. */
function resetTime(text: string): string | null {
  const m = /\|(\d{9,11})\s*$/.exec(text.trim());
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

function parseResult(stdout: string): ClaudeResult | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    // A stream form is a list of events; the answer is the last "result" one.
    if (Array.isArray(value)) return ([...value].reverse().find((e) => (e as { type?: string })?.type === 'result') as ClaudeResult | undefined) ?? null;
    return value !== null && typeof value === 'object' ? (value as ClaudeResult) : null;
  } catch {
    return null;
  }
}

/** Writes summaries by running Claude Code (`claude -p`) on this computer, on the owner's Claude plan. */
export class ClaudeCodeLlm extends PromptedLlm {
  readonly model: string;
  private readonly effort: string;
  private readonly cmd: string;
  private readonly run: ClaudeRunner;
  private readonly timeoutMs: number;

  constructor(opts: { model: string; effort: string; cmd: string; run?: ClaudeRunner; timeoutMs?: number }) {
    super();
    this.model = opts.model;
    this.effort = opts.effort;
    this.cmd = opts.cmd;
    this.run = opts.run ?? spawnRunner;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  protected async ask<T>(call: AskCall): Promise<T> {
    const args = [
      '-p',
      '--model',
      this.model,
      '--effort',
      this.effort,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(jsonSchemaOf(call.schema)),
      '--system-prompt',
      call.system,
      '--tools',
      '',
      '--no-session-persistence',
      '--safe-mode',
      '--strict-mcp-config',
    ];
    const out = await this.run(this.cmd, args, call.user, cleanEnv(process.env), this.timeoutMs);
    if (out.timedOut) throw new Error(`claude did not answer within ${Math.round(this.timeoutMs / 1000)}s`);

    const result = parseResult(out.stdout);
    if (result === null) {
      const detail = out.stderr.trim() || out.stdout.trim() || `exit status ${out.status}`;
      if (SIGNED_OUT.test(detail)) throw new ClaudeSignInError();
      throw new Error(`claude gave no usable answer: ${detail.slice(0, 300)}`);
    }

    const text = typeof result.result === 'string' ? result.result : '';
    if (result.stop_reason === 'refusal') throw new LlmRefusal(result.stop_details?.category ?? 'unspecified');
    if (result.api_error_status === 401 || (result.is_error === true && SIGNED_OUT.test(text))) throw new ClaudeSignInError();
    if (result.api_error_status === 429 || (result.is_error === true && LIMIT.test(text))) throw new UsageLimitError(resetTime(text));
    if (result.is_error === true) throw new Error(`claude reported an error: ${text.slice(0, 300) || `exit status ${out.status}`}`);
    if (result.structured_output === undefined || result.structured_output === null) throw new Error('claude returned no structured output');
    return result.structured_output as T;
  }
}
