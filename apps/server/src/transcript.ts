import type { Message } from '@context-hub/core';
import type { DigestBody } from './digest-store.js';

/** Tool calls are context for the digest, not its subject; a short form is enough. */
export const TOOL_FIELD_CAP = 500;

function cut(s: string): string {
  return s.length <= TOOL_FIELD_CAP ? s : s.slice(0, TOOL_FIELD_CAP) + '…';
}

/** One entry per message, prefixed with its position so the model can cite it. */
export function renderLines(messages: Message[]): string[] {
  return messages.map((m) =>
    m.kind === 'text'
      ? `[${m.seq}] ${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`
      : `[${m.seq}] TOOL ${m.tool_name}(${cut(m.tool_input)}) -> ${m.tool_status}: ${cut(m.tool_result)}`,
  );
}

/**
 * Joins entries into parts of at most maxChars. Splits between entries where it
 * can; an entry longer than the limit on its own is cut by characters.
 */
export function splitParts(lines: string[], maxChars: number): string[] {
  if (maxChars < 1) throw new Error('splitParts: the limit must be at least 1 character');
  const parts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') parts.push(current);
    current = '';
  };
  for (const line of lines) {
    if (line.length > maxChars) {
      flush();
      for (let i = 0; i < line.length; i += maxChars) parts.push(line.slice(i, i + maxChars));
      continue;
    }
    if (current !== '' && current.length + 1 + line.length > maxChars) flush();
    current = current === '' ? line : current + '\n' + line;
  }
  flush();
  return parts;
}

const at = (seq: number | null): string => (seq === null ? '' : ` (#${seq})`);

/** The readable form of a digest: what is stored, searched and shown to assistants. */
export function renderDigest(body: DigestBody): string {
  const out = [`Goal: ${body.goal}`];
  if (body.done.length > 0) out.push('Done:', ...body.done.map((d) => `- ${d.text}${at(d.seq)}`));
  if (body.decisions.length > 0) out.push('Decisions:', ...body.decisions.map((d) => `- ${d.what} — because ${d.why}${at(d.seq)}`));
  if (body.open_items.length > 0) out.push('Open:', ...body.open_items.map((d) => `- ${d.text}${at(d.seq)}`));
  if (body.key_refs.length > 0) out.push(`Refs: ${body.key_refs.join(', ')}`);
  return out.join('\n');
}
