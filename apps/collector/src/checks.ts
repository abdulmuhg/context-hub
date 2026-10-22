import { spawnSync } from 'node:child_process';
import { claudeOnlyAsCmd, cleanEnv, findClaude } from './claude-llm.js';
import { DEFAULT_SUMMARY_EFFORT, DEFAULT_SUMMARY_MODEL, type Config } from './config.js';
import type { Io } from './cli.js';

export type Mark = '✓' | '!' | '✗' | '–';
export type Row = [Mark, string];

export function printRows(io: Io, rows: Row[]): void {
  for (const [mark, text] of rows) io.out(`${mark} ${text}`);
}

/**
 * Runs `claude` for the doctor and setup. `mcp list` checks every server, so it can take a few seconds. `auth status`
 * is run the way summaries are (no shell, the clean environment), so it reports what a summary run would see.
 */
export function runClaudeCommand(args: string[]): { found: boolean; output: string } {
  if (args[0] === 'auth') {
    const cmd = findClaude();
    if (cmd === null) return { found: false, output: '' };
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, env: cleanEnv(process.env), windowsHide: true });
    return { found: r.status === 0, output: `${r.stdout ?? ''}` };
  }
  const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32', windowsHide: true });
  return { found: r.status === 0, output: `${r.stdout ?? ''}` };
}

/** Summaries are written here by Claude Code, on its sign-in: is it installed and signed in? */
export function summariesRow(io: Io, cfg: Config, hubWritesSummaries: boolean): Row {
  const auth = (io.runClaude ?? runClaudeCommand)(['auth', 'status', '--json']);
  if (!auth.found) {
    if (hubWritesSummaries) return ['!', "Claude Code is not installed; the hub will summarize this computer's sessions"];
    if (!io.runClaude && claudeOnlyAsCmd()) return ['✗', 'Claude Code is installed only as a .cmd file, which summaries cannot use. Install the native claude.exe, then run: claude'];
    return ['✗', 'Claude Code is not installed, so sessions wait here. Install it, then run: claude'];
  }
  let loggedIn: boolean | null = null;
  try {
    loggedIn = (JSON.parse(auth.output) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    loggedIn = null;
  }
  const model = cfg.summaries?.model ?? DEFAULT_SUMMARY_MODEL;
  const effort = cfg.summaries?.effort ?? DEFAULT_SUMMARY_EFFORT;
  if (loggedIn === true) return ['✓', `Claude Code signed in, model ${model}, effort ${effort}`];
  if (loggedIn === false) return ['✗', 'Claude Code is not signed in, or its login expired. Run: claude auth login'];
  return ['!', 'could not tell whether Claude Code is signed in. Run: claude'];
}
