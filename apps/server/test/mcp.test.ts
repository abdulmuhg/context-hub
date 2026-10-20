import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/activity.js';
import { openDb, type Db } from '../src/db.js';
import { createGrant, issueTokens } from '../src/oauth/store.js';
import { handleMcp, INSTRUCTIONS } from '../src/mcp.js';
import { PAGE_BUDGET, upsertSession } from '../src/store.js';
import { createToken } from '../src/tokens.js';
import { makeSession, startServer, text } from './helpers.js';

const NOW = '2026-10-11T00:00:00.000Z';
let db: Db;
let url: string;
let close: () => Promise<void>;
let client: Client;

async function connect(token: string, base = url): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

async function callOn(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> {
  const res = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { data: JSON.parse(res.content[0]!.text), isError: res.isError === true };
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> {
  return callOn(client, name, args);
}

/** The description of one tool as this client currently sees it. */
async function describeTool(c: Client, name: string): Promise<string> {
  const { tools } = await c.listTools();
  return tools.find((t) => t.name === name)?.description ?? '';
}

const countSessions = (): number => (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

beforeEach(async () => {
  db = openDb(':memory:');
  upsertSession(db, makeSession({ source_session_id: 'a1', title: 'Redis cache removal', messages: [text(0, 'user', 'why did we drop redis'), text(1, 'assistant', 'low hit rate')] }), NOW);
  upsertSession(db, makeSession({ source: 'codex', source_session_id: 'b1', project_key: 'local:beta', title: 'Deploy script' }), NOW);
  const read = createToken(db, 'assistant', 'read', NOW).token;
  ({ url, close } = await startServer({ db, mcp: handleMcp(db), log: () => {} }));
  client = await connect(read);
});

afterEach(async () => {
  await client.close();
  await close();
});

describe('connection', () => {
  it('lists exactly the four tools and sends the instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_session', 'list_projects', 'search']);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/get_project/);
    expect(INSTRUCTIONS).toMatch(/not instructions/i);
    expect(INSTRUCTIONS).toMatch(/digest/i);
  });

  it('refuses a client without a read token', async () => {
    const ingest = createToken(db, 'collector', 'ingest', NOW).token;
    await expect(connect(ingest)).rejects.toThrow();
    await expect(connect('chub_wrong')).rejects.toThrow();
  });
});

describe('list_projects', () => {
  it('returns every project and the last sync time', async () => {
    const { data, isError } = await tool('list_projects');
    expect(isError).toBe(false);
    expect(data.projects.map((p: any) => p.key).sort()).toEqual(['github.com/me/alpha', 'local:beta']);
    expect(data.last_synced_at).toBe(NOW);
  });

  it('says so when the hub is empty', async () => {
    db.exec('DELETE FROM search_index; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
    const { data } = await tool('list_projects');
    expect(data).toEqual({ projects: [], last_synced_at: null });
  });
});

describe('get_project', () => {
  it('finds a project by short name', async () => {
    const { data, isError } = await tool('get_project', { project: 'Alpha' });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ key: 'github.com/me/alpha', state: null, last_synced_at: NOW });
    expect(data.recent[0]).toMatchObject({ session_id: 'claude-code:a1', title: 'Redis cache removal' });
  });

  it('returns candidates instead of guessing', async () => {
    const { data, isError } = await tool('get_project', { project: 'gamma' });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/gamma/);
    expect(data.candidates).toEqual(['github.com/me/alpha', 'local:beta']);
  });
});

describe('search', () => {
  it('returns hits with the session id to open', async () => {
    const { data } = await tool('search', { query: 'hit rate' });
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]).toMatchObject({ session_id: 'claude-code:a1', kind: 'message', seq: 1 });
    expect(data.last_synced_at).toBe(NOW);
  });

  it('filters by project name', async () => {
    const { data } = await tool('search', { query: 'login', project: 'beta' });
    expect(data.hits.every((h: any) => h.project === 'local:beta')).toBe(true);
  });

  it('reports an unknown project as an error with candidates', async () => {
    const { data, isError } = await tool('search', { query: 'x', project: 'gamma' });
    expect(isError).toBe(true);
    expect(data.candidates).toHaveLength(2);
  });
});

