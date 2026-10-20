import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installScript, loadClientBundle } from '../src/client-dist.js';
import { openDb } from '../src/db.js';
import type { AppDeps } from '../src/http.js';
import { startServer } from './helpers.js';

const HUB = 'https://hub.test';
const web = (publicOrigin: string | null) => ({
  imageTag: null,
  startedAt: '2026-10-20T12:00:00.000Z',
  digestsOn: false,
  backupStatusPath: null,
  secureCookies: false,
  publicOrigin,
});

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(extra: Partial<AppDeps>): Promise<string> {
  const s = await startServer({ db: openDb(':memory:'), ...extra });
  close = s.close;
  return s.url;
}

describe('GET /install and /hub.mjs', () => {
  it('answer 404 without a public URL', async () => {
    const url = await serve({ web: web(null), client: { bundle: 'x' } });
    expect((await fetch(url + '/install')).status).toBe(404);
    expect((await fetch(url + '/hub.mjs')).status).toBe(404);
  });

  it('serve the script with the hub address filled in, and need no session', async () => {
    const url = await serve({ web: web(HUB), client: { bundle: 'console.log(1)' } });
    const res = await fetch(url + '/install');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body).toContain('set -eu');
    expect(body).toContain("'https://hub.test/hub.mjs'");
    expect(body).toContain("hub login --url 'https://hub.test'");
  });

  it('serve the bundle, and 404 when there is none', async () => {
    const url = await serve({ web: web(HUB), client: { bundle: 'console.log("hub")' } });
    const res = await fetch(url + '/hub.mjs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('console.log("hub")');
    await close!();
    const none = await serve({ web: web(HUB), client: { bundle: null } });
    expect((await fetch(none + '/hub.mjs')).status).toBe(404);
  });
});

describe('loadClientBundle', () => {
  it('reads the file, and gives null when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'hub.mjs'), 'abc');
    expect(loadClientBundle(join(dir, 'hub.mjs'))).toBe('abc');
    expect(loadClientBundle(join(dir, 'nope.mjs'))).toBeNull();
  });
});

describe('the install script', () => {
  it('quotes an address that holds a quote', () => {
    expect(installScript("https://a.test/'x")).toContain(`'https://a.test/'\\''x/hub.mjs'`);
  });

  it.skipIf(process.platform === 'win32')('installs, updates in place and leaves ~/.context-hub alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'install-'));
    const home = join(root, 'home');
    const fake = join(root, 'fakebin');
    mkdirSync(join(home, '.context-hub'), { recursive: true });
    mkdirSync(fake);
    const config = join(home, '.context-hub', 'config.json');
    writeFileSync(config, '{"server_url":"https://keep.test"}\n');
    writeFileSync(join(home, '.context-hub', 'credentials'), 'secret-placeholder\n');

    // A curl that writes a stub bundle where -o says. The stub records its arguments.
    writeFileSync(
      join(fake, 'curl'),
      [
        '#!/bin/sh',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in -o) out="$2"; shift ;; http*) echo "$1" >> "$HOME/curl.log" ;; esac',
        '  shift',
        'done',
        `cat > "$out" <<'EOF'`,
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.HOME + '/ran.log', process.argv.slice(2).join(' ') + '\\n');",
        'EOF',
        '',
      ].join('\n'),
    );
    chmodSync(join(fake, 'curl'), 0o755);
    const script = join(root, 'install.sh');
    writeFileSync(script, installScript(HUB));

    const env = { HOME: home, PATH: `${fake}:${dirname(process.execPath)}:/usr/bin:/bin` } as NodeJS.ProcessEnv;
    const run = (): string => execFileSync('sh', [script], { env, encoding: 'utf8' });
    const before = readFileSync(config);
    run();
    run();

    const bundle = join(home, '.local', 'share', 'context-hub', 'hub.mjs');
    const launcher = join(home, '.local', 'bin', 'hub');
    expect(existsSync(bundle)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toBe(`#!/bin/sh\nexec node "${bundle}" "$@"\n`);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(home, 'curl.log'), 'utf8').trim().split('\n')).toEqual([`${HUB}/hub.mjs`, `${HUB}/hub.mjs`]);
    expect(readFileSync(join(home, 'ran.log'), 'utf8').trim().split('\n')).toEqual(['install-commands', 'install-commands']);
    expect(readFileSync(config).equals(before)).toBe(true);
    expect(readFileSync(join(home, '.context-hub', 'credentials'), 'utf8')).toBe('secret-placeholder\n');
  });
});
