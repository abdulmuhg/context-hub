import { readFileSync } from 'node:fs';

/**
 * The small JSON file `scripts/backup-context-hub.sh` writes after every run. Its folder is the
 * only part of the backup store the hub's container can see, and only read-only.
 */
export interface BackupStatus {
  finished_at: string;
  local_ok: boolean;
  size_bytes: number | null;
  offsite_configured: boolean;
  offsite_ok: boolean | null;
}

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isBoolOrNull = (v: unknown): v is boolean | null => typeof v === 'boolean' || v === null;

/**
 * Reads the backup status file. A missing path, an unreadable file, broken JSON or a field of the
 * wrong shape all give null, which the page shows as "no backup status yet": the file is written
 * by a script outside this repo, so a surprise in it must not break the dashboard.
 */
export function readBackupStatus(path: string | null): BackupStatus | null {
  if (path === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (!isTime(o['finished_at'])) return null;
  if (typeof o['local_ok'] !== 'boolean') return null;
  if (!(typeof o['size_bytes'] === 'number' || o['size_bytes'] === null)) return null;
  if (typeof o['offsite_configured'] !== 'boolean') return null;
  if (!isBoolOrNull(o['offsite_ok'])) return null;
  return {
    finished_at: o['finished_at'],
    local_ok: o['local_ok'],
    size_bytes: o['size_bytes'],
    offsite_configured: o['offsite_configured'],
    offsite_ok: o['offsite_ok'],
  };
}