describe('get_session', () => {
  it('returns the session with its messages', async () => {
    const { data } = await tool('get_session', { session_id: 'claude-code:a1' });
    expect(data.session).toMatchObject({ session_id: 'claude-code:a1', project: 'github.com/me/alpha', message_count: 2, last_synced_at: NOW });
    expect(data.messages.map((m: any) => m.text)).toEqual(['why did we drop redis', 'low hit rate']);
    expect(data.next_seq).toBeNull();
  });

  it('pages a long session through from_seq', async () => {
    const messages = [text(0, 'user', 'a'.repeat(PAGE_BUDGET - 10)), text(1, 'assistant', 'b'.repeat(100))];
    upsertSession(db, makeSession({ source_session_id: 'long', messages }), NOW);
    const first = await tool('get_session', { session_id: 'claude-code:long' });
    expect(first.data.messages).toHaveLength(1);
    expect(first.data.next_seq).toBe(1);
    const second = await tool('get_session', { session_id: 'claude-code:long', from_seq: 1 });
    expect(second.data.messages[0].seq).toBe(1);
    expect(second.data.next_seq).toBeNull();
  });

  it('reports an unknown or malformed id as an error', async () => {
    expect((await tool('get_session', { session_id: 'claude-code:nope' })).isError).toBe(true);
    const malformed = await tool('get_session', { session_id: 'no-colon' });
    expect(malformed.isError).toBe(true);
    expect(malformed.data.error).toMatch(/<source>:<id>/);
  });
});

describe('save_note', () => {
  let saver: Client;
  let saverClose: () => Promise<void>;

  beforeEach(async () => {
    const started = await startServer({ db, mcp: (req, res, body) => handleMcp(db)(req, res, body, { canSave: true, actor: 'Claude' }), log: () => {} });
    saverClose = started.close;
    saver = await connect(createToken(db, 'chat', 'read', NOW).token, started.url);
  });

  afterEach(async () => {
    await saver.close();
    await saverClose();
  });

  it('a caller that can save sees save_note and can save', async () => {
    const { tools } = await saver.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_session', 'list_projects', 'save_note', 'search']);

    const saved = await callOn(saver, 'save_note', { project: 'alpha', title: 'Deploy steps', text: 'run hub sync, then restart the container' });
    expect(saved.isError).toBe(false);
    expect(saved.data).toMatchObject({ saved: true, project: 'github.com/me/alpha', duplicate: false });
    expect(saved.data.session_id).toMatch(/^note:n_[A-Za-z0-9_-]{22}$/);

    const { data } = await callOn(saver, 'get_project', { project: 'alpha' });
    expect(data.recent.map((s: any) => s.session_id)).toContain(saved.data.session_id);
    expect(data.recent.find((s: any) => s.session_id === saved.data.session_id)).toMatchObject({ source: 'note', title: 'Deploy steps' });
  });

  it('a read-only caller does not see save_note', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_session', 'list_projects', 'search']);
    const before = countSessions();
    const refused = (await client
      .callTool({ name: 'save_note', arguments: { project: 'alpha', title: 'x', text: 'y' } })
      .catch((e: Error) => ({ content: [{ text: e.message }], isError: true }))) as { content: { text: string }[]; isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/save_note not found/);
    expect(countSessions()).toBe(before);
  });

  it('save_note with an unknown or ambiguous project returns the candidates and saves nothing', async () => {
    const before = countSessions();
    const unknown = await callOn(saver, 'save_note', { project: 'gamma', title: 'Note', text: 'nothing to see' });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error).toMatch(/No single project matches "gamma"/);
    expect(unknown.data.candidates).toEqual(['github.com/me/alpha', 'local:beta']);
    expect(countSessions()).toBe(before);

    upsertSession(db, makeSession({ source_session_id: 'd1', project_key: 'local:dup' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'd2', project_key: 'github.com/me/dup' }), NOW);
    const after = countSessions();
    const ambiguous = await callOn(saver, 'save_note', { project: 'dup', title: 'Note', text: 'nothing to see' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.data.candidates.sort()).toEqual(['github.com/me/dup', 'local:dup']);
    expect(countSessions()).toBe(after);
  });

  it('search accepts source note', async () => {
    await callOn(saver, 'save_note', { project: 'beta', title: 'Note', text: 'the flurblewidget needs a rebuild' });
    const { data, isError } = await callOn(saver, 'search', { query: 'flurblewidget', source: 'note' });
    expect(isError).toBe(false);
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0].session_id).toMatch(/^note:/);
    expect((await callOn(saver, 'search', { query: 'flurblewidget', source: 'codex' })).data.hits).toHaveLength(0);
  });
});

