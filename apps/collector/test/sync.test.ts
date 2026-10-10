import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadState, saveConfig, savePersonal, saveToken } from '../src/config.js';
import { listProjects, runSync, type SyncOptions } from '../src/sync.js';
import { tempDir, writeJsonl } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '44444444-4444-4444-8444-444444444444';
const KEY_A = 'github.com/me/alpha';

const cc = (sid: string, cwd: string, text: string) => ({
  type: 'user',
  sessionId: sid,
  cwd,
  timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: 'user', content: text },
});

interface Sent {
  method: string;
  url: string;
  auth: string | null;
  body: any;
}

let home: string;
let hub: string;
let sent: Sent[];
let failAfter: number;

/** A stand-in for the server: records requests, can start failing. */
const fakeFetch: typeof fetch = async (input, init) => {
  if (sent.length >= failAfter) return new Response('boom', { status: 500 });
  const headers = new Headers(init?.headers);
  const raw = init?.body as Uint8Array | undefined;
  sent.push({
    method: init?.method ?? 'GET',
    url: String(input),
    auth: headers.get('authorization'),
    body: raw ? JSON.parse(gunzipSync(raw).toString('utf8')) : null,
  });
  return new Response('{"ok":true}', { status: 200 });
};

const opts = (over: Partial<SyncOptions> = {}): SyncOptions => ({
  home,
  hubDir: hub,
  fetchImpl: fakeFetch,
  exists: () => true,
  git: (cwd, args) => {
    if (args[0] === 'remote') return cwd.includes('alpha') ? 'git@github.com:me/alpha.git' : null;
    return cwd.includes('alpha') ? '/work/alpha' : null;
  },
  now: () => new Date('2026-10-10T00:00:00Z'),
  ...over,
});

const proj = () => join(home, '.claude', 'projects', 'p');
const track = (...keys: string[]) => saveConfig(hub, { ...loadConfig(hub), tracked: keys });

beforeEach(() => {
  home = tempDir();
  hub = tempDir();
  sent = [];
  failAfter = Infinity;
  saveConfig(hub, { ...loadConfig(hub), server_url: 'https://hub.example.com/' });
  saveToken(hub, 'tok-1');
  writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question')]);
  writeJsonl(join(proj(), `${S2}.jsonl`), [cc(S2, '/tmp/beta', 'beta question')]);
});

describe('runSync: selection', () => {
  it('uploads nothing when nothing is tracked', async () => {
    const report = await runSync(opts());
    expect(report.uploaded).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('uploads only sessions of tracked projects', async () => {
    track(KEY_A);
    const report = await runSync(opts());
    expect(report.uploaded).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: `https://hub.example.com/api/sessions/claude-code/${S1}`,
      auth: 'Bearer tok-1',
    });
    expect(sent[0].body).toMatchObject({ project_key: KEY_A, source_session_id: S1 });
    expect(sent[0].body.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops a skipped session', async () => {
    track(KEY_A);
    saveConfig(hub, { ...loadConfig(hub), skipped: [`claude-code:${S1}`] });
    expect((await runSync(opts())).uploaded).toEqual([]);
  });

  it('--project limits the sync and accepts a short name', async () => {
    track(KEY_A, 'local:beta');
    const report = await runSync(opts({ project: 'beta' }));
    expect(report.uploaded.map((u) => u.project)).toEqual(['local:beta']);
  });

  it('--session uploads one session even when its project is not tracked', async () => {
    const report = await runSync(opts({ session: S2 }));
    expect(report.uploaded).toEqual([{ project: 'local:beta', session: `claude-code:${S2}` }]);
  });

  it('a subagent follows its parent: same project, uploaded with it, parent set', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), S1, 'subagents', 'agent-x.jsonl'), [cc(S1, '/somewhere/else', 'sub task')]);
    await runSync(opts());
    const sub = sent.find((s) => s.body.parent === S1)!;
    expect(sub.body).toMatchObject({ project_key: KEY_A, source_session_id: `${S1}/agent-x` });
    expect(sub.url).toBe(`https://hub.example.com/api/sessions/claude-code/${encodeURIComponent(`${S1}/agent-x`)}`);
  });
});

