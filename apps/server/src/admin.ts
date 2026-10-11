import { parseArgs } from 'node:util';
import type { Db } from './db.js';
import { createToken, listTokens, revokeToken, type Scope } from './tokens.js';

export interface AdminIo {
  db: Db;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
}

const USAGE = `Usage: hub-admin <command>

  token create --label <name> --scope <ingest or read>   create a token (shown once)
  token list                                             list tokens
  token revoke <id>                                      revoke a token
  backup <file>                                          write a consistent copy of the database`;

class Fail extends Error {}

async function dispatch(argv: string[], io: AdminIo): Promise<number> {
  const now = (io.now ?? (() => new Date()))().toISOString();
  const [command, sub, ...rest] = argv;

  if (command === 'token' && sub === 'create') {
    const { values } = parseArgs({ args: rest, options: { label: { type: 'string' }, scope: { type: 'string' } } });
    if (!values.label) throw new Fail('A --label is required, for example --label claude-code-laptop.');
    if (values.scope !== 'ingest' && values.scope !== 'read') throw new Fail('--scope must be ingest or read.');
    const { id, token } = createToken(io.db, values.label, values.scope as Scope, now);
    io.out(`Token ${id} (${values.scope}, "${values.label}"):`);
    io.out(token);
    io.out('It is shown only once. Store it now.');
    return 0;
  }

  if (command === 'token' && sub === 'list') {
    const rows = listTokens(io.db);
    if (rows.length === 0) io.out('No tokens yet.');
    for (const r of rows) {
      const state = r.revoked_at ? `revoked ${r.revoked_at.slice(0, 10)}` : 'active';
      io.out(`${r.id}  ${r.scope}  ${r.label}  created ${r.created_at.slice(0, 10)}  last used ${r.last_used_at?.slice(0, 10) ?? 'never'}  ${state}`);
    }
    return 0;
  }

  if (command === 'token' && sub === 'revoke') {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Fail('Give the numeric id from `hub-admin token list`.');
    if (!revokeToken(io.db, id, now)) throw new Fail(`No active token with id ${id}.`);
    io.out(`Token ${id} revoked.`);
    return 0;
  }

  if (command === 'backup') {
    if (!sub) throw new Fail('Give the file to write, for example: hub-admin backup /data/backup.sqlite');
    await io.db.backup(sub);
    io.out(`Backup written to ${sub}`);
    return 0;
  }

  throw new Fail(USAGE);
}

export async function runAdmin(argv: string[], io: AdminIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
