export type Source = 'claude-code' | 'codex' | 'antigravity';
export type ToolStatus = 'ok' | 'error';

export interface TextMessage {
  seq: number;
  role: 'user' | 'assistant';
  kind: 'text';
  ts: string | null;
  text: string;
}

export interface ToolCallMessage {
  seq: number;
  role: 'assistant';
  kind: 'tool_call';
  ts: string | null;
  tool_name: string;
  tool_input: string;
  tool_result: string;
  tool_status: ToolStatus;
}

export type Message = TextMessage | ToolCallMessage;

export interface Session {
  source: Source;
  source_session_id: string;
  account_id: string | null;
  project_key: string;
  /** For a subagent transcript: the source_session_id of its main session. */
  parent: string | null;
  title: string;
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  messages: Message[];
}

export interface HashedSession extends Session {
  content_hash: string;
}

/** What sanitizeSession accepts: title may be missing, times are derived. */
export type SessionInput = Omit<Session, 'title' | 'started_at' | 'last_activity_at'> & {
  title: string | null;
};
