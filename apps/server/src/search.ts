import type { Db } from './db.js';
import { publicId } from './store.js';

/**
 * Turns what a person typed into an FTS5 query in which every word or quoted
 * phrase is a literal term. Operators such as AND, NEAR, *, -, ^ and column
 * filters lose their meaning, so no input can be a syntax error.
 */
export function toFtsQuery(input: string): string | null {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  // Control characters (NUL above all) can end the query string early inside SQLite.
  const cleaned = input.replace(/[\x00-\x1f\x7f]/g, ' ');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const term = (m[1] ?? m[2] ?? '').replace(/"/g, ' ').trim();
    if (term !== '') terms.push(`"${term}"`);
  }
  return terms.length > 0 ? terms.join(' ') : null;
}

export interface SearchOptions {
  query: string;
  projectId?: number;
  source?: string;
  /** YYYY-MM-DD, inclusive. */
  since?: string;
  /** YYYY-MM-DD, inclusive. */
  until?: string;
  limit?: number;
}

export interface SearchHit {
  session_id: string;
  project: string;
  source: string;
  title: string;
  last_activity_at: string | null;
  kind: 'digest' | 'title' | 'message' | 'tool';
  /** Message position. Null for a title or digest hit. */
  seq: number | null;
  snippet: string;
  is_subagent: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Digest hits come first, then titles, then messages and tool calls. Each tier is its own ranked
 * query, so a common word is answered from the digests without ranking every message it is in.
 */
const TIERS = ['kind : "digest"', 'kind : "title"', '( kind : "message" OR kind : "tool" )'];

export function search(db: Db, opts: SearchOptions): SearchHit[] {
  const fts = toFtsQuery(opts.query);
  if (fts === null) return [];

  // The words are matched in the body only, and the kind column weighs nothing in the rank.
  const where = ['search_index MATCH ?', "rank MATCH 'bm25(1.0, 0.0)'"];
  const params: (string | number)[] = [];
  if (opts.projectId !== undefined) {
    where.push('s.project_id = ?');
    params.push(opts.projectId);
  }
  if (opts.source) {
    where.push('s.source = ?');
    params.push(opts.source);
  }
  if (opts.since && DATE.test(opts.since)) {
    where.push('substr(s.last_activity_at, 1, 10) >= ?');
    params.push(opts.since.slice(0, 10));
  }
  if (opts.until && DATE.test(opts.until)) {
    where.push('substr(s.last_activity_at, 1, 10) <= ?');
    params.push(opts.until.slice(0, 10));
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const tier = db.prepare(
    `SELECT s.source, s.source_session_id, s.title, s.last_activity_at, s.parent, p.key AS project,
            search_index.kind AS kind, search_index.seq AS seq,
            snippet(search_index, 0, '[', ']', '…', 24) AS snippet
     FROM search_index
     JOIN sessions s ON s.id = CAST(search_index.session_id AS INTEGER)
     JOIN projects p ON p.id = s.project_id
     WHERE ${where.join(' AND ')}
     ORDER BY rank
     LIMIT ?`,
  );
  const rows: {
    source: string;
    source_session_id: string;
    title: string;
    last_activity_at: string | null;
    parent: string | null;
    project: string;
    kind: SearchHit['kind'];
    seq: number;
    snippet: string;
  }[] = [];
  for (const kinds of TIERS) {
    if (rows.length >= limit) break;
    rows.push(...(tier.all(`body : ( ${fts} ) AND ${kinds}`, ...params, limit - rows.length) as typeof rows));
  }

  return rows.map((r) => ({
    session_id: publicId(r.source, r.source_session_id),
    project: r.project,
    source: r.source,
    title: r.title,
    last_activity_at: r.last_activity_at,
    kind: r.kind,
    seq: r.kind === 'message' || r.kind === 'tool' ? Number(r.seq) : null,
    snippet: r.snippet,
    is_subagent: r.parent !== null,
  }));
}
