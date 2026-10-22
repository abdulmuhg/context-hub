import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { autoOff, autoOn, autoStatus, hookCommand, isOurHook, repointHook, runAutoChild, startLockHeartbeat, takeLock } from '../src/auto.js';
import { run, type Io } from '../src/cli.js';
import { loadConfig, saveConfig, saveToken } from '../src/config.js';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
import { tempDir, writeJsonl, writeRaw } from './helpers.js';

const CMD = hookCommand('/usr/bin/node', '/home/me/.local/hub/bin.js');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('hookCommand', () => {
  it('quotes both paths and ends with sync --auto', () => {
    expect(hookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a b\\hub\\bin.js')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\hub\\bin.js" sync --auto',
    );
  });
});

describe('autoOn / autoOff', () => {
  let path: string;
  beforeEach(() => {
    path = join(tempDir(), '.claude', 'settings.json');
  });

  it('creates a missing file with only the hook, in the documented shape', () => {
    expect(autoOn(path, CMD)).toEqual({ changed: true });
    expect(read(path)).toEqual({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: CMD, timeout: 10 }] }] } });
    expect(existsSync(`${path}.hub-backup`)).toBe(false);
  });

  it('keeps other keys and other SessionEnd hooks, adds ours once, and writes a backup', () => {
    const other = { matcher: 'clear', hooks: [{ type: 'command', command: 'echo bye' }] };
    const original = { theme: 'dark', hooks: { PreToolUse: [{ hooks: [] }], SessionEnd: [other] } };
    writeRaw(path, JSON.stringify(original, null, 4));
    const before = readFileSync(path, 'utf8');
    expect(autoOn(path, CMD)).toEqual({ changed: true });
    expect(autoOn(path, CMD)).toEqual({ changed: false });
    const after = read(path);
    expect(after.theme).toBe('dark');
    expect(after.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(after.hooks.SessionEnd[0]).toEqual(other);
    expect(readFileSync(`${path}.hub-backup`, 'utf8')).toBe(before);
  });

  it('refuses invalid JSON and leaves the file byte-identical', () => {
    writeRaw(path, '{ "theme": "dark", ');
    const before = readFileSync(path, 'utf8');
    expect(() => autoOn(path, CMD)).toThrow(
      `~/.claude/settings.json is not valid JSON, so it was not changed. Fix it or add the hook by hand: ${CMD}`,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(`${path}.hub-backup`)).toBe(false);
  });

  it('off removes only our entry and leaves everything else', () => {
    const other = { hooks: [{ type: 'command', command: 'echo bye' }] };
    const theirs = { hooks: [{ type: 'command', command: 'echo sync --auto' }] };
    writeRaw(path, JSON.stringify({ theme: 'dark', hooks: { SessionEnd: [other, theirs] } }));
    autoOn(path, CMD);
    expect(autoOff(path)).toEqual({ removed: 1 });
    expect(read(path)).toEqual({ theme: 'dark', hooks: { SessionEnd: [other, theirs] } });
    expect(autoOff(path)).toEqual({ removed: 0 });
  });

  it('off removes our hook from an entry shared with another hook, and empties cleanly', () => {
    const mixed = { hooks: [{ type: 'command', command: 'echo bye' }, { type: 'command', command: CMD }] };
    writeRaw(path, JSON.stringify({ hooks: { SessionEnd: [mixed] } }));
    expect(autoOff(path)).toEqual({ removed: 1 });
    expect(read(path)).toEqual({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } });
    autoOn(path, CMD);
    writeRaw(path, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: CMD }] }] } }));
    autoOff(path);
    expect(read(path)).toEqual({});
  });

  const OLD = '"C:\node.exe" "C:\src\context-hub\apps\collector\dist\bin.js" sync --auto';

  it('autoOn over a hook pointing at an old clone repoints it instead of adding a second', () => {
    writeRaw(path, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: OLD, timeout: 10 }] }] } }));
    expect(autoOn(path, CMD)).toEqual({ changed: true });
    const end = read(path).hooks.SessionEnd;
    expect(end).toHaveLength(1);
    expect(end[0].hooks).toEqual([{ type: 'command', command: CMD, timeout: 10 }]);
    expect(autoOn(path, CMD)).toEqual({ changed: false });
  });

  it('repointHook leaves settings untouched when there is no hook of ours', () => {
    writeRaw(path, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo sync --auto' }] }] } }, null, 4));
    const before = readFileSync(path, 'utf8');
    expect(repointHook(path, CMD)).toEqual({ repointed: 0 });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(`${path}.hub-backup`)).toBe(false);
  });

  it('repointHook collapses two of our hooks into one', () => {
    writeRaw(
      path,
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: OLD }] }, { hooks: [{ type: 'command', command: CMD }, { type: 'command', command: 'echo bye' }] }] } }),
    );
    expect(repointHook(path, CMD)).toEqual({ repointed: 2 });
    const end = read(path).hooks.SessionEnd;
    const commands = end.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(commands.filter((c: string) => isOurHook(c))).toEqual([CMD]);
    expect(commands).toContain('echo bye');
  });

  it('recognises a hook whose paths contain spaces', () => {
    expect(isOurHook('"C:\Program Files\nodejs\node.exe" "C:\Users\John Smith\AppData\Local\context-hub\hub.mjs" sync --auto')).toBe(true);
  });

  it("other people's hooks are never touched", () => {
    const theirs = { hooks: [{ type: 'command', command: 'echo sync --auto' }] };
    writeRaw(path, JSON.stringify({ hooks: { SessionEnd: [theirs] } }));
    expect(autoOff(path)).toEqual({ removed: 0 });
    expect(repointHook(path, CMD)).toEqual({ repointed: 0 });
    expect(read(path)).toEqual({ hooks: { SessionEnd: [theirs] } });
  });

  it('off does nothing when the file is missing, and refuses invalid JSON', () => {
    expect(autoOff(path)).toEqual({ removed: 0 });
    writeRaw(path, 'nope');
    expect(() => autoOff(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('nope');
  });
});

