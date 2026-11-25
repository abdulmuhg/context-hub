import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, pushText, readLines, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

/** Preferred first: a conversation mirrored in several roots is taken from the first. */
const ROOTS = ['antigravity-ide', 'antigravity-cli', 'antigravity', 'antigravity-backup'];
const BOOKKEEPING = new Set(['EPHEMERAL_MESSAGE', 'SYSTEM_MESSAGE', 'CONVERSATION_HISTORY', 'KNOWLEDGE_ARTIFACTS', 'CHECKPOINT']);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;
const USER_REQUEST_ENVELOPE = /<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>/;

function readTitle(transcriptPath: string, id: string): string | null {
  const rootDir = dirname(dirname(dirname(dirname(dirname(transcriptPath)))));
  const pbtxt = join(rootDir, 'annotations', `${id}.pbtxt`);
  if (!existsSync(pbtxt)) return null;
  try {
    const m = /\btitle:"((?:[^"\\]|\\.)*)"/.exec(readFileSync(pbtxt, 'utf8'));
    const title = m?.[1]?.replace(/\\(.)/g, '$1').trim();
    return title || null;
  } catch {
    return null;
  }
}

function cleanUserInput(content: string): string {
  const m = USER_REQUEST_ENVELOPE.exec(content);
  return m ? m[1]! : content;
}

function discover(home: string): SessionFile[] {
  const seen = new Set<string>();
  const out: SessionFile[] = [];
  for (const root of ROOTS) {
    const brain = join(home, '.gemini', root, 'brain');
    if (!existsSync(brain)) continue;
    for (const entry of readdirSync(brain, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const transcript = join(brain, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!existsSync(transcript)) continue;
      seen.add(entry.name);
      out.push(sessionFile('antigravity', transcript, entry.name, null));
    }
  }
  return out;
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  raw.title = readTitle(file.path, file.id);
  /** Tool calls still waiting for the step that carries their result. */
  const waiting: ToolCallMessage[] = [];

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    const running = r?.status === 'RUNNING';
    const ts: string | null = typeof r?.created_at === 'string' ? r.created_at : null;
    const content: string = typeof r?.content === 'string' ? r.content : '';

    if (r?.type === 'USER_INPUT') {
      if (!running) pushText(raw, 'user', ts, cleanUserInput(content));
      continue;
    }
    if (r?.type === 'PLANNER_RESPONSE') {
      if (running) continue; // an unfinished step would upload half a turn
      pushText(raw, 'assistant', ts, content);
      for (const tc of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        for (const value of Object.values(args)) {
          if (typeof value === 'string' && ABSOLUTE_PATH.test(value)) raw.path_hints.push(value);
        }
        const call: ToolCallMessage = {
          seq: raw.messages.length,
          role: 'assistant',
          kind: 'tool_call',
          ts,
          tool_name: String(tc?.name ?? 'unknown'),
          tool_input: JSON.stringify(args),
          tool_result: '',
          tool_status: 'ok',
        };
        raw.messages.push(call);
        waiting.push(call);
      }
      continue;
    }
    if (typeof r?.type !== 'string' || BOOKKEEPING.has(r.type)) continue;

    // Any other step is the outcome of the oldest tool call still waiting; keep alignment even while RUNNING.
    const call = waiting.shift();
    if (!call || running) continue;
    call.tool_result = content;
    if (r.status === 'ERROR') call.tool_status = 'error';
  }
  return raw;
}

export const antigravity: Adapter = { source: 'antigravity', discover, read };
