// Step 8 of check-claude-p.sh: one real summary through the collector's own code path.
import { ClaudeCodeLlm, findClaude, spawnRunner, type ClaudeRunner } from '../apps/collector/src/claude-llm.ts';

const cmd = findClaude();
if (!cmd) {
  console.log('✗ 8 collector: findClaude() found no usable claude (on Windows it needs claude.exe, not only claude.cmd)');
  process.exit(1);
}

let stderr = '';
const run: ClaudeRunner = async (c, args, stdin, env, timeoutMs) => {
  const r = await spawnRunner(c, args, stdin, env, timeoutMs);
  stderr = r.stderr;
  return r;
};

const started = Date.now();
try {
  const timeoutMs = Number(process.env.CHECK_LIMIT ?? 90) * 1000;
  const body = await new ClaudeCodeLlm({ model: 'claude-sonnet-5-5', effort: 'low', cmd, run, timeoutMs }).digest({
    project: 'github.com/me/check',
    title: 'Pick a database',
    transcript: '[1] USER: Let us use SQLite for the hub instead of Postgres.\n[2] ASSISTANT: Agreed. SQLite with FTS5 keeps it one file and needs no server.',
    part: null,
  });
  console.log(`✓ 8 collector: ${Math.round((Date.now() - started) / 1000)}s, goal: ${body.goal.slice(0, 100)}`);
} catch (e) {
  console.log(`✗ 8 collector: ${(e as Error).constructor.name}: ${(e as Error).message}${stderr ? ` | stderr: ${stderr.slice(0, 200)}` : ''}`);
  process.exit(1);
}
