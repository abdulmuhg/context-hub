import { readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../src/auto.js';
import { run, type Io } from '../src/cli.js';
import { DEFAULT_SUMMARY_EFFORT, DEFAULT_SUMMARY_MODEL, loadConfig, loadToken, saveConfig, saveToken } from '../src/config.js';
import { setupCase, parsePicks } from '../src/setup.js';
import { tempDir, writeJsonl, writeRaw } from './helpers.js';

const SUMMARIES = `✓ Claude Code signed in, model ${DEFAULT_SUMMARY_MODEL}, effort ${DEFAULT_SUMMARY_EFFORT}`;
const NEW_LINE = 'Get a new line from Sign-ins → Add a computer and paste it.';

let io: Io;
let out: string[];
let err: string[];
let requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
let statusAnswer: { status: number; body: unknown };
let devicesStatus: number;
let claude: { found: boolean; output: string };

const settingsPath = (): string => join(io.home, '.claude', 'settings.json');
const setup = (...args: string[]): Promise<number> => run(['setup', '--url', 'https://hub.test', ...args], io);
const hook = (): string => hookCommand('/usr/bin/node', io.bundlePath!);

beforeEach(() => {
  out = [];
  err = [];
  requests = [];
  statusAnswer = { status: 200, body: { label: 'MRC', projects: 1, sessions: 2 } };
  devicesStatus = 200;
  claude = { found: true, output: '{"loggedIn":true}' };
  io = {
    home: tempDir(),
    hubDir: tempDir(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ask: async () => '',
    hostname: () => 'test-host',
    bundlePath: join(tempDir(), 'hub.mjs'),
    execPath: '/usr/bin/node',
    runClaude: () => claude,
    exists: () => true,
    fetchImpl: async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/devices')) {
        return devicesStatus === 200
          ? new Response(JSON.stringify({ token: 'chub_new', label: 'my-mac' }), { status: 200 })
          : new Response(JSON.stringify({ error: 'nope' }), { status: devicesStatus });
      }
      if (url.endsWith('/api/status')) return new Response(JSON.stringify(statusAnswer.body), { status: statusAnswer.status });
      return new Response('{}', { status: 200 });
    },
  };
});