describe('runSync: change detection', () => {
  it('does not upload an unchanged session twice', async () => {
    track(KEY_A);
    await runSync(opts());
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('uploads again when the file grows', async () => {
    track(KEY_A);
    await runSync(opts());
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question'), cc(S1, '/work/alpha', 'more')]);
    const second = await runSync(opts());
    expect(second.uploaded).toHaveLength(1);
    expect(sent[1].body.messages).toHaveLength(2);
  });

  it('counts a touched file with the same content as unchanged', async () => {
    track(KEY_A);
    await runSync(opts());
    const later = new Date('2026-10-09T00:00:00Z');
    utimesSync(join(proj(), `${S1}.jsonl`), later, later);
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([]);
    expect(second.unchanged).toBe(1);
  });

  // Review Focus 4
  it('uploads again under the new key when an alias changes the project', async () => {
    track(KEY_A, 'local:renamed');
    await runSync(opts());
    saveConfig(hub, { ...loadConfig(hub), aliases: { [KEY_A]: 'local:renamed' } });
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([{ project: 'local:renamed', session: `claude-code:${S1}` }]);
    expect(sent[1].body.project_key).toBe('local:renamed');
  });

  it('uploads again masked when a personal level is raised', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'my card 4242424242424242')]);
    const first = await runSync(opts());
    expect(first.personal).toEqual([{ session: `claude-code:${S1}`, type: 'card', count: 1 }]);
    expect(sent[0].body.messages[0].text).toContain('4242424242424242');

    saveConfig(hub, { ...loadConfig(hub), personal: { card: 'full', list: 'warn' } });
    await runSync(opts());
    expect(sent[1].body.messages[0].text).toBe('my card [REDACTED:card]');
  });
});

describe('runSync: safety', () => {
  it('strips secrets before upload and reports the count, never the value', async () => {
    track(KEY_A);
    const secret = 'gh' + 'p_' + 'a'.repeat(36);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', `token ${secret}`)]);
    const report = await runSync(opts());
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(report.secrets).toEqual({ github: 1 });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('never uploads the personal list itself, and the report holds no listed value', async () => {
    track(KEY_A);
    savePersonal(hub, [{ label: 'phone', value: '081234567890', level: 'full' }]);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'call 0812-3456-7890')]);
    const report = await runSync(opts());
    expect(JSON.stringify(sent)).not.toMatch(/0812[\s-]?3456[\s-]?7890/);
    expect(JSON.stringify(report)).not.toContain('081234567890');
    expect(report.personal).toEqual([{ session: `claude-code:${S1}`, type: 'phone', count: 1 }]);
  });

  it('a dry run sends nothing and writes no state', async () => {
    track(KEY_A);
    const report = await runSync(opts({ dryRun: true }));
    expect(report.wouldUpload).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(report.uploaded).toEqual([]);
    expect(sent).toEqual([]);
    expect(existsSync(join(hub, 'state.json'))).toBe(false);
  });

  // Review Focus 5
  it('keeps confirmed sessions synced and the rest pending when the server fails midway', async () => {
    track(KEY_A, 'local:beta');
    failAfter = 1;
    const first = await runSync(opts());
    expect(first.uploaded).toHaveLength(1);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toMatch(/500/);

    failAfter = Infinity;
    const second = await runSync(opts());
    expect(second.uploaded).toHaveLength(1);
    expect(second.uploaded[0].session).not.toBe(first.uploaded[0].session);
    expect(second.unchanged).toBe(1);
  });

  it('reports a missing token or server URL instead of trying to upload', async () => {
    track(KEY_A);
    saveConfig(hub, { ...loadConfig(hub), server_url: '' });
    const report = await runSync(opts());
    expect(report.errors[0]).toMatch(/hub init/);
    expect(sent).toEqual([]);
  });

  it('one failing adapter does not stop the others', async () => {
    track(KEY_A);
    const { ALL_ADAPTERS } = await import('../src/adapters/index.js');
    const broken = { source: 'codex' as const, discover: () => { throw new Error('disk on fire'); }, read: ALL_ADAPTERS[1].read };
    const report = await runSync(opts({ adapters: [broken, ALL_ADAPTERS[0]] }));
    expect(report.errors).toEqual(['codex: disk on fire']);
    expect(report.uploaded).toHaveLength(1);
  });

  it('passes adapter warnings through to the report', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'q'), { type: 'brand-new' }]);
    const report = await runSync(opts());
    expect(report.warnings).toEqual([{ session: `claude-code:${S1}`, bad_lines: 0, unknown_records: 1, dropped_blocks: 0 }]);
  });
});

