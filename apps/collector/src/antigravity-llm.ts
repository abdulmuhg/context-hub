import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jsonSchemaOf, LlmRefusal, PromptedLlm, type AskCall, type Llm } from '@context-hub/core';
import { ClaudeSignInError, spawnRunner, UsageLimitError, type ClaudeRunner } from './claude-llm.js';

/** Strips API key env vars so `agy` always uses the owner's stored Antigravity login. */
export function cleanAntigravityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The path of the `agy` CLI program, or null. Checks PATH first, then `~/.gemini/bin/agy(.exe)`
 * so background hooks find it even when `~/.gemini/bin` is not on PATH.
 */
export function findAntigravity(home: string = homedir()): string | null {
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('where', ['agy'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
      if (exe) return exe;
    } else {
      const found = execFileSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found !== '') return found;
    }
  } catch {
    // Fall back to the default ~/.gemini/bin location below.
  }
  const fallback = join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  return existsSync(fallback) ? fallback : null;
}

export class AntigravityLimitError extends Error {
  constructor(detail?: string) {
    super(detail ? `the Antigravity usage limit was reached (${detail})` : 'the Antigravity usage limit was reached');
  }
}

export class AntigravityTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Antigravity did not answer within ${Math.round(timeoutMs / 1000)}s`);
  }
}

export class AntigravitySignInError extends Error {
  constructor() {
    super('Antigravity is not signed in. Run: agy');
  }
}

interface AgyResultPayload {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  finished_reason?: string;
  structured_output?: unknown;
}

interface ParsedAgyOutput {
  conversationId: string | null;
  result: AgyResultPayload | null;
}

const SIGNED_OUT = /not logged in|unauthenticated|unauthorized|failed to authenticate|sign in|please log in|invalid credentials/i;
const LIMIT = /usage limit|limit reached|rate limit|quota|resource exhausted|429/i;
const REFUSAL = /refus|safety|content policy/i;

function parseOutput(stdout: string): ParsedAgyOutput {
  let conversationId: string | null = null;
  let result: AgyResultPayload | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as { event?: string; conversation_id?: unknown; result?: unknown } & AgyResultPayload;
    if (typeof rec.conversation_id === 'string' && rec.conversation_id) conversationId = rec.conversation_id;
    if (rec.event === 'result' && rec.result && typeof rec.result === 'object') {
      result = rec.result as AgyResultPayload;
      if (typeof result.conversation_id === 'string' && result.conversation_id) conversationId = result.conversation_id;
    } else if (rec.event === undefined && ('status' in rec || 'structured_output' in rec)) {
      result = rec;
    }
  }
  return { conversationId, result };
}

function cleanupConversation(home: string | undefined, conversationId: string | null): void {
  if (!home || !conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) return;
  const root = join(home, '.gemini', 'antigravity-cli');
  for (const p of [join(root, 'brain', conversationId), join(root, 'conversations', `${conversationId}.pb`), join(root, 'annotations', `${conversationId}.pbtxt`)]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of temporary summary conversations.
    }
  }
}

/** Writes summaries by running Antigravity CLI (`agy`) in stream-json mode on this computer. */
export class AntigravityLlm extends PromptedLlm {
  readonly model: string;
  private readonly effort: string;
  private readonly cmd: string;
  private readonly run: ClaudeRunner;
  private readonly timeoutMs: number;
  private readonly home?: string;

  constructor(opts: { model: string; effort: string; cmd: string; run?: ClaudeRunner; timeoutMs?: number; home?: string }) {
    super();
    this.model = opts.model;
    this.effort = opts.effort;
    this.cmd = opts.cmd;
    this.run = opts.run ?? spawnRunner;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.home = opts.home;
  }

  protected async ask<T>(call: AskCall): Promise<T> {
    const args = [
      '--model',
      this.model,
      '--effort',
      this.effort,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--json-schema',
      JSON.stringify(jsonSchemaOf(call.schema)),
      '--disable-slash-commands',
    ];
    const stdin = JSON.stringify({ event: 'user', message: { role: 'user', content: `${call.system}\n\n${call.user}` } }) + '\n';
    const out = await this.run(this.cmd, args, stdin, cleanAntigravityEnv(process.env), this.timeoutMs);
    const { conversationId, result } = parseOutput(out.stdout);
    try {
      if (out.timedOut) throw new AntigravityTimeoutError(this.timeoutMs);
      if (result === null) {
        const detail = out.stderr.trim() || out.stdout.trim() || `exit status ${out.status}`;
        if (SIGNED_OUT.test(detail)) throw new AntigravitySignInError();
        if (LIMIT.test(detail)) throw new AntigravityLimitError();
        throw new Error(`agy gave no usable answer: ${detail.slice(0, 300)}`);
      }
      const errText = typeof result.error === 'string' && result.error ? result.error : typeof result.response === 'string' ? result.response : '';
      if (result.status === 'ERROR') {
        if (SIGNED_OUT.test(errText)) throw new AntigravitySignInError();
        if (LIMIT.test(errText)) throw new AntigravityLimitError();
        if (result.finished_reason && REFUSAL.test(result.finished_reason)) throw new LlmRefusal(result.finished_reason);
        throw new Error(`agy reported an error: ${errText.slice(0, 300) || `exit status ${out.status}`}`);
      }
      if (result.structured_output !== undefined && result.structured_output !== null) return result.structured_output as T;
      if (typeof result.response === 'string' && result.response.trim() !== '') {
        try {
          return JSON.parse(result.response) as T;
        } catch {
          // Fall through to missing structured output error.
        }
      }
      throw new Error('agy returned no structured output');
    } finally {
      cleanupConversation(this.home, conversationId);
    }
  }
}

/** Uses `primary` first and switches to `fallback` for the rest of the run on sign-in or usage-limit errors. */
export class FallbackLlm implements Llm {
  private active: Llm;
  private switched = false;

  constructor(
    primary: Llm,
    private readonly fallback: Llm,
  ) {
    this.active = primary;
  }

  get model(): string {
    return this.active.model;
  }

  private async runWithFallback<T>(fn: (llm: Llm) => Promise<T>): Promise<T> {
    try {
      return await fn(this.active);
    } catch (e) {
      if (!this.switched && (e instanceof ClaudeSignInError || e instanceof UsageLimitError)) {
        this.switched = true;
        this.active = this.fallback;
        return await fn(this.active);
      }
      throw e;
    }
  }

  digest(req: Parameters<Llm['digest']>[0]) {
    return this.runWithFallback((l) => l.digest(req));
  }

  mergeDigests(req: Parameters<Llm['mergeDigests']>[0]) {
    return this.runWithFallback((l) => l.mergeDigests(req));
  }

  projectState(req: Parameters<Llm['projectState']>[0]) {
    return this.runWithFallback((l) => l.projectState(req));
  }

  reviewState(req: Parameters<Llm['reviewState']>[0]) {
    return this.runWithFallback((l) => l.reviewState(req));
  }
}
