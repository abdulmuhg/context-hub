import { contentHash } from './hash.js';
import { filterPersonal, type PersonalConfig } from './personal.js';
import { stripSecrets } from './secrets.js';
import type { HashedSession, Message, Session, SessionInput } from './types.js';

export const TOOL_INPUT_CAP = 2000;
export const TOOL_RESULT_HEAD = 1500;
export const TOOL_RESULT_TAIL = 500;
export const TITLE_MAX = 80;

export interface SanitizeResult {
  session: HashedSession;
  secrets: Record<string, number>;
  personal: Record<string, number>;
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

function capResult(s: string): string {
  if (s.length <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL) return s;
  return s.slice(0, TOOL_RESULT_HEAD) + s.slice(-TOOL_RESULT_TAIL);
}

export function sanitizeSession(input: SessionInput, personal: PersonalConfig): SanitizeResult {
  const secrets: Record<string, number> = {};
  const found: Record<string, number> = {};

  // Strip and filter the full text first, cap afterwards, so a secret that
  // straddles the cap is still seen whole.
  const clean = (s: string): string => {
    const a = stripSecrets(s);
    add(secrets, a.counts);
    const b = filterPersonal(a.text, personal);
    add(found, b.findings);
    return b.text;
  };

  const messages: Message[] = input.messages.map((m, seq) =>
    m.kind === 'text'
      ? { ...m, seq, text: clean(m.text) }
      : {
          ...m,
          seq,
          tool_input: clean(m.tool_input).slice(0, TOOL_INPUT_CAP),
          tool_result: capResult(clean(m.tool_result)),
        },
  );

  // A derived title reuses the already-cleaned message, so nothing is counted twice.
  const firstUser = messages.find((m) => m.kind === 'text' && m.role === 'user');
  const titleSource = input.title !== null ? clean(input.title) : firstUser?.kind === 'text' ? firstUser.text : '';
  const title = titleSource.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '(untitled)';

  const times = messages.map((m) => m.ts).filter((t): t is string => t !== null).sort();

  const session: Session = {
    source: input.source,
    source_session_id: input.source_session_id,
    account_id: input.account_id,
    project_key: input.project_key,
    parent: input.parent,
    title,
    cwd: input.cwd,
    git_branch: input.git_branch,
    started_at: times[0] ?? null,
    last_activity_at: times[times.length - 1] ?? null,
    messages,
  };

  return { session: { ...session, content_hash: contentHash(session) }, secrets, personal: found };
}
