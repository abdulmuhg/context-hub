import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logActivity, type Action, type Direction } from '../src/activity.js';
import { openDb, type Db } from '../src/db.js';
import { markDigestPending, refuseDigest, saveDigest, saveProjectState } from '../src/digest-store.js';
import { createConnectCode } from '../src/oauth/store.js';
import { AuthLimiter } from '../src/ratelimit.js';
import type { WebConfig } from '../src/web/routes.js';
import { startServer } from './helpers.js';

const START = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;
const ago = (ms: number) => new Date(START.getTime() - ms).toISOString();

const JSONROOM = 'github.com/abdulmuhg/jsonroom';

let db: Db;
let url: string;
let close: () => Promise<void>;
let clock: Date;
let cfg: WebConfig;
let cookie: string;

/** A main session (or, with source 'note', a saved note) straight into the tables. */
function addSession(
  id: string,
  project: string,
  over: { title?: string; source?: string; at?: string } = {},
): number {
  const at = over.at ?? ago(HOUR);
  db.prepare('INSERT INTO projects(key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(
    project,
    project.split('/').pop(),
    at,
  );
  const projectId = (db.prepare('SELECT id FROM projects WHERE key = ?').get(project) as { id: number }).id;
  const info = db
    .prepare(
      `INSERT INTO sessions(source, source_session_id, project_id, parent, title, started_at, last_activity_at, content_hash, synced_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'h1', ?)`,
    )
    .run(over.source ?? 'claude-code', id, projectId, over.title ?? `title ${id}`, at, at, at);
  return Number(info.lastInsertRowid);
}

const projectId = (key: string): number => (db.prepare('SELECT id FROM projects WHERE key = ?').get(key) as { id: number }).id;

const log = (at: string, over: Partial<{ direction: Direction; action: Action; projectKey: string | null; actor: string; detail: string | null }> = {}): void => {
  logActivity(
    db,
    {
      direction: over.direction ?? 'out',
      action: over.action ?? 'get_project',
      projectKey: over.projectKey === undefined ? 'local:alpha' : over.projectKey,
      sessionRef: null,
      actor: over.actor ?? 'claude.ai',
      detail: over.detail === undefined ? null : over.detail,
    },
    at,
  );
};

beforeEach(async () => {
  db = openDb(':memory:');
  clock = START;
  cfg = {
    imageTag: 'deadbee',
    startedAt: ago(HOUR),
    digestsOn: true,
    backupStatusPath: null,
    secureCookies: false,
    publicOrigin: null,
  };
  const s = await startServer({ db, now: () => clock, limiter: new AuthLimiter(() => clock.getTime()), web: cfg });
  url = s.url;
  close = s.close;
  const { code } = createConnectCode(db, clock.toISOString());
  const login = await fetch(url + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }),
  });
  cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
});

afterEach(async () => {
  await close();
});

const get = (path: string): Promise<Response> => fetch(url + path, { headers: { Cookie: cookie } });