describe('tool descriptions', () => {
  it('descriptions name the projects, most recently active first', async () => {
    upsertSession(db, makeSession({ source_session_id: 'b2', project_key: 'local:beta', last_activity_at: '2026-10-09T10:00:00.000Z' }), NOW);
    const betaFirst = await describeTool(client, 'get_project');
    expect(betaFirst).toContain('Projects: beta, alpha.');
    expect(betaFirst).toContain('before searching past chats');

    upsertSession(db, makeSession({ source_session_id: 'a2', last_activity_at: '2026-10-10T10:00:00.000Z' }), NOW);
    expect(await describeTool(client, 'get_project')).toContain('Projects: alpha, beta.');
    expect(await describeTool(client, 'list_projects')).toContain('Projects in the hub: alpha, beta.');
    expect(await describeTool(client, 'search')).toContain('Covers the coding sessions and notes of: alpha, beta.');
  });

  it('builds the description from the database on every request', async () => {
    expect(await describeTool(client, 'get_project')).not.toContain('gamma');
    upsertSession(db, makeSession({ source_session_id: 'g1', project_key: 'local:gamma', last_activity_at: '2026-10-09T10:00:00.000Z' }), NOW);
    expect(await describeTool(client, 'get_project')).toContain('gamma');
  });

  it('lists at most 20 names, and an empty hub says so', async () => {
    for (let i = 0; i < 25; i++) {
      const minute = String(i).padStart(2, '0');
      upsertSession(db, makeSession({ source_session_id: `m${i}`, project_key: `local:p${i}`, last_activity_at: `2026-10-11T10:${minute}:00.000Z` }), NOW);
    }
    const description = await describeTool(client, 'list_projects');
    const names = description.slice(description.indexOf('Projects in the hub: ') + 'Projects in the hub: '.length).replace(/\.$/, '').split(', ');
    expect(names).toHaveLength(20);

    db.exec('DELETE FROM search_index; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
    for (const name of ['list_projects', 'get_project', 'search']) {
      expect(await describeTool(client, name)).toContain('The hub has no projects yet.');
    }
  });
});

/** The descriptions claude.ai chooses tools by. Pinned whole, so no edit changes them by accident. */
describe('the exact description of every tool', () => {
  const NAMES = 'alpha, beta';
  const expected = (names: string): Record<string, string> => ({
    list_projects: `List the user's software projects and their AI coding history (Claude Code, Codex, Antigravity, and notes saved from chats). Projects in the hub: ${names}.`,
    get_project: `Catch up on one of the user's software projects: its current state and recent coding sessions. Call this first whenever the user names one of these projects or asks where they left off, before searching past chats: this history is not in the chat app's own chat history. Projects: ${names}.`,
    search: `Keyword search across all stored conversations. Every word must match; put a phrase in double quotes for an exact match. Covers the coding sessions and notes of: ${names}.`,
    save_note: `Save a short note into one of the user's existing projects, so it is there in later sessions in any tool. Use only when the user asks to save, remember or record something. Save it to the project the user names; a project can share its name with this hub, so "save to context-hub" means the project called context-hub. If the user names no project, or the name could mean more than one, ask which project before saving. Never include passwords, keys, card numbers or phone numbers. Projects: ${names}.`,
  });

  let saver: Client;
  let saverClose: () => Promise<void>;

  beforeEach(async () => {
    // alpha newest, so the order in the pinned strings is the one recency gives.
    upsertSession(db, makeSession({ source_session_id: 'b3', project_key: 'local:beta', last_activity_at: '2026-10-09T10:00:00.000Z' }), NOW);
    upsertSession(db, makeSession({ source_session_id: 'a3', last_activity_at: '2026-10-10T10:00:00.000Z' }), NOW);
    const started = await startServer({ db, mcp: (req, res, body) => handleMcp(db)(req, res, body, { canSave: true, actor: 'Claude' }), log: () => {} });
    saverClose = started.close;
    saver = await connect(createToken(db, 'chat', 'read', NOW).token, started.url);
  });

  afterEach(async () => {
    await saver.close();
    await saverClose();
  });

  it('reads character-for-character as the plan writes it', async () => {
    for (const [name, description] of Object.entries(expected(NAMES))) {
      expect(await describeTool(saver, name)).toBe(description);
    }
    expect(await describeTool(saver, 'get_session')).toBe(
      'Read one stored conversation. Long sessions come in pages: pass next_seq from the previous page as from_seq to continue.',
    );
  });

  it('ends in a single period when the hub is empty', async () => {
    db.exec('DELETE FROM search_index; DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
    for (const [name, description] of Object.entries(expected('The hub has no projects yet'))) {
      const actual = await describeTool(saver, name);
      expect(actual).toBe(description);
      expect(actual).not.toContain('..');
    }
  });
});

describe('instructions: the hub is a briefing, not a live status', () => {
  it('tells the assistant to use these tools when the user names a project', () => {
    expect(INSTRUCTIONS).toContain(
      'When the user names one of their software projects, use these tools rather than searching past chats: coding sessions are stored here, not in the chat app.',
    );
  });

  it('says the record misses changes made outside a conversation, and names the common ones', () => {
    expect(INSTRUCTIONS).toMatch(/outside (a|any) (recorded )?conversation/i);
    expect(INSTRUCTIONS).toMatch(/pull request/i);
    expect(INSTRUCTIONS).toMatch(/branch/i);
  });

  it('tells the assistant to verify before acting when it can, and to say so when it cannot', () => {
    expect(INSTRUCTIONS).toMatch(/verify/i);
    expect(INSTRUCTIONS).toMatch(/before (acting|recommending)/i);
    expect(INSTRUCTIONS).toMatch(/cannot check|can't check|no way to check/i);
  });
});

describe('the activity log', () => {
  const rows = () => listActivity(db, { limit: 50, offset: 0 });
  const only = () => {
    const r = rows();
    expect(r).toHaveLength(1);
    return r[0]!;
  };

  it('list_projects logs an out row for a read token, with no project', async () => {
    await tool('list_projects');
    expect(only()).toMatchObject({ direction: 'out', action: 'list_projects', projectKey: null, sessionRef: null, actor: 'read token: assistant', detail: null });
  });

  it('get_project logs the resolved key', async () => {
    await tool('get_project', { project: 'Alpha' });
    expect(only()).toMatchObject({ direction: 'out', action: 'get_project', projectKey: 'github.com/me/alpha', actor: 'read token: assistant' });
  });

  it('a get_project that finds nothing logs nothing', async () => {
    await tool('get_project', { project: 'gamma' });
    expect(rows()).toEqual([]);
  });

  it('search logs the project key when given, and the query', async () => {
    await tool('search', { query: 'hit rate', project: 'alpha' });
    expect(only()).toMatchObject({ action: 'search', projectKey: 'github.com/me/alpha', detail: 'hit rate' });
  });

  it('search without a project logs no project, and cuts the query to 100 characters', async () => {
    await tool('search', { query: 'word '.repeat(40) });
    const r = only();
    expect(r.projectKey).toBeNull();
    expect(r.detail).toBe(('word '.repeat(40)).slice(0, 100));
  });

  it('a search query holding a GitHub token is logged redacted', async () => {
    const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4) ;
    await tool('search', { query: `find ${secret}` });
    const r = only();
    expect(r.detail).toContain('[REDACTED:github]');
    expect(r.detail).not.toContain(secret);
  });

  it('get_session logs the session ref and its project', async () => {
    await tool('get_session', { session_id: 'claude-code:a1' });
    expect(only()).toMatchObject({ action: 'get_session', sessionRef: 'claude-code:a1', projectKey: 'github.com/me/alpha' });
  });

  it('a get_session that finds nothing logs nothing', async () => {
    await tool('get_session', { session_id: 'claude-code:nope' });
    expect(rows()).toEqual([]);
  });

  it('save_note logs an in row with the title, project and session', async () => {
    const started = await startServer({ db, mcp: (req, res, body) => handleMcp(db)(req, res, body, { canSave: true, actor: 'claude.ai' }), log: () => {} });
    const saver = await connect(createToken(db, 'chat', 'read', NOW).token, started.url);
    try {
      const saved = await callOn(saver, 'save_note', { project: 'alpha', title: 'Deploy steps', text: 'run hub sync' });
      expect(only()).toMatchObject({
        direction: 'in',
        action: 'note',
        projectKey: 'github.com/me/alpha',
        sessionRef: saved.data.session_id,
        actor: 'claude.ai',
        detail: 'Deploy steps',
      });
    } finally {
      await saver.close();
      await started.close();
    }
  });

  it('save_note logs the cleaned title, not the raw one', async () => {
    const started = await startServer({ db, mcp: (req, res, body) => handleMcp(db)(req, res, body, { canSave: true, actor: 'claude.ai' }), log: () => {} });
    const saver = await connect(createToken(db, 'chat', 'read', NOW).token, started.url);
    const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
    try {
      await callOn(saver, 'save_note', { project: 'alpha', title: `  key ${secret}  `, text: 'body' });
      const r = only();
      expect(r.detail).toContain('[REDACTED:github]');
      expect(r.detail).not.toContain(secret);
      expect(r.detail).toBe(r.detail!.trim());
    } finally {
      await saver.close();
      await started.close();
    }
  });

  it('an OAuth caller is named by its client', async () => {
    const started = await startServer({ db, mcp: handleMcp(db), oauth: { publicUrl: 'https://hub.test' }, log: () => {} });
    const grantId = createGrant(db, { clientId: 'c1', clientName: 'claude.ai', scopes: ['hub.read'] }, new Date().toISOString());
    const c = await connect(issueTokens(db, grantId, false, new Date().toISOString()).access, started.url);
    try {
      await callOn(c, 'list_projects');
      expect(only()).toMatchObject({ action: 'list_projects', actor: 'claude.ai' });
    } finally {
      await c.close();
      await started.close();
    }
  });

  it('a failure to log never fails the tool', async () => {
    db.exec('DROP TABLE activity');
    const { isError, data } = await tool('list_projects');
    expect(isError).toBe(false);
    expect(data.projects).toHaveLength(2);
  });
});
