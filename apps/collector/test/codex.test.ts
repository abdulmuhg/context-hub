import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codex } from '../src/adapters/codex.js';
import { tempDir, writeJsonl } from './helpers.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-02T09:00:00.000Z';
const wrap = (type: string, payload: unknown) => ({ timestamp: T, type, payload });
const msg = (role: string, text: string) => ({
  type: 'message',
  role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});

function home(records: unknown[], name = `rollout-2026-10-02T09-00-00-${UUID}.jsonl`): string {
  const h = tempDir();
  writeJsonl(join(h, '.codex', 'sessions', '2026', '10', '02', name), records);
  return h;
}
const read = (records: unknown[]) => {
  const h = home(records);
  return codex.read(codex.discover(h)[0]);
};

describe('codex.discover', () => {
  it('finds rollout files recursively and takes the id from the file name', () => {
    const files = codex.discover(home([wrap('session_meta', { id: UUID, cwd: '/work/demo' })]));
    expect(files.map((f) => ({ id: f.id, parent: f.parent }))).toEqual([{ id: UUID, parent: null }]);
  });

  it('returns nothing when the tool is not installed', () => {
    expect(codex.discover(tempDir())).toEqual([]);
  });
});

describe('codex.read', () => {
  it('reads the folder, branch and remote from session_meta', () => {
    const raw = read([
      wrap('session_meta', {
        id: UUID,
        cwd: '/work/demo',
        git: { repository_url: 'https://github.com/me/demo.git', branch: 'feat/x' },
      }),
    ]);
    expect(raw).toMatchObject({
      source: 'codex',
      source_session_id: UUID,
      cwd: '/work/demo',
      git_branch: 'feat/x',
      remote_hint: 'https://github.com/me/demo.git',
    });
  });

  it('falls back to turn_context for the folder', () => {
    const raw = read([wrap('turn_context', { cwd: '/work/other', model: 'x' })]);
    expect(raw.cwd).toBe('/work/other');
  });

  // Review Focus 2
  it('reads each turn once although event_msg repeats it', () => {
    const raw = read([
      wrap('response_item', msg('user', 'add a test')),
      wrap('event_msg', { type: 'user_message', message: 'add a test', kind: 'plain' }),
      wrap('response_item', msg('assistant', 'Done.')),
      wrap('event_msg', { type: 'agent_message', message: 'Done.' }),
      wrap('event_msg', { type: 'token_count', info: null }),
    ]);
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: T, text: 'add a test' },
      { seq: 1, role: 'assistant', kind: 'text', ts: T, text: 'Done.' },
    ]);
    expect(raw.warnings.unknown_records).toBe(0);
  });

  it('pairs a function call with its output and reads the exit code', () => {
    const raw = read([
      wrap('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' }),
      wrap('response_item', {
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'no such file', metadata: { exit_code: 2 } }),
      }),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: T,
        tool_name: 'shell',
        tool_input: '{"command":["ls"]}',
        tool_result: 'no such file',
        tool_status: 'error',
      },
    ]);
  });

  it('keeps a plain-text output as it is', () => {
    const raw = read([
      wrap('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** patch', call_id: 'c2' }),
      wrap('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'applied' }),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_name: 'apply_patch', tool_input: '*** patch', tool_result: 'applied', tool_status: 'ok' });
  });

  it('skips reasoning, system roles and the injected environment block', () => {
    const raw = read([
      wrap('response_item', { type: 'reasoning', summary: [], encrypted_content: 'zzz' }),
      wrap('response_item', msg('developer', 'rules')),
      wrap('response_item', msg('user', '<environment_context>\n<cwd>/x</cwd>\n</environment_context>')),
      wrap('response_item', msg('user', 'real question')),
    ]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real question']);
  });

  it('reads the older bare format', () => {
    const raw = read([
      { id: UUID, timestamp: T, instructions: null, git: { branch: 'main' } },
      { record_type: 'state' },
      msg('user', 'hello'),
      { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]);
    expect(raw.git_branch).toBe('main');
    expect(raw.messages.map((m) => m.kind)).toEqual(['text', 'tool_call']);
    expect(raw.messages[0].ts).toBeNull();
  });

  it('counts unknown records and unknown items', () => {
    const raw = read([wrap('brand_new', { a: 1 }), wrap('response_item', { type: 'hologram' })]);
    expect(raw.warnings).toEqual({ bad_lines: 0, unknown_records: 1, dropped_blocks: 1 });
  });
});
