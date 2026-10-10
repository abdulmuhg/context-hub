import { readFileSync, statSync } from 'node:fs';
import type { Message, Source } from '@context-hub/core';

export interface SessionFile {
  source: Source;
  /** The tool's session id. For a subagent: "<parent id>/<file name>". */
  id: string;
  path: string;
  parent: string | null;
  size: number;
  mtimeMs: number;
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
  cwd: string | null;
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
