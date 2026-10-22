import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { autoOn, autoStatus, hookCommand, repointHook } from './auto.js';
import { printRows, runClaudeCommand, summariesRow, type Row } from './checks.js';
import { connectWithCode, mainSessions, newProjects, plural, scanOpts, type Io } from './cli.js';
import { SLASH_COMMANDS } from './commands.js';
import { loadConfig, loadToken, saveConfig } from './config.js';
import { Fail, friendlyMessage } from './errors.js';
import { listProjects, type ProjectRow } from './sync.js';
import { getStatus } from './upload.js';
import { HUB_VERSION } from './version.js';

const trimUrl = (u: string): string => u.trim().replace(/\/+$/, '');

/** Runs a normal `hub sync`. */
type Sync = () => Promise<number>;

/**
 * `hub setup`, run by the installers (and safe to run again): connects this computer, installs the slash
 * commands, turns on auto sync on a first install, and prints a checklist. Returns 1 only when something
 * failed that leaves the computer unable to upload; warnings (!) do not fail it.
 */
export async function setupCase(io: Io, args: string[], sync: Sync): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
      code: { type: 'string' },
      note: { type: 'string', multiple: true },
      warn: { type: 'string', multiple: true },
    },
  });
  if (!values.url) throw new Fail('hub setup needs the hub address: hub setup --url https://your-hub');
  const url = trimUrl(values.url);
  const code = values.code?.trim() ?? '';
  const rows: Row[] = [];
  const bundle = io.bundlePath ?? resolve(process.argv[1] ?? '');

  const configPath = join(io.hubDir, 'config.json');
  const firstInstall = !existsSync(configPath);
  const before = loadConfig(io.hubDir);

  // What was installed, and what changed.
  if (before.setup_version === undefined) rows.push(['✓', `hub ${HUB_VERSION} installed in ${dirname(bundle)}`]);
  else if (before.setup_version === HUB_VERSION) rows.push(['✓', `hub ${HUB_VERSION} already current`]);
  else rows.push(['✓', `hub ${HUB_VERSION}, updated from ${before.setup_version}`]);
  for (const note of values.note ?? []) rows.push(['✓', note]);

  // The slash commands.
  try {
    const dir = join(io.home, '.claude', 'commands');
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(SLASH_COMMANDS)) writeFileSync(join(dir, name), text);
    rows.push(['✓', `Slash commands installed (${Object.keys(SLASH_COMMANDS).length})`]);
  } catch (e) {
    rows.push(['!', `Couldn't install the slash commands (${(e as Error).message}). Run: hub install-commands`]);
  }

  // Connect.
  let connected = false;
  let hubWritesSummaries = false;
  const host = (io.hostname ?? hostname)();
  const savedToken = loadToken(io.hubDir);
  const sameHub = Boolean(before.server_url) && trimUrl(before.server_url) === url;
  if (code !== '') {
    try {
      const { label, previousUrl } = await connectWithCode(io, url, code, before.label ?? host);
      rows.push(['✓', `Connected to ${url} as "${label}"${previousUrl ? ` (was ${trimUrl(previousUrl)})` : ''}`]);
      connected = true;
    } catch (e) {
      rows.push(['✗', friendlyMessage(e, io.hubDir)]);
    }
  } else if (sameHub && savedToken) {
    try {
      const status = await getStatus({ url, token: savedToken, fetchImpl: io.fetchImpl });
      hubWritesSummaries = status.server_summaries === true;
      const label = status.label ?? before.label ?? host;
      if (label !== before.label) {
        const cfg = loadConfig(io.hubDir);
        cfg.label = label;
        saveConfig(io.hubDir, cfg);
      }
      rows.push(['✓', `Connected to ${url} as "${label}"`]);
      connected = true;
    } catch (e) {
      rows.push(['✗', friendlyMessage(e, io.hubDir)]);
    }
  } else {
    rows.push(['!', 'Not connected yet. Paste the line from Sign-ins → Add a computer, or run: hub login']);
  }

  // Auto sync: on for a first install, left as it was after that. Our hook always runs the bundle just installed.
  const claude = (io.runClaude ?? runClaudeCommand)(['auth', 'status', '--json']);
  if (connected) {
    const settings = join(io.home, '.claude', 'settings.json');
    const command = hookCommand(io.execPath ?? process.execPath, bundle);
    try {
      repointHook(settings, command);
      if (firstInstall) {
        if (!claude.found) {
          rows.push(['–', "Auto sync skipped: Claude Code isn't installed"]);
        } else {
          autoOn(settings, command);
          rows.push(['✓', 'Auto sync on (runs when a Claude Code session ends)']);
        }
      } else if (autoStatus(settings, join(io.hubDir, 'auto.log')).on) {
        rows.push(['✓', 'Auto sync on (runs when a Claude Code session ends)']);
      } else {
        rows.push(['–', 'Auto sync off (turn on with: hub auto on)']);
      }
    } catch (e) {
      rows.push(['!', `Auto sync not changed: ${(e as Error).message}`]);
    }
  }

  // Claude Code is a warning here: the computer is connected without it.
  const [mark, text] = summariesRow(io, loadConfig(io.hubDir), hubWritesSummaries);
  rows.push([mark === '✗' ? '!' : mark, text]);

  const failed = rows.some(([m]) => m === '✗');
  if (!failed) {
    const cfg = loadConfig(io.hubDir);
    cfg.setup_version = HUB_VERSION;
    saveConfig(io.hubDir, cfg);
  }
  for (const warning of values.warn ?? []) rows.push(['!', warning]);
  printRows(io, rows);
  if (failed) return 1;
  return connected ? pickAndSync(io, sync) : 0;
}