describe('autoStatus', () => {
  it('reports on or off and the last log line', () => {
    const dir = tempDir();
    const settings = join(dir, 'settings.json');
    const log = join(dir, 'auto.log');
    expect(autoStatus(settings, log)).toEqual({ on: false, lastLine: null });
    autoOn(settings, CMD);
    writeRaw(log, 'first\nsecond\n');
    expect(autoStatus(settings, log)).toEqual({ on: true, lastLine: 'second' });
    autoOff(settings);
    expect(autoStatus(settings, log).on).toBe(false);
  });
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-21T10:00:00.000Z');

describe('runAutoChild', () => {
  let home: string;
  let hubDir: string;
  let puts: string[];
  let opts: Parameters<typeof runAutoChild>[0];

  beforeEach(() => {
    home = tempDir();
    hubDir = tempDir();
    puts = [];
    for (const [id, cwd] of [[S1, '/work/alpha'], [S2, '/work/beta']]) {
      writeJsonl(join(home, '.claude', 'projects', 'p', `${id}.jsonl`), [
        { type: 'user', sessionId: id, cwd, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      ]);
    }
    saveConfig(hubDir, { ...loadConfig(hubDir), server_url: 'https://hub.example.com', tracked: ['github.com/me/alpha'] });
    saveToken(hubDir, 'tok');
    opts = {
      home,
      hubDir,
      exists: () => true,
      git: (cwd, args) => {
        const name = cwd.includes('beta') ? 'beta' : 'alpha';
        return args[0] === 'remote' ? `git@github.com:me/${name}.git` : `/work/${name}`;
      },
      fetchImpl: async (input, init) => {
        if (init?.method === 'PUT') puts.push(String(input));
        return new Response('{}', { status: 200 });
      },
      now: () => T0,
      llm: new FakeLlm(),
    };
  });

  it('uploads tracked projects only, never an untracked one, and never tracks anything', async () => {
    await runAutoChild(opts);
    expect(puts).toEqual([`https://hub.example.com/api/sessions/claude-code/${S1}`]);
    expect(loadConfig(hubDir).tracked).toEqual(['github.com/me/alpha']);
    expect(loadConfig(hubDir).declined).toEqual([]);
    expect(readFileSync(join(hubDir, 'auto.log'), 'utf8')).toBe(`${T0.toISOString()} ok 1 uploaded, 0 unchanged, 1 summarized, 0 waiting\n`);
    expect(existsSync(join(hubDir, 'auto.lock'))).toBe(false);
  });

  it('tells the hub the run was started by the hook', async () => {
    const triggers: (string | null)[] = [];
    await runAutoChild({
      ...opts,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'PUT' || init?.method === 'POST') triggers.push(new Headers(init.headers).get('x-hub-trigger'));
        return new Response('{}', { status: 200 });
      },
    });
    expect(triggers.length).toBeGreaterThan(0);
    expect(new Set(triggers)).toEqual(new Set(['auto']));
  });

  it('exits without syncing while a fresh lock exists', async () => {
    writeRaw(join(hubDir, 'auto.lock'), new Date(T0.getTime() - 2 * 60 * 1000).toISOString());
    await runAutoChild(opts);
    expect(puts).toEqual([]);
    expect(existsSync(join(hubDir, 'auto.log'))).toBe(false);
    expect(existsSync(join(hubDir, 'auto.lock'))).toBe(true);
  });

  it('takes over a stale lock, logs one line and keeps only the last 200', async () => {
    writeRaw(join(hubDir, 'auto.lock'), new Date(T0.getTime() - 11 * 60 * 1000).toISOString());
    writeRaw(join(hubDir, 'auto.log'), Array.from({ length: 250 }, (_, i) => `old ${i}`).join('\n') + '\n');
    await runAutoChild(opts);
    expect(puts).toHaveLength(1);
    const lines = readFileSync(join(hubDir, 'auto.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('old 51');
    expect(lines.at(-1)).toBe(`${T0.toISOString()} ok 1 uploaded, 0 unchanged, 1 summarized, 0 waiting`);
    expect(existsSync(join(hubDir, 'auto.lock'))).toBe(false);
  });

  it('turns a failing server into one error line and does not throw', async () => {
    opts.fetchImpl = async () => new Response('no', { status: 401 });
    await expect(runAutoChild(opts)).resolves.toBeUndefined();
    const lines = readFileSync(join(hubDir, 'auto.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^2026-10-21T10:00:00.000Z error 0 uploaded, 0 unchanged, 0 summarized, 0 waiting, 1 errors: .*401/);
  });

  it('does not throw when the hub folder cannot be used', async () => {
    const file = join(tempDir(), 'afile');
    writeFileSync(file, 'x');
    await expect(runAutoChild({ ...opts, hubDir: join(file, 'sub') })).resolves.toBeUndefined();
  });
});

describe('hub sync --auto', () => {
  let io: Io;
  let calls: { cmd: string; args: string[]; options: Record<string, unknown> }[];
  let unrefs: number;

  beforeEach(() => {
    calls = [];
    unrefs = 0;
    io = {
      home: tempDir(),
      hubDir: tempDir(),
      out: () => {},
      err: () => {},
      ask: async () => '',
      execPath: '/usr/bin/node',
      bundlePath: '/hub/bin.js',
      spawn: ((cmd: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ cmd, args, options });
        return { unref: () => unrefs++, on: () => {} };
      }) as unknown as Io['spawn'],
    };
  });

  it('spawns a detached child with ignored stdio and returns 0 at once', async () => {
    expect(await run(['sync', '--auto'], io)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: '/usr/bin/node', args: ['/hub/bin.js', 'sync', '--auto-child'] });
    expect(calls[0]!.options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(unrefs).toBe(1);
  });

  it('does no sync itself and asks nothing', async () => {
    io.interactive = true;
    io.ask = async () => {
      throw new Error('must not ask');
    };
    expect(await run(['sync', '--auto'], io)).toBe(0);
    expect(existsSync(join(io.hubDir, 'config.json'))).toBe(false);
  });

  it('--auto-child runs the sync quietly and logs a line', async () => {
    const out: string[] = [];
    io.out = (l) => out.push(l);
    io.err = (l) => out.push(l);
    expect(await run(['sync', '--auto-child'], io)).toBe(0);
    expect(out).toEqual([]);
    expect(readFileSync(join(io.hubDir, 'auto.log'), 'utf8')).toMatch(/ error 0 uploaded, 0 unchanged, 0 summarized, 0 waiting, 1 errors: No server address/);
  });

  it.skipIf(process.platform === 'win32')('returns in under a second against an unreachable server with a real spawn', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const stub = join(dir, 'bin.js'); // stands in for the hub script: slow, like a sync that waits on a dead server
    writeFileSync(stub, 'setTimeout(() => {}, 3000);\n');
    const real: Io = { ...io, spawn: undefined, bundlePath: stub, execPath: process.execPath };
    const started = Date.now();
    expect(await run(['sync', '--auto'], real)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('auto on / off / status go through the settings file under the home folder', async () => {
    const out: string[] = [];
    io.out = (l) => out.push(l);
    expect(await run(['auto', 'on'], io)).toBe(0);
    const settings = join(io.home, '.claude', 'settings.json');
    expect(read(settings).hooks.SessionEnd[0].hooks[0].command).toBe('"/usr/bin/node" "/hub/bin.js" sync --auto');
    out.length = 0;
    await run(['auto', 'status'], io);
    expect(out[0]).toBe('Automatic sync is on.');
    await run(['auto', 'off'], io);
    expect(read(settings)).toEqual({});
    expect(await run(['auto', 'wat'], io)).toBe(1);
  });
});


describe('the auto-sync lock while summaries are written', () => {
  const lockPath = () => join(tempDir(), 'auto.lock');

  it('a heartbeat keeps the lock fresh past 10 minutes', async () => {
    const path = lockPath();
    let clock = T0;
    expect(takeLock(path, clock)).toBe(true);
    const stop = startLockHeartbeat(path, () => clock, 5);
    clock = new Date(T0.getTime() + 11 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(takeLock(path, clock)).toBe(false);
    stop();
  });

  it('without a heartbeat the lock is taken over after 10 minutes', () => {
    const path = lockPath();
    expect(takeLock(path, T0)).toBe(true);
    expect(takeLock(path, new Date(T0.getTime() + 11 * 60 * 1000))).toBe(true);
  });

  it('the heartbeat never brings back a lock that was removed', async () => {
    const path = lockPath();
    takeLock(path, T0);
    const stop = startLockHeartbeat(path, () => T0, 5);
    unlinkSync(path);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(existsSync(path)).toBe(false);
  });

  it('the lock is removed after the run, and the heartbeat stops', async () => {
    const hubDir = tempDir();
    saveConfig(hubDir, { ...loadConfig(hubDir), server_url: 'https://hub.example.com', tracked: [] });
    saveToken(hubDir, 'tok');
    await runAutoChild({ home: tempDir(), hubDir, exists: () => true, now: () => T0, llm: new FakeLlm(), fetchImpl: async () => new Response('{}', { status: 200 }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(join(hubDir, 'auto.lock'))).toBe(false);
  });
});
