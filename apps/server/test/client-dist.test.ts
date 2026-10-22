import { execFileSync, spawnSync } from 'node:child_process';
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
  dailyBudgetUsd: null,
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
    expect(body).toContain("HUB_URL='https://hub.test'");
    expect(body).toContain('setup --url');
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

  const posix = process.platform !== 'win32';

  /** A throwaway home with a fake curl that writes a stub bundle, which records the arguments it is run with. */
  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), 'install-'));
    const home = join(root, 'home');
    const fake = join(root, 'fakebin');
    mkdirSync(join(home, '.context-hub'), { recursive: true });
    mkdirSync(fake);
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
    const env = (extra: Record<string, string> = {}, front = ''): NodeJS.ProcessEnv =>
      ({ HOME: home, PATH: `${front}${fake}:${dirname(process.execPath)}:/usr/bin:/bin`, ...extra }) as NodeJS.ProcessEnv;
    const run = (args: string[] = [], e: NodeJS.ProcessEnv = env(), cmd = 'sh'): string =>
      execFileSync(cmd, cmd === 'sh' ? [script, ...args] : ['sh', script, ...args], { env: e, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const ranLog = (): string[] => readFileSync(join(home, 'ran.log'), 'utf8').trim().split('\n');
    return { root, home, fake, script, env, run, ranLog };
  }

  it.skipIf(!posix)('installs, updates in place and leaves ~/.context-hub alone', () => {
    const { home, run, ranLog } = sandbox();
    const config = join(home, '.context-hub', 'config.json');
    writeFileSync(config, '{"server_url":"https://keep.test"}\n');
    writeFileSync(join(home, '.context-hub', 'credentials'), 'secret-placeholder\n');
    const before = readFileSync(config);
    run();
    run();

    const bundle = join(home, '.local', 'share', 'context-hub', 'hub.mjs');
    const launcher = join(home, '.local', 'bin', 'hub');
    expect(existsSync(bundle)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toBe(`#!/bin/sh\nexec node "${bundle}" "$@"\n`);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(home, 'curl.log'), 'utf8').trim().split('\n')).toEqual([`${HUB}/hub.mjs`, `${HUB}/hub.mjs`]);
    const ran = ranLog();
    expect(ran[0]).toMatch(/^setup --url https:\/\/hub\.test --note Added ~\/\.local\/bin to the front of PATH in /);
    expect(ran[1]).toBe('setup --url https://hub.test');
    expect(readFileSync(config).equals(before)).toBe(true);
    expect(readFileSync(join(home, '.context-hub', 'credentials'), 'utf8')).toBe('secret-placeholder\n');
  });

  it.skipIf(!posix)('passes the code to setup', () => {
    const { run, ranLog } = sandbox();
    run(['--code', 'ABCD-EFGH']);
    expect(ranLog()[0]).toMatch(/^setup --url https:\/\/hub\.test --code ABCD-EFGH/);
  });

  it.skipIf(!posix)('stops before changing anything when Node is too old', () => {
    const { home, fake, run, env } = sandbox();
    writeFileSync(join(fake, 'node'), '#!/bin/sh\necho 20.11.0\n');
    chmodSync(join(fake, 'node'), 0o755);
    let output = '';
    try {
      run([], env());
    } catch (e) {
      output = String((e as { stdout?: string }).stdout);
    }
    expect(output).toContain('found: 20.11.0');
    expect(output).toContain('paste the same line again');
    expect(existsSync(join(home, '.local', 'share', 'context-hub', 'hub.mjs'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'hub'))).toBe(false);
  });

  it.skipIf(!posix)('adds the PATH line to the profile once', () => {
    const { home, run, env } = sandbox();
    run([], env({ SHELL: '/bin/zsh' }));
    run([], env({ SHELL: '/bin/zsh' }));
    const lines = readFileSync(join(home, '.zshrc'), 'utf8').split('\n').filter((l) => l.includes('# added by context-hub'));
    expect(lines).toEqual(['export PATH="$HOME/.local/bin:$PATH" # added by context-hub']);
  });

  it.skipIf(!posix)('renames an old context-hub launcher that comes first on PATH', () => {
    const { root, run, env, ranLog } = sandbox();
    const ahead = join(root, 'ahead');
    mkdirSync(ahead);
    writeFileSync(join(ahead, 'hub'), '#!/bin/sh\nexec node /src/context-hub/apps/collector/dist/bin.js "$@"\n');
    chmodSync(join(ahead, 'hub'), 0o755);
    run([], env({}, `${ahead}:`));
    expect(existsSync(join(ahead, 'hub'))).toBe(false);
    expect(existsSync(join(ahead, 'hub.old'))).toBe(true);
    expect(ranLog()[0]).toContain(`--note Renamed the old hub at ${ahead}/hub to ${ahead}/hub.old`);
  });

  it.skipIf(!posix)("leaves a hub that isn't ours and warns", () => {
    const { root, home, run, env, ranLog } = sandbox();
    const ahead = join(root, 'ahead');
    mkdirSync(ahead);
    writeFileSync(join(ahead, 'hub'), '#!/bin/sh\necho some other tool\n');
    chmodSync(join(ahead, 'hub'), 0o755);
    run([], env({}, `${ahead}:`));
    expect(existsSync(join(ahead, 'hub'))).toBe(true);
    expect(ranLog()[0]).toContain(`--warn Another hub at ${ahead}/hub comes first on PATH; this one is at ${home}/.local/bin/hub`);
  });

  const hasSetsid = posix && spawnSync('setsid', ['--version']).status === 0;
  it.skipIf(!hasSetsid)('runs setup without /dev/tty when there is none', () => {
    const { run, env, ranLog } = sandbox();
    run([], env(), 'setsid');
    expect(ranLog()[0]).toMatch(/^setup --url https:\/\/hub\.test/);
  });

  it.skipIf(!posix)('a failed download changes nothing', () => {
    const ok = sandbox();
    ok.run();
    const bundle = join(ok.home, '.local', 'share', 'context-hub', 'hub.mjs');
    const old = readFileSync(bundle, 'utf8');
    writeFileSync(join(ok.fake, 'curl'), '#!/bin/sh\necho "$@" >> "$HOME/curl.log"\nexit 22\n');
    let output = '';
    try {
      ok.run();
    } catch (e) {
      output = String((e as { stdout?: string }).stdout);
    }
    expect(output).toContain('hub.mjs');
    expect(output).toContain('Nothing was changed');
    expect(readFileSync(bundle, 'utf8')).toBe(old);
  });
});
