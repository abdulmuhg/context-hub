import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hubDir,
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveConfig,
  savePersonal,
  saveState,
  saveToken,
  settingsFingerprint,
} from '../src/config.js';
import { tempDir, writeRaw } from './helpers.js';

describe('hubDir', () => {
  it('defaults to ~/.context-hub', () => {
    expect(hubDir({})).toBe(join(homedir(), '.context-hub'));
  });
  it('honours CONTEXT_HUB_HOME', () => {
    expect(hubDir({ CONTEXT_HUB_HOME: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('config', () => {
  it('returns defaults when nothing is saved: nothing tracked, card numbers masked', () => {
    expect(loadConfig(tempDir())).toEqual({
      server_url: '',
      tracked: [],
      skipped: [],
      declined: [],
      aliases: {},
      assignments: {},
      personal: { card: 'partial', list: 'warn' },
    });
  });

  it('folds SSH host aliases in saved project keys', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), JSON.stringify({ tracked: ['github.com-work/acme/app', 'github.com/acme/app', 'local:x'], declined: ['github.com_me/a/b'] }));
    expect(loadConfig(dir)).toMatchObject({
      tracked: ['github.com/acme/app', 'local:x'],
      declined: ['github.com/a/b'],
    });
  });

  it('loads an older config file without declined as an empty list', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), JSON.stringify({ server_url: 'https://h', tracked: ['a'] }));
    expect(loadConfig(dir).declined).toEqual([]);
  });

  it('round-trips and creates the folder', () => {
    const dir = join(tempDir(), 'nested', 'hub');
    const cfg = { ...loadConfig(dir), server_url: 'https://hub.example.com', tracked: ['local:demo'] };
    saveConfig(dir, cfg);
    expect(loadConfig(dir)).toEqual(cfg);
  });

  it('fills in fields missing from an older file', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), JSON.stringify({ server_url: 'https://h', tracked: ['a'] }));
    expect(loadConfig(dir)).toMatchObject({ tracked: ['a'], skipped: [], personal: { card: 'partial', list: 'warn' } });
  });

  it('fails with a clear message when the file is not valid JSON', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), '{oops');
    expect(() => loadConfig(dir)).toThrow(/config\.json is not valid JSON/);
  });
});

describe('state, personal list and token', () => {
  it('state defaults to empty and round-trips', () => {
    const dir = tempDir();
    expect(loadState(dir)).toEqual({ fingerprint: '', files: {} });
    const state = {
      fingerprint: 'abc',
      files: { '/a.jsonl': { size: 1, mtimeMs: 2, project_key: 'local:a', hash: 'h', synced_at: '2026-10-01T00:00:00Z' } },
    };
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  it('personal list defaults to empty and round-trips', () => {
    const dir = tempDir();
    expect(loadPersonal(dir)).toEqual([]);
    savePersonal(dir, [{ label: 'phone', value: '0812', level: 'full' }]);
    expect(loadPersonal(dir)).toEqual([{ label: 'phone', value: '0812', level: 'full' }]);
    expect(existsSync(join(dir, 'personal.json'))).toBe(true);
  });

  it('token is stored trimmed in its own file and is null when missing', () => {
    const dir = tempDir();
    expect(loadToken(dir)).toBeNull();
    saveToken(dir, '  tok-123 \n');
    expect(loadToken(dir)).toBe('tok-123');
    expect(readFileSync(join(dir, 'credentials'), 'utf8')).toBe('tok-123\n');
  });
});

describe('settingsFingerprint', () => {
  const dir = tempDir();
  const base = loadConfig(dir);
  const fp = (cfg = base, entries: Parameters<typeof settingsFingerprint>[1] = []) => settingsFingerprint(cfg, entries);

  it('does not change when a project is declined', () => {
    expect(fp({ ...base, declined: ['local:x'] })).toBe(fp());
  });

  it('is stable for the same settings', () => {
    expect(fp()).toBe(fp());
  });

  it.each([
    ['an alias', { ...base, aliases: { a: 'b' } }],
    ['an assignment', { ...base, assignments: { 'codex:s': 'local:x' } }],
    ['a personal level', { ...base, personal: { card: 'full' as const, list: 'warn' as const } }],
  ])('changes with %s', (_name, cfg) => {
    expect(fp(cfg)).not.toBe(fp());
  });

  it('changes with the personal list', () => {
    expect(fp(base, [{ label: 'phone', value: '0812' }])).not.toBe(fp());
  });

  it('does not change with the server URL, tracked or skipped lists', () => {
    expect(fp({ ...base, server_url: 'https://x', tracked: ['a'], skipped: ['b'] })).toBe(fp());
  });
});

describe('settingsFingerprint: collector revision', () => {
  it('changes when the collector revision changes, so improved parsing reaches sessions already uploaded', async () => {
    const { COLLECTOR_REVISION } = await import('../src/config.js');
    const cfg = loadConfig(tempDir());
    expect(Number.isInteger(COLLECTOR_REVISION)).toBe(true);
    expect(settingsFingerprint(cfg, [])).toBe(settingsFingerprint(cfg, [], COLLECTOR_REVISION));
    expect(settingsFingerprint(cfg, [], COLLECTOR_REVISION + 1)).not.toBe(settingsFingerprint(cfg, []));
  });
});
