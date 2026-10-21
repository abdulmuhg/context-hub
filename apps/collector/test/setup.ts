import { vi } from 'vitest';

// No test may start the real Claude Code, which would use the plan of whoever runs the tests.
// A test that wants a writer passes a fake `llm` (or a fake runner) of its own.
vi.mock('../src/claude-llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/claude-llm.js')>()),
  findClaude: () => null,
}));
