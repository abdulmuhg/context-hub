import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { autoOff, autoOn, autoStatus, hookCommand, runAutoChild } from './auto.js';
import { SLASH_COMMANDS } from './commands.js';
import type { Level } from '@context-hub/core';
import {
  loadConfig,
  loadPersonal,
  loadToken,
  saveConfig,
  savePersonal,
  saveToken,
  type Config,
} from './config.js';
import { applyOverrides, projectMatches, realGit, resolveProjectKey, type GitRunner } from './project.js';
import { listProjects, runSync, type ProjectRow, type SyncReport } from './sync.js';
import { deleteRemote, exchangeDeviceCode, getStatus, requestConnectCode, type Remote } from './upload.js';

export interface Io {
  home: string;
  hubDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  git?: GitRunner;
  exists?: (path: string) => boolean;
  hostname?: () => string;
  /** True when stdin and stdout are a terminal, so it is safe to ask questions. */
  interactive?: boolean;
  /** For `hub auto` and `hub sync --auto`: the node binary and the running hub script. */
  execPath?: string;
  bundlePath?: string;
  spawn?: typeof spawn;
}

const USAGE = `Usage: hub <command>

  login [--url URL] [--name NAME]      connect this computer with a code from the dashboard
  sync                                 upload your tracked projects (asks about new ones)
  auto on | off | status               sync automatically when a Claude Code session ends

Advanced:
  init [--url URL] [--token TOKEN]     save the server address and upload token
  projects                             list projects found on this PC
  track <project> | untrack <project>  choose which projects are uploaded
  skip <session> | unskip <session>    exclude one session (<source>:<id>)
  alias <from> <to>                    merge or rename a project key
  assign <session> <project>           set the project of one session
  sync [--project P] [--session S] [--dry-run]   (--project narrows tracked projects)
  forget <project> | forget --session <source>:<id>
  status                               ask the server for its status
  connect                              get a one-time code to sign claude.ai in to the hub
  install-commands [--dir PATH]        write the Claude Code slash commands (default ~/.claude/commands)
  personal add <label> | list | remove <label> | level <card|list|label> <level>
  docs [list]                          list the folders of notes uploaded as documents
  docs add <folder> [--project P] [--as LABEL] [--exclude a,b]
                                       upload a folder's Markdown files with its tracked project
  docs remove <label|folder>           stop uploading a folder (uploaded copies stay)`;

const LEVELS: Level[] = ['off', 'warn', 'partial', 'full'];
const SESSION_KEY = /^(claude-code|codex|antigravity):.+$/;

class Fail extends Error {}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Fail(`Missing ${what}.\n\n${USAGE}`);
  return value;
}

// Only `forget` may name a saved note, which has no local file, or a document.
function sessionKey(value: string | undefined, allowNote = false): string {
  const v = need(value, 'session');
  if (!SESSION_KEY.test(v) && !(allowNote && /^(note|doc):.+$/.test(v))) throw new Fail(`A session is written as <source>:<id>, for example claude-code:1234. Got "${v}".`);
  return v;
}

function update(io: Io, change: (cfg: Config) => void): void {
  const cfg = loadConfig(io.hubDir);
  change(cfg);
  saveConfig(io.hubDir, cfg);
}

function scanOpts(io: Io) {
  return { home: io.home, hubDir: io.hubDir, git: io.git, exists: io.exists };
}

function remote(io: Io): Remote {
  const cfg = loadConfig(io.hubDir);
  const token = loadToken(io.hubDir);
  if (!cfg.server_url || !token) throw new Fail('No server address or upload token. Run `hub init` first.');
  return { url: cfg.server_url, token, fetchImpl: io.fetchImpl };
}

const NEVER_OFFERED = 'unfiled';

function mainSessions(row: ProjectRow): number {
  return Object.values(row.sessions).reduce((a, b) => a + b, 0);
}

/** Projects with sessions on this computer that are neither tracked nor declined. */
export function newProjects(rows: ProjectRow[], cfg: Config): ProjectRow[] {
  return rows.filter(
    (r) => r.key !== NEVER_OFFERED && !cfg.tracked.includes(r.key) && !cfg.declined.includes(r.key) && mainSessions(r) > 0,
  );
}

function shortName(key: string): string {
  return key.split(/[/\\]/).filter(Boolean).pop() ?? key;
}