describe('hub setup', () => {
  it('a first install connects, installs commands, turns auto sync on and prints the checklist', async () => {
    expect(await setup('--code', 'ABCD-EFGH', '--note', 'Added ~/.local/bin to the front of PATH')).toBe(0);
    expect(out).toEqual([
      `✓ hub dev installed in ${dirname(io.bundlePath!)}`,
      '✓ Added ~/.local/bin to the front of PATH',
      '✓ Slash commands installed (6)',
      '✓ Connected to https://hub.test as "my-mac"',
      '✓ Auto sync on (runs when a Claude Code session ends)',
      SUMMARIES,
    ]);
    expect(loadConfig(io.hubDir).setup_version).toBe('dev');
    expect(loadToken(io.hubDir)).toBe('chub_new');
    expect(requests[0]!.body).toEqual({ code: 'ABCD-EFGH', name: 'test-host' });
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8')).hooks.SessionEnd[0].hooks[0].command).toBe(hook());
  });

  it('a re-run keeps the name, leaves auto sync off when it was off, and says already current', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://hub.test', label: 'MRC', setup_version: 'dev' });
    saveToken(io.hubDir, 'chub_old');
    expect(await setup('--code', 'ABCD-EFGH')).toBe(0);
    expect(out).toContain('✓ hub dev already current');
    expect(out).toContain('– Auto sync off (turn on with: hub auto on)');
    expect(requests[0]!.body).toEqual({ code: 'ABCD-EFGH', name: 'MRC' });
  });

  it('an update says from and to', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://hub.test', label: 'MRC', setup_version: '2026.10.01-aaaaaaa' });
    saveToken(io.hubDir, 'chub_old');
    await setup('--code', 'ABCD-EFGH');
    expect(out[0]).toBe('✓ hub dev, updated from 2026.10.01-aaaaaaa');
  });

  it('a re-run repoints an old hook even when it says nothing else about auto', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://hub.test', label: 'MRC', setup_version: 'dev' });
    saveToken(io.hubDir, 'chub_old');
    const old = '"C:\\node.exe" "C:\\src\\context-hub\\apps\\collector\\dist\\bin.js" sync --auto';
    writeRaw(settingsPath(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: old }] }] } }));
    await setup();
    const end = JSON.parse(readFileSync(settingsPath(), 'utf8')).hooks.SessionEnd;
    expect(end).toHaveLength(1);
    expect(end[0].hooks[0].command).toBe(hook());
    expect(out).toContain('✓ Auto sync on (runs when a Claude Code session ends)');
  });

  it('without a code and already connected it checks the token and keeps it', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://hub.test', setup_version: 'dev' });
    saveToken(io.hubDir, 'chub_old');
    expect(await setup()).toBe(0);
    expect(out).toContain('✓ Connected to https://hub.test as "MRC"');
    expect(requests.map((r) => r.url)).toEqual(['https://hub.test/api/status']);
    expect(loadToken(io.hubDir)).toBe('chub_old');
    expect(loadConfig(io.hubDir).label).toBe('MRC');
  });

  it('without a code and not connected it says how to connect and returns 0', async () => {
    expect(await setup()).toBe(0);
    expect(out).toContain('! Not connected yet. Paste the line from Sign-ins → Add a computer, or run: hub login');
    expect(out).toContain('✓ Slash commands installed (6)');
    expect(requests).toEqual([]);
  });

  it('a revoked token without a code says the computer was disconnected', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://hub.test', setup_version: 'dev' });
    saveToken(io.hubDir, 'chub_old');
    statusAnswer = { status: 401, body: { error: 'x' } };
    expect(await setup()).toBe(1);
    expect(out).toContain(`✗ This computer was disconnected from the hub. ${NEW_LINE}`);
    expect(out.join('\n')).not.toContain('Already connected');
  });

  it('a bad code fails with how to get a new one and saves nothing', async () => {
    devicesStatus = 401;
    expect(await setup('--code', 'OLD-CODE')).toBe(1);
    expect(out).toContain(`✗ That code didn't work: it has expired, was already used, or was mistyped. ${NEW_LINE}`);
    expect(loadToken(io.hubDir)).toBeNull();
    expect(loadConfig(io.hubDir).setup_version).toBeUndefined();
  });

  it('a new hub with a code says which hub it was connected to', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), server_url: 'https://old.test', setup_version: 'dev' });
    saveToken(io.hubDir, 'chub_old');
    await run(['setup', '--url', 'https://new.test', '--code', 'ABCD-EFGH'], io);
    expect(out).toContain('✓ Connected to https://new.test as "my-mac" (was https://old.test)');
    expect(requests[0]!.headers.Authorization).toBeUndefined();
  });

  it('no Claude Code skips auto sync and says why', async () => {
    claude = { found: false, output: '' };
    await setup('--code', 'ABCD-EFGH');
    expect(out).toContain("– Auto sync skipped: Claude Code isn't installed");
  });

  it('a broken settings.json warns on the auto row and setup still succeeds', async () => {
    writeRaw(settingsPath(), '{ "theme": ');
    expect(await setup('--code', 'ABCD-EFGH')).toBe(0);
    expect(out.some((l) => l.startsWith('! Auto sync not changed: ~/.claude/settings.json is not valid JSON'))).toBe(true);
    expect(out).toContain('✓ Connected to https://hub.test as "my-mac"');
  });

  it('--warn rows print with !', async () => {
    await setup('--code', 'ABCD-EFGH', '--warn', 'Another hub at /x/hub comes first on PATH');
    expect(out.at(-1)).toBe('! Another hub at /x/hub comes first on PATH');
  });

  it('needs the hub address', async () => {
    expect(await run(['setup'], io)).toBe(1);
    expect(err.join('\n')).toContain('hub setup --url');
  });
});

describe('parsePicks', () => {
  it('reads numbers, all, and nothing', () => {
    expect(parsePicks('1 3', 6)).toEqual([1, 3]);
    expect(parsePicks('1,3', 6)).toEqual([1, 3]);
    expect(parsePicks('all', 6)).toBe('all');
    expect(parsePicks('', 6)).toEqual([]);
    expect(parsePicks('7', 6)).toBeNull();
    expect(parsePicks('x', 6)).toBeNull();
  });
});

