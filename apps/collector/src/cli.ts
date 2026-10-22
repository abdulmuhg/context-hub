import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { autoOff, autoOn, autoStatus, hookCommand, runAutoChild } from './auto.js';
import { claudeOnlyAsCmd, cleanEnv, findClaude } from './claude-llm.js';
import { SLASH_COMMANDS } from './commands.js';
import { isTrigger, TRIGGERS, type Effort, type Level, type Llm, type Trigger } from '@context-hub/core';
import {
  DEFAULT_SUMMARY_EFFORT,
  DEFAULT_SUMMARY_MODEL,
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveConfig,
  savePersonal,
  saveToken,
  type Config,
} from './config.js';
import { HUB_VERSION } from './version.js';
import { Fail, friendlyMessage } from './errors.js';
import { runResummarize } from './resummarize.js';
import { NO_CHECKOUT } from './git-check.js';
import type { CommandRunner } from './git-facts.js';
import { applyOverrides, projectMatches, realGit, resolveProjectKey, type GitRunner } from './project.js';
import { listProjects, runSync, type ProjectRow, type SyncProgress, type SyncReport } from './sync.js';
import { deleteRemote, exchangeDeviceCode, getStatus, requestConnectCode, type Remote } from './upload.js';

export interface Io {
  home: string;
  hubDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Writes the summaries. Left out, Claude Code on this computer is used. Tests pass a fake. */
  llm?: Llm | null;
  git?: GitRunner;
  /** The folder the command was run in; `hub sync` remembers it as the project's checkout. */
  cwd?: string;
  /** Runs git and gh to check pages against git. Tests pass a fake. */
  runCommand?: CommandRunner;
  exists?: (path: string) => boolean;
  hostname?: () => string;
  /** True when stdin and stdout are a terminal, so it is safe to ask questions. */
  interactive?: boolean;
  /** Rewrites one status line in place; an empty line clears it. Only set for a terminal. */
  progress?: (line: string) => void;
  /** For `hub auto` and `hub sync --auto`: the node binary and the running hub script. */
  execPath?: string;
  bundlePath?: string;
  spawn?: typeof spawn;
  /** For `hub doctor`: runs `claude` with these arguments (`mcp list`, `auth status --json`). found is false when Claude Code is not installed. */
  runClaude?: (args: string[]) => { found: boolean; output: string };
}