async function page(path: string): Promise<string> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe('the Activity page', () => {
  it('shows the newest 50 rows and a link to the next page', async () => {
    for (let i = 0; i < 120; i++) log(new Date(START.getTime() - (120 - i) * MINUTE).toISOString(), { detail: `row ${i}` });
    const html = await page('/activity');
    expect(html.match(/read page/g)).toHaveLength(50);
    expect(html).toContain('row 119</td>');
    expect(html).toContain('row 70</td>');
    expect(html).not.toContain('row 69</td>');
    expect(html).toContain('href="/activity?page=2"');

    const two = await page('/activity?page=2');
    expect(two).toContain('row 69</td>');
    expect(two).toContain('row 20</td>');
    expect(two).toContain('href="/activity?page=3"');

    const three = await page('/activity?page=3');
    expect(three.match(/read page/g)).toHaveLength(20);
    expect(three).toContain('row 0</td>');
    expect(three).not.toContain('?page=4');
  });

  it('shows each row with its time, direction, what, project and actor', async () => {
    log(ago(MINUTE), { action: 'search', projectKey: null, actor: 'Claude Code (read token: laptop)', detail: 'redirect loop' });
    log(ago(2 * MINUTE), { direction: 'in', action: 'note', projectKey: JSONROOM, actor: 'claude.ai' });
    log(ago(3 * MINUTE), { direction: 'in', action: 'delete', projectKey: 'local:alpha', actor: 'your PC (collector)' });
    log(ago(4 * MINUTE), { direction: 'in', action: 'sync', projectKey: null, actor: 'your PC (laptop)', detail: '2 uploaded, 0 unchanged' });
    const html = await page('/activity');
    for (const th of ['Time', 'Direction', 'What', 'Project', 'By']) expect(html).toContain(`<th>${th}</th>`);
    expect(html).toContain(`<time datetime="${ago(MINUTE)}"`);
    expect(html).toContain('search');
    expect(html).toContain('redirect loop');
    expect(html).toContain('Claude Code (read token: laptop)');
    expect(html).toContain('note');
    expect(html).toContain('github.com/abdulmuhg/jsonroom');
    expect(html).toContain('deleted');
    expect(html).toContain('your PC (collector)');
    expect(html).toContain('sync');
    // Friendly directions, not the stored codes.
    expect(html).toContain('saved in');
    expect(html).toContain('read out');
    // No raw tool names leak into the What column.
    expect(html).not.toContain('get_project');
    expect(html).not.toContain('list_projects');
  });

  it('filters by direction and offers the three filter links', async () => {
    log(ago(MINUTE), { direction: 'out', action: 'get_project', detail: 'a read' });
    log(ago(2 * MINUTE), { direction: 'in', action: 'upload', actor: 'your PC (collector)', detail: 'a save' });
    const all = await page('/activity');
    expect(all).toContain('href="/activity"');
    expect(all).toContain('href="/activity?direction=in"');
    expect(all).toContain('href="/activity?direction=out"');
    expect(all).toContain('a read');
    expect(all).toContain('a save');

    const out = await page('/activity?direction=out');
    expect(out).toContain('a read');
    expect(out).not.toContain('a save');

    const inward = await page('/activity?direction=in');
    expect(inward).toContain('a save');
    expect(inward).not.toContain('a read');
  });

  it('collapses consecutive uploads of one project by one actor within two minutes', async () => {
    const upload = (at: string) => log(at, { direction: 'in', action: 'upload', projectKey: JSONROOM, actor: 'your PC (collector)' });
    upload(ago(MINUTE));
    upload(ago(MINUTE + 30_000));
    upload(ago(2 * MINUTE));
    // Ten minutes earlier is its own run; a different project breaks the run too.
    upload(ago(12 * MINUTE));
    log(ago(13 * MINUTE), { direction: 'in', action: 'upload', projectKey: 'local:alpha', actor: 'your PC (collector)' });
    const html = await page('/activity');
    expect(html).toContain('3 sessions');
    expect(html).toContain('1 session');
    expect(html.match(/sessions?<\/span>/g)).toHaveLength(3);
  });

  it('clamps a page number that is not a page instead of failing', async () => {
    for (let i = 0; i < 120; i++) log(new Date(START.getTime() - (120 - i) * MINUTE).toISOString(), { detail: `row ${i}` });
    for (const q of ['?page=0', '?page=-5', '?page=abc', '?page=', '?page=1e9']) {
      const html = await page('/activity' + q);
      expect(html).toContain('row 119</td>');
    }
    // Past the end lands on the last page, not an empty one.
    const far = await page('/activity?page=9999');
    expect(far).toContain('row 0</td>');
    expect(far).not.toContain('?page=10000');
    // An unknown direction is ignored rather than refused.
    const odd = await page('/activity?direction=sideways');
    expect(odd).toContain('row 119</td>');
  });

  it('says so when there is nothing to show', async () => {
    const html = await page('/activity');
    expect(html).toContain('Nothing yet.');
    expect(html).not.toContain('?page=2');
  });
});

describe('the Projects page', () => {
  it('lists every project with its session count, times and summary', async () => {
    addSession('a', JSONROOM);
    addSession('b', JSONROOM, { at: ago(2 * HOUR) });
    addSession('c', 'local:alpha', { at: ago(3 * HOUR) });
    saveProjectState(db, projectId(JSONROOM), { summary: 'A JSON viewer in the browser.', body: '# jsonroom', model: 'm' }, ago(HOUR), true);
    const html = await page('/projects');
    expect(html).toContain('github.com/abdulmuhg/jsonroom');
    expect(html).toContain('local:alpha');
    expect(html).toContain('A JSON viewer in the browser.');
    expect(html).toContain(`href="/projects/${encodeURIComponent(JSONROOM)}"`);
    expect(html).toContain('href="/projects/local%3Aalpha"');
    // Two main sessions in jsonroom, one in alpha.
    expect(html).toMatch(/>2</);
    expect(html).toContain('No summary yet');
  });

  it('says so when no project has been synced yet', async () => {
    const html = await page('/projects');
    expect(html).toContain('No projects yet.');
  });
});

