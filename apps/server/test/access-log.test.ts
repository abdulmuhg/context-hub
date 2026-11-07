import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { openDb, type Db } from '../src/db.js';
import { createHandler } from '../src/http.js';
import { createLogger } from '../src/logger.js';
import { createToken } from '../src/tokens.js';
import { startServer } from './helpers.js';

let db: Db;
let url: string;
let close: () => Promise<void>;
let lines: string[];
const parsed = (): Array<Record<string, unknown>> => lines.map((l) => JSON.parse(l));
const accessLines = () => parsed().filter((l) => l.msg === 'request');

beforeEach(async () => {
  db = openDb(':memory:');
  lines = [];
  const logger = createLogger('debug', (l) => lines.push(l));
  ({ url, close } = await startServer({ db, logger, version: 'abc123' }));
});

afterEach(async () => {
  await close();
});

describe('access log', () => {
  it('logs method, path without query, status, ms and req_id, and never the query token', async () => {
    const res = await fetch(`${url}/api/status?token=secret`);
    expect(res.status).toBe(401);
    await res.text();
    const [line] = accessLines();
    expect(line).toMatchObject({ level: 'info', method: 'GET', path: '/api/status', status: 401 });
    expect(typeof line!.ms).toBe('number');
    expect(typeof line!.req_id).toBe('string');
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('puts keys in the order ts, level, msg, then fields', async () => {
    await (await fetch(`${url}/nope`)).text();
    expect(Object.keys(JSON.parse(lines[0]!)).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
  });

  it('sets X-Request-Id to the logged id and ignores a client-supplied one', async () => {
    const res = await fetch(`${url}/nope`, { headers: { 'X-Request-Id': 'evil' } });
    await res.text();
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe('evil');
    expect(accessLines()[0]!.req_id).toBe(id);
    expect(lines.join('\n')).not.toContain('evil');
  });

  it('never logs the Authorization header or bearer token', async () => {
    const { token } = createToken(db, 'c', 'ingest', new Date().toISOString());
    await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).text();
    const text = lines.join('\n');
    expect(text).not.toContain(token);
    expect(text.toLowerCase()).not.toContain('authorization');
  });

  it('logs exactly one line for a request aborted mid-flight', async () => {
    await new Promise<void>((resolve) => {
      const sock = connect(Number(new URL(url).port), '127.0.0.1', () => {
        sock.write('PUT /api/sessions/a/b HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\npartial');
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(accessLines()).toHaveLength(1);
  });

  it('logs /healthz at debug, so it is hidden at info', async () => {
    await (await fetch(`${url}/healthz`)).text();
    expect(accessLines()[0]!.level).toBe('debug');
  });

  it('logs an unhandled error as one error line with the stack, and answers 500 without it', async () => {
    const broken = openDb(':memory:');
    broken.exec('DROP TABLE tokens');
    const out: string[] = [];
    const server = createServer(createHandler({ db: broken, logger: createLogger('debug', (l) => out.push(l)) }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`, { headers: { Authorization: 'Bearer x' } });
    const body = await res.text();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(500);
    expect(body).not.toMatch(/at /);
    const errs = out.map((l) => JSON.parse(l)).filter((l) => l.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].msg).toBe('unhandled error');
    expect(typeof errs[0].err).toBe('string');
  });
});

describe('/healthz', () => {
  it('answers 200 with ok and the version, without a token', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'abc123' });
  });

  it('answers 503, not a 500 with a stack, when the database is closed', async () => {
    db.close();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, version: 'abc123' });
    expect(parsed().filter((l) => l.level === 'error')).toHaveLength(0);
  });
});
