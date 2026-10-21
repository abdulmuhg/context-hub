import { parseArgs } from 'node:util';
import type { Db } from './db.js';
import { digestCounts, getProjectState, markDigestPending, markStateDirty } from './digest-store.js';
import { createConnectCode, listGrants, revokeGrant } from './oauth/store.js';
import { resolveProject, splitPublicId } from './store.js';
import { formatUsd, usageReport, type Totals } from './usage.js';
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
  connect-code                                           print a one-time sign-in code for claude.ai or a browser (10 minutes)
  device-code                                            print a one-time code that connects a computer with hub login (10 minutes)
  oauth list                                             list Claude app sign-ins
  oauth revoke <id>                                      revoke a Claude app sign-in
  backup <file>                                          write a consistent copy of the database
  redigest <project> | redigest --session <source>:<id>  queue digests again
  redigest --failed [<project>]                          queue again only the digests that failed
  rebuild-state <project>                                rebuild a project's state page from all digests
  digests                                                show digest counts and problems
  usage [--days N]                                       show model calls, tokens and cost per day (default 7 days, UTC)`;

class Fail extends Error {}

function projectOrFail(io: AdminIo, input: string | undefined): { id: number; key: string } {
  if (!input) throw new Fail('Give a project key or name.');
  const r = resolveProject(io.db, input);
  if (!r.ok) throw new Fail(`No single project matches "${input}". Projects:\n${r.candidates.map((k) => `  ${k}`).join('\n')}`);
  return { id: r.id, key: r.key };
}

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

  if (command === 'connect-code') {
    const { code, expiresAt } = createConnectCode(io.db, now);
    io.out(`Sign-in code: ${code}`);
    io.out(`Valid until ${expiresAt}, for one use. Enter it on the hub's sign-in page when claude.ai asks you to sign in.`);
    return 0;
  }

  // The way in for a hub's very first computer, when no browser is signed in to the dashboard yet.
  if (command === 'device-code') {
    const { code, expiresAt } = createConnectCode(io.db, now, 'device');
    io.out(`Computer code: ${code}`);
    io.out(`Valid until ${expiresAt}, for one use. Enter it when hub login asks for a code on the new computer.`);
    return 0;
  }

  if (command === 'oauth' && sub === 'list') {
    const rows = listGrants(io.db);
    if (rows.length === 0) io.out('No Claude app sign-ins yet.');
    for (const r of rows) {
      const state = r.revokedAt ? `revoked ${r.revokedAt.slice(0, 10)}` : 'active';
      io.out(`${r.id}  ${r.clientName}  ${r.scopes.join(' ')}  created ${r.createdAt.slice(0, 10)}  last used ${r.lastUsedAt?.slice(0, 10) ?? 'never'}  ${state}`);
    }
    return 0;
  }

  if (command === 'oauth' && sub === 'revoke') {
    const id = Number(rest[0]);
    if (!rest[0] || !Number.isInteger(id)) throw new Fail('Give the numeric id from `hub-admin oauth list`.');
    if (!revokeGrant(io.db, id, now)) throw new Fail(`No active sign-in with id ${id}.`);
    io.out(`Sign-in ${id} revoked. Its access and refresh tokens stop working now.`);
    return 0;
  }

  if (command === 'backup') {
    if (!sub) throw new Fail('Give the file to write, for example: hub-admin backup /data/backup.sqlite');
    await io.db.backup(sub);
    io.out(`Backup written to ${sub}`);
    return 0;
  }

  if (command === 'redigest') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { session: { type: 'string' }, failed: { type: 'boolean' } },
      allowPositionals: true,
    });
    if (values.failed) {
      // A digest that already succeeded is not sent to the model again; refusals wait for --session.
      const project = positionals[0] === undefined ? null : projectOrFail(io, positionals[0]);
      const rows = io.db
        .prepare(
          `SELECT s.id FROM digests d JOIN sessions s ON s.id = d.session_id
           WHERE d.status = 'failed' AND s.parent IS NULL AND s.source <> 'doc' AND (? IS NULL OR s.project_id = ?)`,
        )
        .all(project?.id ?? null, project?.id ?? null) as { id: number }[];
      for (const r of rows) markDigestPending(io.db, r.id, now);
      io.out(`Queued ${rows.length} failed session${rows.length === 1 ? '' : 's'}${project ? ` of ${project.key}` : ''}.`);
      return 0;
    }
    if (values.session) {
      const parts = splitPublicId(values.session);
      if (!parts) throw new Fail('A session is written <source>:<id>, for example claude-code:1234.');
      const row = io.db.prepare('SELECT id, parent FROM sessions WHERE source = ? AND source_session_id = ?').get(parts.source, parts.id) as
        | { id: number; parent: string | null }
        | undefined;
      if (!row) throw new Fail(`No session with id "${values.session}".`);
      if (row.parent !== null) throw new Fail('That is a subagent transcript. Subagents are covered by their parent session; redigest the parent.');
      if (parts.source === 'doc') throw new Fail('That is a document. Documents are read as they are and have no digest.');
      markDigestPending(io.db, row.id, now);
      io.out(`Queued ${values.session}.`);
      return 0;
    }
    const project = projectOrFail(io, positionals[0]);
    const rows = io.db.prepare("SELECT id FROM sessions WHERE project_id = ? AND parent IS NULL AND source <> 'doc'").all(project.id) as { id: number }[];
    for (const r of rows) markDigestPending(io.db, r.id, now);
    io.out(`Queued ${rows.length} session${rows.length === 1 ? '' : 's'} of ${project.key}.`);
    return 0;
  }

  if (command === 'rebuild-state') {
    const project = projectOrFail(io, sub);
    if (!getProjectState(io.db, project.id)) {
      io.out(`${project.key} has no state page yet. One is written after its first digest.`);
      return 0;
    }
    markStateDirty(io.db, project.id);
    io.out(`${project.key}: the state page will be rebuilt from all digests on the worker's next pass.`);
    return 0;
  }

  if (command === 'digests') {
    const counts = digestCounts(io.db);
    io.out(`ok: ${counts.ok}  pending: ${counts.pending}  failed: ${counts.failed}  refused: ${counts.refused}`);
    const problems = io.db
      .prepare(
        `SELECT s.source, s.source_session_id, d.status, d.error, d.attempts, d.next_attempt_at
         FROM digests d JOIN sessions s ON s.id = d.session_id
         WHERE d.status IN ('failed', 'refused') ORDER BY d.updated_at DESC`,
      )
      .all() as { source: string; source_session_id: string; status: string; error: string | null; attempts: number; next_attempt_at: string | null }[];
    for (const p of problems) {
      const when = p.status === 'failed' ? `, attempt ${p.attempts}, next try ${p.next_attempt_at}` : '';
      io.out(`${p.status}  ${p.source}:${p.source_session_id}  ${p.error ?? ''}${when}`);
    }
    return 0;
  }

  if (command === 'usage') {
    const { values } = parseArgs({ args: argv.slice(1), options: { days: { type: 'string' } } });
    const days = values.days === undefined ? 7 : Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Fail('--days must be a whole number from 1 to 90.');
    const report = usageReport(io.db, days, now);
    const cost = (t: Totals): string => (t.calls > 0 && t.priced === 0 ? '—' : formatUsd(t.micro_usd));
    const line = (name: string, t: Totals): string =>
      `${name.padEnd(30)}  ${String(t.calls).padStart(6)} calls  ${String(t.input).padStart(12)} in  ${String(t.output).padStart(10)} out  ${cost(t).padStart(9)}`;
    io.out(`Model usage, last ${days} day${days === 1 ? '' : 's'} (UTC days)`);
    for (const d of report.days) io.out(line(d.day, d));
    io.out('');
    io.out('By kind');
    for (const k of report.by_kind) io.out(line(k.name, k));
    io.out('');
    io.out('By project');
    for (const p of report.by_project) io.out(line(p.name, p));
    io.out('');
    io.out(`over the 100K price step: ${report.over_step} call${report.over_step === 1 ? '' : 's'}`);
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
