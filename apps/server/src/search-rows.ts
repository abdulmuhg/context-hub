import type { Db } from './db.js';

/**
 * A search row's rowid is made from its session: the session's id times SLOTS, plus 0 for the
 * title, 1 for the digest and 2 + seq for a message. A session's rows are then found by rowid;
 * a lookup by session_id would read every row of the index. Migration 12 uses the same numbers.
 */
const SLOTS = 2 ** 24;
const TITLE = 0;
const DIGEST = 1;

/** The highest message seq that still fits inside its session's rowids. */
export const MAX_SEQ = SLOTS - 3;

export type SearchKind = 'title' | 'digest' | 'message' | 'tool';

function rowid(sessionRowId: number, slot: number): number {
  return sessionRowId * SLOTS + slot;
}

/** Returns a function that adds rows to the search index, for writing many rows with one statement. */
export function searchRowWriter(db: Db): (sessionRowId: number, kind: SearchKind, seq: number, body: string) => void {
  const insert = db.prepare('INSERT INTO search_index(rowid, body, kind, session_id, seq) VALUES (?, ?, ?, ?, ?)');
  return (sessionRowId, kind, seq, body) => {
    if (seq > MAX_SEQ) throw new Error(`search row: seq ${seq} is above ${MAX_SEQ}`);
    const slot = kind === 'title' ? TITLE : kind === 'digest' ? DIGEST : seq + 2;
    insert.run(rowid(sessionRowId, slot), body, kind, sessionRowId, seq);
  };
}

/**
 * The session's rowids are listed from FTS5's docsize table, a plain table with one row per
 * search row: FTS5 itself checks a rowid range against every row, only an equal rowid is fast.
 */
export function deleteSearchRows(db: Db, sessionRowId: number): void {
  db.prepare('DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_docsize WHERE id >= ? AND id < ?)').run(
    rowid(sessionRowId, 0),
    rowid(sessionRowId + 1, 0),
  );
}

export function deleteDigestRow(db: Db, sessionRowId: number): void {
  db.prepare('DELETE FROM search_index WHERE rowid = ?').run(rowid(sessionRowId, DIGEST));
}