const USAGE = `Usage: hub <command>

  login [--url URL] [--name NAME]      connect this computer with a code from the dashboard
  sync                                 upload your tracked projects (asks about new ones)
  auto on | off | status               sync automatically when a Claude Code session ends
  doctor                               check that this computer is set up and connected

Advanced:
  init [--url URL] [--token TOKEN]     save the server address and upload token
  projects                             list projects found on this PC
  track <project> | untrack <project>  choose which projects are uploaded
  skip <session> | unskip <session>    exclude one session (<source>:<id>)
  alias <from> <to>                    merge or rename a project key
  assign <session> <project>           set the project of one session
  sync [--project P] [--session S] [--dry-run] [--all] [--trigger T]   (--project narrows tracked projects; --all lifts the cap on summaries;
                                       --trigger names what started it on the dashboard: terminal, slash, auto or other)
  summaries [model <id> | effort <level>]   show or change how this computer writes summaries
  resummarize [<project>] [--all] [--model-not ID]   rewrite older summaries with this computer's model
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
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SESSION_KEY = /^(claude-code|codex|antigravity):.+$/;

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
  return { url: cfg.server_url, token, fetchImpl: io.fetchImpl, trigger: triggerOf(io) };
}

/** Who started this run when it does not say: a person at a terminal, or something without one. */
function triggerOf(io: Io, given?: string): Trigger {
  if (given === undefined) return io.interactive ? 'terminal' : 'other';
  if (!isTrigger(given)) throw new Fail(`--trigger must be one of: ${TRIGGERS.join(', ')}`);
  return given;
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

/** What each step of a sync is called on the progress line. */
const PROGRESS_STEP: Record<SyncProgress['step'], string> = {
  read: 'Reading',
  owed: 'Summarizing owed',
  summarize: 'Summarizing',
  upload: 'Uploading',
  page: 'Updating project page',
};

function printReport(io: Io, report: SyncReport, dryRun: boolean): void {
  const list = dryRun ? report.wouldUpload : report.uploaded;
  const docs = list.filter((ref) => ref.session.startsWith('doc:')).length;
  const what = docs === 0 ? plural(list.length, 'session') : `${plural(list.length - docs, 'session')} and ${plural(docs, 'document')}`;
  io.out(`${dryRun ? 'Would upload' : 'Uploaded'} ${what}. Unchanged: ${report.unchanged}.`);
  const perProject = new Map<string, number>();
  for (const ref of list) perProject.set(ref.project, (perProject.get(ref.project) ?? 0) + 1);
  for (const [project, n] of perProject) io.out(`  ${project}: ${n}`);
  if (dryRun && report.wouldSummarize.length > 0) io.out(`Would summarize ${plural(report.wouldSummarize.length, 'session')}.`);
  if (!dryRun && report.summarized.length > 0) io.out(`${report.summarized.length} ${report.summarized.length === 1 ? 'summary' : 'summaries'} written.`);
  if (report.waiting.count > 0) io.out(`${plural(report.waiting.count, 'session')} waiting${report.waiting.reason ? `: ${report.waiting.reason}` : ''}`);
  if (report.pages.left.length > 0) io.out(`${plural(report.pages.left.length, 'page')} left for the next sync`);
  if (report.git.checked.length > 0) io.out(`Checked against git: ${plural(report.git.checked.length, 'project')}`);
  // Most projects have no checkout here until a session or a sync from inside one records it, so that reason is not news.
  const notChecked = report.git.skipped.filter((s) => s.reason !== NO_CHECKOUT);
  if (notChecked.length > 0) {
    io.out('Not checked against git:');
    for (const s of notChecked) io.out(`  ${shortName(s.project)}: ${s.reason}`);
  }
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
  const added: string[] = [];
  const skipped: string[] = [];
  for (const r of fresh) {
    const n = mainSessions(r);
    const answer = (await io.ask(`New project "${displayName(r.key)}" (${plural(n, 'session')}). Upload it to the hub? [y/N] `)).trim().toLowerCase();
    update(io, (cfg) => {
      if (answer === 'y') {
        if (!cfg.tracked.includes(r.key)) cfg.tracked.push(r.key);
      } else if (!cfg.declined.includes(r.key)) cfg.declined.push(r.key);
    });
    (answer === 'y' ? added : skipped).push(shortName(r.key));
  }
  if (added.length > 0) io.out(`Will upload: ${added.join(', ')}.`);
  if (skipped.length > 0) {
    const how = skipped.length === 1 ? `hub track ${skipped[0]}` : 'hub track <name>';
    io.out(`Not uploading: ${skipped.join(', ')}. Add it later with: ${how}`);
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
          all: { type: 'boolean' },
          auto: { type: 'boolean' },
          'auto-child': { type: 'boolean' },
          trigger: { type: 'string' },
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
        await runAutoChild({ ...scanOpts(io), fetchImpl: io.fetchImpl, ...(io.llm !== undefined ? { llm: io.llm } : {}) });
        return 0;
      }
      const trigger = triggerOf(io, values.trigger);
      const dryRun = values['dry-run'] === true;
      const plain = !dryRun && !values.project && !values.session;
      if (plain) await offerNewProjects(io);
      const wanted = values.project;
      if (wanted && !values.session && !loadConfig(io.hubDir).tracked.some((k) => projectMatches(wanted, k))) {
        throw new Fail(`"${wanted}" is not tracked, so nothing would be uploaded. Run \`hub track ${wanted}\` first.`);
      }
      // In a terminal, say what is happening: an upload of many sessions can take a while.
      const progress = io.interactive && !dryRun ? io.progress : undefined;
      let shown = false;
      if (io.interactive && !dryRun) io.out(`Syncing ${plural(loadConfig(io.hubDir).tracked.length, 'tracked project')}…`);
      const report = await runSync({
        ...scanOpts(io),
        fetchImpl: io.fetchImpl,
        ...(io.llm !== undefined ? { llm: io.llm } : {}),
        dryRun,
        all: values.all === true,
        project: values.project,
        session: values.session,
        trigger,
        ...(io.cwd ? { cwd: io.cwd } : {}),
        ...(io.runCommand ? { run: io.runCommand } : {}),
        onProgress:
          progress &&
          ((p) => {
            shown = true;
            const part = p.part ? ` (part ${p.part.index}/${p.part.total})` : '';
            progress(`${PROGRESS_STEP[p.step]} ${p.done}/${p.total}  ${shortName(p.project)}${part}`);
          }),
      });
      if (progress && shown) progress('');
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
      const status = await getStatus(remote(io));
      io.out(JSON.stringify(status, null, 2));
      const waiting = loadState(io.hubDir).last_waiting;
      if (waiting) io.out(`${plural(waiting.count, 'session')} waiting on this computer${waiting.reason ? `: ${waiting.reason}` : ''}`);
      const pages = status.pages_needed ?? [];
      if (pages.length > 0) io.out(`${plural(pages.length, 'project page')} waiting for an update: ${pages.join(', ')}`);
      const owed = status.summaries_owed ?? 0;
      if (owed > 0) io.out(`${owed} ${owed === 1 ? 'summary' : 'summaries'} owed after re-cleaning`);
      return 0;
    }
    case 'resummarize': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { all: { type: 'boolean' }, 'model-not': { type: 'string' } },
        allowPositionals: true,
      });
      const report = await runResummarize({
        hubDir: io.hubDir,
        project: positionals[0],
        all: values.all === true,
        modelNot: values['model-not'],
        fetchImpl: io.fetchImpl,
        ...(io.llm !== undefined ? { llm: io.llm } : {}),
      });
      io.out(`Rewrote ${report.rewritten.length} ${report.rewritten.length === 1 ? 'summary' : 'summaries'}.`);
      if (report.waiting.count > 0) io.out(`${plural(report.waiting.count, 'session')} waiting${report.waiting.reason ? `: ${report.waiting.reason}` : ''}`);
      if (report.pages.updated.length > 0) io.out(`Rebuilt ${plural(report.pages.updated.length, 'project page')}.`);
      if (report.pages.left.length > 0) io.out(`${plural(report.pages.left.length, 'page')} left for the next run`);
      return 0;
    }
    case 'summaries': {
      const [what, value] = rest;
      const current = loadConfig(io.hubDir).summaries ?? {};
      if (what === undefined) {
        io.out(`model: ${current.model ?? DEFAULT_SUMMARY_MODEL}`);
        io.out(`effort: ${current.effort ?? DEFAULT_SUMMARY_EFFORT}`);
        return 0;
      }
      if (what === 'model') {
        const model = need(value, 'model id');
        update(io, (cfg) => {
          cfg.summaries = { ...cfg.summaries, model };
        });
        io.out(`Summaries on this computer now use ${model}.`);
        return 0;
      }
      if (what === 'effort') {
        const level = need(value, 'effort level') as Effort;
        if (!EFFORTS.includes(level)) throw new Fail(`Effort must be one of: ${EFFORTS.join(', ')}.`);
        update(io, (cfg) => {
          cfg.summaries = { ...cfg.summaries, effort: level };
        });
        io.out(`Summaries on this computer now use effort ${level}.`);
        return 0;
      }
      throw new Fail(USAGE);
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
    case '--version':
      io.out(HUB_VERSION);
      return 0;
    case 'doctor':
      return doctorCase(io);
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

type Mark = '✓' | '!' | '✗' | '–';

const DAY_MS = 86_400_000;
const QUIET_DAYS = 3;

function ago(iso: string, now: number): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Runs `claude` for the doctor. `mcp list` checks every server, so it can take a few seconds. `auth status`
 * is run the way summaries are (no shell, the clean environment), so it reports what a summary run would see.
 */
function runClaudeCommand(args: string[]): { found: boolean; output: string } {
  if (args[0] === 'auth') {
    const cmd = findClaude();
    if (cmd === null) return { found: false, output: '' };
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, env: cleanEnv(process.env), windowsHide: true });
    return { found: r.status === 0, output: `${r.stdout ?? ''}` };
  }
  const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32', windowsHide: true });
  return { found: r.status === 0, output: `${r.stdout ?? ''}` };
}

