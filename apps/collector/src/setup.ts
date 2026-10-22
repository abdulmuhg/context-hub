import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { autoOn, autoStatus, hookCommand, repointHook } from './auto.js';
import { printRows, runClaudeCommand, summariesRow, type Row } from './checks.js';
import { connectWithCode, type Io } from './cli.js';
import { SLASH_COMMANDS } from './commands.js';
import { loadConfig, loadToken, saveConfig } from './config.js';
import { Fail, friendlyMessage } from './errors.js';
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
  void sync;
  return failed ? 1 : 0;
}
