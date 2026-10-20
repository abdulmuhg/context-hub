import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, mostUsed, pushText, readLines, recordCwd, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
  }
}

function discover(home: string): SessionFile[] {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  walk(root, paths);
  return paths.map((p) => {
    const stem = basename(p, '.jsonl');
    return sessionFile('codex', p, UUID_AT_END.exec(stem)?.[1] ?? stem, null);
  });
}

type Kind = 'session_meta' | 'turn_context' | 'response_item' | 'event_msg' | 'ignored' | 'unknown';
const WRAPPED = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg']);

/** Works out what a line is in both the wrapped and the older bare format. */
function classify(r: any): { kind: Kind; body: any; ts: string | null } {
  const wrapped = r && typeof r.type === 'string' && r.payload && typeof r.payload === 'object';
  if (wrapped) {
    const kind = WRAPPED.has(r.type) ? (r.type as Kind) : 'unknown';
    return { kind, body: r.payload, ts: typeof r.timestamp === 'string' ? r.timestamp : null };
  }
  if (r && typeof r.type === 'string') return { kind: 'response_item', body: r, ts: null };
  if (r && typeof r.id === 'string' && typeof r.timestamp === 'string') return { kind: 'session_meta', body: r, ts: null };
  if (r && 'record_type' in r) return { kind: 'ignored', body: r, ts: null };
  return { kind: 'unknown', body: r, ts: null };
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t !== '')
    .join('\n');
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  const pending = new Map<string, ToolCallMessage>();

  const item = (p: any, ts: string | null): void => {
    switch (p?.type) {
      case 'message': {
        if (p.role !== 'user' && p.role !== 'assistant') return;
        const text = messageText(p.content);
        if (p.role === 'user' && text.trimStart().startsWith('<environment_context')) return;
        pushText(raw, p.role, ts, text);
        return;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const input = p.arguments ?? p.input ?? p.action ?? {};
        const call: ToolCallMessage = {
          seq: raw.messages.length,
          role: 'assistant',
          kind: 'tool_call',
          ts,
          tool_name: String(p.name ?? p.type),
          tool_input: typeof input === 'string' ? input : JSON.stringify(input),
          tool_result: '',
          tool_status: 'ok',
        };
        raw.messages.push(call);
        if (typeof p.call_id === 'string') pending.set(p.call_id, call);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const call = pending.get(p.call_id);
        if (!call) {
          raw.warnings.dropped_blocks++;
          return;
        }
        let text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.output === 'string') {
            text = parsed.output;
            const code = parsed.metadata?.exit_code;
            if (typeof code === 'number' && code !== 0) call.tool_status = 'error';
          }
        } catch {
          // plain text output
        }
        call.tool_result = text;
        return;
      }
      case 'reasoning':
        return; // encrypted, never uploaded
      default:
        raw.warnings.dropped_blocks++;
    }
  };

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    const { kind, body, ts } = classify(r);
    switch (kind) {
      case 'session_meta':
        recordCwd(raw, body.cwd);
        if (typeof body.git?.repository_url === 'string') raw.remote_hint = body.git.repository_url;
        if (typeof body.git?.branch === 'string') raw.git_branch = body.git.branch;
        break;
      case 'turn_context':
        recordCwd(raw, body.cwd);
        break;
      case 'response_item':
        item(body, ts);
        break;
      case 'event_msg': // repeats response_item for the UI
      case 'ignored':
        break;
      default:
        raw.warnings.unknown_records++;
    }
  }
  raw.cwd = mostUsed(raw.cwds);
  return raw;
}

export const codex: Adapter = { source: 'codex', discover, read };
