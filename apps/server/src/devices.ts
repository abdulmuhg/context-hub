import type { Db } from './db.js';
import { consumeConnectCode } from './oauth/store.js';
import { createToken, retireIngestToken } from './tokens.js';

const MAX_NAME = 40;

/** A computer name from the wire: letters, digits, space, `.`, `_` and `-` only, at most 40 characters, never empty. */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return 'computer';
  const name = raw.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, MAX_NAME).trim();
  return name === '' ? 'computer' : name;
}

/** Swaps a device code for a new upload token labelled with the computer's name. When `retire` is the computer's current upload token, it is revoked once the new one exists. Null for a wrong, used or expired code. */
export function exchangeDeviceCode(
  db: Db,
  input: { code: string; name: string; retire?: string },
  now: string,
): { token: string; label: string } | null {
  return db.transaction(() => {
    if (!consumeConnectCode(db, input.code, now, 'device')) return null;
    const label = cleanDeviceName(input.name);
    const made = { token: createToken(db, label, 'ingest', now).token, label };
    if (input.retire) retireIngestToken(db, input.retire, now);
    return made;
  })();
}
