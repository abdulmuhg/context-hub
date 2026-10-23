import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** A problem the person can fix; its message is shown as it is. */
export class Fail extends Error {}

/** The hub could not be reached at all (DNS, TLS, timeout, refused). */
export class UnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`could not reach ${url}: ${reason}`);
  }
}

/** The hub answered with a status the caller did not expect. */
export class HttpStatusError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`${method} ${path}: server answered ${status}`);
  }
}

/** The one-time code was refused: expired, used or mistyped. The hub does not say which. */
export class BadCodeError extends Error {
  constructor() {
    super('The code was refused.');
  }
}

/** A network failure in plain words. */
export function plainReason(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: unknown } };
  const code = typeof err?.cause?.code === 'string' ? err.cause.code : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "the address wasn't found";
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'ECONNRESET') return 'the connection was dropped';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return "it didn't answer in time";
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'the network is unreachable';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return "it didn't answer in time";
  if (/^(CERT_|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO)/.test(code)) return "its certificate couldn't be checked";
  return err?.message ?? String(e);
}

const NEW_LINE = 'Get a new line from Sign-ins → Add a computer and paste it.';

/** What to show for any error: what happened and the one thing to do. A stack trace goes to the log, never the screen. */
export function friendlyMessage(e: unknown, hubDir: string, now: Date = new Date()): string {
  if (e instanceof Fail) return e.message;
  if (e instanceof BadCodeError) return `That code didn't work: it has expired, was already used, or was mistyped. ${NEW_LINE}`;
  if (e instanceof UnreachableError) {
    return `Can't reach ${e.url} (${e.reason}). Check your internet connection and the address, then try again.`;
  }
  if (e instanceof HttpStatusError) {
    if (e.status === 401 || e.status === 403) return `This computer was disconnected from the hub. ${NEW_LINE}`;
    if (e.status === 429) return 'Too many wrong codes from this address. Wait 15 minutes, then try again.';
    // Only these two are on every hub, so a 404 means the address is wrong; elsewhere it means something else.
    if (e.status === 404 && (e.path === '/api/status' || e.path === '/api/devices')) {
      return "That address answered, but it doesn't look like a context-hub. Check the address, then try again.";
    }
    if (e.status >= 500) return "The hub isn't answering properly right now (it may be restarting). Try again in a minute.";
  }
  const message = e instanceof Error ? e.message : String(e);
  const log = join(hubDir, 'error.log');
  try {
    mkdirSync(hubDir, { recursive: true });
    appendFileSync(log, `${now.toISOString()}\n${e instanceof Error ? (e.stack ?? message) : message}\n\n`);
  } catch {
    // The log is a courtesy; never fail on it.
  }
  return `Something went wrong: ${message.split(/\r?\n/)[0]}. Details are in ${log}`;
}
