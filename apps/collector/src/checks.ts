import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanAntigravityEnv, findAntigravity } from './antigravity-llm.js';
import { claudeOnlyAsCmd, cleanEnv, findClaude } from './claude-llm.js';
import { DEFAULT_ANTIGRAVITY_SUMMARY_MODEL, DEFAULT_SUMMARY_EFFORT, DEFAULT_SUMMARY_MODEL, type Config } from './config.js';
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
    // Found means it ran. A signed-out Claude Code may exit non-zero, and must not read as not installed.
    return { found: r.error === undefined, output: `${r.stdout ?? ''}` };
  }
  const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32', windowsHide: true });
  return { found: r.status === 0, output: `${r.stdout ?? ''}` };
}

/** Runs `agy` for doctor and setup. */
export function runAntigravityCommand(args: string[], home?: string): { found: boolean; output: string } {
  const cmd = findAntigravity(home);
  if (cmd === null) return { found: false, output: '' };
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, env: cleanAntigravityEnv(process.env), windowsHide: true });
  return { found: r.error === undefined && r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** True when Antigravity appears installed in `io.home` or via the injected/real `agy` probe. */
export function antigravityInstalled(io: Io): boolean {
  if (io.runAntigravity) return io.runAntigravity(['--version']).found;
  if (existsSync(join(io.home, '.gemini'))) return true;
  if (io.runClaude) return false; // keep Claude-only unit tests isolated from host binaries
  return findAntigravity(io.home) !== null;
}

const ANTIGRAVITY_MODEL = /^(?:gemini-|gpt-)/i;

/** Doctor row for Antigravity MCP (`~/.gemini/config/mcp_config.json` or `agy mcp list`). */
export function antigravityMcpRow(io: Io, cfg: Config): Row {
  const mcpPath = join(io.home, '.gemini', 'config', 'mcp_config.json');
  const installed = antigravityInstalled(io) || existsSync(mcpPath);
  if (!installed) return ['–', 'not installed here, skipped'];

  if (existsSync(mcpPath)) {
    const raw = readFileSync(mcpPath, 'utf8').trim();
    if (raw !== '') {
      try {
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { url?: string; serverUrl?: string }> };
        const servers = parsed?.mcpServers ?? {};
        const match = Object.entries(servers).find(([name, entry]) => /context-hub/i.test(name) || /context-hub/i.test(entry?.url ?? entry?.serverUrl ?? ''));
        if (match) return ['✓', `context-hub MCP configured (${match[0]})`];
      } catch {
        return ['!', '~/.gemini/config/mcp_config.json is not valid JSON'];
      }
    }
  }

  const agy = io.runAntigravity ? io.runAntigravity(['mcp', 'list']) : io.runClaude ? { found: false, output: '' } : runAntigravityCommand(['mcp', 'list'], io.home);
  if (agy.found && /context-hub/i.test(agy.output)) return ['✓', 'context-hub MCP configured'];

  const mcpUrl = cfg.server_url ? `${cfg.server_url.replace(/\/+$/, '')}/mcp` : '<hub-url>/mcp';
  return ['!', `no context-hub MCP server. Run: agy mcp add --header "Authorization: Bearer <read-token>" context-hub ${mcpUrl}`];
}

/** Summaries are written here by Claude Code or Antigravity (`agy`): is a local summarizer ready? */
export function summariesRow(io: Io, cfg: Config, hubWritesSummaries: boolean): Row {
  const effort = cfg.summaries?.effort ?? DEFAULT_SUMMARY_EFFORT;
  const provider = cfg.summaries?.provider ?? 'claude-code';
  const configuredModel = cfg.summaries?.model;
  const isAgyModel = configuredModel !== undefined && ANTIGRAVITY_MODEL.test(configuredModel);
  const wantsAgy = provider === 'antigravity';
  const agyModel = configuredModel && (wantsAgy || isAgyModel) ? configuredModel : DEFAULT_ANTIGRAVITY_SUMMARY_MODEL;
  const agyReady = io.runAntigravity
    ? io.runAntigravity(['--version']).found
    : io.runClaude
      ? false
      : findAntigravity(io.home) !== null;

  if (wantsAgy) {
    if (agyReady) return ['✓', `Antigravity ready, model ${agyModel}, effort ${effort}`];
    if (hubWritesSummaries) return ['!', "Antigravity is not installed; the hub will summarize this computer's sessions"];
    return ['✗', 'Antigravity (agy) is not installed, so sessions wait here. Install Antigravity or run: hub summaries provider claude-code'];
  }

  const auth = (io.runClaude ?? runClaudeCommand)(['auth', 'status', '--json']);
  let loggedIn: boolean | null = null;
  if (auth.found) {
    try {
      loggedIn = (JSON.parse(auth.output) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      loggedIn = null;
    }
  }
  const model = configuredModel && !isAgyModel ? configuredModel : DEFAULT_SUMMARY_MODEL;
  if (loggedIn === true) return ['✓', `Claude Code signed in, model ${model}, effort ${effort}`];

  if (provider === 'auto' && agyReady) {
    return ['✓', `Antigravity ready (Claude fallback), model ${agyModel}, effort ${effort}`];
  }

  if (!auth.found) {
    if (hubWritesSummaries) return ['!', "Claude Code is not installed; the hub will summarize this computer's sessions"];
    if (!io.runClaude && claudeOnlyAsCmd()) return ['✗', 'Claude Code is installed only as a .cmd file, which summaries cannot use. Install the native claude.exe, then run: claude'];
    return ['✗', 'Claude Code is not installed, so sessions wait here. Install it, then run: claude'];
  }
  if (loggedIn === false) return ['✗', 'Claude Code is not signed in, or its login expired. Run: claude auth login'];
  return ['!', 'could not tell whether Claude Code is signed in. Run: claude'];
}
