import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { newProjects, run, type Io } from '../src/cli.js';
import { SLASH_COMMANDS } from '../src/commands.js';
import { UsageLimitError } from '../src/claude-llm.js';
import { loadConfig, loadPersonal, loadToken, saveConfig, saveState, settingsFingerprint } from '../src/config.js';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
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
    llm: new FakeLlm(),
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

describe('hub login', () => {
  const SECRET = 'chub_test-token-value';
  let asked: string[];
  let bodies: unknown[];
  let status: number;

  beforeEach(() => {
    asked = [];
    bodies = [];
    status = 200;
    io.hostname = () => 'test-host';
    io.ask = async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    };
    io.fetchImpl = async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      bodies.push(JSON.parse(String(init?.body)));
      return status === 200
        ? new Response(JSON.stringify({ token: SECRET, label: 'my-mac' }), { status })
        : new Response(JSON.stringify({ error: 'That code is wrong or has expired.' }), { status });
    };
  });

  it('saves the address and token and prints the label, never the token', async () => {
    answers = ['ABCD-EFGH'];
    expect(await run(['login', '--url', 'https://hub.example.com/', '--name', 'my-mac'], io)).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: 'https://hub.example.com/api/devices' }]);
    expect(bodies).toEqual([{ code: 'ABCD-EFGH', name: 'my-mac' }]);
    expect(loadConfig(io.hubDir).server_url).toBe('https://hub.example.com');
    expect(loadToken(io.hubDir)).toBe(SECRET);
    expect(out).toContain('Connected as "my-mac". Next: hub projects, then hub track <project> and hub sync.');
    expect([...out, ...err, ...asked].join('\n')).not.toContain(SECRET);
  });

  it('asks for the address, offers the host name as the default and keeps it on an empty answer', async () => {
    answers = ['https://hub.example.com', '', 'ABCD-EFGH'];
    expect(await run(['login'], io)).toBe(0);
    expect(asked).toEqual(['Hub address (https://...): ', 'Name for this computer [test-host]: ', 'Code from the dashboard (Sign-ins > Add a computer): ']);
    expect(bodies).toEqual([{ code: 'ABCD-EFGH', name: 'test-host' }]);
  });

  it('uses the saved address without asking for it', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'old'], io);
    answers = ['laptop', 'ABCD-EFGH'];
    expect(await run(['login'], io)).toBe(0);
    expect(asked[0]).toBe('Name for this computer [test-host]: ');
    expect(requests[0]!.url).toBe('https://hub.example.com/api/devices');
  });

  it('prints the server message on a wrong code and saves nothing', async () => {
    status = 401;
    answers = ['WRONG-CODE'];
    expect(await run(['login', '--url', 'https://hub.example.com', '--name', 'x'], io)).toBe(1);
    expect(err.join('\n')).toContain('That code is wrong or has expired.');
    expect(loadConfig(io.hubDir).server_url).toBeFalsy();
    expect(loadToken(io.hubDir)).toBeFalsy();
  });

  it('asks before replacing a different saved hub and stops on anything but y', async () => {
    await run(['init', '--url', 'https://old.example.com', '--token', 'old'], io);
    answers = ['n'];
    expect(await run(['login', '--url', 'https://new.example.com', '--name', 'x'], io)).toBe(1);
    expect(asked).toEqual(['This computer is connected to https://old.example.com. Replace it with https://new.example.com? (y/N) ']);
    expect(requests).toEqual([]);
    expect(loadConfig(io.hubDir).server_url).toBe('https://old.example.com');
    expect(loadToken(io.hubDir)).toBe('old');
  });

  it('replaces the saved hub after y', async () => {
    await run(['init', '--url', 'https://old.example.com', '--token', 'old'], io);
    answers = ['y', 'ABCD-EFGH'];
    expect(await run(['login', '--url', 'https://new.example.com', '--name', 'x'], io)).toBe(0);
    expect(loadConfig(io.hubDir).server_url).toBe('https://new.example.com');
    expect(loadToken(io.hubDir)).toBe(SECRET);
  });

  it('keeps the old hub when the exchange fails after y', async () => {
    await run(['init', '--url', 'https://old.example.com', '--token', 'old'], io);
    status = 401;
    answers = ['y', 'BAD-CODE'];
    expect(await run(['login', '--url', 'https://new.example.com', '--name', 'x'], io)).toBe(1);
    expect(loadConfig(io.hubDir).server_url).toBe('https://old.example.com');
    expect(loadToken(io.hubDir)).toBe('old');
  });
});