function displayName(key: string): string {
  const name = shortName(key);
  return name === key ? key : `${name} — ${key}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printReport(io: Io, report: SyncReport, dryRun: boolean): void {
  const list = dryRun ? report.wouldUpload : report.uploaded;
  const docs = list.filter((ref) => ref.session.startsWith('doc:')).length;
  const what = docs === 0 ? plural(list.length, 'session') : `${plural(list.length - docs, 'session')} and ${plural(docs, 'document')}`;
  io.out(`${dryRun ? 'Would upload' : 'Uploaded'} ${what}. Unchanged: ${report.unchanged}.`);
  const perProject = new Map<string, number>();
  for (const ref of list) perProject.set(ref.project, (perProject.get(ref.project) ?? 0) + 1);
  for (const [project, n] of perProject) io.out(`  ${project}: ${n}`);
  const gone = dryRun ? report.wouldDelete : report.deleted;
  if (gone.length > 0) io.out(`${dryRun ? 'Would remove' : 'Removed'} ${plural(gone.length, 'document')} whose file is gone:`);
  for (const ref of gone) io.out(`  ${ref.session}`);

  const secrets = Object.entries(report.secrets);
  if (secrets.length > 0) io.out(`Secrets stripped: ${secrets.map(([t, n]) => `${t} ${n}`).join(', ')}`);
  for (const p of report.personal) io.out(`Personal data: ${p.type} x${p.count} in ${p.session}`);
  for (const w of report.warnings) {
    io.out(`Warning: ${w.session}: ${w.bad_lines} unreadable lines, ${w.unknown_records} unknown records, ${w.dropped_blocks} dropped blocks`);
  }
  for (const e of report.errors) io.err(`Error: ${e}`);
  if (report.reportError) io.err(`Note: could not report this run to the server (${report.reportError}). The sync itself is unaffected.`);
  if (dryRun) return;
  if (report.errors.length > 0) {
    io.err(`Sync finished with ${report.errors.length} error(s).`);
  } else {
    io.out(`Up to date: ${report.uploaded.length} uploaded, ${report.unchanged} unchanged, ${loadConfig(io.hubDir).tracked.length} tracked project(s).`);
  }
}

async function personal(io: Io, args: string[]): Promise<void> {
  const [sub, a, b] = args;
  const entries = loadPersonal(io.hubDir);
  switch (sub) {
    case 'add': {
      const label = need(a, 'label');
      if (entries.some((e) => e.label === label)) throw new Fail(`"${label}" is already in the list. Remove it first.`);
      const value = (await io.ask(`Value for "${label}" (stays on this PC): `)).trim();
      if (value === '') throw new Fail('No value entered. Nothing saved.');
      savePersonal(io.hubDir, [...entries, { label, value }]);
      io.out(`Saved "${label}".`);
      return;
    }
    case 'list': {
      const cfg = loadConfig(io.hubDir);
      io.out(`card: ${cfg.personal.card}`);
      io.out(`list: ${cfg.personal.list}`);
      for (const e of entries) io.out(`  ${e.label}: ${e.level ?? `${cfg.personal.list} (from list)`}`);
      return;
    }
    case 'remove': {
      const label = need(a, 'label');
      if (!entries.some((e) => e.label === label)) throw new Fail(`No entry called "${label}".`);
      savePersonal(io.hubDir, entries.filter((e) => e.label !== label));
      io.out(`Removed "${label}".`);
      return;
    }
    case 'level': {
      const target = need(a, 'card, list or a label');
      const level = need(b, 'level') as Level;
      if (!LEVELS.includes(level)) throw new Fail(`Level must be one of: ${LEVELS.join(', ')}.`);
      if (target === 'card' || target === 'list') {
        update(io, (cfg) => {
          cfg.personal[target] = level;
        });
      } else {
        if (!entries.some((e) => e.label === target)) throw new Fail(`No entry called "${target}".`);
        savePersonal(io.hubDir, entries.map((e) => (e.label === target ? { ...e, level } : e)));
      }
      io.out(`${target}: ${level}`);
      return;
    }
    default:
      throw new Fail(USAGE);
  }
}

/** The project a folder of notes belongs to: the one named, or the git repo the folder is in. */
function docsProject(io: Io, folder: string, named: string | undefined): string {
  const cfg = loadConfig(io.hubDir);
  if (named !== undefined) {
    const keys = [...new Set([...listProjects(scanOpts(io)).map((r) => r.key), ...cfg.tracked])];
    const matches = keys.filter((k) => projectMatches(named, k));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0 && (named.includes('/') || named.startsWith('local:'))) return named;
    const why = matches.length === 0 ? `No project matches "${named}".` : `"${named}" matches more than one project.`;
    throw new Fail(`${why} Pass a full key, one of:\n${(matches.length ? matches : keys).map((k) => `  ${k}`).join('\n')}`);
  }
  const git = io.git ?? realGit;
  if (git(folder, ['rev-parse', '--show-toplevel']) === null) {
    throw new Fail(`${folder} is not inside a git repo, so its project is unknown. Name it with --project.`);
  }
  const key = resolveProjectKey({ cwd: folder, remoteHint: null, pathHints: [] }, { git, exists: io.exists ?? existsSync });
  return applyOverrides(key, '', cfg);
}

function docsCase(io: Io, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'list') {
    const { docs } = loadConfig(io.hubDir);
    if (docs.length === 0) io.out('No document folders. Add one with: hub docs add <folder>');
    for (const f of docs) {
      io.out(`${f.label}  ${f.path}  -> ${f.project}${f.exclude.length ? `  (leaving out ${f.exclude.join(', ')})` : ''}`);
    }
    return 0;
  }
  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { project: { type: 'string' }, as: { type: 'string' }, exclude: { type: 'string' } },
      allowPositionals: true,
    });
    const path = resolve(need(positionals[0], 'folder'));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Fail(`${path} is not a folder.`);
    const project = docsProject(io, path, values.project);
    const label = (values.as ?? basename(path)).trim();
    if (label === '' || /[#/\\]/.test(label)) throw new Fail(`"${label}" cannot name a folder: leave out #, / and \\.`);
    const exclude = (values.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cfg = loadConfig(io.hubDir);
    // Tracking uploads every session of the project, so adding notes must never switch it on.
    if (!cfg.tracked.includes(project)) {
      throw new Fail(`${project} is not tracked. Documents upload only with a tracked project, and tracking also uploads its sessions. Run \`hub track ${project}\` first if you want both.`);
    }
    if (cfg.docs.some((f) => f.path === path)) throw new Fail(`${path} is already added. Remove it first to change it.`);
    // A file under two folders would get two ids and swap between them on every sync.
    const overlap = cfg.docs.find((f) => path.startsWith(f.path + sep) || f.path.startsWith(path + sep));
    if (overlap) throw new Fail(`${path} overlaps ${overlap.path}, which is already added. Remove one, or leave the inner folder out with --exclude.`);
    if (cfg.docs.some((f) => f.project === project && f.label === label)) {
      throw new Fail(`${project} already has a folder called "${label}". Choose another with --as.`);
    }
    cfg.docs.push({ project, path, label, exclude });
    saveConfig(io.hubDir, cfg);
    io.out(`Added ${path} as "${label}" for ${project}. Its Markdown files upload with the next hub sync.`);
    return 0;
  }
  if (sub === 'remove') {
    const wanted = need(rest[0], 'folder or label');
    const cfg = loadConfig(io.hubDir);
    const keep = cfg.docs.filter((f) => f.label !== wanted && f.path !== resolve(wanted));
    if (keep.length === cfg.docs.length) throw new Fail(`No document folder called "${wanted}". See hub docs list.`);
    if (cfg.docs.length - keep.length > 1) throw new Fail(`"${wanted}" names more than one folder. Pass the folder path instead.`);
    cfg.docs = keep;
    saveConfig(io.hubDir, cfg);
    io.out(`No longer uploading ${wanted}. Documents already uploaded stay on the server; remove one with hub forget --session doc:<id>.`);
    return 0;
  }
  throw new Fail(USAGE);
}

