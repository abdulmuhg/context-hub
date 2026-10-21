import { existsSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { LlmRefusal } from '@context-hub/core';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
import { UsageLimitError } from '../src/claude-llm.js';
import { loadConfig, loadState, saveConfig, savePersonal, saveToken } from '../src/config.js';
import { listProjects, runSync, type SyncOptions } from '../src/sync.js';
import { tempDir, writeJsonl, writeRaw } from './helpers.js';

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
let reports: Sent[];
let failAfter: number;
let llm: FakeLlm;
/** What the fake hub answers to GET /api/status, to the list of a project's digests, and to GET of a stored session. */
let hubStatus: Record<string, unknown>;
let owedList: Record<string, unknown>[];
let stored: Record<string, unknown>;
let digestAnswer: number;
let pageInputs: Record<string, unknown>;

/** A stand-in for the server: records requests, can start failing. */
const fakeFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/api/sync-runs')) {
    const headers = new Headers(init?.headers);
    const raw = init?.body as Uint8Array;
    reports.push({ method: init?.method ?? 'GET', url: String(input), auth: headers.get('authorization'), body: JSON.parse(gunzipSync(raw).toString('utf8')) });
    return new Response(null, { status: 204 });
  }
  const method = init?.method ?? 'GET';
  const url = String(input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  if (method === 'GET' && url.endsWith('/api/status')) return json(hubStatus);
  if (method === 'GET' && url.includes('/api/projects/') && url.endsWith('/digests')) return json({ sessions: owedList });
  if (method === 'GET' && url.endsWith('/page-inputs')) return json(pageInputs[decodeURIComponent(url.split('/api/projects/')[1]!.split('/')[0]!)]);
  if (method === 'GET' && url.includes('/api/sessions/')) {
    const found = stored[url.split('/api/sessions/')[1]!];
    return found ? json({ session: found }) : new Response('{}', { status: 404 });
  }
  if (sent.length >= failAfter) return new Response('boom', { status: 500 });
  const headers = new Headers(init?.headers);
  const raw = init?.body as Uint8Array | undefined;
  sent.push({
    method: init?.method ?? 'GET',
    url: String(input),
    auth: headers.get('authorization'),
    body: raw ? JSON.parse(gunzipSync(raw).toString('utf8')) : null,
  });
  if (url.endsWith('/digest')) return new Response(digestAnswer === 204 ? null : '{}', { status: digestAnswer });
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
  llm,
  ...over,
});

const proj = () => join(home, '.claude', 'projects', 'p');
const track = (...keys: string[]) => saveConfig(hub, { ...loadConfig(hub), tracked: keys });