describe('a project page', () => {
  it('shows the rendered state page and the recent sessions and notes', async () => {
    const a = addSession('a', JSONROOM, { title: 'Fix the import' });
    addSession('n1', JSONROOM, { source: 'note', title: 'Remember the schema', at: ago(2 * HOUR) });
    const refused = addSession('r', JSONROOM, { title: 'Secrets inside', at: ago(3 * HOUR) });
    markDigestPending(db, a, ago(HOUR));
    saveDigest(db, {
      sessionRowId: a,
      hash: 'h1',
      model: 'claude',
      body: { goal: 'fix the import', done: [], decisions: [], open_items: [], key_refs: [] },
      text: 'summary of a',
      now: ago(HOUR),
    });
    markDigestPending(db, refused, ago(3 * HOUR));
    refuseDigest(db, refused, 'the transcript holds secrets', ago(3 * HOUR));
    saveProjectState(
      db,
      projectId(JSONROOM),
      { summary: 'A JSON viewer.', body: '## Where things stand\n\nThe **importer** is done.\n\n- next: the exporter', model: 'm' },
      ago(HOUR),
      true,
    );

    const html = await page('/projects/' + encodeURIComponent(JSONROOM));
    expect(html).toContain('github.com/abdulmuhg/jsonroom');
    // The state page is rendered Markdown, not a code block of it.
    expect(html).toContain('<h2>Where things stand</h2>');
    expect(html).toContain('<strong>importer</strong>');
    expect(html).toContain('<li>next: the exporter</li>');
    // Each session and note: title, source, date and digest status.
    expect(html).toContain('Fix the import');
    expect(html).toContain('Remember the schema');
    expect(html).toContain('note');
    expect(html).toContain('claude-code');
    expect(html).toContain('ok');
    expect(html).toContain('refused');
    expect(html).toContain(`<time datetime="${ago(2 * HOUR)}"`);
  });

  it('opens a project whose key holds slashes, and 404s an unknown key', async () => {
    addSession('a', JSONROOM);
    const ok = await get('/projects/' + encodeURIComponent(JSONROOM));
    expect(ok.status).toBe(200);

    const missing = await get('/projects/' + encodeURIComponent('github.com/abdulmuhg/nope'));
    expect(missing.status).toBe(404);
    const body = await missing.text();
    expect(body).toContain('No such project');
    // The 404 is a page with the usual headers, and it names nothing else that is stored.
    expect(missing.headers.get('content-type')).toContain('text/html');
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).not.toContain('jsonroom');
  });

  it('404s a malformed or impossible key instead of failing', async () => {
    addSession('a', JSONROOM);
    for (const path of ['/projects/%zz', '/projects/%', '/projects/', '/projects/github.com/abdulmuhg/jsonroom']) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
    // An unknown page is still the JSON 404, not a project page.
    const other = await get('/nope');
    expect(other.status).toBe(404);
    expect(other.headers.get('content-type')).toContain('application/json');
  });

  it('renders stored titles and state pages as text, and a javascript: link as plain text', async () => {
    addSession('a', JSONROOM, { title: '<img src=x onerror=alert(1)>' });
    saveProjectState(
      db,
      projectId(JSONROOM),
      { summary: '<script>alert(1)</script>', body: '<script>alert(1)</script>\n\n[x](javascript:alert(1))', model: 'm' },
      ago(HOUR),
      true,
    );
    const html = await page('/projects/' + encodeURIComponent(JSONROOM));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;');
    // The javascript: link keeps its text but is not a link.
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('escapes a project key that holds markup, on the list and the page', async () => {
    const nasty = 'github.com/me/<img src=x onerror=alert(1)>';
    addSession('a', nasty);
    const list = await page('/projects');
    expect(list).not.toContain('<img');
    expect(list).toContain('&lt;img');
    const html = await page('/projects/' + encodeURIComponent(nasty));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
