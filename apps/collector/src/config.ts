import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Level, PersonalEntry } from '@context-hub/core';

export interface Config {
  server_url: string;
  /** Project keys that `hub sync` uploads. Empty by default. */
  tracked: string[];
  /** Session keys ("<source>:<id>") excluded from tracked projects. */
  skipped: string[];
  /** Project key -> project key. */
  aliases: Record<string, string>;
  /** Session key -> project key. */
  assignments: Record<string, string>;
  personal: { card: Level; list: Level };
}

export interface StateEntry {
  size: number;
  mtimeMs: number;
  project_key: string;
  /** Content hash last confirmed by the server, or null if never uploaded. */
  hash: string | null;
  synced_at: string | null;
}

export interface State {
  /** Fingerprint of the settings in force at the last complete sync. */
  fingerprint: string;
  /** Keyed by source file path. */
  files: Record<string, StateEntry>;
}

export function hubDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTEXT_HUB_HOME || join(homedir(), '.context-hub');
}

const defaultConfig = (): Config => ({
  server_url: '',
  tracked: [],
  skipped: [],
  aliases: {},
  assignments: {},
  personal: { card: 'warn', list: 'warn' },
});

function readJson<T>(dir: string, name: string, fallback: T): T {
  const path = join(dir, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new Error(`${path}: ${name} is not valid JSON. Fix or delete the file.`);
  }
}

function writePrivate(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // no effect on Windows, where the user profile ACL applies
  } catch {
    // best effort
  }
}

export function loadConfig(dir: string): Config {
  const saved = readJson<Partial<Config>>(dir, 'config.json', {});
  const d = defaultConfig();
  return { ...d, ...saved, personal: { ...d.personal, ...(saved.personal ?? {}) } };
}

export function saveConfig(dir: string, cfg: Config): void {
  writePrivate(dir, 'config.json', JSON.stringify(cfg, null, 2) + '\n');
}

export function loadState(dir: string): State {
  const saved = readJson<Partial<State>>(dir, 'state.json', {});
  return { fingerprint: saved.fingerprint ?? '', files: saved.files ?? {} };
}

export function saveState(dir: string, state: State): void {
  writePrivate(dir, 'state.json', JSON.stringify(state, null, 2) + '\n');
}

export function loadPersonal(dir: string): PersonalEntry[] {
  return readJson<{ entries?: PersonalEntry[] }>(dir, 'personal.json', {}).entries ?? [];
}

export function savePersonal(dir: string, entries: PersonalEntry[]): void {
  writePrivate(dir, 'personal.json', JSON.stringify({ entries }, null, 2) + '\n');
}

export function loadToken(dir: string): string | null {
  const path = join(dir, 'credentials');
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf8').trim();
  return token === '' ? null : token;
}

export function saveToken(dir: string, token: string): void {
  writePrivate(dir, 'credentials', token.trim() + '\n');
}

/** Covers every setting that changes what a session looks like when uploaded. */
export function settingsFingerprint(cfg: Config, entries: PersonalEntry[]): string {
  const sorted = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  const material = JSON.stringify({
    aliases: sorted(cfg.aliases),
    assignments: sorted(cfg.assignments),
    personal: [cfg.personal.card, cfg.personal.list],
    entries: entries.map((e) => [e.label, e.value, e.level ?? null]),
  });
  return createHash('sha256').update(material).digest('hex');
}
