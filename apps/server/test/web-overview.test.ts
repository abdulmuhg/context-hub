import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logActivity } from '../src/activity.js';
import { openDb, type Db } from '../src/db.js';
import { failDigest, markDigestPending, refuseDigest } from '../src/digest-store.js';
import { createConnectCode } from '../src/oauth/store.js';
import { AuthLimiter } from '../src/ratelimit.js';
import type { WebConfig } from '../src/web/routes.js';
import { startServer } from './helpers.js';

const START = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(START.getTime() - ms).toISOString();

let db: Db;
let url: string;
let close: () => Promise<void>;
let clock: Date;
let cfg: WebConfig;
let dir: string;
let statusPath: string;

const writeStatus = (over: Record<string, unknown> = {}): void => {
  writeFileSync(
    statusPath,
    JSON.stringify({ finished_at: ago(2 * HOUR), local_ok: true, size_bytes: 2048, offsite_configured: true, offsite_ok: true, ...over }),
    'utf8',
  );
};

function addSession(id: string, project: string): number {
  db.prepare('INSERT INTO projects(key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(project, project, ago(HOUR));
  const projectId = (db.prepare('SELECT id FROM projects WHERE key = ?').get(project) as { id: number }).id;
  const info = db
    .prepare(
      `INSERT INTO sessions(source, source_session_id, project_id, parent, title, last_activity_at, content_hash, synced_at)
       VALUES ('claude-code', ?, ?, NULL, ?, ?, 'h1', ?)`,
    )
    .run(id, projectId, `title ${id}`, ago(HOUR), ago(HOUR));
  return Number(info.lastInsertRowid);
}

const addSyncRun = (over: { errors?: number } = {}): void => {
  db.prepare('INSERT INTO sync_runs(token_id, finished_at, uploaded, unchanged, errors, received_at) VALUES (1, ?, 2, 205, ?, ?)').run(
    ago(HOUR),
    over.errors ?? 0,
    ago(HOUR),
  );
};

beforeEach(async () => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'hub-overview-'));
  statusPath = join(dir, 'context-hub.json');
  writeStatus();
  clock = START;
  cfg = {
    imageTag: 'deadbee',
    startedAt: ago(HOUR),
    digestsOn: true,
    backupStatusPath: statusPath,
    secureCookies: false,
    publicOrigin: null,
  };
  const s = await startServer({ db, now: () => clock, limiter: new AuthLimiter(() => clock.getTime()), web: cfg });
  url = s.url;
  close = s.close;
  addSyncRun();
});

afterEach(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

/** Signs in and fetches the Overview page's HTML. */
async function overview(): Promise<string> {
  const { code } = createConnectCode(db, clock.toISOString());
  const login = await fetch(url + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const res = await fetch(url + '/', { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

describe('the Overview page', () => {
  it('shows the five number cards and a healthy status', async () => {
    addSession('a', 'local:alpha');
    const html = await overview();
    for (const label of ['Status', 'Projects', 'Sessions', 'Last sync', 'Last backup']) expect(html).toContain(label);
    expect(html).toContain('Healthy');
    expect(html).not.toContain('Needs attention');
    expect(html).not.toContain('Problems');
    // One project, one session, and the run the collector reported.
    expect(html).toMatch(/Projects<\/[a-z]+><[^>]*>1</);
    expect(html).toMatch(/2 uploaded/);
  });

  it('shows the deployed version and when the server started', async () => {
    const html = await overview();
    expect(html).toContain('Running <code>deadbee</code>');
    expect(html).toContain(`datetime="${ago(HOUR)}"`);
  });

  it('leaves out the version when the image tag is unknown', async () => {
    cfg.imageTag = null;
    const html = await overview();
    expect(html).not.toContain('running');
    expect(html).toContain(`datetime="${ago(HOUR)}"`);
  });

  it('shows the Problems box with one line per problem when something is wrong', async () => {
    const id = addSession('a', 'local:alpha');
    markDigestPending(db, id, ago(HOUR));
    failDigest(db, id, 'the model timed out', clock.toISOString());
    const html = await overview();
    expect(html).toContain('Needs attention');
    expect(html).not.toContain('>Healthy<');
    expect(html).toContain('Problems');
    expect(html).toContain('the model timed out');
    expect(html).toContain('claude-code:a');
  });

  it('marks a refused summary as a notice and stays healthy', async () => {
    const id = addSession('a', 'local:alpha');
    markDigestPending(db, id, ago(HOUR));
    refuseDigest(db, id, 'the transcript holds secrets', clock.toISOString());
    const html = await overview();
    expect(html).toContain('Healthy');
    expect(html).not.toContain('Needs attention');
    expect(html).not.toContain('Problems');
    expect(html).toContain("won't be retried until the session changes");
    expect(html).toContain('the transcript holds secrets');
  });

  it('says there is no backup status yet when the file is missing', async () => {
    cfg.backupStatusPath = null;
    const html = await overview();
    expect(html).toContain('No backup status yet');
    expect(html).toContain('Healthy');
  });

  it('shows the latest ten activity rows and a link to Activity', async () => {
    for (let i = 0; i < 12; i++) {
      logActivity(
        db,
        { direction: 'out', action: 'get_project', projectKey: 'local:alpha', sessionRef: null, actor: 'claude.ai', detail: `row ${i}` },
        new Date(START.getTime() - (12 - i) * 60_000).toISOString(),
      );
    }
    const html = await overview();
    expect(html).toContain('href="/activity"');
    expect(html).toContain('row 11');
    expect(html).toContain('row 2');
    expect(html).not.toContain('row 1<');
    expect(html).not.toContain('row 0');
    // The What column names the action in plain words, not the MCP tool name behind it.
    expect(html).not.toContain('get_project');
    expect(html.match(/read page/g)).toHaveLength(10);
  });

  it('escapes stored text and renders times as UTC time elements', async () => {
    addSession('a', '<script>alert(1)</script>');
    logActivity(
      db,
      { direction: 'out', action: 'search', projectKey: '<script>alert(1)</script>', sessionRef: null, actor: '"><b>x', detail: '<img onerror=x>' },
      ago(60_000),
    );
    const html = await overview();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<time datetime="2026-10-20T[^"]+Z">[^<]*UTC<\/time>/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    // No tag carries an inline handler; the stored text that looks like one is escaped into a cell.
    expect(html).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/);
    expect(html).not.toContain('<img');
  });

  it('reads the clock it is given, not the wall clock', async () => {
    addSyncRun();
    // Four days on, the same run has gone quiet.
    clock = new Date(START.getTime() + 4 * 24 * HOUR);
    const html = await overview();
    expect(html).toContain('Needs attention');
    expect(html).toMatch(/no sync run/i);
  });
});