/**
 * Reads the answer to "which projects": 1-based numbers separated by spaces or commas, "all", or nothing
 * (an empty list). Null for anything else, or a number that is not in the list.
 */
export function parsePicks(answer: string, count: number): number[] | 'all' | null {
  const text = answer.trim().toLowerCase();
  if (text === '') return [];
  if (text === 'all') return 'all';
  const picks: number[] = [];
  for (const part of text.split(/[s,]+/)) {
    if (!/^d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 1 || n > count) return null;
    if (!picks.includes(n)) picks.push(n);
  }
  return picks;
}

const DAY_MS = 86_400_000;

function when(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS);
  if (!(days >= 1)) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Asks which of the undecided projects to upload, then runs the first sync in the foreground. */
async function pickAndSync(io: Io, sync: Sync): Promise<number> {
  const fresh = newProjects(listProjects(scanOpts(io)), loadConfig(io.hubDir)).sort((a: ProjectRow, b: ProjectRow) =>
    b.last_activity.localeCompare(a.last_activity),
  );
  if (fresh.length === 0) return 0;
  if (!io.interactive) {
    io.out('Run hub sync in a terminal to choose which projects to upload.');
    return 0;
  }
  const now = Date.now();
  io.out('');
  io.out(`Found ${plural(fresh.length, 'project')} on this computer:`);
  const width = Math.max(...fresh.map((r) => r.key.length));
  const numberWidth = String(fresh.length).length;
  fresh.forEach((r, i) => {
    const sessions = plural(mainSessions(r), 'session');
    io.out(`  ${String(i + 1).padStart(numberWidth)}  ${r.key.padEnd(width)}  ${sessions.padEnd(12)}  ${when(r.last_activity, now)}`);
  });
  const prompt = 'Which should go to the hub? Numbers (e.g. 1 3), "all", or Enter for none: ';
  let picks = parsePicks(await io.ask(prompt), fresh.length);
  if (picks === null) {
    io.out("That wasn't a list of numbers from above.");
    picks = parsePicks(await io.ask(prompt), fresh.length);
  }
  if (picks === null) {
    io.out('Nothing chosen. Run hub sync to choose which projects to upload.');
    return 0;
  }
  if (picks === 'all') picks = fresh.map((_, i) => i + 1);
  if (picks.length === 0) {
    io.out('Nothing chosen. Run hub sync to choose which projects to upload.');
    return 0;
  }
  const cfg = loadConfig(io.hubDir);
  fresh.forEach((r, i) => {
    if (picks.includes(i + 1)) {
      if (!cfg.tracked.includes(r.key)) cfg.tracked.push(r.key);
    } else if (!cfg.declined.includes(r.key)) cfg.declined.push(r.key);
  });
  saveConfig(io.hubDir, cfg);

  io.out('');
  const stopListening = io.onInterrupt?.(() => io.out('Stopped. The rest uploads on the next sync, or run hub sync.'));
  let code: number;
  try {
    code = await sync();
  } finally {
    stopListening?.();
  }
  if (code === 0) io.out('Done. This computer syncs when a Claude Code session ends; run hub sync any time.');
  return code;
}
