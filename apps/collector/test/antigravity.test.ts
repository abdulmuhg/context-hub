import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { antigravity } from '../src/adapters/antigravity.js';
import { ALL_ADAPTERS } from '../src/adapters/index.js';
import { tempDir, writeJsonl } from './helpers.js';

const CID = '33333333-3333-4333-8333-333333333333';
const T = '2026-10-03T08:00:00Z';
let n = 0;
const step = (type: string, extra: Record<string, unknown> = {}) => ({
  step_index: n++,
  source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  type,
  status: 'DONE',
  created_at: T,
  ...extra,
});

function put(home: string, root: string, id: string, records: unknown[]): void {
  writeJsonl(join(home, '.gemini', root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), records);
}
const read = (records: unknown[]) => {
  const h = tempDir();
  put(h, 'antigravity-ide', CID, records);
  return antigravity.read(antigravity.discover(h)[0]);
};

describe('antigravity.discover', () => {
  it('uses the folder name as the id and stores a mirrored conversation once', () => {
    const h = tempDir();
    put(h, 'antigravity-ide', CID, [step('USER_INPUT', { content: 'hi' })]);
    put(h, 'antigravity', CID, [step('USER_INPUT', { content: 'hi' })]);
    put(h, 'antigravity-backup', CID, [step('USER_INPUT', { content: 'hi' })]);
    const files = antigravity.discover(h);
    expect(files.map((f) => f.id)).toEqual([CID]);
    expect(files[0].path).toContain('antigravity-ide');
  });

  it('returns nothing when the tool is not installed', () => {
    expect(antigravity.discover(tempDir())).toEqual([]);
  });
});

describe('antigravity.read', () => {
  it('reads user input and planner text', () => {
    const raw = read([step('USER_INPUT', { content: 'add dark mode' }), step('PLANNER_RESPONSE', { content: 'I will start.' })]);
    expect(raw).toMatchObject({ source: 'antigravity', source_session_id: CID, cwd: null });
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: T, text: 'add dark mode' },
      { seq: 1, role: 'assistant', kind: 'text', ts: T, text: 'I will start.' },
    ]);
  });

  it('turns planner tool calls into tool_call messages and attaches the following step as the result', () => {
    const raw = read([
      step('PLANNER_RESPONSE', {
        thinking: 'private',
        tool_calls: [{ name: 'list_dir', args: { DirectoryPath: 'C:\\work\\demo\\src', toolSummary: 'List' } }],
      }),
      step('LIST_DIRECTORY', { content: 'a.ts\nb.ts' }),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: T,
        tool_name: 'list_dir',
        tool_input: '{"DirectoryPath":"C:\\\\work\\\\demo\\\\src","toolSummary":"List"}',
        tool_result: 'a.ts\nb.ts',
        tool_status: 'ok',
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain('private');
  });

  it('collects absolute paths from tool arguments as project hints', () => {
    const raw = read([
      step('PLANNER_RESPONSE', {
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: 'C:\\work\\demo\\src\\app.ts' } },
          { name: 'run', args: { Cwd: '/work/demo', CommandLine: 'pnpm test' } },
        ],
      }),
    ]);
    expect(raw.path_hints).toEqual(['C:\\work\\demo\\src\\app.ts', '/work/demo']);
  });

  // Review Focus 3
  it('skips steps that are still running', () => {
    const raw = read([
      step('USER_INPUT', { content: 'go' }),
      step('PLANNER_RESPONSE', { content: 'half an answ', status: 'RUNNING' }),
      step('RUN_COMMAND', { content: 'partial output', status: 'RUNNING' }),
    ]);
    expect(raw.messages).toHaveLength(1);
  });

  it('marks a tool result from a failed step as an error', () => {
    const raw = read([
      step('PLANNER_RESPONSE', { tool_calls: [{ name: 'run', args: {} }] }),
      step('RUN_COMMAND', { content: 'exit 1', status: 'ERROR' }),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_result: 'exit 1', tool_status: 'error' });
  });

  it('ignores bookkeeping steps and counts bad lines', () => {
    const raw = read([
      step('EPHEMERAL_MESSAGE', { content: 'reminder' }),
      step('SYSTEM_MESSAGE', { content: 'sys' }),
      step('CONVERSATION_HISTORY'),
      step('KNOWLEDGE_ARTIFACTS'),
      step('CHECKPOINT', { content: 'cp' }),
      step('USER_INPUT', { content: 'real' }),
    ]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real']);
    expect(raw.warnings).toEqual({ bad_lines: 0, unknown_records: 0, dropped_blocks: 0 });
  });
});

describe('ALL_ADAPTERS', () => {
  it('lists the three tools in a fixed order', () => {
    expect(ALL_ADAPTERS.map((a) => a.source)).toEqual(['claude-code', 'codex', 'antigravity']);
  });
});
