import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonSchemaOf, LlmRefusal, PromptedLlm, type AskCall } from '@context-hub/core';

/** Claude Code settings and the host's sign-in must never reach a summary run: it uses the owner's stored login only. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Windows treats variable names without regard to case. CLAUDE_CONFIG_DIR stays:
    // it says where the owner's own Claude Code keeps its settings and sign-in.
    if (/^(ANTHROPIC_|CLAUDE)/i.test(name) && name.toUpperCase() !== 'CLAUDE_CONFIG_DIR') continue;
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

/** True on Windows when `claude` is on the path only as a .cmd shim, which summaries cannot start. */
export function claudeOnlyAsCmd(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const lines = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    return lines.length > 0 && !lines.some((l) => l.trim().toLowerCase().endsWith('.exe'));
  } catch {
    return false;
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
  /**
   * resetsAt is an ISO time when Claude Code gave a timestamp. resetsText is the
   * reset time as Claude Code wrote it otherwise, for example "5:20pm (Asia/Jakarta)".
   */
  constructor(
    readonly resetsAt: string | null,
    readonly resetsText: string | null = null,
  ) {
    const when = resetsAt ?? resetsText;
    super(when === null ? 'the Claude usage limit was reached' : `the Claude usage limit was reached (resets ${when})`);
  }
}

/**
 * Claude Code gave no answer in time. Whatever held it up (a stuck start, the
 * network) would hold up the next call too, so the run stops writing summaries.
 */
export class ClaudeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)}s`);
  }
}

/** Claude Code has no usable sign-in on this computer. */
export class ClaudeSignInError extends Error {
  constructor() {
    super('Claude Code is not signed in, or its login expired. Run: claude auth login');
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

// "Failed to authenticate: OAuth session expired…" comes with api_error_status null, so the text decides.
const SIGNED_OUT = /not logged in|please run \/login|run \/login|invalid api key|authentication|failed to authenticate|oauth session expired/i;
// "You've hit your session limit · resets 5:20pm (Asia/Jakarta)" is what a Pro plan shows today.
const LIMIT = /usage limit|limit reached|rate limit|hit your [a-z ]*limit/i;

/** "Claude AI usage limit reached|1792580400" carries the reset time as epoch seconds. */
function resetTime(text: string): string | null {
  const m = /\|(\d{9,11})\s*$/.exec(text.trim());
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

/** "… · resets 5:20pm (Asia/Jakarta)": the reset time as written, or null. */
function resetText(text: string): string | null {
  const m = /resets\s+([^·\n]+?)\s*$/i.exec(text.trim());
  return m ? m[1]!.slice(0, 60) : null;
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
      // The user's settings.json can carry an env block (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)
      // that sends Claude Code to a proxy or another account, and --safe-mode still applies it.
      // Loading only project settings, from an empty folder, leaves the stored plan login.
      '--setting-sources',
      'project',
    ];
    const out = await this.run(this.cmd, args, call.user, cleanEnv(process.env), this.timeoutMs);
    if (out.timedOut) throw new ClaudeTimeoutError(this.timeoutMs);

    const result = parseResult(out.stdout);
    if (result === null) {
      const detail = out.stderr.trim() || out.stdout.trim() || `exit status ${out.status}`;
      if (SIGNED_OUT.test(detail)) throw new ClaudeSignInError();
      throw new Error(`claude gave no usable answer: ${detail.slice(0, 300)}`);
    }

    const text = typeof result.result === 'string' ? result.result : '';
    if (result.stop_reason === 'refusal') throw new LlmRefusal(result.stop_details?.category ?? 'unspecified');
    if (result.api_error_status === 401 || (result.is_error === true && SIGNED_OUT.test(text))) throw new ClaudeSignInError();
    if (result.api_error_status === 429 || (result.is_error === true && LIMIT.test(text))) throw new UsageLimitError(resetTime(text), resetText(text));
    if (result.is_error === true) throw new Error(`claude reported an error: ${text.slice(0, 300) || `exit status ${out.status}`}`);
    if (result.structured_output === undefined || result.structured_output === null) throw new Error('claude returned no structured output');
    return result.structured_output as T;
  }
}