function bundleOf(io: Io): string {
  return io.bundlePath ?? resolve(process.argv[1] ?? '');
}

function autoCase(io: Io, sub: string | undefined): number {
  const settings = join(io.home, '.claude', 'settings.json');
  const log = join(io.hubDir, 'auto.log');
  if (sub === 'on') {
    const command = hookCommand(io.execPath ?? process.execPath, bundleOf(io));
    const { changed } = autoOn(settings, command);
    io.out(changed ? 'Automatic sync is on. When a Claude Code session ends, hub syncs your tracked projects in the background.' : 'Automatic sync was already on.');
    io.out(`Log: ${log}`);
    return 0;
  }
  if (sub === 'off') {
    const { removed } = autoOff(settings, basename(bundleOf(io)));
    io.out(removed > 0 ? 'Automatic sync is off.' : 'Automatic sync was not on.');
    return 0;
  }
  if (sub === 'status') {
    const { on, lastLine } = autoStatus(settings, log);
    io.out(on ? 'Automatic sync is on.' : 'Automatic sync is off.');
    io.out(lastLine ? `Last run: ${lastLine}` : 'No automatic run yet.');
    return 0;
  }
  throw new Fail('Usage: hub auto on | off | status');
}

async function offerNewProjects(io: Io): Promise<void> {
  const fresh = newProjects(listProjects(scanOpts(io)), loadConfig(io.hubDir));
  if (fresh.length === 0) return;
  if (!io.interactive) {
    const names = fresh.slice(0, 5).map((r) => shortName(r.key));
    const more = fresh.length > 5 ? `, and ${fresh.length - 5} more` : '';
    io.out(`${fresh.length} new project(s) not uploaded: ${names.join(', ')}${more}. Run hub sync in a terminal to choose.`);
    return;
  }
  for (const r of fresh) {
    const n = mainSessions(r);
    const answer = (await io.ask(`New project "${displayName(r.key)}" (${plural(n, 'session')}). Upload it to the hub? [y/N] `)).trim().toLowerCase();
    update(io, (cfg) => {
      if (answer === 'y') {
        if (!cfg.tracked.includes(r.key)) cfg.tracked.push(r.key);
      } else if (!cfg.declined.includes(r.key)) cfg.declined.push(r.key);
    });
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init': {
      const { values } = parseArgs({ args: rest, options: { url: { type: 'string' }, token: { type: 'string' } } });
      const url = (values.url ?? (await io.ask('Server address (https://...): '))).trim();
      if (!/^https?:\/\//i.test(url)) throw new Fail('The server address must start with http:// or https://');
      const token = (values.token ?? (await io.ask('Upload token: '))).trim();
      if (token === '') throw new Fail('No token entered. Nothing saved.');
      update(io, (cfg) => {
        cfg.server_url = url;
      });
      saveToken(io.hubDir, token);
      io.out(`Saved. Files are in ${io.hubDir}`);
      return 0;
    }
    case 'projects': {
      const rows = listProjects(scanOpts(io)).sort((x, y) => y.last_activity.localeCompare(x.last_activity));
      for (const r of rows) {
        const counts = Object.entries(r.sessions).map(([s, n]) => `${s}: ${n}`).join(', ');
        io.out(`${r.tracked ? '[x]' : '[ ]'} ${r.key}  ${counts}  last activity ${r.last_activity.slice(0, 10)}  synced ${r.last_synced?.slice(0, 10) ?? 'never'}`);
      }
      if (rows.length === 0) io.out('No AI tool history found on this PC.');
      return 0;
    }
    case 'track':
    case 'untrack': {
      const input = need(rest[0], 'project');
      if (command === 'untrack') {
        update(io, (cfg) => {
          for (const k of cfg.tracked.filter((k) => projectMatches(input, k))) {
            if (!cfg.declined.includes(k)) cfg.declined.push(k);
          }
          cfg.tracked = cfg.tracked.filter((k) => !projectMatches(input, k));
        });
        io.out(`No longer tracking ${input}. Nothing was deleted from the server.`);
        return 0;
      }
      const keys = listProjects(scanOpts(io)).map((r) => r.key);
      const matches = keys.filter((k) => projectMatches(input, k));
      if (matches.length !== 1) {
        const why = matches.length === 0 ? `No project matches "${input}".` : `"${input}" matches more than one project.`;
        throw new Fail(`${why} Projects on this PC:\n${(matches.length ? matches : keys).map((k) => `  ${k}`).join('\n')}`);
      }
      update(io, (cfg) => {
        if (!cfg.tracked.includes(matches[0])) cfg.tracked.push(matches[0]);
        cfg.declined = cfg.declined.filter((k) => k !== matches[0]);
      });
      io.out(`Tracking ${matches[0]}. Run \`hub sync\` to upload it.`);
      return 0;
    }
    case 'skip':
    case 'unskip': {
      const key = sessionKey(rest[0]);
      update(io, (cfg) => {
        cfg.skipped = cfg.skipped.filter((k) => k !== key);
        if (command === 'skip') cfg.skipped.push(key);
      });
      io.out(command === 'skip' ? `Skipping ${key}.` : `No longer skipping ${key}.`);
      return 0;
    }
    case 'alias': {
      const from = need(rest[0], 'source project key');
      const to = need(rest[1], 'target project key');
      update(io, (cfg) => {
        cfg.aliases[from] = to;
      });
      io.out(`${from} now counts as ${to}.`);
      return 0;
    }
    case 'assign': {
      const key = sessionKey(rest[0]);
      const project = need(rest[1], 'project key');
      update(io, (cfg) => {
        cfg.assignments[key] = project;
      });
      io.out(`${key} now belongs to ${project}.`);
      return 0;
    }
    case 'sync': {
      const { values } = parseArgs({
        args: rest,
        options: {
          project: { type: 'string' },
          session: { type: 'string' },
          'dry-run': { type: 'boolean' },
          auto: { type: 'boolean' },
          'auto-child': { type: 'boolean' },
        },
      });
      if (values.auto) {
        // Return at once so closing Claude Code is never delayed; a detached child does the work.
        const child = (io.spawn ?? spawn)(io.execPath ?? process.execPath, [bundleOf(io), 'sync', '--auto-child'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on?.('error', () => {});
        child.unref();
        return 0;
      }
      if (values['auto-child']) {
        await runAutoChild({ ...scanOpts(io), fetchImpl: io.fetchImpl });
        return 0;
      }
      const dryRun = values['dry-run'] === true;
      const plain = !dryRun && !values.project && !values.session;
      if (plain) await offerNewProjects(io);
      const wanted = values.project;
      if (wanted && !values.session && !loadConfig(io.hubDir).tracked.some((k) => projectMatches(wanted, k))) {
        throw new Fail(`"${wanted}" is not tracked, so nothing would be uploaded. Run \`hub track ${wanted}\` first.`);
      }
      const report = await runSync({ ...scanOpts(io), fetchImpl: io.fetchImpl, dryRun, project: values.project, session: values.session });
      printReport(io, report, dryRun);
      return report.errors.length > 0 ? 1 : 0;
    }
    case 'forget': {
      const { values, positionals } = parseArgs({ args: rest, options: { session: { type: 'string' } }, allowPositionals: true });
      const r = remote(io);
      const what = values.session ? sessionKey(values.session, true) : need(positionals[0], 'project');
      const answer = (await io.ask(`Delete ${what} from the server? This cannot be undone. Type yes to confirm: `)).trim();
      if (answer !== 'yes') {
        io.err('Not confirmed. Nothing was deleted.');
        return 1;
      }
      if (values.session) {
        const i = what.indexOf(':');
        await deleteRemote(r, { source: what.slice(0, i), id: what.slice(i + 1) });
      } else {
        await deleteRemote(r, { project: what });
      }
      io.out(`Deleted ${what} from the server. Local files are untouched.`);
      return 0;
    }
    case 'status': {
      io.out(JSON.stringify(await getStatus(remote(io)), null, 2));
      return 0;
    }
    case 'connect': {
      const { code } = await requestConnectCode(remote(io));
      io.out(`Sign-in code: ${code}`);
      io.out("Valid for 10 minutes, for one use. Enter it on the hub's sign-in page when claude.ai asks you to sign in.");
      return 0;
    }
    case 'login': {
      const { values } = parseArgs({ args: rest, options: { url: { type: 'string' }, name: { type: 'string' } } });
      const saved = loadConfig(io.hubDir).server_url;
      const trim = (u: string): string => u.trim().replace(/\/+$/, '');
      const url = trim(values.url || saved || (await io.ask('Hub address (https://...): ')));
      if (!/^https?:\/\//i.test(url)) throw new Fail('The hub address must start with http:// or https://');
      if (saved && trim(saved) !== url) {
        const answer = (await io.ask(`This computer is connected to ${saved}. Replace it with ${url}? (y/N) `)).trim().toLowerCase();
        if (answer !== 'y') {
          io.err('Not replaced. Nothing was changed.');
          return 1;
        }
      }
      const host = (io.hostname ?? hostname)();
      const name = values.name ?? ((await io.ask(`Name for this computer [${host}]: `)).trim() || host);
      const code = (await io.ask('Code from the dashboard (Sign-ins > Add a computer): ')).trim();
      if (code === '') throw new Fail('No code entered. Nothing saved.');
      const { token, label } = await exchangeDeviceCode(url, code, name, io.fetchImpl);
      update(io, (cfg) => {
        cfg.server_url = url;
      });
      saveToken(io.hubDir, token);
      io.out(`Connected as "${label}". Next: hub projects, then hub track <project> and hub sync.`);
      return 0;
    }
    case 'install-commands': {
      const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' } } });
      const dir = values.dir ?? join(io.home, '.claude', 'commands');
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(SLASH_COMMANDS)) writeFileSync(join(dir, name), text);
      io.out(`Installed ${Object.keys(SLASH_COMMANDS).length} slash commands in ${dir}.`);
      return 0;
    }
    case 'auto':
      return autoCase(io, rest[0]);
    case 'personal':
      await personal(io, rest);
      return 0;
    case 'docs':
      return docsCase(io, rest);
    default:
      throw new Fail(USAGE);
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
