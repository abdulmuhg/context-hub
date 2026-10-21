import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { getDigest, getProjectState, nextDueDigest, saveProjectState } from '../src/digest-store.js';
import { saveNote } from '../src/notes.js';
import { search } from '../src/search.js';
import { getSessionPage, splitPublicId, upsertSession } from '../src/store.js';
import { makeSession } from './helpers.js';

const NOW = '2026-10-20T10:00:00.000Z';
let db: Db;

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  upsertSession(db, makeSession(), NOW);
});

describe('saveNote', () => {
  it('saves a note into an existing project', () => {
    const r = saveNote(db, { project: 'alpha', title: 'Pick Postgres', text: 'We chose Postgres for the queue.' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session_id).toMatch(/^note:n_[A-Za-z0-9_-]{22}$/);
    expect(r.project).toBe('github.com/me/alpha');
    expect(r.duplicate).toBe(false);
    const id = splitPublicId(r.session_id)!;
    const page = getSessionPage(db, id.source, id.id, 0)!;
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ role: 'user', kind: 'text', text: 'We chose Postgres for the queue.' });
  });

  it('refuses an unknown project and saves nothing', () => {
    const before = count();
    const r = saveNote(db, { project: 'hub', title: 'T', text: 'x' }, NOW);
    expect(r).toMatchObject({ ok: false, error: 'unknown_project' });
    expect(count()).toBe(before);
  });

  it('refuses an empty or over-long title or text', () => {
    const before = count();
    const bad: [{ title: string; text: string }, string, string][] = [
      [{ title: '', text: 'x' }, 'title', '200'],
      [{ title: 'a'.repeat(201), text: 'x' }, 'title', '200'],
      [{ title: 'T', text: '   ' }, 'text', '20,000'],
      [{ title: 'T', text: 'a'.repeat(20001) }, 'text', '20,000'],
    ];
    for (const [input, field, limit] of bad) {
      const r = saveNote(db, { project: 'alpha', ...input }, NOW);
      expect(r).toMatchObject({ ok: false, error: 'invalid' });
      if (r.ok || r.error !== 'invalid') throw new Error('expected invalid');
      expect(r.message).toContain(field);
      expect(r.message).toContain(limit);
    }
    expect(count()).toBe(before);
  });

  it('strips secrets and masks card numbers', () => {
    const secret = 'gh' + 'p_' + 'a'.repeat(36);
    const r = saveNote(db, { project: 'alpha', title: 'Keys', text: `token ${secret} and card 4242424242424242 here` }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    const id = splitPublicId(r.session_id)!;
    const stored = JSON.stringify(getSessionPage(db, id.source, id.id, 0));
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('4242424242424242');
  });

  // Review Focus 1
  it('a retry within 10 minutes returns the first note', () => {
    const input = { project: 'alpha', title: 'Same', text: 'same text' };
    const first = saveNote(db, input, NOW);
    const retry = saveNote(db, input, '2026-10-20T10:09:59.000Z');
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.session_id).toBe(first.session_id);
    expect(retry.duplicate).toBe(true);
    const later = saveNote(db, input, '2026-10-20T10:10:01.000Z');
    expect(later.ok && later.session_id !== first.session_id && !later.duplicate).toBe(true);
  });

  // Review Focus 4
  it('a note is searchable at once', () => {
    saveNote(db, { project: 'alpha', title: 'Idea', text: 'the unusualword is here' }, NOW);
    const hits = search(db, { query: 'unusualword' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.session_id.startsWith('note:')).toBe(true);
  });
});

describe('saveNote digest', () => {
  it('writes its digest at save time, with no worker and no key', () => {
    const project = (db.prepare('SELECT id FROM projects').get() as { id: number }).id;
    saveProjectState(db, project, { summary: 's', body: 'b', model: 'm' }, NOW, true);
    const r = saveNote(db, { project: 'alpha', title: 'Pick Postgres', text: 'We chose Postgres for the queue.' }, NOW);
    if (!r.ok) throw new Error('note not saved');
    const row = (db.prepare('SELECT id FROM sessions WHERE source = ?').get('note') as { id: number }).id;
    const d = getDigest(db, row)!;
    expect(d).toMatchObject({ status: 'ok', model: 'note' });
    expect(d.text).toBe('Note saved from a chat: Pick Postgres\nWe chose Postgres for the queue.');
    expect(nextDueDigest(db, NOW)?.source).toBe('claude-code'); // only the ordinary session is still due
    expect(search(db, { query: '"Note saved from a chat"' }).some((h) => h.kind === 'digest' && h.session_id === r.session_id)).toBe(true);
    expect(getProjectState(db, project)!.dirty).toBe(true);
  });
});
