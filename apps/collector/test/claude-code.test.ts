import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../src/adapters/claude-code.js';
import { tempDir, writeJsonl, writeRaw } from './helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const rec = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) => ({
  type,
  sessionId: SID,
  cwd: 'C:\\work\\demo',
  gitBranch: 'main',
  ownerAccountUuid: 'acct-1',
  timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: type, content },
  ...extra,
});

function home(records: unknown[], subagent?: unknown[]): string {
  const h = tempDir();
  const proj = join(h, '.claude', 'projects', 'C--work-demo');
  writeJsonl(join(proj, `${SID}.jsonl`), records);
  if (subagent) writeJsonl(join(proj, SID, 'subagents', 'agent-a1.jsonl'), subagent);
  return h;
}

describe('claudeCode.discover', () => {
  it('finds main sessions and subagent transcripts with their parent', () => {
    const h = home([rec('user', 'hi')], [rec('user', 'sub task')]);
    const files = claudeCode.discover(h).sort((a, b) => a.id.localeCompare(b.id));
    expect(files.map((f) => ({ id: f.id, parent: f.parent }))).toEqual([
      { id: SID, parent: null },
      { id: `${SID}/agent-a1`, parent: SID },
    ]);
    expect(files[0].size).toBeGreaterThan(0);
  });

  it('returns nothing when the tool is not installed', () => {
    expect(claudeCode.discover(tempDir())).toEqual([]);
  });
});

describe('claudeCode.read', () => {
  const read = (records: unknown[]) => {
    const h = home(records);
    return claudeCode.read(claudeCode.discover(h)[0]);
  };

  it('reads string and block text for both roles, with session details', () => {
    const raw = read([
      rec('user', 'fix the login bug'),
      rec('assistant', [{ type: 'text', text: 'Looking now.' }], { timestamp: '2026-10-01T10:01:00.000Z' }),
    ]);
    expect(raw).toMatchObject({
      source: 'claude-code',
      source_session_id: SID,
      account_id: 'acct-1',
      cwd: 'C:\\work\\demo',
      git_branch: 'main',
      parent: null,
    });
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: '2026-10-01T10:00:00.000Z', text: 'fix the login bug' },
      { seq: 1, role: 'assistant', kind: 'text', ts: '2026-10-01T10:01:00.000Z', text: 'Looking now.' },
    ]);
  });

  it('pairs a tool call with its result and marks errors', () => {
    const raw = read([
      rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: '2 failed', is_error: true }]),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: '2026-10-01T10:00:00.000Z',
        tool_name: 'Bash',
        tool_input: '{"command":"pnpm test"}',
        tool_result: '2 failed',
        tool_status: 'error',
      },
    ]);
  });

  it('joins the text parts of a list-shaped tool result', () => {
    const raw = read([
      rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      rec('user', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'image', source: { data: 'AAAA' } },
            { type: 'text', text: 'line 2' },
          ],
        },
      ]),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_result: 'line 1\nline 2', tool_status: 'ok' });
  });

  it('skips thinking silently', () => {
    const raw = read([rec('assistant', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }])]);
    expect(raw.messages.map((m) => m.kind)).toEqual(['text']);
    expect(raw.warnings.dropped_blocks).toBe(0);
  });

  // Review Focus 1
  it('drops and counts image, server tool and advisor blocks', () => {
    const raw = read([
      rec('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } },
        { type: 'text', text: 'see screenshot' },
      ]),
      rec('assistant', [
        { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} },
        { type: 'advisor_tool_result', tool_use_id: 's1', content: { type: 'x', encrypted_content: 'zzz' } },
      ]),
    ]);
    expect(raw.messages).toHaveLength(1);
    expect(JSON.stringify(raw.messages)).not.toContain('AAAA');
    expect(raw.warnings.dropped_blocks).toBe(3);
  });

  it('skips records flagged isMeta', () => {
    const raw = read([rec('user', 'injected skill text', { isMeta: true }), rec('user', 'real question')]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real question']);
  });

  it('uses a custom title when one is recorded', () => {
    const raw = read([rec('user', 'hi'), { type: 'custom-title', customTitle: 'Login fix', sessionId: SID }]);
    expect(raw.title).toBe('Login fix');
  });

  it('counts bad lines and unknown record types without failing', () => {
    const h = tempDir();
    const path = join(h, '.claude', 'projects', 'p', `${SID}.jsonl`);
    writeRaw(
      path,
      [
        JSON.stringify(rec('user', 'one')),
        '{not json',
        JSON.stringify({ type: 'brand-new-record' }),
        JSON.stringify({ type: 'file-history-snapshot' }),
        JSON.stringify(rec('user', 'two')),
      ].join('\n'),
    );
    const raw = claudeCode.read(claudeCode.discover(h)[0]);
    expect(raw.messages).toHaveLength(2);
    expect(raw.warnings).toEqual({ bad_lines: 1, unknown_records: 1, dropped_blocks: 0 });
  });

  it('gives a subagent transcript its parent and a combined id', () => {
    const h = home([rec('user', 'hi')], [rec('user', 'sub task', { isSidechain: true })]);
    const sub = claudeCode.discover(h).find((f) => f.parent !== null)!;
    const raw = claudeCode.read(sub);
    expect(raw).toMatchObject({ source_session_id: `${SID}/agent-a1`, parent: SID });
  });
});

describe('claudeCode.read: account id', () => {
  const readRecords = (records: unknown[]) => {
    const h = home(records);
    return claudeCode.read(claudeCode.discover(h)[0]);
  };
  const plain = (text: string) => {
    const r = rec('user', text) as Record<string, unknown>;
    delete r.ownerAccountUuid;
    return r;
  };

  // Found on real history: the account id is written on bridge-session records,
  // not on the user and assistant records.
  it('takes the account id from a bridge-session record', () => {
    const raw = readRecords([plain('hi'), { type: 'bridge-session', bridgeSessionId: 'b1', ownerAccountUuid: 'acct-from-bridge' }]);
    expect(raw.account_id).toBe('acct-from-bridge');
    expect(raw.messages).toHaveLength(1);
    expect(raw.warnings.unknown_records).toBe(0);
  });

  it('keeps the first account id seen and is null when none is recorded', () => {
    const two = readRecords([
      { type: 'bridge-session', ownerAccountUuid: 'first' },
      plain('hi'),
      { type: 'bridge-session', ownerAccountUuid: 'second' },
    ]);
    expect(two.account_id).toBe('first');
    expect(readRecords([plain('hi')]).account_id).toBeNull();
  });
});