beforeEach(() => {
  home = tempDir();
  hub = tempDir();
  sent = [];
  reports = [];
  failAfter = Infinity;
  llm = new FakeLlm();
  hubStatus = { server_summaries: false, pages_needed: [], summaries_owed: 0 };
  owedList = [];
  stored = {};
  digestAnswer = 204;
  pageInputs = {};
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
    saveConfig(hub, { ...loadConfig(hub), personal: { card: 'warn', list: 'warn' } });
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

describe('upload timeout', () => {
  it('gives up on a server that never answers instead of hanging the sync', async () => {
    const { putSession } = await import('../src/upload.js');
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const session = { source: 'claude-code', source_session_id: 'x', messages: [] } as never;
    await expect(putSession({ url: 'https://hub.example.com', token: 't', fetchImpl: never, timeoutMs: 50 }, session)).rejects.toThrow(/could not reach/);
  });
});

describe('runSync: after a collector upgrade', () => {
  it('re-reads unchanged files once, and uploads only those whose output actually changed', async () => {
    track(KEY_A, 'local:beta');
    await runSync(opts());
    expect(sent).toHaveLength(2);

    // Pretend the last sync was made by an older collector.
    const { loadState, saveState } = await import('../src/config.js');
    saveState(hub, { ...loadState(hub), fingerprint: 'fingerprint-from-an-older-collector' });

    // An adapter that now reads something the old one missed, for one session only.
    const { ALL_ADAPTERS } = await import('../src/adapters/index.js');
    const real = ALL_ADAPTERS[0]!;
    let reads = 0;
    const improved = {
      ...real,
      read: (file: Parameters<typeof real.read>[0]) => {
        reads++;
        const raw = real.read(file);
        return file.id === S1 ? { ...raw, account_id: 'acct-now-found' } : raw;
      },
    };

    const second = await runSync(opts({ adapters: [improved] }));
    expect(reads).toBe(2); // both files re-read although neither changed on disk
    expect(second.uploaded).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(second.unchanged).toBe(1);
    expect(sent[2].body.account_id).toBe('acct-now-found');

    const third = await runSync(opts({ adapters: [improved] }));
    expect(third.uploaded).toEqual([]);
    expect(reads).toBe(2); // and not re-read again afterwards
  });
});

describe('runSync: reports the run to the server', () => {
  it('sends one report with the run counts after a real sync', async () => {
    track(KEY_A);
    const report = await runSync(opts());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ method: 'POST', url: 'https://hub.example.com/api/sync-runs', auth: 'Bearer tok-1' });
    expect(reports[0]!.body).toEqual({
      finished_at: '2026-10-10T00:00:00.000Z',
      uploaded: report.uploaded.length,
      unchanged: report.unchanged,
      errors: report.errors.length,
    });
    expect(report.uploaded).toHaveLength(1);
  });

  it('counts errors when an upload fails', async () => {
    track(KEY_A);
    failAfter = 0;
    const report = await runSync(opts());
    expect(report.errors).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toMatchObject({ uploaded: 0, errors: 1 });
  });

  it('sends nothing on a dry run', async () => {
    track(KEY_A);
    await runSync(opts({ dryRun: true }));
    expect(reports).toEqual([]);
  });

  it('a scoped sync still reports', async () => {
    track(KEY_A);
    await runSync(opts({ project: 'alpha' }));
    expect(reports).toHaveLength(1);
  });

  it('a failed report is returned, not thrown', async () => {
    track(KEY_A);
    const report = await runSync(opts({ fetchImpl: async (input, init) => (String(input).endsWith('/api/sync-runs') ? new Response('no', { status: 500 }) : fakeFetch(input, init)) }));
    expect(report.uploaded).toHaveLength(1);
    expect(report.reportError).toMatch(/sync-runs/);
  });
});