describe('listProjects', () => {
  it('lists every project with counts, tracked flag and last sync', async () => {
    track(KEY_A);
    await runSync(opts());
    const rows = listProjects(opts()).sort((a, b) => a.key.localeCompare(b.key));
    expect(rows.map((r) => ({ key: r.key, sessions: r.sessions, tracked: r.tracked, last_synced: r.last_synced }))).toEqual([
      { key: KEY_A, sessions: { 'claude-code': 1 }, tracked: true, last_synced: '2026-10-10T00:00:00.000Z' },
      { key: 'local:beta', sessions: { 'claude-code': 1 }, tracked: false, last_synced: null },
    ]);
    expect(loadState(hub).files).not.toEqual({});
  });
});

describe('runSync: scoped syncs do not advance sync state', () => {
  const withCards = (id: string, cwd: string) => [cc(id, cwd, 'my card 4242424242424242')];

  it('keeps the fingerprint and re-masks every project on the next full sync', async () => {
    track(KEY_A, 'local:beta');
    writeJsonl(join(proj(), `${S1}.jsonl`), withCards(S1, '/work/alpha'));
    writeJsonl(join(proj(), `${S2}.jsonl`), withCards(S2, '/tmp/beta'));
    await runSync(opts());
    expect(sent).toHaveLength(2);
    const before = loadState(hub).fingerprint;

    saveConfig(hub, { ...loadConfig(hub), personal: { card: 'full', list: 'warn' } });
    const scoped = await runSync(opts({ project: 'alpha' }));
    expect(scoped.errors).toEqual([]);
    expect(scoped.uploaded.map((u) => u.project)).toEqual([KEY_A]);
    expect(loadState(hub).fingerprint).toBe(before);

    const full = await runSync(opts());
    expect(full.uploaded).toEqual([{ project: 'local:beta', session: `claude-code:${S2}` }]);
    expect(sent[sent.length - 1].body.messages[0].text).toBe('my card [REDACTED:card]');
    expect(loadState(hub).fingerprint).not.toBe(before);
  });

  it('a scoped sync leaves another project\'s changed file pending', async () => {
    track(KEY_A, 'local:beta');
    await runSync(opts());
    expect(sent).toHaveLength(2);

    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question'), cc(S1, '/work/alpha', 'appended')]);
    const scoped = await runSync(opts({ project: 'beta' }));
    expect(scoped.uploaded).toEqual([]);
    expect(sent).toHaveLength(2);

    const full = await runSync(opts());
    expect(full.uploaded).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(sent[2].body.messages).toHaveLength(2);
  });
});

describe('runSync: untouched state entries keep a fresh project key', () => {
  it('classifies a previously unselected session under its new alias once tracked', async () => {
    track(KEY_A);
    await runSync(opts());
    expect(sent).toHaveLength(1);

    saveConfig(hub, { ...loadConfig(hub), aliases: { 'local:beta': 'local:renamed' } });
    const unscoped = await runSync(opts());
    expect(unscoped.uploaded).toEqual([]);

    track(KEY_A, 'local:renamed');
    expect(listProjects(opts()).map((r) => r.key).sort()).toEqual([KEY_A, 'local:renamed']);
    const report = await runSync(opts());
    expect(report.uploaded).toEqual([{ project: 'local:renamed', session: `claude-code:${S2}` }]);
    expect(sent[sent.length - 1].body.project_key).toBe('local:renamed');
  });
});

describe('runSync: --project never bypasses tracking', () => {
  it('uploads nothing for an untracked project named by --project', async () => {
    const report = await runSync(opts({ project: 'beta' }));
    expect(report.uploaded).toEqual([]);
    expect(sent).toEqual([]);
  });
});