describe('hub setup: picking projects', () => {
  const NOW = new Date().toISOString();
  const session = (id: string, cwd: string, at: string) => ({
    type: 'user',
    sessionId: id,
    cwd,
    timestamp: at,
    message: { role: 'user', content: 'hello' },
  });
  let answers: string[];
  let prompts: string[];
  let syncs: number;

  beforeEach(() => {
    answers = [];
    prompts = [];
    syncs = 0;
    // A project's last activity is its newest file's modified time, so the files get the session's time.
    const seed = (file: string, id: string, cwd: string, at: string): void => {
      const path = join(io.home, '.claude', 'projects', 'p', file);
      writeJsonl(path, [session(id, cwd, at)]);
      utimesSync(path, new Date(at), new Date(at));
    };
    seed('a1.jsonl', '11111111-1111-4111-8111-111111111111', '/work/alpha', '2026-01-01T10:00:00.000Z');
    seed('a2.jsonl', '11111111-1111-4111-8111-111111111112', '/work/alpha', '2026-01-02T10:00:00.000Z');
    seed('b1.jsonl', '22222222-2222-4222-8222-222222222222', '/work/beta', NOW);
    seed('g1.jsonl', '33333333-3333-4333-8333-333333333333', '/work/gamma', '2026-01-03T10:00:00.000Z');
    io.git = (cwd, args) => (args[0] === 'remote' ? `git@github.com:me/${cwd.split('/').pop()}.git` : cwd);
    io.interactive = true;
    io.ask = async (q) => {
      prompts.push(q);
      return answers.shift() ?? '';
    };
  });

  const sync = async (): Promise<number> => {
    syncs++;
    return 0;
  };
  const go = (): Promise<number> => setupCase(io, ['--url', 'https://hub.test', '--code', 'ABCD-EFGH'], sync);
  const PROMPT = 'Which should go to the hub? Numbers (e.g. 1 3), "all", or Enter for none: ';

  it('lists undecided projects newest first and tracks the picks, declining the rest', async () => {
    answers = ['1'];
    expect(await go()).toBe(0);
    expect(out).toContain('Found 3 projects on this computer:');
    const rows = out.filter((l) => /^\s+\d\s+github\.com/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/1\s+github\.com\/me\/beta\s+1 session\s+today/);
    expect(rows[2]).toMatch(/3\s+github\.com\/me\/alpha\s+2 sessions\s+\d+ days ago/);
    const cfg = loadConfig(io.hubDir);
    expect(cfg.tracked).toEqual(['github.com/me/beta']);
    expect(cfg.declined.sort()).toEqual(['github.com/me/alpha', 'github.com/me/gamma']);
    expect(prompts).toEqual([PROMPT]);
    expect(syncs).toBe(1);
  });

  it('an unreadable answer asks once more, then picks nothing', async () => {
    answers = ['x', 'x'];
    expect(await go()).toBe(0);
    expect(prompts).toEqual([PROMPT, PROMPT]);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
    expect(loadConfig(io.hubDir).declined).toEqual([]);
    expect(syncs).toBe(0);
  });

  it('Enter decides nothing and runs no sync', async () => {
    answers = [''];
    expect(await go()).toBe(0);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
    expect(loadConfig(io.hubDir).declined).toEqual([]);
    expect(syncs).toBe(0);
  });

  it('without a terminal it picks nothing and says how to choose later', async () => {
    io.interactive = false;
    expect(await go()).toBe(0);
    expect(prompts).toEqual([]);
    expect(out.at(-1)).toBe('Run hub sync in a terminal to choose which projects to upload.');
    expect(syncs).toBe(0);
  });

  it("the first sync's last line", async () => {
    answers = ['all'];
    await go();
    expect(out.at(-1)).toBe('Done. This computer syncs when a Claude Code session ends; run hub sync any time.');
    expect(loadConfig(io.hubDir).tracked).toHaveLength(3);
  });

  it('Ctrl+C during the first sync prints how the rest uploads', async () => {
    answers = ['1'];
    let handler: (() => void) | undefined;
    let removed = false;
    io.onInterrupt = (h) => {
      handler = h;
      return () => {
        removed = true;
      };
    };
    await setupCase(io, ['--url', 'https://hub.test', '--code', 'ABCD-EFGH'], async () => {
      handler!();
      expect(removed).toBe(false);
      return 0;
    });
    expect(out).toContain('Stopped. The rest uploads on the next sync, or run hub sync.');
    expect(removed).toBe(true);
  });

  it('already-decided projects are not offered again on a re-run', async () => {
    answers = ['1'];
    await go();
    out.length = 0;
    prompts.length = 0;
    answers = [];
    expect(await go()).toBe(0);
    expect(prompts).toEqual([]);
    expect(out.join('\n')).not.toContain('Found');
  });
});
