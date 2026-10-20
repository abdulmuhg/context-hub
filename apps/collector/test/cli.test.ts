import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';
import { loadConfig, loadPersonal, loadToken } from '../src/config.js';
import { tempDir, writeJsonl } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
let io: Io;
let out: string[];
let err: string[];
let answers: string[];
let requests: { method: string; url: string }[];

beforeEach(() => {
  out = [];
  err = [];
  answers = [];
  requests = [];
  const home = tempDir();
  writeJsonl(join(home, '.claude', 'projects', 'p', `${S1}.jsonl`), [
    { type: 'user', sessionId: S1, cwd: '/work/alpha', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
  ]);
  io = {
    home,
    hubDir: tempDir(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ask: async () => answers.shift() ?? '',
    exists: () => true,
    git: (_cwd, args) => (args[0] === 'remote' ? 'git@github.com:me/alpha.git' : '/work/alpha'),
    fetchImpl: async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return new Response('{"sessions":1}', { status: 200 });
    },
  };
});

const KEY = 'github.com/me/alpha';

describe('hub init', () => {
  it('saves the URL and token from flags', async () => {
    expect(await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io)).toBe(0);
    expect(loadConfig(io.hubDir).server_url).toBe('https://hub.example.com');
    expect(loadToken(io.hubDir)).toBe('tok');
  });

  it('asks for what is missing', async () => {
    answers = ['https://hub.example.com', 'tok-asked'];
    expect(await run(['init'], io)).toBe(0);
    expect(loadToken(io.hubDir)).toBe('tok-asked');
  });

  it('rejects a URL that is not http or https', async () => {
    expect(await run(['init', '--url', 'hub.example.com', '--token', 't'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/must start with http/);
  });
});

describe('hub track / untrack / projects', () => {
  it('tracks by short name and stores the full key', async () => {
    expect(await run(['track', 'alpha'], io)).toBe(0);
    expect(loadConfig(io.hubDir).tracked).toEqual([KEY]);
  });

  it('refuses a project it cannot find, and lists what exists', async () => {
    expect(await run(['track', 'nope'], io)).toBe(1);
    expect(err.join('\n')).toContain(KEY);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
  });

  it('untrack removes it and tracking twice does not duplicate', async () => {
    await run(['track', 'alpha'], io);
    await run(['track', 'alpha'], io);
    expect(loadConfig(io.hubDir).tracked).toEqual([KEY]);
    await run(['untrack', 'alpha'], io);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
  });

  it('projects shows the key, the count and a tracked mark', async () => {
    await run(['track', 'alpha'], io);
    out = [];
    expect(await run(['projects'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/\[x\]\s+github\.com\/me\/alpha\s+claude-code: 1/);
  });
});

describe('hub skip / alias / assign', () => {
  it('stores each override', async () => {
    await run(['skip', `claude-code:${S1}`], io);
    await run(['alias', 'local:a', KEY], io);
    await run(['assign', `claude-code:${S1}`, 'local:special'], io);
    expect(loadConfig(io.hubDir)).toMatchObject({
      skipped: [`claude-code:${S1}`],
      aliases: { 'local:a': KEY },
      assignments: { [`claude-code:${S1}`]: 'local:special' },
    });
    await run(['unskip', `claude-code:${S1}`], io);
    expect(loadConfig(io.hubDir).skipped).toEqual([]);
  });

  it('rejects a session without a source prefix', async () => {
    expect(await run(['skip', S1], io)).toBe(1);
    expect(err.join('\n')).toMatch(/<source>:<id>/);
  });
});

describe('hub sync', () => {
  beforeEach(async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    await run(['track', 'alpha'], io);
    out = [];
  });

  it('dry run prints what would be uploaded and sends nothing', async () => {
    expect(await run(['sync', '--dry-run'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Would upload 1 session/);
    expect(out.join('\n')).toContain(KEY);
    expect(requests).toEqual([]);
  });

  it('uploads and prints a summary', async () => {
    expect(await run(['sync'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Uploaded 1 session/);
    expect(requests).toEqual([{ method: 'PUT', url: `https://hub.example.com/api/sessions/claude-code/${S1}` }]);
  });

  it('says so when --project names a project that is not tracked', async () => {
    await run(['untrack', 'alpha'], io);
    out = [];
    expect(await run(['sync', '--project', 'alpha', '--dry-run'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/not tracked/);
    expect(err.join('\n')).toMatch(/hub track/);
    expect(requests).toEqual([]);
  });

  it('exits 1 and prints the error when the server refuses', async () => {
    io.fetchImpl = async () => new Response('no', { status: 401 });
    expect(await run(['sync'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/401/);
  });
});

describe('hub forget', () => {
  beforeEach(async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
  });

  it('deletes a project after confirmation', async () => {
    answers = ['yes'];
    expect(await run(['forget', KEY], io)).toBe(0);
    expect(requests).toEqual([{ method: 'DELETE', url: `https://hub.example.com/api/projects/${encodeURIComponent(KEY)}` }]);
  });

  it('does nothing without confirmation', async () => {
    answers = ['no'];
    expect(await run(['forget', KEY], io)).toBe(1);
    expect(requests).toEqual([]);
  });

  it('deletes one session with --session', async () => {
    answers = ['yes'];
    expect(await run(['forget', '--session', `claude-code:${S1}`], io)).toBe(0);
    expect(requests[0]).toEqual({ method: 'DELETE', url: `https://hub.example.com/api/sessions/claude-code/${S1}` });
  });
});

describe('hub personal', () => {
  it('add asks for the value, list never prints it', async () => {
    answers = ['0812-3456-7890'];
    expect(await run(['personal', 'add', 'phone'], io)).toBe(0);
    expect(loadPersonal(io.hubDir)).toEqual([{ label: 'phone', value: '0812-3456-7890' }]);
    out = [];
    await run(['personal', 'list'], io);
    expect(out.join('\n')).toContain('phone');
    expect(out.join('\n')).not.toContain('0812');
  });

  it('level sets card, list and a single entry', async () => {
    answers = ['0812-3456-7890'];
    await run(['personal', 'add', 'phone'], io);
    await run(['personal', 'level', 'card', 'partial'], io);
    await run(['personal', 'level', 'list', 'full'], io);
    await run(['personal', 'level', 'phone', 'off'], io);
    expect(loadConfig(io.hubDir).personal).toEqual({ card: 'partial', list: 'full' });
    expect(loadPersonal(io.hubDir)[0].level).toBe('off');
  });

  it('rejects an unknown level and an unknown label', async () => {
    expect(await run(['personal', 'level', 'card', 'loud'], io)).toBe(1);
    expect(await run(['personal', 'level', 'nobody', 'full'], io)).toBe(1);
  });

  it('remove deletes the entry', async () => {
    answers = ['x-value-123'];
    await run(['personal', 'add', 'thing'], io);
    await run(['personal', 'remove', 'thing'], io);
    expect(loadPersonal(io.hubDir)).toEqual([]);
  });
});

describe('hub connect', () => {
  it('hub connect prints the code and how to use it', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'ingest-secret-token'], io);
    out = [];
    io.fetchImpl = async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return new Response(JSON.stringify({ code: 'ABCD-EFGH', expires_at: '2026-10-11T00:10:00.000Z' }), { status: 200 });
    };
    expect(await run(['connect'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('ABCD-EFGH');
    expect(text).toContain('10 minutes');
    expect(text).toContain('one use');
    expect(text).not.toContain('ingest-secret-token');
    expect(requests.at(-1)).toEqual({ method: 'POST', url: 'https://hub.example.com/api/connect-code' });
  });
});

describe('hub status and usage', () => {
  it('status prints what the server returns', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    out = [];
    expect(await run(['status'], io)).toBe(0);
    expect(out.join('\n')).toContain('"sessions": 1');
  });

  it('an unknown command prints usage and exits 1', async () => {
    expect(await run(['dance'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: hub/);
  });
});
