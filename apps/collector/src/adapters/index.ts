import { antigravity } from './antigravity.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import type { Adapter } from './types.js';

export const ALL_ADAPTERS: Adapter[] = [claudeCode, codex, antigravity];
export * from './types.js';