/**
 * `hub doctor`: one line per piece of the setup, with the fix for anything wrong. Exit 1 only for
 * problems that stop uploads; warnings ("!") and skipped checks ("–") do not fail it.
 */
async function doctorCase(io: Io): Promise<number> {
  const rows: [Mark, string, string][] = [];
  const add = (mark: Mark, label: string, text: string): void => {
    rows.push([mark, label, text]);
  };
  const now = Date.now();
  const cfg = loadConfig(io.hubDir);
  const token = loadToken(io.hubDir);

  add('✓', 'hub command', bundleOf(io));
  let hubWritesSummaries = false;

  // Uploading: where to, and whether the hub accepts this computer.
  if (!cfg.server_url) {
    add('✗', 'Hub address', 'not set. Run: hub login');
  } else {
    const url = cfg.server_url.replace(/\/+$/, '');
    add('✓', 'Hub address', url);
    if (!token) {
      add('✗', 'Connection', 'no upload token saved. Run: hub login');
    } else {
      try {
        const s = await getStatus({ url: cfg.server_url, token, fetchImpl: io.fetchImpl });
        hubWritesSummaries = s.server_summaries === true;
        add('✓', 'Connection', `hub reachable, token accepted (${s.projects ?? '?'} projects, ${s.sessions ?? '?'} sessions)`);
      } catch (e) {
        const refused = /answered 40[13]/.test((e as Error).message);
        add('✗', 'Connection', refused ? "the hub refused this computer's token. Run: hub login" : `could not reach ${url}. Check the address and your network.`);
      }
    }
  }

  // What gets uploaded, and when it last was.
  const fresh = newProjects(listProjects(scanOpts(io)), cfg);
  if (cfg.tracked.length === 0) add('!', 'Tracked projects', 'none yet. Run: hub sync');
  else add('✓', 'Tracked projects', String(cfg.tracked.length));
  if (fresh.length > 0) {
    const names = fresh.slice(0, 5).map((r) => shortName(r.key)).join(', ');
    add('!', 'New projects', `${fresh.length} not decided (${names}${fresh.length > 5 ? ', …' : ''}). Run: hub sync`);
  }
  if (cfg.tracked.length > 0) {
    const last = Object.values(loadState(io.hubDir).files)
      .map((f) => f.synced_at)
      .filter((t): t is string => typeof t === 'string')
      .sort()
      .at(-1);
    if (!last) add('!', 'Last sync', 'never from this computer. Run: hub sync');
    else if (now - Date.parse(last) > QUIET_DAYS * DAY_MS) add('!', 'Last sync', `${ago(last, now)}. Run: hub sync`);
    else add('✓', 'Last sync', ago(last, now));
  }

  // Automatic sync is optional, so "off" is not a problem.
  const auto = autoStatus(join(io.home, '.claude', 'settings.json'), join(io.hubDir, 'auto.log'));
  if (!auto.on) add('–', 'Automatic sync', 'off (optional). Turn on with: hub auto on');
  else if (auto.lastLine && / error /.test(auto.lastLine)) add('!', 'Automatic sync', `on, but the last run failed: ${auto.lastLine}`);
  else add('✓', 'Automatic sync', auto.lastLine ? `on, last run: ${auto.lastLine}` : 'on, no run yet');

  // The slash commands, compared with the copies this hub command carries.
  const dir = join(io.home, '.claude', 'commands');
  const names = Object.keys(SLASH_COMMANDS);
  const stale = names.filter((n) => !existsSync(join(dir, n)) || readFileSync(join(dir, n), 'utf8') !== SLASH_COMMANDS[n]);
  if (stale.length === 0) add('✓', 'Slash commands', `${names.length} installed, up to date`);
  else add('!', 'Slash commands', `${stale.length} missing or out of date. Run: hub install-commands`);

  // Reading: whether Claude Code on this computer can reach the hub.
  const runClaude = io.runClaude ?? runClaudeCommand;
  const claude = runClaude(['mcp', 'list']);
  const hubLines = claude.output.split(/\r?\n/).filter((l) => /context-hub/i.test(l));
  if (!claude.found) add('–', 'Claude Code', 'not installed here, skipped');
  else if (hubLines.some((l) => /✓|✔|connected/i.test(l) && !/failed|✗|needs/i.test(l))) add('✓', 'Claude Code', 'context-hub connected');
  else if (hubLines.length > 0) add('!', 'Claude Code', `context-hub listed but not connected: ${hubLines[0]!.trim()}`);
  else add('!', 'Claude Code', 'no context-hub connection. Add the connector to this Claude account (README: "Read from the hub in the Claude apps").');

  // Summaries: written here by Claude Code, on its sign-in.
  const auth = runClaude(['auth', 'status', '--json']);
  if (!auth.found) {
    if (hubWritesSummaries) add('!', 'Summaries', "Claude Code is not installed; the hub will summarize this computer's sessions");
    else if (!io.runClaude && claudeOnlyAsCmd()) add('✗', 'Summaries', 'Claude Code is installed only as a .cmd file, which summaries cannot use. Install the native claude.exe, then run: claude');
    else add('✗', 'Summaries', 'Claude Code is not installed, so sessions wait here. Install it, then run: claude');
  } else {
    let loggedIn: boolean | null = null;
    try {
      loggedIn = (JSON.parse(auth.output) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      loggedIn = null;
    }
    const model = cfg.summaries?.model ?? DEFAULT_SUMMARY_MODEL;
    const effort = cfg.summaries?.effort ?? DEFAULT_SUMMARY_EFFORT;
    if (loggedIn === true) add('✓', 'Summaries', `Claude Code signed in, model ${model}, effort ${effort}`);
    else if (loggedIn === false) add('✗', 'Summaries', 'Claude Code is not signed in, or its login expired. Run: claude auth login');
    else add('!', 'Summaries', 'could not tell whether Claude Code is signed in. Run: claude');
  }
  const waiting = loadState(io.hubDir).last_waiting;
  if (waiting) add('!', 'Waiting summaries', `${plural(waiting.count, 'session')}${waiting.reason ? `: ${waiting.reason}` : ''}`);

  const width = Math.max(...rows.map(([, label]) => label.length)) + 2;
  for (const [mark, label, text] of rows) io.out(`${mark} ${label.padEnd(width)}${text}`);
  const fails = rows.filter(([m]) => m === '✗').length;
  const warns = rows.filter(([m]) => m === '!').length;
  io.out('');
  io.out(fails > 0 ? `${fails} problem(s) to fix${warns > 0 ? `, ${warns} thing(s) to look at` : ''}.` : warns > 0 ? `${warns} thing(s) to look at.` : 'All good.');
  return fails > 0 ? 1 : 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    io.err(friendlyMessage(e, io.hubDir));
    return 1;
  }
}
