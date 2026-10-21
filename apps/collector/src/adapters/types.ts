import { readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Message, Source } from '@context-hub/core';

export interface SessionFile {
  source: Source;
  /** The tool's session id. For a subagent: "<parent id>/<file name>". */
  id: string;
  path: string;
  parent: string | null;
  size: number;
  mtimeMs: number;
  /** Set when the project is known without reading the file, as for a document. */
  project_key?: string;
}

export interface Warnings {
  bad_lines: number;
  unknown_records: number;
  dropped_blocks: number;
}

export interface RawSession {
  source: Source;
  source_session_id: string;
  account_id: string | null;
  parent: string | null;
  title: string | null;
  /** The folder used most (see `cwds`). Uploaded as the session's folder. */
  cwd: string | null;
  /** The folder of every record, in order. The project is decided by vote over these. */
  cwds: string[];
  git_branch: string | null;
  remote_hint: string | null;
  path_hints: string[];
  /** Uncapped and unsanitised. seq is the position in this list. */
  messages: Message[];
  warnings: Warnings;
}

export interface Adapter {
  source: Source;
  /** Lists session files under the user's home folder. Reads no content. */
  discover(home: string): SessionFile[];
  read(file: SessionFile): RawSession;
}

/** A file, or a link to one. */
export function isFileEntry(dir: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  return entry.isSymbolicLink() && (statSync(join(dir, entry.name), { throwIfNoEntry: false })?.isFile() ?? false);
}

/** A folder, or a link to one. Only for walks of fixed depth, where a link cannot loop. */
export function isDirEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  return entry.isSymbolicLink() && (statSync(join(dir, entry.name), { throwIfNoEntry: false })?.isDirectory() ?? false);
}

export function sessionFile(source: Source, path: string, id: string, parent: string | null): SessionFile {
  const st = statSync(path);
  return { source, id, path, parent, size: st.size, mtimeMs: st.mtimeMs };
}

export function emptyRaw(file: SessionFile): RawSession {
  return {
    source: file.source,
    source_session_id: file.id,
    account_id: null,
    parent: file.parent,
    title: null,
    cwd: null,
    cwds: [],
    git_branch: null,
    remote_hint: null,
    path_hints: [],
    messages: [],
    warnings: { bad_lines: 0, unknown_records: 0, dropped_blocks: 0 },
  };
}

export function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

export function pushText(raw: RawSession, role: 'user' | 'assistant', ts: string | null, text: string): void {
  if (text.trim() === '') return;
  raw.messages.push({ seq: raw.messages.length, role, kind: 'text', ts, text });
}

/** Note the folder one record ran in. */
export function recordCwd(raw: RawSession, cwd: unknown): void {
  if (typeof cwd === 'string' && cwd !== '') raw.cwds.push(cwd);
}

/** The folder used most; on a tie, the one used last. */
export function mostUsed(paths: readonly string[]): string | null {
  const seen = new Map<string, { count: number; last: number }>();
  paths.forEach((p, i) => {
    const s = seen.get(p) ?? { count: 0, last: 0 };
    seen.set(p, { count: s.count + 1, last: i });
  });
  let best: string | null = null;
  let bestScore = { count: 0, last: -1 };
  for (const [p, s] of seen) {
    if (s.count > bestScore.count || (s.count === bestScore.count && s.last > bestScore.last)) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}