describe('runSync: documents', () => {
  let notes: string;
  const docUrl = (path: string) => `https://hub.example.com/api/sessions/doc/${encodeURIComponent(`${KEY_A}#kb/${path}`)}`;
  const withDocs = (exclude: string[] = []) =>
    saveConfig(hub, { ...loadConfig(hub), docs: [{ project: KEY_A, path: notes, label: 'kb', exclude }] });

  beforeEach(() => {
    notes = tempDir();
    writeRaw(join(notes, 'INDEX.md'), '# Index\n- T-1');
    writeRaw(join(notes, 'tickets', 'T-1.md'), '# T-1 login loop\nroot cause: cookie check');
  });

  it('uploads each Markdown file under its project, titled by its heading', async () => {
    track(KEY_A);
    withDocs();
    const report = await runSync(opts());
    const docs = sent.filter((r) => r.url.includes('/api/sessions/doc/'));
    expect(docs.map((r) => r.url).sort()).toEqual([docUrl('INDEX.md'), docUrl('tickets/T-1.md')]);
    const t1 = docs.find((r) => r.url === docUrl('tickets/T-1.md'))!.body;
    expect(t1).toMatchObject({ source: 'doc', project_key: KEY_A, title: 'T-1 login loop', parent: null, cwd: null });
    expect(t1.messages.map((m: any) => m.text)).toEqual(['# T-1 login loop\nroot cause: cookie check']);
    expect(report.uploaded.filter((r) => r.session.startsWith('doc:'))).toHaveLength(2);
  });

  it('uploads nothing for a project that is not tracked', async () => {
    withDocs();
    await runSync(opts());
    expect(sent.filter((r) => r.url.includes('/doc/'))).toEqual([]);
  });

  it('sends an edited document again, and only that one', async () => {
    track(KEY_A);
    withDocs();
    await runSync(opts());
    sent = [];
    writeRaw(join(notes, 'tickets', 'T-1.md'), '# T-1 login loop\nfixed in PR 12');
    utimesSync(join(notes, 'tickets', 'T-1.md'), new Date('2026-10-12T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));
    await runSync(opts());
    expect(sent.map((r) => [r.method, r.url])).toEqual([['PUT', docUrl('tickets/T-1.md')]]);
  });

  it('removes a document from the server when its file is deleted or renamed', async () => {
    track(KEY_A);
    withDocs();
    await runSync(opts());
    sent = [];
    renameSync(join(notes, 'tickets', 'T-1.md'), join(notes, 'tickets', 'T-1-login.md'));
    const report = await runSync(opts());
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['PUT', docUrl('tickets/T-1-login.md')],
      ['DELETE', docUrl('tickets/T-1.md')],
    ]);
    expect(report.deleted).toEqual([{ project: KEY_A, session: `doc:${KEY_A}#kb/tickets/T-1.md` }]);
    sent = [];
    await runSync(opts());
    expect(sent).toEqual([]);
  });

  it('removes nothing when the whole folder is missing, and says so', async () => {
    track(KEY_A);
    withDocs();
    await runSync(opts());
    sent = [];
    rmSync(notes, { recursive: true });
    const report = await runSync(opts());
    expect(sent).toEqual([]);
    expect(report.errors).toEqual([`doc folder ${notes} is missing`]);
  });

  it('only reports what a dry run would remove', async () => {
    track(KEY_A);
    withDocs();
    await runSync(opts());
    sent = [];
    rmSync(join(notes, 'INDEX.md'));
    const report = await runSync(opts({ dryRun: true }));
    expect(sent).toEqual([]);
    expect(report.wouldDelete).toEqual([{ project: KEY_A, session: `doc:${KEY_A}#kb/INDEX.md` }]);
  });

  it('treats a newly excluded file like a deleted one', async () => {
    track(KEY_A);
    withDocs();
    await runSync(opts());
    sent = [];
    withDocs(['tickets']);
    await runSync(opts());
    expect(sent.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual([docUrl('tickets/T-1.md')]);
  });
});

describe('runSync: summaries', () => {
  const S3 = '55555555-5555-4555-8555-555555555555';
  const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T10:00:00.000Z`;
  const ccAt = (sid: string, ts: string, text: string) => ({ ...cc(sid, '/work/alpha', text), timestamp: ts });
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const puts = () => sent.filter((r) => r.method === 'PUT' && !r.url.endsWith('/digest'));
  const digestCalls = () => llm.calls.filter((c) => c.kind === 'digest');

  /** Writes n sessions of the alpha project, session i last active on day i. */
  const manySessions = (n: number) => {
    rmSync(join(proj(), `${S1}.jsonl`));
    for (let i = 1; i <= n; i++) writeJsonl(join(proj(), `${uuid(i)}.jsonl`), [ccAt(uuid(i), at(i), `question ${i}`)]);
  };

  it('uploads a new main session together with its digest', async () => {
    track(KEY_A);
    const report = await runSync(opts());
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body.digest).toMatchObject({ model: 'fake-model', body: { goal: expect.stringContaining('digest of') } });
    expect(report.summarized).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(report.waiting).toEqual({ count: 0, reason: null });
  });

  it('writes at most 20 digests per sync, newest first, and --all lifts the cap', async () => {
    track(KEY_A);
    manySessions(25);
    const first = await runSync(opts());
    expect(first.uploaded).toHaveLength(20);
    expect(puts().map((r) => r.body.source_session_id)).toEqual(Array.from({ length: 20 }, (_, i) => uuid(25 - i)));
    expect(first.waiting.count).toBe(5);
    expect(first.waiting.reason).toMatch(/cap of 20 reached.*hub sync --all/);

    const second = await runSync(opts());
    expect(second.uploaded).toHaveLength(5);
    expect(second.waiting.count).toBe(0);

    sent = [];
    rmSync(join(hub, 'state.json'));
    const all = await runSync(opts({ all: true }));
    expect(all.uploaded).toHaveLength(25);
  });

  it('a session whose digest fails is not uploaded and is retried next sync', async () => {
    track(KEY_A);
    llm.failWith = new Error('claude exploded');
    const first = await runSync(opts());
    expect(puts()).toEqual([]);
    expect(first.uploaded).toEqual([]);
    expect(first.waiting.count).toBe(1);
    expect(first.errors).toEqual([]);
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
  });

  it('stops summarizing when the limit is hit mid-session', async () => {
    track(KEY_A);
    const big = 'w'.repeat(70_000);
    writeJsonl(join(proj(), `${S1}.jsonl`), [ccAt(S1, at(9), big), ccAt(S1, at(9), big)]);
    writeJsonl(join(proj(), `${S3}.jsonl`), [ccAt(S3, at(1), 'older and small')]);
    const realDigest = llm.digest.bind(llm);
    llm.digest = async (req) => {
      if (req.part?.index === 2) throw new UsageLimitError('2026-10-10T14:00:00.000Z');
      return realDigest(req);
    };
    const report = await runSync(opts());
    expect(puts()).toEqual([]);
    expect(llm.calls.filter((c) => c.kind === 'digest')).toHaveLength(1); // part 1 only; part 2 threw, and the older session was not tried
    expect(report.waiting.count).toBe(2);
    expect(report.waiting.reason).toMatch(/Claude usage limit reached \(resets /);
    expect(loadState(hub).files[join(proj(), `${S1}.jsonl`)]).toBeUndefined();
  });

  it('makes no more model calls after an upload fails', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), `${S3}.jsonl`), [ccAt(S3, at(1), 'second one')]);
    failAfter = 0;
    const report = await runSync(opts());
    expect(report.errors).toHaveLength(1);
    expect(digestCalls()).toHaveLength(1);
  });

  it('uploads a refused session marked refused', async () => {
    track(KEY_A);
    llm.failWith = new LlmRefusal('cyber');
    const report = await runSync(opts());
    expect(puts()[0]!.body.digest).toEqual({ refused: 'cyber', model: 'fake-model' });
    expect(report.uploaded).toHaveLength(1);
    expect(report.summarized).toEqual([]);
  });

  it('uploads failed after the same content fails on 3 syncs', async () => {
    track(KEY_A);
    for (let i = 0; i < 2; i++) {
      llm.failWith = new Error('claude exploded');
      const r = await runSync(opts());
      expect(r.waiting.count).toBe(1);
      expect(puts()).toEqual([]);
    }
    llm.failWith = new Error('claude exploded');
    const third = await runSync(opts());
    expect(puts()[0]!.body.digest).toEqual({ failed: 'claude exploded' });
    expect(third.uploaded).toHaveLength(1);
    expect(third.waiting.count).toBe(0);
  });

  it('restarts the failure count when the content changes', async () => {
    track(KEY_A);
    for (let i = 0; i < 2; i++) {
      llm.failWith = new Error('claude exploded');
      await runSync(opts());
    }
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question'), cc(S1, '/work/alpha', 'and more')]);
    llm.failWith = new Error('claude exploded');
    await runSync(opts());
    expect(puts()).toEqual([]);
  });

  it('holds a waiting session\'s subagents back', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), S1, 'subagents', 'agent-x.jsonl'), [cc(S1, '/somewhere/else', 'sub task')]);
    llm.failWith = new Error('claude exploded');
    await runSync(opts());
    expect(sent).toEqual([]);
    const second = await runSync(opts());
    expect(second.uploaded.map((u) => u.session)).toEqual([`claude-code:${S1}`, `claude-code:${S1}/agent-x`]);
  });

  it('uploads a subagent at once when its parent is already on the hub', async () => {
    track(KEY_A);
    await runSync(opts());
    sent = [];
    llm.calls = [];
    writeJsonl(join(proj(), S1, 'subagents', 'agent-x.jsonl'), [cc(S1, '/somewhere/else', 'sub task')]);
    const report = await runSync(opts());
    expect(puts().map((r) => r.body.source_session_id)).toEqual([`${S1}/agent-x`]);
    expect(puts()[0]!.body.digest).toBeUndefined();
    expect(llm.calls).toEqual([]);
    expect(report.uploaded).toHaveLength(1);
  });

  it('re-cleaning uploads changed sessions at once with summary_to_follow, outside the cap', async () => {
    track(KEY_A);
    manySessions(22);
    await runSync(opts({ all: true }));
    expect(puts()).toHaveLength(22);
    sent = [];
    llm.calls = [];

    savePersonal(hub, [{ label: 'q', value: 'question', level: 'full' }]);
    const report = await runSync(opts());
    expect(puts()).toHaveLength(22);
    expect(puts().every((r) => JSON.stringify(r.body.digest) === '{"summary_to_follow":true}')).toBe(true);
    expect(puts()[0]!.body.messages[0].text).toContain('[REDACTED');
    expect(report.uploaded).toHaveLength(22);
    expect(llm.calls).toEqual([]);
    expect(report.waiting.count).toBe(0);
  });

  it('re-cleaning also uploads a subagent of an uploaded session, without a digest', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), S1, 'subagents', 'agent-x.jsonl'), [cc(S1, '/somewhere/else', 'sub question')]);
    await runSync(opts());
    sent = [];
    savePersonal(hub, [{ label: 'q', value: 'question', level: 'full' }]);
    await runSync(opts());
    const sub = puts().find((r) => r.body.parent === S1)!;
    expect(sub.body.digest).toBeUndefined();
  });

  it('catches up owed summaries from the server before new work', async () => {
    track(KEY_A);
    hubStatus = { server_summaries: false, pages_needed: [], summaries_owed: 1 };
    owedList = [{ source: 'claude-code', id: S3, content_hash: 'a'.repeat(64), last_activity_at: at(2), status: 'pending', model: null, written_by: null, summary_to_follow: true }];
    stored[`claude-code/${S3}`] = {
      source: 'claude-code',
      source_session_id: S3,
      project_key: KEY_A,
      parent: null,
      title: 'Owed',
      content_hash: 'a'.repeat(64),
      messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello' }],
    };
    await runSync(opts());
    const order = sent.map((r) => (r.url.endsWith('/digest') ? 'digest' : 'session'));
    expect(order).toEqual(['digest', 'session']);
    const digestPut = sent[0]!;
    expect(digestPut.url).toBe(`https://hub.example.com/api/sessions/claude-code/${S3}/digest`);
    expect(digestPut.body).toMatchObject({ hash: 'a'.repeat(64), digest: { model: 'fake-model', body: { goal: expect.stringContaining('digest of Owed') } } });
  });

  it('counts a catch-up digest toward the cap', async () => {
    track(KEY_A);
    manySessions(20);
    hubStatus = { server_summaries: false, pages_needed: [], summaries_owed: 1 };
    owedList = [{ source: 'claude-code', id: S3, content_hash: 'a'.repeat(64), last_activity_at: at(2), status: 'pending', model: null, written_by: null, summary_to_follow: true }];
    stored[`claude-code/${S3}`] = { source: 'claude-code', source_session_id: S3, project_key: KEY_A, parent: null, title: 'Owed', content_hash: 'a'.repeat(64), messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello' }] };
    const report = await runSync(opts());
    expect(puts()).toHaveLength(19);
    expect(report.waiting.count).toBe(1);
  });

  it('without Claude Code, uploads without a digest only when the server has a key', async () => {
    track(KEY_A);
    const waiting = await runSync(opts({ llm: null }));
    expect(puts()).toEqual([]);
    expect(waiting.waiting).toEqual({ count: 1, reason: 'Claude Code is not installed' });

    hubStatus = { server_summaries: true, pages_needed: [], summaries_owed: 0 };
    const uploaded = await runSync(opts({ llm: null }));
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body.digest).toBeUndefined();
    expect(uploaded.waiting.count).toBe(0);
  });

  it('a dry run calls no model', async () => {
    track(KEY_A);
    const report = await runSync(opts({ dryRun: true }));
    expect(llm.calls).toEqual([]);
    expect(report.wouldSummarize).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(report.wouldUpload).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(sent).toEqual([]);
  });

  it('records the waiting count in the state file', async () => {
    track(KEY_A);
    llm.failWith = new Error('claude exploded');
    await runSync(opts());
    expect(loadState(hub).last_waiting).toEqual({ count: 1, reason: 'summary failed: claude exploded', at: '2026-10-10T00:00:00.000Z' });
  });
});

