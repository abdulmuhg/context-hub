import { randomBytes } from 'node:crypto';
import { contentHash, filterPersonal, stripSecrets, type Session } from '@context-hub/core';
import type { Db } from './db.js';
import { publicId, resolveProject, upsertSession } from './store.js';

export const NOTE_TITLE_MAX = 200;
export const NOTE_TEXT_MAX = 20000;
/** A repeat of the same note inside this window is a retry, not a new note. */
const DEDUPE_MS = 10 * 60 * 1000;

export type SaveNoteResult =
  | { ok: true; session_id: string; project: string; title: string; duplicate: boolean; redactions: number }
  | { ok: false; error: 'unknown_project'; candidates: string[] }
  | { ok: false; error: 'invalid'; message: string };

// A card number in a note saved from a chat is always an accident, so it is masked.
const PERSONAL = { card: 'partial', list: 'off', entries: [] } as const;

function clean(value: string): { text: string; redactions: number } {
  const a = stripSecrets(value);
  const b = filterPersonal(a.text, { ...PERSONAL, entries: [] });
  const sum = (o: Record<string, number>) => Object.values(o).reduce((n, v) => n + v, 0);
  return { text: b.text, redactions: sum(a.counts) + sum(b.findings) };
}

export function saveNote(db: Db, input: { project: string; title: string; text: string }, now: string): SaveNoteResult {
  const title = input.title.trim();
  const body = input.text.trim();
  if (title.length < 1 || title.length > NOTE_TITLE_MAX) {
    return { ok: false, error: 'invalid', message: `title must be 1 to ${NOTE_TITLE_MAX} characters` };
  }
  if (body.length < 1 || body.length > NOTE_TEXT_MAX) {
    return { ok: false, error: 'invalid', message: `text must be 1 to ${NOTE_TEXT_MAX.toLocaleString('en-US')} characters` };
  }

  const project = resolveProject(db, input.project);
  if (!project.ok) return { ok: false, error: 'unknown_project', candidates: project.candidates };

  const t = clean(title);
  const b = clean(body);
  const redactions = t.redactions + b.redactions;

  const cutoff = new Date(Date.parse(now) - DEDUPE_MS).toISOString();
  const prior = db
    .prepare(
      `SELECT s.source_session_id AS id FROM sessions s JOIN messages m ON m.session_id = s.id
       WHERE s.source = 'note' AND s.project_id = ? AND s.title = ? AND s.started_at >= ? AND m.seq = 0 AND m.text = ?
       ORDER BY s.started_at DESC LIMIT 1`,
    )
    .get(project.id, t.text, cutoff, b.text) as { id: string } | undefined;
  if (prior) {
    return { ok: true, session_id: publicId('note', prior.id), project: project.key, title: t.text, duplicate: true, redactions };
  }

  const id = 'n_' + randomBytes(16).toString('base64url');
  const session: Session = {
    source: 'note',
    source_session_id: id,
    account_id: null,
    project_key: project.key,
    parent: null,
    title: t.text,
    cwd: null,
    git_branch: null,
    started_at: now,
    last_activity_at: now,
    messages: [{ seq: 0, role: 'user', kind: 'text', ts: now, text: b.text }],
  };
  upsertSession(db, { ...session, content_hash: contentHash(session) }, now);
  return { ok: true, session_id: publicId('note', id), project: project.key, title: t.text, duplicate: false, redactions };
}