describe('hub install-commands', () => {
  it('writes the six slash commands and overwrites them on a second run', async () => {
    const dir = join(tempDir(), 'commands');
    expect(await run(['install-commands', '--dir', dir], io)).toBe(0);
    expect(out).toContain(`Installed 6 slash commands in ${dir}.`);
    expect(readdirSync(dir).sort()).toEqual(Object.keys(SLASH_COMMANDS).sort());
    for (const [name, text] of Object.entries(SLASH_COMMANDS)) expect(readFileSync(join(dir, name), 'utf8')).toBe(text);
    writeFileSync(join(dir, 'hub-sync.md'), 'changed');
    expect(await run(['install-commands', '--dir', dir], io)).toBe(0);
    expect(readFileSync(join(dir, 'hub-sync.md'), 'utf8')).toBe(SLASH_COMMANDS['hub-sync.md']);
  });

  it('defaults to ~/.claude/commands', async () => {
    expect(await run(['install-commands'], io)).toBe(0);
    expect(readdirSync(join(io.home, '.claude', 'commands'))).toHaveLength(6);
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
    expect(requests).toEqual([
      { method: 'GET', url: 'https://hub.example.com/api/status' },
      { method: 'PUT', url: `https://hub.example.com/api/sessions/claude-code/${S1}` },
      { method: 'GET', url: 'https://hub.example.com/api/status' },
      { method: 'POST', url: 'https://hub.example.com/api/sync-runs' },
    ]);
  });

  it('says so when --project names a project that is not tracked', async () => {
    await run(['untrack', 'alpha'], io);
    out = [];
    expect(await run(['sync', '--project', 'alpha', '--dry-run'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/not tracked/);
    expect(err.join('\n')).toMatch(/hub track/);
    expect(requests).toEqual([]);
  });

  it('tells the hub what started the run: --trigger when given, else whether a terminal ran it', async () => {
    const seen: (string | null)[] = [];
    const real = io.fetchImpl!;
    io.fetchImpl = async (input, init) => {
      if (init?.method === 'POST') seen.push(new Headers(init.headers).get('x-hub-trigger'));
      return real(input, init);
    };
    await run(['sync', '--trigger', 'slash'], io);
    await run(['sync'], io);
    io.interactive = true;
    await run(['sync'], io);
    expect(seen).toEqual(['slash', 'other', 'terminal']);
  });

  it('refuses a --trigger it does not know', async () => {
    expect(await run(['sync', '--trigger', 'cron'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/--trigger must be one of: terminal, slash, auto, other/);
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

  it('deletes a saved note with --session note:<id>', async () => {
    answers = ['yes'];
    expect(await run(['forget', '--session', 'note:n_abc'], io)).toBe(0);
    expect(requests).toEqual([{ method: 'DELETE', url: 'https://hub.example.com/api/sessions/note/n_abc' }]);
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

describe('hub sync: reporting the run', () => {
  it('still exits 0 and prints one line when the report cannot be sent', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    await run(['track', 'alpha'], io);
    io.fetchImpl = async (input) =>
      String(input).endsWith('/api/sync-runs') ? new Response('no', { status: 500 }) : new Response('{"stored":true}', { status: 200 });
    err = [];
    expect(await run(['sync'], io)).toBe(0);
    expect(err.filter((l) => l.includes('could not report this run'))).toHaveLength(1);
    expect(err).toHaveLength(1);
  });
});

describe('hub sync: new projects', () => {
  let asked: string[];
  const putCount = () => requests.filter((r) => r.method === 'PUT').length;

  beforeEach(async () => {
    asked = [];
    io.ask = async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    };
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    out = [];
  });

  it('asks in a terminal and tracks and uploads on y', async () => {
    io.interactive = true;
    answers = ['y'];
    expect(await run(['sync'], io)).toBe(0);
    expect(asked).toEqual([`New project "alpha — ${KEY}" (1 session). Upload it to the hub? [y/N] `]);
    expect(loadConfig(io.hubDir).tracked).toEqual([KEY]);
    expect(putCount()).toBe(1);
  });

  it('declines on Enter, uploads nothing, and does not ask again', async () => {
    io.interactive = true;
    answers = [''];
    expect(await run(['sync'], io)).toBe(0);
    expect(loadConfig(io.hubDir)).toMatchObject({ tracked: [], declined: [KEY] });
    expect(putCount()).toBe(0);
    expect(await run(['sync'], io)).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('hub track brings a declined project back and untrack declines it', async () => {
    io.interactive = true;
    answers = ['n'];
    await run(['sync'], io);
    await run(['track', 'alpha'], io);
    expect(loadConfig(io.hubDir)).toMatchObject({ tracked: [KEY], declined: [] });
    await run(['untrack', 'alpha'], io);
    expect(loadConfig(io.hubDir)).toMatchObject({ tracked: [], declined: [KEY] });
    await run(['sync'], io);
    expect(asked).toHaveLength(1);
  });

  it('never asks outside a terminal, says so, and uploads nothing from it', async () => {
    expect(await run(['sync'], io)).toBe(0);
    expect(asked).toEqual([]);
    expect(out).toContain('1 new project(s) not uploaded: alpha. Run hub sync in a terminal to choose.');
    expect(putCount()).toBe(0);
    expect(loadConfig(io.hubDir).declined).toEqual([]);
  });

  it('never asks with --dry-run, --project or --session', async () => {
    io.interactive = true;
    await run(['sync', '--dry-run'], io);
    await run(['sync', '--project', 'alpha'], io);
    await run(['sync', '--session', `claude-code:${S1}`], io);
    expect(asked).toEqual([]);
    expect(loadConfig(io.hubDir)).toMatchObject({ tracked: [], declined: [] });
  });

  it('says what it will do with the answers, then shows progress in a terminal', async () => {
    io.interactive = true;
    const shown: string[] = [];
    io.progress = (line) => shown.push(line);
    answers = ['y'];
    expect(await run(['sync'], io)).toBe(0);
    expect(out.slice(0, 2)).toEqual(['Will upload: alpha.', 'Syncing 1 tracked project…']);
    expect(shown).toEqual(['Reading 1/1  alpha', 'Summarizing 1/1  alpha', '']);
    expect(out.at(-1)).toMatch(/^Up to date: 1 uploaded/);
  });

  it('names a declined project and how to add it later', async () => {
    io.interactive = true;
    answers = ['n'];
    await run(['sync'], io);
    expect(out[0]).toBe('Not uploading: alpha. Add it later with: hub track alpha');
  });

  it('shows no progress outside a terminal', async () => {
    const shown: string[] = [];
    io.progress = (line) => shown.push(line);
    await run(['track', 'alpha'], io);
    out = [];
    await run(['sync'], io);
    expect(shown).toEqual([]);
    expect(out.some((l) => l.startsWith('Syncing'))).toBe(false);
  });

  it('does not offer a tracked project', async () => {
    io.interactive = true;
    await run(['track', 'alpha'], io);
    await run(['sync'], io);
    expect(asked).toEqual([]);
  });
});

describe('newProjects', () => {
  const row = (key: string, n = 1) => ({ key, sessions: { 'claude-code': n }, last_activity: '', tracked: false, last_synced: null });
  const cfg = { ...loadConfig(tempDir()), tracked: ['a'], declined: ['b'] };

  it('leaves out tracked, declined, unfiled and empty projects', () => {
    expect(newProjects([row('a'), row('b'), row('unfiled'), row('d', 0), row('e')], cfg).map((r) => r.key)).toEqual(['e']);
  });
});

describe('hub sync: summary and usage', () => {
  it('ends a successful sync with the summary line', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    await run(['track', 'alpha'], io);
    out = [];
    expect(await run(['sync'], io)).toBe(0);
    expect(out.at(-1)).toBe('Up to date: 1 uploaded, 0 unchanged, 1 tracked project(s).');
    out = [];
    await run(['sync'], io);
    expect(out.at(-1)).toBe('Up to date: 0 uploaded, 1 unchanged, 1 tracked project(s).');
  });

  it('ends a failed sync with the error count', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    await run(['track', 'alpha'], io);
    io.fetchImpl = async () => new Response('no', { status: 401 });
    err = [];
    expect(await run(['sync'], io)).toBe(1);
    expect(err.some((l) => l.startsWith('Error: '))).toBe(true);
    expect(err.at(-1)).toBe('Sync finished with 1 error(s).');
  });

  it('lists login, sync and auto before Advanced, and every other command after', async () => {
    await run(['dance'], io);
    const lines = err.join('\n').split(/\r?\n/);
    const at = lines.indexOf('Advanced:');
    expect(at).toBeGreaterThan(0);
    const starts = (part: string[], c: string) => part.some((l) => l.startsWith(`  ${c} `));
    for (const c of ['login', 'sync', 'auto']) expect(starts(lines.slice(0, at), c)).toBe(true);
    for (const c of ['init', 'projects', 'track', 'skip', 'alias', 'assign', 'forget', 'status', 'connect', 'install-commands', 'personal']) {
      expect(starts(lines.slice(0, at), c)).toBe(false);
      expect(starts(lines.slice(at), c)).toBe(true);
    }
  });
});

describe('hub docs', () => {
  beforeEach(() => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), tracked: [KEY] });
  });

  it('adds a folder under the project of the repo it sits in', async () => {
    const folder = tempDir();
    expect(await run(['docs', 'add', folder, '--exclude', 'archive, sessions'], io)).toBe(0);
    const cfg = loadConfig(io.hubDir);
    expect(cfg.docs).toEqual([{ project: KEY, path: folder, label: folder.split(/[/\\]/).pop(), exclude: ['archive', 'sessions'] }]);
  });

  it('refuses a project that is not tracked, and never starts tracking it', async () => {
    saveConfig(io.hubDir, { ...loadConfig(io.hubDir), tracked: [], declined: [KEY] });
    expect(await run(['docs', 'add', tempDir()], io)).toBe(1);
    expect(err.join('\n')).toMatch(/is not tracked.*hub track github\.com\/me\/alpha/s);
    const cfg = loadConfig(io.hubDir);
    expect(cfg).toMatchObject({ tracked: [], declined: [KEY], docs: [] });
  });

  it('refuses a folder inside or around one already added', async () => {
    const outer = tempDir();
    writeJsonl(join(outer, 'tickets', 'keep.jsonl'), []);
    await run(['docs', 'add', outer, '--as', 'kb'], io);
    expect(await run(['docs', 'add', join(outer, 'tickets'), '--as', 'tickets'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/overlaps/);
    err = [];
    await run(['docs', 'remove', 'kb'], io);
    await run(['docs', 'add', join(outer, 'tickets'), '--as', 'tickets'], io);
    expect(await run(['docs', 'add', outer, '--as', 'kb'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/overlaps/);
    expect(loadConfig(io.hubDir).docs.map((f) => f.label)).toEqual(['tickets']);
  });

  it('takes a project by name and a label', async () => {
    const folder = tempDir();
    expect(await run(['docs', 'add', folder, '--project', 'alpha', '--as', 'memory'], io)).toBe(0);
    expect(loadConfig(io.hubDir).docs[0]).toMatchObject({ project: KEY, label: 'memory' });
  });

  it('asks for --project when the folder is not in a git repo', async () => {
    io.git = () => null;
    expect(await run(['docs', 'add', tempDir()], io)).toBe(1);
    expect(err.join('\n')).toMatch(/not inside a git repo.*--project/);
  });

  it('refuses a second folder with the same label in one project', async () => {
    await run(['docs', 'add', tempDir(), '--as', 'kb'], io);
    expect(await run(['docs', 'add', tempDir(), '--as', 'kb'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/already has a folder called "kb"/);
  });

  it('lists and removes folders, leaving uploaded copies alone', async () => {
    const folder = tempDir();
    await run(['docs', 'add', folder, '--as', 'kb'], io);
    out = [];
    expect(await run(['docs'], io)).toBe(0);
    expect(out).toEqual([`kb  ${folder}  -> ${KEY}`]);
    expect(await run(['docs', 'remove', 'kb'], io)).toBe(0);
    expect(loadConfig(io.hubDir).docs).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('lets forget name a document', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    answers = ['yes'];
    expect(await run(['forget', '--session', `doc:${KEY}#kb/INDEX.md`], io)).toBe(0);
    expect(requests.at(-1)).toEqual({ method: 'DELETE', url: `https://hub.example.com/api/sessions/doc/${encodeURIComponent(`${KEY}#kb/INDEX.md`)}` });
  });
});

describe('hub doctor', () => {
  const STATUS = JSON.stringify({ projects: 6, sessions: 253, digests: { pending: 0, ok: 81, failed: 0, refused: 0 }, last_sync: [] });
  const connected = (args: string[] = []) =>
    args[0] === 'auth'
      ? { found: true, output: JSON.stringify({ loggedIn: true }) }
      : { found: true, output: 'claude.ai context-hub: https://hub.example.com/mcp - ✓ Connected\n' };
  const login = () => run(['init', '--url', 'https://hub.example.com', '--token', 'fake-token-QX7'], io);
  const answersWith = (status: number, body = STATUS) => {
    io.fetchImpl = async () => new Response(body, { status });
  };

  it('says all good when everything is connected', async () => {
    await login();
    await run(['track', KEY], io);
    answersWith(200);
    await run(['sync'], io);
    await run(['install-commands', '--dir', join(io.home, '.claude', 'commands')], io);
    answersWith(200);
    io.runClaude = connected;
    out = [];
    expect(await run(['doctor'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/✓ Hub address\s+https:\/\/hub\.example\.com/);
    expect(text).toMatch(/✓ Connection\s+.*6 projects, 253 sessions/);
    expect(text).toMatch(/✓ Tracked projects\s+1/);
    expect(text).toMatch(/✓ Slash commands\s+6 installed/);
    expect(text).toMatch(/✓ Claude Code\s+context-hub connected/);
    expect(text).toContain('All good.');
    expect(text).not.toContain('fake-token-QX7');
  });

  it('fails with the fix when this computer is not connected', async () => {
    io.runClaude = connected;
    expect(await run(['doctor'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Hub address\s+not set\. Run: hub login/);
  });

  it('tells a refused token from an unreachable hub', async () => {
    await login();
    io.runClaude = connected;
    answersWith(401, '{"error":"A valid token is required"}');
    out = [];
    expect(await run(['doctor'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Connection\s+the hub refused this computer's token\. Run: hub login/);
    io.fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND hub.example.com');
    };
    out = [];
    expect(await run(['doctor'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Connection\s+could not reach https:\/\/hub\.example\.com/);
  });

  it('warns about missing or outdated slash commands and an untracked project, without failing', async () => {
    await login();
    answersWith(200);
    io.runClaude = connected;
    const dir = join(io.home, '.claude', 'commands');
    await run(['install-commands', '--dir', dir], io);
    writeFileSync(join(dir, 'hub-sync.md'), 'old text');
    out = [];
    expect(await run(['doctor'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/! Slash commands\s+1 missing or out of date\. Run: hub install-commands/);
    expect(text).toMatch(/! Tracked projects\s+none yet\. Run: hub sync/);
    expect(text).toMatch(/! New projects\s+1 not decided \(alpha\)\. Run: hub sync/);
  });

  it('skips the Claude Code check when Claude Code is not installed', async () => {
    await login();
    answersWith(200);
    io.runClaude = () => ({ found: false, output: '' });
    out = [];
    await run(['doctor'], io);
    expect(out.join('\n')).toMatch(/– Claude Code\s+not installed here, skipped/);
  });

  it('warns when Claude Code is installed but has no context-hub connection', async () => {
    await login();
    answersWith(200);
    io.runClaude = () => ({ found: true, output: 'github: npx github-mcp - ✓ Connected\n' });
    out = [];
    await run(['doctor'], io);
    expect(out.join('\n')).toMatch(/! Claude Code\s+no context-hub connection\. Add the connector to this Claude account/);
  });
});

describe('hub sync: summaries', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const login = () => run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
  const addSessions = (n: number) => {
    for (let i = 1; i <= n; i++) {
      writeJsonl(join(io.home, '.claude', 'projects', 'p', `${uuid(i)}.jsonl`), [
        { type: 'user', sessionId: uuid(i), cwd: '/work/alpha', timestamp: `2026-10-${String(i).padStart(2, '0')}T10:00:00.000Z`, message: { role: 'user', content: `q${i}` } },
      ]);
    }
  };

  beforeEach(async () => {
    await login();
    await run(['track', KEY], io);
    out = [];
  });

  it('prints how many summaries were written', async () => {
    expect(await run(['sync'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/1 summary written\./);
  });

  it('sync --all passes all to runSync', async () => {
    addSessions(22);
    expect(await run(['sync'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Uploaded 20 sessions/);
    expect(out.join('\n')).toMatch(/3 sessions waiting: cap of 20 reached\. Run hub sync --all to catch up/);
    out = [];
    expect(await run(['sync', '--all'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Uploaded 3 sessions/);
    expect(out.join('\n')).not.toMatch(/waiting/);
  });

  it('prints the waiting reason', async () => {
    const fail = new FakeLlm();
    fail.failWith = new UsageLimitError('2026-10-21T14:00:00.000Z');
    io.llm = fail;
    expect(await run(['sync'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/1 session waiting: Claude usage limit reached \(resets \d\d:\d\d\)/);
    expect(out.join('\n')).toMatch(/Uploaded 0 sessions/);
  });

  it('says to install Claude Code when it is missing', async () => {
    io.llm = null;
    await run(['sync'], io);
    expect(out.join('\n')).toMatch(/1 session waiting: Claude Code is not installed/);
  });

  it('says how many pages are left for the next sync', async () => {
    io.fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/status')) return new Response(JSON.stringify({ pages_needed: [KEY], summaries_owed: 0 }), { status: 200 });
      if (url.endsWith('/page-inputs')) return new Response(JSON.stringify({ page: null, digests: [{ session_id: 'x', title: 't', date: null, text: 'g', saved_seq: 1 }], through: 1 }), { status: 200 });
      if (init?.method === 'PUT' && url.endsWith('/page')) return new Response('{}', { status: 409 });
      return new Response('{}', { status: 200 });
    };
    await run(['sync'], io);
    expect(out.join('\n')).toMatch(/1 page left for the next sync/);
  });

  it('says how many projects were checked against git', async () => {
    const llm = new FakeLlm();
    io.llm = llm;
    io.cwd = '/work/alpha';
    io.fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/status')) return new Response(JSON.stringify({ pages_needed: [], summaries_owed: 0 }), { status: 200 });
      if (url.endsWith('/page-inputs')) {
        const page = { summary: 's', body: '## Open items\n\n- x', version: 1, rebuilt_at: '2026-10-09T00:00:00.000Z', dirty: false, digests_through: 1 };
        return new Response(JSON.stringify({ page, digests: [{ session_id: 'x', title: 't', date: null, text: 'g', saved_seq: 1 }], through: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    io.runCommand = (_cmd, _cwd, args) => (args[0] === 'symbolic-ref' ? 'origin/main' : args[0] === 'log' ? 'abc1234\t2026-10-22\tinit' : '');
    await run(['sync'], io);
    expect(out.join('\n')).toMatch(/Checked against git: 1 project\b/);
  });

  it('a dry run says what it would summarize and calls no model', async () => {
    const llm = new FakeLlm();
    io.llm = llm;
    await run(['sync', '--dry-run'], io);
    expect(out.join('\n')).toMatch(/Would summarize 1 session/);
    expect(llm.calls).toEqual([]);
  });
});

describe('hub status', () => {
  it('shows what waits on this computer and what the hub still needs', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    saveState(io.hubDir, { fingerprint: 'x', files: {}, last_waiting: { count: 3, reason: 'Claude usage limit reached (resets 14:00)', at: '2026-10-21T10:00:00.000Z' } });
    io.fetchImpl = async () => new Response(JSON.stringify({ projects: 2, sessions: 9, pages_needed: ['github.com/me/alpha'], summaries_owed: 4 }), { status: 200 });
    out = [];
    expect(await run(['status'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/3 sessions waiting on this computer: Claude usage limit reached \(resets 14:00\)/);
    expect(text).toMatch(/1 project page waiting for an update: github\.com\/me\/alpha/);
    expect(text).toMatch(/4 summaries owed after re-cleaning/);
  });

  it('stays quiet about summaries when nothing waits', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    io.fetchImpl = async () => new Response(JSON.stringify({ projects: 2, sessions: 9, pages_needed: [], summaries_owed: 0 }), { status: 200 });
    out = [];
    await run(['status'], io);
    expect(out.join('\n')).not.toMatch(/waiting on this computer|waiting for an update|owed after re-cleaning/);
  });
});

describe('hub summaries', () => {
  it('shows the model and effort in use', async () => {
    expect(await run(['summaries'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/model: claude-haiku-5-5/);
    expect(out.join('\n')).toMatch(/effort: low/);
  });

  it('hub summaries model saves the model without changing the settings fingerprint', async () => {
    const before = settingsFingerprint(loadConfig(io.hubDir), loadPersonal(io.hubDir));
    expect(await run(['summaries', 'model', 'claude-opus-5-5'], io)).toBe(0);
    expect(loadConfig(io.hubDir).summaries?.model).toBe('claude-opus-5-5');
    expect(settingsFingerprint(loadConfig(io.hubDir), loadPersonal(io.hubDir))).toBe(before);
    out = [];
    await run(['summaries'], io);
    expect(out.join('\n')).toMatch(/model: claude-opus-5-5/);
  });

  it('hub summaries effort saves a valid level and refuses another', async () => {
    expect(await run(['summaries', 'effort', 'high'], io)).toBe(0);
    expect(loadConfig(io.hubDir).summaries?.effort).toBe('high');
    expect(await run(['summaries', 'effort', 'extreme'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/low, medium, high, xhigh, max/);
    expect(loadConfig(io.hubDir).summaries?.effort).toBe('high');
  });

  it('is in the help text', async () => {
    await run([], io);
    expect(err.join('\n')).toMatch(/summaries \[model <id> \| effort <level>\]/);
    expect(err.join('\n')).toMatch(/sync \[--project P\] \[--session S\] \[--dry-run\] \[--all\]/);
  });
});

describe('hub doctor: summaries', () => {
  const login = () => run(['init', '--url', 'https://hub.example.com', '--token', 'fake-token-QX7'], io);
  const statusWith = (extra: Record<string, unknown> = {}) => {
    io.fetchImpl = async () => new Response(JSON.stringify({ projects: 1, sessions: 1, ...extra }), { status: 200 });
  };
  const signedIn = (args: string[]) => (args[0] === 'auth' ? { found: true, output: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }) } : { found: true, output: '' });

  it('doctor reports Claude Code signed in', async () => {
    await login();
    statusWith();
    io.runClaude = signedIn;
    out = [];
    await run(['doctor'], io);
    expect(out.join('\n')).toMatch(/✓ Summaries\s+Claude Code signed in, model claude-haiku-5-5, effort low/);
  });

  it('asks Claude Code for its sign-in with the auth status command', async () => {
    await login();
    statusWith();
    const asked: string[][] = [];
    io.runClaude = (args) => {
      asked.push(args);
      return signedIn(args);
    };
    await run(['doctor'], io);
    expect(asked).toContainEqual(['auth', 'status', '--json']);
  });

  it('warns when Claude Code is not signed in', async () => {
    await login();
    statusWith();
    io.runClaude = (args) => (args[0] === 'auth' ? { found: true, output: JSON.stringify({ loggedIn: false }) } : { found: true, output: '' });
    out = [];
    expect(await run(['doctor'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Summaries\s+Claude Code is not signed in, or its login expired\. Run: claude auth login/);
  });

  it('warns, without failing, when Claude Code is missing but the hub has a key', async () => {
    await login();
    statusWith({ server_summaries: true });
    io.runClaude = () => ({ found: false, output: '' });
    out = [];
    expect(await run(['doctor'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/! Summaries\s+Claude Code is not installed; the hub will summarize this computer's sessions/);
  });

  it('fails when Claude Code is missing and the hub has no key', async () => {
    await login();
    statusWith({ server_summaries: false });
    io.runClaude = () => ({ found: false, output: '' });
    out = [];
    expect(await run(['doctor'], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Summaries\s+Claude Code is not installed, so sessions wait here\. Install it, then run: claude/);
  });

  it('shows the sessions waiting from the last sync', async () => {
    await login();
    statusWith();
    io.runClaude = signedIn;
    saveState(io.hubDir, { fingerprint: 'x', files: {}, last_waiting: { count: 2, reason: 'cap of 20 reached. Run hub sync --all to catch up', at: '2026-10-21T10:00:00.000Z' } });
    out = [];
    await run(['doctor'], io);
    expect(out.join('\n')).toMatch(/! Waiting summaries\s+2 sessions: cap of 20 reached/);
  });
});

describe('hub resummarize', () => {
  const login = () => run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
  const owed = {
    source: 'claude-code',
    id: 'old1',
    content_hash: 'a'.repeat(64),
    last_activity_at: '2026-10-01T10:00:00.000Z',
    status: 'ok',
    model: 'claude-haiku-5-5',
    written_by: null,
    summary_to_follow: false,
  };

  beforeEach(async () => {
    await login();
    await run(['track', KEY], io);
    out = [];
    io.fetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url });
      if (url.endsWith('/digests')) return new Response(JSON.stringify({ sessions: [owed] }), { status: 200 });
      if (method === 'GET' && url.includes('/api/sessions/')) {
        return new Response(
          JSON.stringify({ session: { source: 'claude-code', source_session_id: 'old1', project_key: KEY, parent: null, title: 'Old', content_hash: 'a'.repeat(64), messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hi' }] } }),
          { status: 200 },
        );
      }
      if (url.endsWith('/page-inputs')) return new Response(JSON.stringify({ page: null, digests: [{ session_id: 'x', title: 't', date: null, text: 'g', saved_seq: 1 }], through: 1 }), { status: 200 });
      if (method === 'PUT' && url.endsWith('/digest')) return new Response(null, { status: 204 });
      return new Response('{"version":1}', { status: 200 });
    };
  });

  it('prints how many summaries it rewrote and rebuilt pages', async () => {
    expect(await run(['resummarize'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/Rewrote 1 summary\./);
    expect(text).toMatch(/Rebuilt 1 project page\./);
    expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('/api/sessions/claude-code/old1/digest'))).toBe(true);
  });

  it('takes a project, --all and --model-not', async () => {
    expect(await run(['resummarize', 'alpha', '--all', '--model-not', 'claude-sonnet-5-5'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Rewrote 1 summary\./);
  });

  it('fails with the install message when Claude Code is missing', async () => {
    io.llm = null;
    expect(await run(['resummarize'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Claude Code is not installed, so sessions wait here/);
  });

  it('prints the waiting reason', async () => {
    const limited = new FakeLlm();
    limited.failWith = new UsageLimitError(null);
    io.llm = limited;
    expect(await run(['resummarize'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/1 session waiting: Claude usage limit reached/);
  });

  it('is in the help text', async () => {
    await run([], io);
    expect(err.join('\n')).toMatch(/resummarize \[<project>\] \[--all\] \[--model-not ID\]/);
  });
});
