import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, pushText, readLines, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

/** Record types that carry no conversation content. Anything else unknown is counted. */
const IGNORED_RECORDS = new Set([
  'queue-operation',
  'attachment',
  'last-prompt',
  'system',
  'summary',
  'file-history-snapshot',
  'file-history-delta',
  'mode',
  'agent-name',
  'atis-latch',
  'bridge-session',
]);

function discover(home: string): SessionFile[] {
  const root = join(home, '.claude', 'projects');
  const out: SessionFile[] = [];
  if (!existsSync(root)) return out;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(sessionFile('claude-code', join(dir, entry.name), basename(entry.name, '.jsonl'), null));
      } else if (entry.isDirectory()) {
        const sub = join(dir, entry.name, 'subagents');
        if (!existsSync(sub)) continue;
        for (const name of readdirSync(sub)) {
          if (!name.endsWith('.jsonl')) continue;
          out.push(
            sessionFile('claude-code', join(sub, name), `${entry.name}/${basename(name, '.jsonl')}`, entry.name),
          );
        }
      }
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  const pending = new Map<string, ToolCallMessage>();

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    // The account id is written on bridge-session records, not on the messages,
    // so read it from whichever record carries it before any record is skipped.
    if (typeof r?.ownerAccountUuid === 'string' && r.ownerAccountUuid !== '') raw.account_id ??= r.ownerAccountUuid;
    if (r?.type === 'custom-title' && typeof r.customTitle === 'string') {
      raw.title = r.customTitle;
      continue;
    }
    if (r?.type !== 'user' && r?.type !== 'assistant') {
      if (!IGNORED_RECORDS.has(r?.type)) raw.warnings.unknown_records++;
      continue;
    }

    raw.cwd ??= typeof r.cwd === 'string' ? r.cwd : null;
    raw.account_id ??= typeof r.ownerAccountUuid === 'string' ? r.ownerAccountUuid : null;
    if (typeof r.gitBranch === 'string' && r.gitBranch !== '') raw.git_branch = r.gitBranch;
    if (r.isMeta === true) continue;

    const role: 'user' | 'assistant' = r.type;
    const ts: string | null = typeof r.timestamp === 'string' ? r.timestamp : null;
    const content = r.message?.content;

    if (typeof content === 'string') {
      pushText(raw, role, ts, content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      switch (block?.type) {
        case 'text':
          pushText(raw, role, ts, typeof block.text === 'string' ? block.text : '');
          break;
        case 'thinking':
        case 'redacted_thinking':
          break; // never uploaded, by design
        case 'tool_use': {
          const call: ToolCallMessage = {
            seq: raw.messages.length,
            role: 'assistant',
            kind: 'tool_call',
            ts,
            tool_name: String(block.name ?? 'unknown'),
            tool_input: JSON.stringify(block.input ?? {}),
            tool_result: '',
            tool_status: 'ok',
          };
          raw.messages.push(call);
          if (typeof block.id === 'string') pending.set(block.id, call);
          break;
        }
        case 'tool_result': {
          const call = pending.get(block.tool_use_id);
          if (!call) {
            raw.warnings.dropped_blocks++;
            break;
          }
          call.tool_result = resultText(block.content);
          if (block.is_error === true) call.tool_status = 'error';
          break;
        }
        default:
          // image, server_tool_use, advisor_tool_result and anything new
          raw.warnings.dropped_blocks++;
      }
    }
  }
  return raw;
}

export const claudeCode: Adapter = { source: 'claude-code', discover, read };
