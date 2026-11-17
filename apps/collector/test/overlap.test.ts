import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAutoChild } from '../src/auto.js';
import { run, type Io } from '../src/cli.js';
import { loadConfig, loadState, saveConfig, saveToken } from '../src/config.js';
import { FakeLlm } from '../../../packages/core/test/fake-llm.js';
import type { DigestBody, DigestRequest } from '../../../packages/core/src/index.js';
import { tempDir, writeJsonl } from './helpers.js';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Counts every summary the writer is asked for, and takes a real moment so two runs genuinely overlap. */
class SlowLlm extends FakeLlm {
  summaries = 0;
  async digest(req: DigestRequest): Promise<DigestBody> {
    this.summaries++;
    await delay(40);
    return super.digest(req);
  }
}

describe('overlapping syncs', () => {
  it('manual and auto started together summarize each session once', async () => {
    const home = tempDir();
    const hubDir = tempDir();
    for (const id of IDS) {
      writeJsonl(join(home, '.claude', 'projects', 'p', `${id}.jsonl`), [
        { type: 'user', sessionId: id, cwd: '/work/alpha', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: `hello ${id}` } },
      ]);
    }
    saveConfig(hubDir, { ...loadConfig(hubDir), server_url: 'https://hub.example.com', tracked: ['github.com/me/alpha'] });
    saveToken(hubDir, 'tok');

    const llm = new SlowLlm();
    const puts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'PUT' && String(input).includes('/api/sessions/')) puts.push(String(input));
      return new Response('{}', { status: 200 });
    };
    const git = (_cwd: string, args: string[]) => (args[0] === 'remote' ? 'git@github.com:me/alpha.git' : '/work/alpha');
    const io: Io = {
      home,
      hubDir,
      out: () => {},
      err: () => {},
      ask: async () => '',
      exists: () => true,
      git,
      llm,
      fetchImpl,
      sleep: delay.bind(null, 10),
      spawn: (() => ({ on: () => {}, unref: () => {} })) as unknown as Io['spawn'],
    };

    // The auto child takes the lock first: the manual path awaits before it calls waitForLock.
    const [code] = await Promise.all([
      run(['sync'], io),
      runAutoChild({ home, hubDir, exists: () => true, git, fetchImpl, llm }),
    ]);

    expect(code).toBe(0);
    expect(llm.summaries).toBe(3);
    expect(puts).toHaveLength(3);
    const entries = Object.entries(loadState(hubDir).files);
    expect(entries).toHaveLength(3);
    for (const id of IDS) {
      const entry = entries.find(([path]) => path.includes(id));
      expect(entry?.[1].hash).toEqual(expect.any(String));
    }
    expect(existsSync(join(hubDir, 'auto.lock'))).toBe(false);
    expect(existsSync(join(hubDir, 'auto.rerun'))).toBe(false);
  });
});