describe('runSync: state pages', () => {
  const pageDigest = { session_id: `claude-code:${S1}`, title: 'T', date: '2026-10-01T10:00:00.000Z', text: 'Goal: x', saved_seq: 1 };
  const pagePuts = () => sent.filter((r) => r.method === 'PUT' && r.url.endsWith('/page'));

  beforeEach(() => {
    hubStatus = { server_summaries: false, pages_needed: [KEY_A], summaries_owed: 0 };
    pageInputs = { [KEY_A]: { page: null, digests: [pageDigest], through: 1 } };
  });

  it('writes the pages the hub says it needs, after the uploads', async () => {
    track(KEY_A);
    const report = await runSync(opts());
    expect(sent.map((r) => (r.url.endsWith('/page') ? 'page' : 'session'))).toEqual(['session', 'page']);
    expect(pagePuts()[0]!.url).toBe(`https://hub.example.com/api/projects/${encodeURIComponent(KEY_A)}/page`);
    expect(pagePuts()[0]!.body).toMatchObject({ base_version: null, through: 1, full_rebuild: true, model: 'fake-model' });
    expect(report.pages).toEqual({ updated: [KEY_A], left: [] });
  });

  it('leaves the pages of projects it did not sync', async () => {
    track(KEY_A);
    hubStatus = { server_summaries: false, pages_needed: ['github.com/me/other', KEY_A], summaries_owed: 0 };
    await runSync(opts());
    expect(pagePuts()).toHaveLength(1);
  });

  it('makes no page call without a writer', async () => {
    track(KEY_A);
    hubStatus = { server_summaries: true, pages_needed: [KEY_A], summaries_owed: 0 };
    const report = await runSync(opts({ llm: null }));
    expect(pagePuts()).toEqual([]);
    expect(report.pages).toEqual({ updated: [], left: [] });
  });

  it('skips the pages once the usage limit is hit', async () => {
    track(KEY_A);
    llm.digest = async () => {
      throw new UsageLimitError(null);
    };
    const report = await runSync(opts());
    expect(pagePuts()).toEqual([]);
    expect(report.waiting.reason).toBe('Claude usage limit reached');
  });

  it('leaves the page of a re-cleaned project until its summaries are written', async () => {
    track(KEY_A);
    await runSync(opts());
    sent = [];
    savePersonal(hub, [{ label: 'q', value: 'question', level: 'full' }]);
    const report = await runSync(opts());
    expect(pagePuts()).toEqual([]);
    expect(report.pages).toEqual({ updated: [], left: [KEY_A] });
  });

  it('does not touch pages in a dry run', async () => {
    track(KEY_A);
    await runSync(opts({ dryRun: true }));
    expect(sent).toEqual([]);
  });
});
