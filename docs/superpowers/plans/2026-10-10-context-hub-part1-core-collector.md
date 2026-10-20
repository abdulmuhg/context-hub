# context-hub Part 1: Core and Collector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `hub` command: it reads Claude Code, Codex and Antigravity history on a PC, turns tracked sessions into one common format with secrets stripped and personal data filtered, and uploads them to the context-hub ingest API.

**Architecture:** A pnpm workspace with two packages. `packages/core` is pure logic with no I/O: the common session format, secret stripping, the personal data filter, hashing, remote-URL normalisation. `apps/collector` owns all I/O: one adapter per tool, the project resolver (calls git), config and state files, the sync engine, the HTTP upload and the CLI. The collector never calls an LLM.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22, pnpm 11 workspaces, vitest, tsx, tsup. No runtime dependencies beyond Node built-ins.

**Spec:** `docs/superpowers/specs/2026-10-10-context-hub-design.md` — sections 5, 6, 7, 8 and the collector rows of section 11.

## Plan series

The spec covers four subsystems. Each gets its own plan and each plan ends with working, tested software.

| Part | Delivers | Status |
|---|---|---|
| 1 (this file) | `packages/core` and the `hub` collector. `hub sync --dry-run` works against real history; uploads are tested against a fake server | Ready |
| 2 | Server: SQLite storage, ingest API, tokens, search, MCP lookup tools | Written after part 1 lands |
| 3 | Digests and project state pages | Written after part 2 lands |
| 4 | Dockerfile, deploy workflow, `vps-stack` changes, backup | Written after part 3 lands |

Parts 2 to 4 are written later on purpose: they import the types this part defines, and plan code written against interfaces that have not been compiled yet goes stale.

## Global Constraints

- Node `>=22`, pnpm `11.x`. ESM only (`"type": "module"`); relative imports end in `.js`.
- `packages/core` has no I/O and no dependencies. It must not import `node:fs`, `node:child_process` or `fetch`.
- Tests never read real history. Every test builds its input in a temp directory or inline.
- No secret-shaped literal may appear in a committed file (GitHub push protection would block the push). Tests build fake secrets by string concatenation at run time, for example `'gh' + 'p_' + 'a'.repeat(36)`.
- Caps, copied from the spec: `tool_input` 2,000 characters; `tool_result` first 1,500 plus last 500; `title` 80 characters.
- Marker formats, copied from the spec: `[REDACTED:<type>]`, `[CARD ····4242]`, `[PERSONAL:<label> ····7890]`.
- Personal data levels: `off`, `warn`, `partial`, `full`. Default `warn`.
- Project keys: normalised git remote such as `github.com/abdulmuhg/jsonroom`, else `local:<name>`, else `unfiled`.
- Nothing is tracked by default. A sync with an empty tracked list uploads nothing.
- Collector files live in `~/.context-hub/`, or in `CONTEXT_HUB_HOME` when that variable is set (tests use it).
- Commit after every task. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but does not spell out. Each has a pinned test in the task named.

1. **Claude Code content blocks that are not text or tool calls** (`image` with base64 data, `server_tool_use`, `advisor_tool_result`): dropped and counted, never uploaded. Task 6.
2. **Codex files carry every turn twice** (`response_item` and `event_msg`): only `response_item` is read, so no turn is duplicated. Task 7.
3. **Antigravity steps still `RUNNING`**: skipped, so half a turn is never uploaded. Task 8.
4. **A session's project key changes between syncs** (alias or assignment added): the session is uploaded again under the new key even though its file did not change. Task 10.
5. **The server fails partway through a sync**: sessions already confirmed stay synced, the rest stay pending, and the next sync sends only those. Task 10.

## File structure

```
package.json, pnpm-workspace.yaml, tsconfig.json, .gitignore, .gitattributes
packages/core/
  package.json
  src/types.ts          common session format
  src/hash.ts           canonical JSON + SHA-256
  src/secrets.ts        stripSecrets
  src/personal.ts       luhn, filterPersonal
  src/sanitize.ts       sanitizeSession: strip, filter, cap, title, hash
  src/remote.ts         normalizeRemote
  src/index.ts          re-exports
  test/*.test.ts
apps/collector/
  package.json, tsup.config.ts
  src/adapters/types.ts       Adapter, SessionFile, RawSession, helpers
  src/adapters/claude-code.ts
  src/adapters/codex.ts
  src/adapters/antigravity.ts
  src/adapters/index.ts       ALL_ADAPTERS
  src/project.ts              resolveProjectKey, applyOverrides, projectMatches
  src/config.ts               config, credentials, personal list, state, fingerprint
  src/upload.ts               putSession, deleteRemote, getStatus
  src/sync.ts                 runSync, listProjects
  src/cli.ts                  the hub command: run(argv, io)
  src/bin.ts                  program entry: wires run() to the real terminal
  test/*.test.ts, test/helpers.ts
integrations/claude-code/hub-sync.md   slash command
```

---

### Task 1: Workspace, common format and hashing

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore`, `.gitattributes`
- Create: `packages/core/package.json`, `packages/core/src/types.ts`, `packages/core/src/hash.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/hash.test.ts`

**Interfaces:**
- Produces: types `Source`, `ToolStatus`, `TextMessage`, `ToolCallMessage`, `Message`, `Session`, `HashedSession`, `SessionInput`; function `contentHash(session: Session): string`.

- [ ] **Step 1: Write the workspace files**

`package.json`:

```json
{
  "name": "context-hub",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.17.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test"]
}
```

`.gitignore`:

```
node_modules/
dist/
```

`.gitattributes`:

```
* text=auto eol=lf
```

`packages/core/package.json`:

```json
{
  "name": "@context-hub/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 2: Install dev tools**

Run: `pnpm add -D -w typescript vitest tsx @types/node`
Expected: a `pnpm-lock.yaml` is created and `node_modules/` exists.

- [ ] **Step 3: Write the failing test**

`packages/core/test/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contentHash, type Session } from '../src/index.js';

const base: Session = {
  source: 'claude-code',
  source_session_id: 's1',
  account_id: null,
  project_key: 'local:demo',
  parent: null,
  title: 'Demo',
  cwd: null,
  git_branch: null,
  started_at: null,
  last_activity_at: null,
  messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello' }],
};

describe('contentHash', () => {
  it('is a 64-character hex string', () => {
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as Session;
    expect(contentHash(reordered)).toBe(contentHash(base));
  });

  it('changes when the project key changes', () => {
    expect(contentHash({ ...base, project_key: 'local:other' })).not.toBe(contentHash(base));
  });

  it('changes when a message changes', () => {
    const changed: Session = {
      ...base,
      messages: [{ seq: 0, role: 'user', kind: 'text', ts: null, text: 'hello!' }],
    };
    expect(contentHash(changed)).not.toBe(contentHash(base));
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm vitest run packages/core/test/hash.test.ts`
Expected: FAIL, cannot resolve `../src/index.js`.

- [ ] **Step 5: Write the implementation**

`packages/core/src/types.ts`:

```ts
export type Source = 'claude-code' | 'codex' | 'antigravity';
export type ToolStatus = 'ok' | 'error';

export interface TextMessage {
  seq: number;
  role: 'user' | 'assistant';
  kind: 'text';
  ts: string | null;
  text: string;
}

export interface ToolCallMessage {
  seq: number;
  role: 'assistant';
  kind: 'tool_call';
  ts: string | null;
  tool_name: string;
  tool_input: string;
  tool_result: string;
  tool_status: ToolStatus;
}

export type Message = TextMessage | ToolCallMessage;

export interface Session {
  source: Source;
  source_session_id: string;
  account_id: string | null;
  project_key: string;
  /** For a subagent transcript: the source_session_id of its main session. */
  parent: string | null;
  title: string;
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  messages: Message[];
}

export interface HashedSession extends Session {
  content_hash: string;
}

/** What sanitizeSession accepts: title may be missing, times are derived. */
export type SessionInput = Omit<Session, 'title' | 'started_at' | 'last_activity_at'> & {
  title: string | null;
};
```

`packages/core/src/hash.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Session } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value ?? null);
}

export function contentHash(session: Session): string {
  return createHash('sha256').update(canonical(session)).digest('hex');
}
```

`packages/core/src/index.ts`:

```ts
export * from './types.js';
export * from './hash.js';
```

Note: `node:crypto` is allowed in core. It is not I/O.

- [ ] **Step 6: Run the test and the typecheck**

Run: `pnpm vitest run packages/core/test/hash.test.ts`
Expected: PASS, 4 tests.

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add workspace, common session format and content hash"
```

---

### Task 2: Secret stripping

**Files:**
- Create: `packages/core/src/secrets.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/secrets.test.ts`

**Interfaces:**
- Produces: `stripSecrets(text: string): { text: string; counts: Record<string, number> }`. Count keys are the marker types: `private_key`, `github`, `anthropic`, `openai`, `aws`, `google`, `slack`, `stripe`, `npm`, `jwt`, `auth_header`, `password`, `env`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { stripSecrets } from '../src/index.js';

// Built at run time so no secret-shaped literal is committed.
const a = (n: number) => 'a'.repeat(n);
const fakes: Record<string, string> = {
  github: 'gh' + 'p_' + a(36),
  github_pat: 'github' + '_pat_' + a(30),
  anthropic: 'sk-' + 'ant-' + a(40),
  openai: 'sk-' + 'proj-' + a(40),
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  google: 'AI' + 'za' + a(35),
  slack: 'xo' + 'xb-' + '1234567890-' + a(12),
  stripe: 'sk_' + 'live_' + a(24),
  npm: 'np' + 'm_' + a(36),
  jwt: 'ey' + 'J' + a(12) + '.' + a(12) + '.' + a(12),
};

describe('stripSecrets', () => {
  it.each([
    ['github', fakes.github, 'github'],
    ['github fine-grained', fakes.github_pat, 'github'],
    ['anthropic', fakes.anthropic, 'anthropic'],
    ['openai', fakes.openai, 'openai'],
    ['aws', fakes.aws, 'aws'],
    ['google', fakes.google, 'google'],
    ['slack', fakes.slack, 'slack'],
    ['stripe', fakes.stripe, 'stripe'],
    ['npm', fakes.npm, 'npm'],
    ['jwt', fakes.jwt, 'jwt'],
  ])('replaces a %s key', (_name, secret, type) => {
    const out = stripSecrets(`before ${secret} after`);
    expect(out.text).toBe(`before [REDACTED:${type}] after`);
    expect(out.counts[type]).toBe(1);
  });

  it('replaces a whole private key block', () => {
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${a(64)}\n${a(64)}\n-----END RSA PRIVATE KEY-----`;
    const out = stripSecrets(`key:\n${block}\ndone`);
    expect(out.text).toBe('key:\n[REDACTED:private_key]\ndone');
  });

  it('replaces the value of an Authorization header and keeps the scheme', () => {
    const out = stripSecrets('Authorization: Bearer abc.def-123');
    expect(out.text).toBe('Authorization: Bearer [REDACTED:auth_header]');
  });

  it('replaces the password in a connection string', () => {
    const out = stripSecrets('postgres://app:s3cr3t@db.example.com:5432/app');
    expect(out.text).toBe('postgres://app:[REDACTED:password]@db.example.com:5432/app');
  });

  it('replaces the value on an env line with a secret-looking name', () => {
    const out = stripSecrets('PORT=3000\nAPP_API_KEY=hunter2hunter2\nexport DB_PASSWORD: pw');
    expect(out.text).toBe('PORT=3000\nAPP_API_KEY=[REDACTED:env]\nexport DB_PASSWORD: [REDACTED:env]');
    expect(out.counts.env).toBe(2);
  });

  it('does not redact an env value twice', () => {
    const out = stripSecrets(`GITHUB_TOKEN=${fakes.github}`);
    expect(out.text).toBe('GITHUB_TOKEN=[REDACTED:github]');
    expect(out.counts.env).toBeUndefined();
  });

  it('leaves ordinary text alone', () => {
    const text = 'The author fixed the key handler in src/auth.ts and ran npm test.';
    expect(stripSecrets(text)).toEqual({ text, counts: {} });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/test/secrets.test.ts`
Expected: FAIL, `stripSecrets` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/core/src/secrets.ts`:

```ts
interface Rule {
  type: string;
  re: RegExp;
  /** Builds the replacement from the match groups. Default: the bare marker. */
  replace?: (groups: string[], marker: string) => string;
}

const ENV_NAME = '[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH)[A-Z0-9_]*';

// Order matters: specific formats first, the broad env-line rule last.
const RULES: Rule[] = [
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { type: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { type: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { type: 'slack', re: /\bxox[a-z]-[A-Za-z0-9-]{10,}/g },
  { type: 'stripe', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { type: 'npm', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    type: 'auth_header',
    re: /(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s"'[]+)/gi,
    replace: (g, marker) => g[0] + marker,
  },
  {
    type: 'password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/[]+)(@)/gi,
    replace: (g, marker) => g[0] + marker + g[2],
  },
  {
    type: 'env',
    re: new RegExp(`^(\\s*(?:export\\s+)?${ENV_NAME}\\s*[=:]\\s*)(?!\\[REDACTED:)(\\S+)`, 'gm'),
    replace: (g, marker) => g[0] + marker,
  },
];

export function stripSecrets(text: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    const marker = `[REDACTED:${rule.type}]`;
    out = out.replace(rule.re, (...args: unknown[]) => {
      counts[rule.type] = (counts[rule.type] ?? 0) + 1;
      // args: match, ...groups, offset, whole string
      const groups = args.slice(1, -2).map((x) => (typeof x === 'string' ? x : ''));
      return rule.replace ? rule.replace(groups, marker) : marker;
    });
  }
  return { text: out, counts };
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from './secrets.js';
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/test/secrets.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add secret stripping"
```

---

### Task 3: Personal data filter

**Files:**
- Create: `packages/core/src/personal.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/personal.test.ts`

**Interfaces:**
- Produces:
  - `type Level = 'off' | 'warn' | 'partial' | 'full'`
  - `interface PersonalEntry { label: string; value: string; level?: Level }`
  - `interface PersonalConfig { card: Level; list: Level; entries: PersonalEntry[] }`
  - `luhn(digits: string): boolean`
  - `filterPersonal(text: string, cfg: PersonalConfig): { text: string; findings: Record<string, number> }`. Finding keys are `card` or the entry label.

- [ ] **Step 1: Write the failing test**

`packages/core/test/personal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterPersonal, luhn, type PersonalConfig } from '../src/index.js';

const CARD = '4242424242424242'; // public test number, passes Luhn
const cfg = (over: Partial<PersonalConfig> = {}): PersonalConfig => ({
  card: 'warn',
  list: 'warn',
  entries: [],
  ...over,
});

describe('luhn', () => {
  it('accepts a valid number and rejects a changed one', () => {
    expect(luhn(CARD)).toBe(true);
    expect(luhn('4242424242424243')).toBe(false);
  });
});

describe('filterPersonal: cards', () => {
  it('warn reports but leaves the text unchanged', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg());
    expect(out).toEqual({ text: `card ${CARD} ok`, findings: { card: 1 } });
  });

  it('partial keeps the last four digits', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg({ card: 'partial' }));
    expect(out.text).toBe('card [CARD ····4242] ok');
  });

  it('full replaces the number', () => {
    const out = filterPersonal(`card ${CARD} ok`, cfg({ card: 'full' }));
    expect(out.text).toBe('card [REDACTED:card] ok');
  });

  it('off neither changes nor reports', () => {
    expect(filterPersonal(CARD, cfg({ card: 'off' }))).toEqual({ text: CARD, findings: {} });
  });

  it('finds a number written with spaces or dashes', () => {
    expect(filterPersonal('4242 4242 4242 4242', cfg({ card: 'full' })).text).toBe('[REDACTED:card]');
    expect(filterPersonal('4242-4242-4242-4242', cfg({ card: 'full' })).text).toBe('[REDACTED:card]');
  });

  it('leaves a 16-digit number that fails Luhn alone', () => {
    const text = 'order 4242424242424243';
    expect(filterPersonal(text, cfg({ card: 'full' }))).toEqual({ text, findings: {} });
  });

  it('does not match digits inside a longer number', () => {
    const text = `id 9${CARD}9`;
    expect(filterPersonal(text, cfg({ card: 'full' })).findings).toEqual({});
  });
});

describe('filterPersonal: personal list', () => {
  const phone = { label: 'phone', value: '0812-3456-7890' };

  it('matches the same digits written with other separators', () => {
    const out = filterPersonal('call 0812 3456 7890 now', cfg({ list: 'full', entries: [phone] }));
    expect(out).toEqual({ text: 'call [REDACTED:phone] now', findings: { phone: 1 } });
  });

  it('partial keeps the last four digits and shows the label', () => {
    const out = filterPersonal('call 081234567890', cfg({ list: 'partial', entries: [phone] }));
    expect(out.text).toBe('call [PERSONAL:phone ····7890]');
  });

  it('treats a different prefix as a different value', () => {
    const text = 'call +62 812 3456 7890';
    expect(filterPersonal(text, cfg({ list: 'full', entries: [phone] })).findings).toEqual({});
  });

  it('matches text values without regard to case', () => {
    const entry = { label: 'home-address', value: 'Jalan Mawar 12' };
    const out = filterPersonal('ship to JALAN MAWAR 12 please', cfg({ list: 'full', entries: [entry] }));
    expect(out.text).toBe('ship to [REDACTED:home-address] please');
  });

  it('masks a value shorter than 8 characters completely under partial', () => {
    const entry = { label: 'pin', value: '4821' };
    const out = filterPersonal('pin 4821', cfg({ list: 'partial', entries: [entry] }));
    expect(out.text).toBe('pin [REDACTED:pin]');
  });

  it('lets an entry level override the list level', () => {
    const entry = { ...phone, level: 'full' as const };
    const out = filterPersonal('081234567890', cfg({ list: 'warn', entries: [entry] }));
    expect(out.text).toBe('[REDACTED:phone]');
  });

  it('treats regex characters in a value literally', () => {
    const entry = { label: 'handle', value: 'a.b(c)+d' };
    expect(filterPersonal('x axb(c)+d y', cfg({ list: 'full', entries: [entry] })).findings).toEqual({});
    expect(filterPersonal('x a.b(c)+d y', cfg({ list: 'full', entries: [entry] })).text).toBe('x [REDACTED:handle] y');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/core/test/personal.test.ts`
Expected: FAIL, `filterPersonal` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/core/src/personal.ts`:

```ts
export type Level = 'off' | 'warn' | 'partial' | 'full';

export interface PersonalEntry {
  label: string;
  value: string;
  level?: Level;
}

export interface PersonalConfig {
  card: Level;
  list: Level;
  entries: PersonalEntry[];
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const DIGITS_AND_SEPARATORS = /^[\d\s().+-]+$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryRegex(value: string): RegExp {
  const digits = value.replace(/\D/g, '');
  if (DIGITS_AND_SEPARATORS.test(value) && digits.length >= 4) {
    // Compare digits only: any run of separators may sit between them.
    return new RegExp('(?<![\\d+])' + digits.split('').join('[\\s().-]*') + '(?!\\d)', 'g');
  }
  return new RegExp(escapeRegex(value), 'gi');
}

/** `compact` is the matched value without separators; `name` labels the marker. */
function mask(level: Level, compact: string, partialPrefix: string, name: string): string | null {
  if (level === 'full') return `[REDACTED:${name}]`;
  if (level === 'partial') {
    if (compact.length < 8) return `[REDACTED:${name}]`;
    return `[${partialPrefix} ····${compact.slice(-4)}]`;
  }
  return null; // warn: leave unchanged
}

export function filterPersonal(
  text: string,
  cfg: PersonalConfig,
): { text: string; findings: Record<string, number> } {
  const findings: Record<string, number> = {};
  let out = text;

  for (const entry of cfg.entries) {
    const level = entry.level ?? cfg.list;
    if (level === 'off' || entry.value.trim() === '') continue;
    const numeric = DIGITS_AND_SEPARATORS.test(entry.value);
    out = out.replace(entryRegex(entry.value), (match) => {
      findings[entry.label] = (findings[entry.label] ?? 0) + 1;
      const compact = numeric ? match.replace(/\D/g, '') : match;
      return mask(level, compact, `PERSONAL:${entry.label}`, entry.label) ?? match;
    });
  }

  if (cfg.card !== 'off') {
    out = out.replace(CARD_RE, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
      findings.card = (findings.card ?? 0) + 1;
      return mask(cfg.card, digits, 'CARD', 'card') ?? match;
    });
  }

  return { text: out, findings };
}
```

The `(?<![\d+])` lookbehind is what makes `+62 812…` a different value from `0812…`: a listed number never matches when it is the tail of a longer or `+`-prefixed number.

Add to `packages/core/src/index.ts`:

```ts
export * from './personal.js';
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/test/personal.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add personal data filter with four levels"
```

---

### Task 4: Session sanitising and remote normalisation

**Files:**
- Create: `packages/core/src/sanitize.ts`, `packages/core/src/remote.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/sanitize.test.ts`, `packages/core/test/remote.test.ts`

**Interfaces:**
- Consumes: `stripSecrets`, `filterPersonal`, `contentHash`, `SessionInput`, `HashedSession`, `PersonalConfig`.
- Produces:
  - `sanitizeSession(input: SessionInput, personal: PersonalConfig): SanitizeResult`
  - `interface SanitizeResult { session: HashedSession; secrets: Record<string, number>; personal: Record<string, number> }`
  - `normalizeRemote(url: string): string | null`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/sanitize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeSession, type PersonalConfig, type SessionInput } from '../src/index.js';

const personal: PersonalConfig = { card: 'full', list: 'warn', entries: [] };
const secret = 'gh' + 'p_' + 'a'.repeat(36);

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  source: 'claude-code',
  source_session_id: 's1',
  account_id: 'acct',
  project_key: 'local:demo',
  parent: null,
  title: null,
  cwd: 'C:\\work\\demo',
  git_branch: 'main',
  messages: [
    { seq: 9, role: 'user', kind: 'text', ts: '2026-10-01T10:00:00Z', text: `use ${secret} please` },
    {
      seq: 9,
      role: 'assistant',
      kind: 'tool_call',
      ts: '2026-10-01T10:05:00Z',
      tool_name: 'Bash',
      tool_input: 'x'.repeat(2500),
      tool_result: 'H'.repeat(1500) + 'M'.repeat(1000) + 'T'.repeat(500),
      tool_status: 'ok',
    },
  ],
  ...over,
});

describe('sanitizeSession', () => {
  it('strips secrets from text and counts them', () => {
    const out = sanitizeSession(input(), personal);
    expect(out.session.messages[0]).toMatchObject({ text: 'use [REDACTED:github] please' });
    expect(out.secrets).toEqual({ github: 1 });
  });

  it('renumbers seq from zero', () => {
    expect(sanitizeSession(input(), personal).session.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('caps tool input at 2000 characters', () => {
    const m = sanitizeSession(input(), personal).session.messages[1];
    expect(m.kind === 'tool_call' && m.tool_input.length).toBe(2000);
  });

  it('keeps the first 1500 and last 500 characters of a long tool result', () => {
    const m = sanitizeSession(input(), personal).session.messages[1];
    if (m.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(m.tool_result.startsWith('H'.repeat(1500))).toBe(true);
    expect(m.tool_result.endsWith('T'.repeat(500))).toBe(true);
    expect(m.tool_result).not.toContain('M');
  });

  it('strips a secret before capping, so one that straddles the cap is still caught', () => {
    const straddling = 'x'.repeat(1990) + secret;
    const base = input();
    const tool = { ...base.messages[1], tool_input: straddling } as SessionInput['messages'][0];
    const out = sanitizeSession({ ...base, messages: [base.messages[0], tool] }, personal);
    const m = out.session.messages[1];
    expect(m.kind === 'tool_call' && m.tool_input).not.toContain('gh' + 'p_');
  });

  it('derives the title from the first user message, 80 characters, one line', () => {
    const long = 'fix the\nlogin   bug ' + 'y'.repeat(200);
    const base = input();
    const out = sanitizeSession(
      { ...base, messages: [{ ...base.messages[0], text: long } as SessionInput['messages'][0]] },
      personal,
    );
    expect(out.session.title).toBe(('fix the login bug ' + 'y'.repeat(200)).slice(0, 80));
  });

  it('keeps a title the tool provided, but still strips secrets from it', () => {
    const out = sanitizeSession(input({ title: `deploy ${secret}` }), personal);
    expect(out.session.title).toBe('deploy [REDACTED:github]');
  });

  it('uses a fixed title when there is no user text', () => {
    expect(sanitizeSession(input({ messages: [] }), personal).session.title).toBe('(untitled)');
  });

  it('derives start and last-activity times from the messages', () => {
    const s = sanitizeSession(input(), personal).session;
    expect(s.started_at).toBe('2026-10-01T10:00:00Z');
    expect(s.last_activity_at).toBe('2026-10-01T10:05:00Z');
  });

  it('applies the personal filter and reports findings', () => {
    const base = input();
    const out = sanitizeSession(
      { ...base, messages: [{ ...base.messages[0], text: 'card 4242424242424242' } as SessionInput['messages'][0]] },
      personal,
    );
    expect(out.session.messages[0]).toMatchObject({ text: 'card [REDACTED:card]' });
    expect(out.personal).toEqual({ card: 1 });
  });

  it('produces a stable content hash', () => {
    const a = sanitizeSession(input(), personal).session.content_hash;
    const b = sanitizeSession(input(), personal).session.content_hash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});
```

`packages/core/test/remote.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeRemote } from '../src/index.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:abdulmuhg/jsonroom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/AbdulMuhg/JsonRoom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/abdulmuhg/jsonroom/', 'github.com/abdulmuhg/jsonroom'],
    ['https://user:token@github.com/abdulmuhg/jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['ssh://git@gitlab.example.com:2222/team/app.git', 'gitlab.example.com/team/app'],
  ])('%s -> %s', (url, key) => {
    expect(normalizeRemote(url)).toBe(key);
  });

  it.each([['jsonroom'], [''], ['C:\\Users\\you\\project\\jsonroom'], ['/home/you/jsonroom']])(
    'returns null for %s',
    (value) => {
      expect(normalizeRemote(value)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/core/test/sanitize.test.ts packages/core/test/remote.test.ts`
Expected: FAIL, `sanitizeSession` and `normalizeRemote` are not exported.

- [ ] **Step 3: Write the implementation**

`packages/core/src/sanitize.ts`:

```ts
import { contentHash } from './hash.js';
import { filterPersonal, type PersonalConfig } from './personal.js';
import { stripSecrets } from './secrets.js';
import type { HashedSession, Message, Session, SessionInput } from './types.js';

export const TOOL_INPUT_CAP = 2000;
export const TOOL_RESULT_HEAD = 1500;
export const TOOL_RESULT_TAIL = 500;
export const TITLE_MAX = 80;

export interface SanitizeResult {
  session: HashedSession;
  secrets: Record<string, number>;
  personal: Record<string, number>;
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

function capResult(s: string): string {
  if (s.length <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL) return s;
  return s.slice(0, TOOL_RESULT_HEAD) + s.slice(-TOOL_RESULT_TAIL);
}

export function sanitizeSession(input: SessionInput, personal: PersonalConfig): SanitizeResult {
  const secrets: Record<string, number> = {};
  const found: Record<string, number> = {};

  // Strip and filter the full text first, cap afterwards, so a secret that
  // straddles the cap is still seen whole.
  const clean = (s: string): string => {
    const a = stripSecrets(s);
    add(secrets, a.counts);
    const b = filterPersonal(a.text, personal);
    add(found, b.findings);
    return b.text;
  };

  const messages: Message[] = input.messages.map((m, seq) =>
    m.kind === 'text'
      ? { ...m, seq, text: clean(m.text) }
      : {
          ...m,
          seq,
          tool_input: clean(m.tool_input).slice(0, TOOL_INPUT_CAP),
          tool_result: capResult(clean(m.tool_result)),
        },
  );

  // A derived title reuses the already-cleaned message, so nothing is counted twice.
  const firstUser = messages.find((m) => m.kind === 'text' && m.role === 'user');
  const titleSource = input.title !== null ? clean(input.title) : firstUser?.kind === 'text' ? firstUser.text : '';
  const title = titleSource.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '(untitled)';

  const times = messages.map((m) => m.ts).filter((t): t is string => t !== null).sort();

  const session: Session = {
    source: input.source,
    source_session_id: input.source_session_id,
    account_id: input.account_id,
    project_key: input.project_key,
    parent: input.parent,
    title,
    cwd: input.cwd,
    git_branch: input.git_branch,
    started_at: times[0] ?? null,
    last_activity_at: times[times.length - 1] ?? null,
    messages,
  };

  return { session: { ...session, content_hash: contentHash(session) }, secrets, personal: found };
}
```

`packages/core/src/remote.ts`:

```ts
/**
 * Turns a git remote URL into a stable project key such as
 * "github.com/abdulmuhg/jsonroom". Returns null when the value is not a
 * remote URL (a plain name or a file path).
 */
export function normalizeRemote(url: string): string | null {
  const s = url.trim();
  let host: string;
  let path: string;

  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(s); // git@host:owner/repo
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s);
  if (scp) [, host, path] = scp as unknown as [string, string, string];
  else if (full) [, host, path] = full as unknown as [string, string, string];
  else return null;

  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (path === '') return null;
  return `${host}/${path}`.toLowerCase();
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from './sanitize.js';
export * from './remote.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/core`
Expected: PASS, all core tests (hash, secrets, personal, sanitize, remote).

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add session sanitising and git remote normalisation"
```

---

### Task 5: Collector package and project resolver

**Files:**
- Create: `apps/collector/package.json`, `apps/collector/tsup.config.ts`
- Create: `apps/collector/src/project.ts`
- Test: `apps/collector/test/project.test.ts`

**Interfaces:**
- Consumes: `normalizeRemote` from `@context-hub/core`.
- Produces:
  - `type GitRunner = (cwd: string, args: string[]) => string | null`
  - `interface ResolveDeps { git: GitRunner; exists: (path: string) => boolean }`
  - `interface ResolveInput { cwd: string | null; remoteHint: string | null; pathHints: string[] }`
  - `resolveProjectKey(input: ResolveInput, deps: ResolveDeps): string`
  - `applyOverrides(key: string, sessionKey: string, overrides: { aliases: Record<string, string>; assignments: Record<string, string> }): string`
  - `projectMatches(input: string, key: string): boolean`
  - `realGit: GitRunner`

- [ ] **Step 1: Create the package**

`apps/collector/package.json`:

```json
{
  "name": "@context-hub/collector",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "hub": "./dist/bin.js" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/bin.ts"
  },
  "dependencies": {
    "@context-hub/core": "workspace:*"
  }
}
```

`apps/collector/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@context-hub/core'],
  banner: { js: '#!/usr/bin/env node' },
});
```

Run: `pnpm add -D -w tsup && pnpm install`
Expected: `apps/collector/node_modules/@context-hub/core` exists as a link.

- [ ] **Step 2: Write the failing test**

`apps/collector/test/project.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOverrides, projectMatches, resolveProjectKey, type ResolveDeps } from '../src/project.js';

/** A fake git: `repos` maps a directory to its remote (or null) and top-level folder. */
function deps(repos: Record<string, { remote: string | null; top: string }>, missing: string[] = []): ResolveDeps {
  const find = (cwd: string) =>
    Object.entries(repos)
      .filter(([dir]) => cwd === dir || cwd.startsWith(dir + '/'))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  return {
    exists: (p) => !missing.includes(p),
    git: (cwd, args) => {
      const repo = find(cwd);
      if (!repo) return null;
      if (args[0] === 'remote') return repo.remote;
      if (args[0] === 'rev-parse') return repo.top;
      return null;
    },
  };
}

const none = { cwd: null, remoteHint: null, pathHints: [] };

describe('resolveProjectKey', () => {
  it('uses the git remote', () => {
    const d = deps({ '/work/jsonroom': { remote: 'git@github.com:abdulmuhg/jsonroom.git', top: '/work/jsonroom' } });
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom' }, d)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('maps a subfolder and a worktree to the same key', () => {
    const repo = { remote: 'https://github.com/abdulmuhg/jsonroom.git', top: '/work/jsonroom' };
    const d = deps({ '/work/jsonroom': repo, '/work/jsonroom-wt/fix': repo });
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom/src' }, d)).toBe('github.com/abdulmuhg/jsonroom');
    expect(resolveProjectKey({ ...none, cwd: '/work/jsonroom-wt/fix' }, d)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('uses the top-level folder name when the repo has no remote', () => {
    const d = deps({ '/work/notes': { remote: null, top: '/work/notes' } });
    expect(resolveProjectKey({ ...none, cwd: '/work/notes/drafts' }, d)).toBe('local:notes');
  });

  it('uses the folder name when it is not a git repo', () => {
    expect(resolveProjectKey({ ...none, cwd: '/tmp/scratch' }, deps({}))).toBe('local:scratch');
  });

  it('uses the folder name when the folder no longer exists', () => {
    expect(resolveProjectKey({ ...none, cwd: 'C:\\old\\gone' }, deps({}, ['C:\\old\\gone']))).toBe('local:gone');
  });

  it('prefers a remote hint recorded by the tool', () => {
    const input = { cwd: '/tmp/x', remoteHint: 'https://github.com/abdulmuhg/harmonize.git', pathHints: [] };
    expect(resolveProjectKey(input, deps({}))).toBe('github.com/abdulmuhg/harmonize');
  });

  it('returns unfiled when there is no folder and no hint', () => {
    expect(resolveProjectKey(none, deps({}))).toBe('unfiled');
  });

  it('infers the project from path hints by majority', () => {
    const d = deps({
      '/work/a': { remote: 'git@github.com:me/a.git', top: '/work/a' },
      '/work/b': { remote: 'git@github.com:me/b.git', top: '/work/b' },
    });
    const input = { ...none, pathHints: ['/work/a/src', '/work/a/test', '/work/b'] };
    expect(resolveProjectKey(input, d)).toBe('github.com/me/a');
  });

  it('walks up from a path hint that does not exist to one that does', () => {
    const d = deps({ '/work/a': { remote: 'git@github.com:me/a.git', top: '/work/a' } }, ['/work/a/src/gone.ts']);
    expect(resolveProjectKey({ ...none, pathHints: ['/work/a/src/gone.ts'] }, d)).toBe('github.com/me/a');
  });

  it('returns unfiled when no path hint resolves to a repo', () => {
    expect(resolveProjectKey({ ...none, pathHints: ['/nowhere/x'] }, deps({}))).toBe('unfiled');
  });
});

describe('applyOverrides', () => {
  const o = { aliases: { 'local:jr': 'github.com/abdulmuhg/jsonroom' }, assignments: { 'codex:s9': 'local:special' } };

  it('applies an alias', () => {
    expect(applyOverrides('local:jr', 'claude-code:s1', o)).toBe('github.com/abdulmuhg/jsonroom');
  });

  it('lets a session assignment win over everything', () => {
    expect(applyOverrides('local:jr', 'codex:s9', o)).toBe('local:special');
  });

  it('leaves other keys alone', () => {
    expect(applyOverrides('local:other', 'claude-code:s1', o)).toBe('local:other');
  });
});

describe('projectMatches', () => {
  it.each([
    ['github.com/abdulmuhg/jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['JsonRoom', 'github.com/abdulmuhg/jsonroom'],
    ['git@github.com:abdulmuhg/jsonroom.git', 'github.com/abdulmuhg/jsonroom'],
    ['notes', 'local:notes'],
    ['local:notes', 'local:notes'],
  ])('%s matches %s', (input, key) => {
    expect(projectMatches(input, key)).toBe(true);
  });

  it('does not match a different project', () => {
    expect(projectMatches('room', 'github.com/abdulmuhg/jsonroom')).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/project.test.ts`
Expected: FAIL, cannot resolve `../src/project.js`.

- [ ] **Step 4: Write the implementation**

`apps/collector/src/project.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { normalizeRemote } from '@context-hub/core';

export type GitRunner = (cwd: string, args: string[]) => string | null;

export interface ResolveDeps {
  git: GitRunner;
  exists: (path: string) => boolean;
}

export interface ResolveInput {
  cwd: string | null;
  /** A remote URL the tool itself recorded, if any. */
  remoteHint: string | null;
  /** Absolute paths seen in tool calls, used when there is no cwd. */
  pathHints: string[];
}

export const realGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
};

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : null;
}

function keyForExistingDir(dir: string, git: GitRunner): string {
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const key = remote ? normalizeRemote(remote) : null;
  if (key) return key;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return `local:${baseName(top ?? dir)}`;
}

/** The repo key for a hint path, or null if it is not inside a git repo. */
function repoKeyForHint(hint: string, deps: ResolveDeps): string | null {
  let dir: string | null = hint;
  while (dir && !deps.exists(dir)) dir = parentDir(dir);
  if (!dir) return null;
  if (deps.git(dir, ['rev-parse', '--show-toplevel']) === null) return null;
  return keyForExistingDir(dir, deps.git);
}

export function resolveProjectKey(input: ResolveInput, deps: ResolveDeps): string {
  if (input.remoteHint) {
    const hinted = normalizeRemote(input.remoteHint);
    if (hinted) return hinted;
  }
  if (input.cwd) {
    if (!deps.exists(input.cwd)) return `local:${baseName(input.cwd)}`;
    return keyForExistingDir(input.cwd, deps.git);
  }
  const votes = new Map<string, number>();
  for (const hint of input.pathHints) {
    const key = repoKeyForHint(hint, deps);
    if (key) votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return winner ? winner[0] : 'unfiled';
}

export function applyOverrides(
  key: string,
  sessionKey: string,
  overrides: { aliases: Record<string, string>; assignments: Record<string, string> },
): string {
  return overrides.assignments[sessionKey] ?? overrides.aliases[key] ?? key;
}

/** Does what the user typed (a key, a name or a remote URL) refer to this key? */
export function projectMatches(input: string, key: string): boolean {
  const wanted = (normalizeRemote(input) ?? input).toLowerCase();
  const k = key.toLowerCase();
  if (k === wanted || k === `local:${wanted}`) return true;
  return k.split('/').pop() === wanted;
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run apps/collector/test/project.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add collector package and project resolver"
```

---

### Task 6: Claude Code adapter

**Files:**
- Create: `apps/collector/src/adapters/types.ts`, `apps/collector/src/adapters/claude-code.ts`
- Create: `apps/collector/test/helpers.ts`
- Test: `apps/collector/test/claude-code.test.ts`

**Interfaces:**
- Produces (in `adapters/types.ts`):
  - `interface SessionFile { source: Source; id: string; path: string; parent: string | null; size: number; mtimeMs: number }`
  - `interface Warnings { bad_lines: number; unknown_records: number; dropped_blocks: number }`
  - `interface RawSession { source: Source; source_session_id: string; account_id: string | null; parent: string | null; title: string | null; cwd: string | null; git_branch: string | null; remote_hint: string | null; path_hints: string[]; messages: Message[]; warnings: Warnings }`
  - `interface Adapter { source: Source; discover(home: string): SessionFile[]; read(file: SessionFile): RawSession }`
  - helpers `sessionFile(source, path, id, parent): SessionFile`, `emptyRaw(file: SessionFile): RawSession`, `readLines(path: string): string[]`, `pushText(raw, role, ts, text): void`
- Produces (in `claude-code.ts`): `export const claudeCode: Adapter`
- Produces (in `test/helpers.ts`): `tempDir(): string`, `writeJsonl(path: string, records: unknown[]): void`, `writeRaw(path: string, text: string): void`

Record shapes, verified on a real machine on 2026-10-10:
- Main sessions: `~/.claude/projects/<folder>/<sessionId>.jsonl`. Subagents: `~/.claude/projects/<folder>/<sessionId>/subagents/<name>.jsonl`.
- A `user` or `assistant` record has `cwd`, `gitBranch`, `timestamp`, `ownerAccountUuid`, optional `isMeta`, and `message.content` that is a string or a list of blocks.
- Block types seen: `text {text}`, `thinking`, `tool_use {id, name, input}`, `tool_result {tool_use_id, content, is_error}`, `server_tool_use`, `advisor_tool_result`, `image {source.data}`.
- A `custom-title` record has `customTitle`.

- [ ] **Step 1: Write the test helpers**

`apps/collector/test/helpers.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'context-hub-test-'));
}

export function writeRaw(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJsonl(path: string, records: unknown[]): void {
  writeRaw(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
```

- [ ] **Step 2: Write the failing test**

`apps/collector/test/claude-code.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../src/adapters/claude-code.js';
import { tempDir, writeJsonl, writeRaw } from './helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const rec = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) => ({
  type,
  sessionId: SID,
  cwd: 'C:\\work\\demo',
  gitBranch: 'main',
  ownerAccountUuid: 'acct-1',
  timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: type, content },
  ...extra,
});

function home(records: unknown[], subagent?: unknown[]): string {
  const h = tempDir();
  const proj = join(h, '.claude', 'projects', 'C--work-demo');
  writeJsonl(join(proj, `${SID}.jsonl`), records);
  if (subagent) writeJsonl(join(proj, SID, 'subagents', 'agent-a1.jsonl'), subagent);
  return h;
}

describe('claudeCode.discover', () => {
  it('finds main sessions and subagent transcripts with their parent', () => {
    const h = home([rec('user', 'hi')], [rec('user', 'sub task')]);
    const files = claudeCode.discover(h).sort((a, b) => a.id.localeCompare(b.id));
    expect(files.map((f) => ({ id: f.id, parent: f.parent }))).toEqual([
      { id: SID, parent: null },
      { id: `${SID}/agent-a1`, parent: SID },
    ]);
    expect(files[0].size).toBeGreaterThan(0);
  });

  it('returns nothing when the tool is not installed', () => {
    expect(claudeCode.discover(tempDir())).toEqual([]);
  });
});

describe('claudeCode.read', () => {
  const read = (records: unknown[]) => {
    const h = home(records);
    return claudeCode.read(claudeCode.discover(h)[0]);
  };

  it('reads string and block text for both roles, with session details', () => {
    const raw = read([
      rec('user', 'fix the login bug'),
      rec('assistant', [{ type: 'text', text: 'Looking now.' }], { timestamp: '2026-10-01T10:01:00.000Z' }),
    ]);
    expect(raw).toMatchObject({
      source: 'claude-code',
      source_session_id: SID,
      account_id: 'acct-1',
      cwd: 'C:\\work\\demo',
      git_branch: 'main',
      parent: null,
    });
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: '2026-10-01T10:00:00.000Z', text: 'fix the login bug' },
      { seq: 1, role: 'assistant', kind: 'text', ts: '2026-10-01T10:01:00.000Z', text: 'Looking now.' },
    ]);
  });

  it('pairs a tool call with its result and marks errors', () => {
    const raw = read([
      rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: '2 failed', is_error: true }]),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: '2026-10-01T10:00:00.000Z',
        tool_name: 'Bash',
        tool_input: '{"command":"pnpm test"}',
        tool_result: '2 failed',
        tool_status: 'error',
      },
    ]);
  });

  it('joins the text parts of a list-shaped tool result', () => {
    const raw = read([
      rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      rec('user', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'image', source: { data: 'AAAA' } },
            { type: 'text', text: 'line 2' },
          ],
        },
      ]),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_result: 'line 1\nline 2', tool_status: 'ok' });
  });

  it('skips thinking silently', () => {
    const raw = read([rec('assistant', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }])]);
    expect(raw.messages.map((m) => m.kind)).toEqual(['text']);
    expect(raw.warnings.dropped_blocks).toBe(0);
  });

  // Review Focus 1
  it('drops and counts image, server tool and advisor blocks', () => {
    const raw = read([
      rec('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } },
        { type: 'text', text: 'see screenshot' },
      ]),
      rec('assistant', [
        { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} },
        { type: 'advisor_tool_result', tool_use_id: 's1', content: { type: 'x', encrypted_content: 'zzz' } },
      ]),
    ]);
    expect(raw.messages).toHaveLength(1);
    expect(JSON.stringify(raw.messages)).not.toContain('AAAA');
    expect(raw.warnings.dropped_blocks).toBe(3);
  });

  it('skips records flagged isMeta', () => {
    const raw = read([rec('user', 'injected skill text', { isMeta: true }), rec('user', 'real question')]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real question']);
  });

  it('uses a custom title when one is recorded', () => {
    const raw = read([rec('user', 'hi'), { type: 'custom-title', customTitle: 'Login fix', sessionId: SID }]);
    expect(raw.title).toBe('Login fix');
  });

  it('counts bad lines and unknown record types without failing', () => {
    const h = tempDir();
    const path = join(h, '.claude', 'projects', 'p', `${SID}.jsonl`);
    writeRaw(
      path,
      [
        JSON.stringify(rec('user', 'one')),
        '{not json',
        JSON.stringify({ type: 'brand-new-record' }),
        JSON.stringify({ type: 'file-history-snapshot' }),
        JSON.stringify(rec('user', 'two')),
      ].join('\n'),
    );
    const raw = claudeCode.read(claudeCode.discover(h)[0]);
    expect(raw.messages).toHaveLength(2);
    expect(raw.warnings).toEqual({ bad_lines: 1, unknown_records: 1, dropped_blocks: 0 });
  });

  it('gives a subagent transcript its parent and a combined id', () => {
    const h = home([rec('user', 'hi')], [rec('user', 'sub task', { isSidechain: true })]);
    const sub = claudeCode.discover(h).find((f) => f.parent !== null)!;
    const raw = claudeCode.read(sub);
    expect(raw).toMatchObject({ source_session_id: `${SID}/agent-a1`, parent: SID });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/claude-code.test.ts`
Expected: FAIL, cannot resolve `../src/adapters/claude-code.js`.

- [ ] **Step 4: Write the shared adapter types**

`apps/collector/src/adapters/types.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import type { Message, Source } from '@context-hub/core';

export interface SessionFile {
  source: Source;
  /** The tool's session id. For a subagent: "<parent id>/<file name>". */
  id: string;
  path: string;
  parent: string | null;
  size: number;
  mtimeMs: number;
}

export interface Warnings {
  bad_lines: number;
  unknown_records: number;
  dropped_blocks: number;
}

export interface RawSession {
  source: Source;
  source_session_id: string;
  account_id: string | null;
  parent: string | null;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  remote_hint: string | null;
  path_hints: string[];
  /** Uncapped and unsanitised. seq is the position in this list. */
  messages: Message[];
  warnings: Warnings;
}

export interface Adapter {
  source: Source;
  /** Lists session files under the user's home folder. Reads no content. */
  discover(home: string): SessionFile[];
  read(file: SessionFile): RawSession;
}

export function sessionFile(source: Source, path: string, id: string, parent: string | null): SessionFile {
  const st = statSync(path);
  return { source, id, path, parent, size: st.size, mtimeMs: st.mtimeMs };
}

export function emptyRaw(file: SessionFile): RawSession {
  return {
    source: file.source,
    source_session_id: file.id,
    account_id: null,
    parent: file.parent,
    title: null,
    cwd: null,
    git_branch: null,
    remote_hint: null,
    path_hints: [],
    messages: [],
    warnings: { bad_lines: 0, unknown_records: 0, dropped_blocks: 0 },
  };
}

export function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

export function pushText(raw: RawSession, role: 'user' | 'assistant', ts: string | null, text: string): void {
  if (text.trim() === '') return;
  raw.messages.push({ seq: raw.messages.length, role, kind: 'text', ts, text });
}
```

- [ ] **Step 5: Write the adapter**

`apps/collector/src/adapters/claude-code.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, pushText, readLines, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

/** Record types that carry no conversation content. Anything else unknown is counted. */
const IGNORED_RECORDS = new Set([
  'queue-operation',
  'attachment',
  'last-prompt',
  'system',
  'summary',
  'file-history-snapshot',
  'file-history-delta',
  'mode',
  'agent-name',
  'atis-latch',
  'bridge-session',
]);

function discover(home: string): SessionFile[] {
  const root = join(home, '.claude', 'projects');
  const out: SessionFile[] = [];
  if (!existsSync(root)) return out;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(sessionFile('claude-code', join(dir, entry.name), basename(entry.name, '.jsonl'), null));
      } else if (entry.isDirectory()) {
        const sub = join(dir, entry.name, 'subagents');
        if (!existsSync(sub)) continue;
        for (const name of readdirSync(sub)) {
          if (!name.endsWith('.jsonl')) continue;
          out.push(
            sessionFile('claude-code', join(sub, name), `${entry.name}/${basename(name, '.jsonl')}`, entry.name),
          );
        }
      }
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  const pending = new Map<string, ToolCallMessage>();

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    if (r?.type === 'custom-title' && typeof r.customTitle === 'string') {
      raw.title = r.customTitle;
      continue;
    }
    if (r?.type !== 'user' && r?.type !== 'assistant') {
      if (!IGNORED_RECORDS.has(r?.type)) raw.warnings.unknown_records++;
      continue;
    }

    raw.cwd ??= typeof r.cwd === 'string' ? r.cwd : null;
    raw.account_id ??= typeof r.ownerAccountUuid === 'string' ? r.ownerAccountUuid : null;
    if (typeof r.gitBranch === 'string' && r.gitBranch !== '') raw.git_branch = r.gitBranch;
    if (r.isMeta === true) continue;

    const role: 'user' | 'assistant' = r.type;
    const ts: string | null = typeof r.timestamp === 'string' ? r.timestamp : null;
    const content = r.message?.content;

    if (typeof content === 'string') {
      pushText(raw, role, ts, content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      switch (block?.type) {
        case 'text':
          pushText(raw, role, ts, typeof block.text === 'string' ? block.text : '');
          break;
        case 'thinking':
        case 'redacted_thinking':
          break; // never uploaded, by design
        case 'tool_use': {
          const call: ToolCallMessage = {
            seq: raw.messages.length,
            role: 'assistant',
            kind: 'tool_call',
            ts,
            tool_name: String(block.name ?? 'unknown'),
            tool_input: JSON.stringify(block.input ?? {}),
            tool_result: '',
            tool_status: 'ok',
          };
          raw.messages.push(call);
          if (typeof block.id === 'string') pending.set(block.id, call);
          break;
        }
        case 'tool_result': {
          const call = pending.get(block.tool_use_id);
          if (!call) {
            raw.warnings.dropped_blocks++;
            break;
          }
          call.tool_result = resultText(block.content);
          if (block.is_error === true) call.tool_status = 'error';
          break;
        }
        default:
          // image, server_tool_use, advisor_tool_result and anything new
          raw.warnings.dropped_blocks++;
      }
    }
  }
  return raw;
}

export const claudeCode: Adapter = { source: 'claude-code', discover, read };
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run apps/collector/test/claude-code.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add Claude Code adapter"
```

---

### Task 7: Codex adapter

**Files:**
- Create: `apps/collector/src/adapters/codex.ts`
- Test: `apps/collector/test/codex.test.ts`

**Interfaces:**
- Consumes: everything `adapters/types.ts` produces (Task 6).
- Produces: `export const codex: Adapter`

Record shapes, verified on a real machine on 2026-10-10:
- Files: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<uuid>.jsonl`.
- Newer files wrap every record: `{timestamp, type, payload}` with `type` one of `session_meta`, `turn_context`, `response_item`, `event_msg`.
- Older files are bare: the first line is `{id, timestamp, instructions, git}` with no `type`; later lines are the items themselves (`{type: 'message', ...}`), and some lines are `{record_type: 'state'}`.
- `session_meta` payload: `id`, `cwd`, `git` (may hold `repository_url`, `branch`).
- Items: `message {role, content: [{type, text}]}`, `function_call {name, arguments, call_id}`, `function_call_output {call_id, output}`, `custom_tool_call {name, input, call_id}`, `reasoning` (encrypted).
- `event_msg` records repeat the user and agent messages for the UI.

- [ ] **Step 1: Write the failing test**

`apps/collector/test/codex.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codex } from '../src/adapters/codex.js';
import { tempDir, writeJsonl } from './helpers.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-02T09:00:00.000Z';
const wrap = (type: string, payload: unknown) => ({ timestamp: T, type, payload });
const msg = (role: string, text: string) => ({
  type: 'message',
  role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});

function home(records: unknown[], name = `rollout-2026-10-02T09-00-00-${UUID}.jsonl`): string {
  const h = tempDir();
  writeJsonl(join(h, '.codex', 'sessions', '2026', '10', '02', name), records);
  return h;
}
const read = (records: unknown[]) => {
  const h = home(records);
  return codex.read(codex.discover(h)[0]);
};

describe('codex.discover', () => {
  it('finds rollout files recursively and takes the id from the file name', () => {
    const files = codex.discover(home([wrap('session_meta', { id: UUID, cwd: '/work/demo' })]));
    expect(files.map((f) => ({ id: f.id, parent: f.parent }))).toEqual([{ id: UUID, parent: null }]);
  });

  it('returns nothing when the tool is not installed', () => {
    expect(codex.discover(tempDir())).toEqual([]);
  });
});

describe('codex.read', () => {
  it('reads the folder, branch and remote from session_meta', () => {
    const raw = read([
      wrap('session_meta', {
        id: UUID,
        cwd: '/work/demo',
        git: { repository_url: 'https://github.com/me/demo.git', branch: 'feat/x' },
      }),
    ]);
    expect(raw).toMatchObject({
      source: 'codex',
      source_session_id: UUID,
      cwd: '/work/demo',
      git_branch: 'feat/x',
      remote_hint: 'https://github.com/me/demo.git',
    });
  });

  it('falls back to turn_context for the folder', () => {
    const raw = read([wrap('turn_context', { cwd: '/work/other', model: 'x' })]);
    expect(raw.cwd).toBe('/work/other');
  });

  // Review Focus 2
  it('reads each turn once although event_msg repeats it', () => {
    const raw = read([
      wrap('response_item', msg('user', 'add a test')),
      wrap('event_msg', { type: 'user_message', message: 'add a test', kind: 'plain' }),
      wrap('response_item', msg('assistant', 'Done.')),
      wrap('event_msg', { type: 'agent_message', message: 'Done.' }),
      wrap('event_msg', { type: 'token_count', info: null }),
    ]);
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: T, text: 'add a test' },
      { seq: 1, role: 'assistant', kind: 'text', ts: T, text: 'Done.' },
    ]);
    expect(raw.warnings.unknown_records).toBe(0);
  });

  it('pairs a function call with its output and reads the exit code', () => {
    const raw = read([
      wrap('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' }),
      wrap('response_item', {
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'no such file', metadata: { exit_code: 2 } }),
      }),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: T,
        tool_name: 'shell',
        tool_input: '{"command":["ls"]}',
        tool_result: 'no such file',
        tool_status: 'error',
      },
    ]);
  });

  it('keeps a plain-text output as it is', () => {
    const raw = read([
      wrap('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** patch', call_id: 'c2' }),
      wrap('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'applied' }),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_name: 'apply_patch', tool_input: '*** patch', tool_result: 'applied', tool_status: 'ok' });
  });

  it('skips reasoning, system roles and the injected environment block', () => {
    const raw = read([
      wrap('response_item', { type: 'reasoning', summary: [], encrypted_content: 'zzz' }),
      wrap('response_item', msg('developer', 'rules')),
      wrap('response_item', msg('user', '<environment_context>\n<cwd>/x</cwd>\n</environment_context>')),
      wrap('response_item', msg('user', 'real question')),
    ]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real question']);
  });

  it('reads the older bare format', () => {
    const raw = read([
      { id: UUID, timestamp: T, instructions: null, git: { branch: 'main' } },
      { record_type: 'state' },
      msg('user', 'hello'),
      { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]);
    expect(raw.git_branch).toBe('main');
    expect(raw.messages.map((m) => m.kind)).toEqual(['text', 'tool_call']);
    expect(raw.messages[0].ts).toBeNull();
  });

  it('counts unknown records and unknown items', () => {
    const raw = read([wrap('brand_new', { a: 1 }), wrap('response_item', { type: 'hologram' })]);
    expect(raw.warnings).toEqual({ bad_lines: 0, unknown_records: 1, dropped_blocks: 1 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/codex.test.ts`
Expected: FAIL, cannot resolve `../src/adapters/codex.js`.

- [ ] **Step 3: Write the adapter**

`apps/collector/src/adapters/codex.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, pushText, readLines, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
  }
}

function discover(home: string): SessionFile[] {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  walk(root, paths);
  return paths.map((p) => {
    const stem = basename(p, '.jsonl');
    return sessionFile('codex', p, UUID_AT_END.exec(stem)?.[1] ?? stem, null);
  });
}

type Kind = 'session_meta' | 'turn_context' | 'response_item' | 'event_msg' | 'ignored' | 'unknown';
const WRAPPED = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg']);

/** Works out what a line is in both the wrapped and the older bare format. */
function classify(r: any): { kind: Kind; body: any; ts: string | null } {
  const wrapped = r && typeof r.type === 'string' && r.payload && typeof r.payload === 'object';
  if (wrapped) {
    const kind = WRAPPED.has(r.type) ? (r.type as Kind) : 'unknown';
    return { kind, body: r.payload, ts: typeof r.timestamp === 'string' ? r.timestamp : null };
  }
  if (r && typeof r.type === 'string') return { kind: 'response_item', body: r, ts: null };
  if (r && typeof r.id === 'string' && typeof r.timestamp === 'string') return { kind: 'session_meta', body: r, ts: null };
  if (r && 'record_type' in r) return { kind: 'ignored', body: r, ts: null };
  return { kind: 'unknown', body: r, ts: null };
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t !== '')
    .join('\n');
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  const pending = new Map<string, ToolCallMessage>();

  const item = (p: any, ts: string | null): void => {
    switch (p?.type) {
      case 'message': {
        if (p.role !== 'user' && p.role !== 'assistant') return;
        const text = messageText(p.content);
        if (p.role === 'user' && text.trimStart().startsWith('<environment_context')) return;
        pushText(raw, p.role, ts, text);
        return;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const input = p.arguments ?? p.input ?? p.action ?? {};
        const call: ToolCallMessage = {
          seq: raw.messages.length,
          role: 'assistant',
          kind: 'tool_call',
          ts,
          tool_name: String(p.name ?? p.type),
          tool_input: typeof input === 'string' ? input : JSON.stringify(input),
          tool_result: '',
          tool_status: 'ok',
        };
        raw.messages.push(call);
        if (typeof p.call_id === 'string') pending.set(p.call_id, call);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const call = pending.get(p.call_id);
        if (!call) {
          raw.warnings.dropped_blocks++;
          return;
        }
        let text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.output === 'string') {
            text = parsed.output;
            const code = parsed.metadata?.exit_code;
            if (typeof code === 'number' && code !== 0) call.tool_status = 'error';
          }
        } catch {
          // plain text output
        }
        call.tool_result = text;
        return;
      }
      case 'reasoning':
        return; // encrypted, never uploaded
      default:
        raw.warnings.dropped_blocks++;
    }
  };

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    const { kind, body, ts } = classify(r);
    switch (kind) {
      case 'session_meta':
        raw.cwd ??= typeof body.cwd === 'string' ? body.cwd : null;
        if (typeof body.git?.repository_url === 'string') raw.remote_hint = body.git.repository_url;
        if (typeof body.git?.branch === 'string') raw.git_branch = body.git.branch;
        break;
      case 'turn_context':
        raw.cwd ??= typeof body.cwd === 'string' ? body.cwd : null;
        break;
      case 'response_item':
        item(body, ts);
        break;
      case 'event_msg': // repeats response_item for the UI
      case 'ignored':
        break;
      default:
        raw.warnings.unknown_records++;
    }
  }
  return raw;
}

export const codex: Adapter = { source: 'codex', discover, read };
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/collector/test/codex.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Codex adapter"
```

---

### Task 8: Antigravity adapter

**Files:**
- Create: `apps/collector/src/adapters/antigravity.ts`, `apps/collector/src/adapters/index.ts`
- Test: `apps/collector/test/antigravity.test.ts`

**Interfaces:**
- Consumes: everything `adapters/types.ts` produces (Task 6); `claudeCode` (Task 6); `codex` (Task 7).
- Produces: `export const antigravity: Adapter`; in `adapters/index.ts`: `export const ALL_ADAPTERS: Adapter[]` in the order `[claudeCode, codex, antigravity]`.

Record shapes, verified on a real machine on 2026-10-10:
- Files: `~/.gemini/<root>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`, where `<root>` is `antigravity-ide`, `antigravity` or `antigravity-backup`. The same conversation can appear under more than one root.
- Each line: `{step_index, source, type, status, created_at, content?, thinking?, tool_calls?}`.
- `source` is `USER_EXPLICIT`, `MODEL` or `SYSTEM`. `status` is `DONE` or `RUNNING`.
- `type` values include `USER_INPUT`, `PLANNER_RESPONSE`, tool steps (`VIEW_FILE`, `RUN_COMMAND`, `GREP_SEARCH`, `LIST_DIRECTORY`, `CODE_ACTION`, `SEARCH_WEB`, `GENERIC`), and bookkeeping (`EPHEMERAL_MESSAGE`, `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY`, `KNOWLEDGE_ARTIFACTS`, `CHECKPOINT`).
- `tool_calls` entries: `{name, args}` where `args` values are strings such as `DirectoryPath`.
- There is no working-folder field.

- [ ] **Step 1: Write the failing test**

`apps/collector/test/antigravity.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { antigravity } from '../src/adapters/antigravity.js';
import { ALL_ADAPTERS } from '../src/adapters/index.js';
import { tempDir, writeJsonl } from './helpers.js';

const CID = '33333333-3333-4333-8333-333333333333';
const T = '2026-10-03T08:00:00Z';
let n = 0;
const step = (type: string, extra: Record<string, unknown> = {}) => ({
  step_index: n++,
  source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  type,
  status: 'DONE',
  created_at: T,
  ...extra,
});

function put(home: string, root: string, id: string, records: unknown[]): void {
  writeJsonl(join(home, '.gemini', root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), records);
}
const read = (records: unknown[]) => {
  const h = tempDir();
  put(h, 'antigravity-ide', CID, records);
  return antigravity.read(antigravity.discover(h)[0]);
};

describe('antigravity.discover', () => {
  it('uses the folder name as the id and stores a mirrored conversation once', () => {
    const h = tempDir();
    put(h, 'antigravity-ide', CID, [step('USER_INPUT', { content: 'hi' })]);
    put(h, 'antigravity', CID, [step('USER_INPUT', { content: 'hi' })]);
    put(h, 'antigravity-backup', CID, [step('USER_INPUT', { content: 'hi' })]);
    const files = antigravity.discover(h);
    expect(files.map((f) => f.id)).toEqual([CID]);
    expect(files[0].path).toContain('antigravity-ide');
  });

  it('returns nothing when the tool is not installed', () => {
    expect(antigravity.discover(tempDir())).toEqual([]);
  });
});

describe('antigravity.read', () => {
  it('reads user input and planner text', () => {
    const raw = read([step('USER_INPUT', { content: 'add dark mode' }), step('PLANNER_RESPONSE', { content: 'I will start.' })]);
    expect(raw).toMatchObject({ source: 'antigravity', source_session_id: CID, cwd: null });
    expect(raw.messages).toEqual([
      { seq: 0, role: 'user', kind: 'text', ts: T, text: 'add dark mode' },
      { seq: 1, role: 'assistant', kind: 'text', ts: T, text: 'I will start.' },
    ]);
  });

  it('turns planner tool calls into tool_call messages and attaches the following step as the result', () => {
    const raw = read([
      step('PLANNER_RESPONSE', {
        thinking: 'private',
        tool_calls: [{ name: 'list_dir', args: { DirectoryPath: 'C:\\work\\demo\\src', toolSummary: 'List' } }],
      }),
      step('LIST_DIRECTORY', { content: 'a.ts\nb.ts' }),
    ]);
    expect(raw.messages).toEqual([
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: T,
        tool_name: 'list_dir',
        tool_input: '{"DirectoryPath":"C:\\\\work\\\\demo\\\\src","toolSummary":"List"}',
        tool_result: 'a.ts\nb.ts',
        tool_status: 'ok',
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain('private');
  });

  it('collects absolute paths from tool arguments as project hints', () => {
    const raw = read([
      step('PLANNER_RESPONSE', {
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: 'C:\\work\\demo\\src\\app.ts' } },
          { name: 'run', args: { Cwd: '/work/demo', CommandLine: 'pnpm test' } },
        ],
      }),
    ]);
    expect(raw.path_hints).toEqual(['C:\\work\\demo\\src\\app.ts', '/work/demo']);
  });

  // Review Focus 3
  it('skips steps that are still running', () => {
    const raw = read([
      step('USER_INPUT', { content: 'go' }),
      step('PLANNER_RESPONSE', { content: 'half an answ', status: 'RUNNING' }),
      step('RUN_COMMAND', { content: 'partial output', status: 'RUNNING' }),
    ]);
    expect(raw.messages).toHaveLength(1);
  });

  it('marks a tool result from a failed step as an error', () => {
    const raw = read([
      step('PLANNER_RESPONSE', { tool_calls: [{ name: 'run', args: {} }] }),
      step('RUN_COMMAND', { content: 'exit 1', status: 'ERROR' }),
    ]);
    expect(raw.messages[0]).toMatchObject({ tool_result: 'exit 1', tool_status: 'error' });
  });

  it('ignores bookkeeping steps and counts bad lines', () => {
    const raw = read([
      step('EPHEMERAL_MESSAGE', { content: 'reminder' }),
      step('SYSTEM_MESSAGE', { content: 'sys' }),
      step('CONVERSATION_HISTORY'),
      step('KNOWLEDGE_ARTIFACTS'),
      step('CHECKPOINT', { content: 'cp' }),
      step('USER_INPUT', { content: 'real' }),
    ]);
    expect(raw.messages.map((m) => m.kind === 'text' && m.text)).toEqual(['real']);
    expect(raw.warnings).toEqual({ bad_lines: 0, unknown_records: 0, dropped_blocks: 0 });
  });
});

describe('ALL_ADAPTERS', () => {
  it('lists the three tools in a fixed order', () => {
    expect(ALL_ADAPTERS.map((a) => a.source)).toEqual(['claude-code', 'codex', 'antigravity']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/antigravity.test.ts`
Expected: FAIL, cannot resolve `../src/adapters/antigravity.js`.

- [ ] **Step 3: Write the adapter**

`apps/collector/src/adapters/antigravity.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCallMessage } from '@context-hub/core';
import { emptyRaw, pushText, readLines, sessionFile, type Adapter, type RawSession, type SessionFile } from './types.js';

/** Preferred first: a conversation mirrored in several roots is taken from the first. */
const ROOTS = ['antigravity-ide', 'antigravity', 'antigravity-backup'];
const BOOKKEEPING = new Set(['EPHEMERAL_MESSAGE', 'SYSTEM_MESSAGE', 'CONVERSATION_HISTORY', 'KNOWLEDGE_ARTIFACTS', 'CHECKPOINT']);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

function discover(home: string): SessionFile[] {
  const seen = new Set<string>();
  const out: SessionFile[] = [];
  for (const root of ROOTS) {
    const brain = join(home, '.gemini', root, 'brain');
    if (!existsSync(brain)) continue;
    for (const entry of readdirSync(brain, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const transcript = join(brain, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!existsSync(transcript)) continue;
      seen.add(entry.name);
      out.push(sessionFile('antigravity', transcript, entry.name, null));
    }
  }
  return out;
}

function read(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  /** Tool calls still waiting for the step that carries their result. */
  const waiting: ToolCallMessage[] = [];

  for (const line of readLines(file.path)) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      raw.warnings.bad_lines++;
      continue;
    }
    if (r?.status === 'RUNNING') continue; // an unfinished step would upload half a turn
    const ts: string | null = typeof r?.created_at === 'string' ? r.created_at : null;
    const content: string = typeof r?.content === 'string' ? r.content : '';

    if (r?.type === 'USER_INPUT') {
      pushText(raw, 'user', ts, content);
      continue;
    }
    if (r?.type === 'PLANNER_RESPONSE') {
      pushText(raw, 'assistant', ts, content);
      for (const tc of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        for (const value of Object.values(args)) {
          if (typeof value === 'string' && ABSOLUTE_PATH.test(value)) raw.path_hints.push(value);
        }
        const call: ToolCallMessage = {
          seq: raw.messages.length,
          role: 'assistant',
          kind: 'tool_call',
          ts,
          tool_name: String(tc?.name ?? 'unknown'),
          tool_input: JSON.stringify(args),
          tool_result: '',
          tool_status: 'ok',
        };
        raw.messages.push(call);
        waiting.push(call);
      }
      continue;
    }
    if (typeof r?.type !== 'string' || BOOKKEEPING.has(r.type)) continue;

    // Any other step is the outcome of the oldest tool call still waiting.
    const call = waiting.shift();
    if (!call) continue;
    call.tool_result = content;
    if (r.status === 'ERROR') call.tool_status = 'error';
  }
  return raw;
}

export const antigravity: Adapter = { source: 'antigravity', discover, read };
```

`apps/collector/src/adapters/index.ts`:

```ts
import { antigravity } from './antigravity.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import type { Adapter } from './types.js';

export const ALL_ADAPTERS: Adapter[] = [claudeCode, codex, antigravity];
export * from './types.js';
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/collector/test/antigravity.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Antigravity adapter and adapter list"
```

---

### Task 9: Config, credentials, personal list and state files

**Files:**
- Create: `apps/collector/src/config.ts`
- Test: `apps/collector/test/config.test.ts`

**Interfaces:**
- Consumes: `Level`, `PersonalEntry` from `@context-hub/core`.
- Produces:
  - `interface Config { server_url: string; tracked: string[]; skipped: string[]; aliases: Record<string, string>; assignments: Record<string, string>; personal: { card: Level; list: Level } }`
  - `interface StateEntry { size: number; mtimeMs: number; project_key: string; hash: string | null; synced_at: string | null }`
  - `interface State { fingerprint: string; files: Record<string, StateEntry> }`
  - `hubDir(env?: NodeJS.ProcessEnv): string`
  - `loadConfig(dir: string): Config`, `saveConfig(dir: string, cfg: Config): void`
  - `loadState(dir: string): State`, `saveState(dir: string, state: State): void`
  - `loadPersonal(dir: string): PersonalEntry[]`, `savePersonal(dir: string, entries: PersonalEntry[]): void`
  - `loadToken(dir: string): string | null`, `saveToken(dir: string, token: string): void`
  - `settingsFingerprint(cfg: Config, entries: PersonalEntry[]): string`
- Session keys in `skipped` and `assignments` have the form `<source>:<source_session_id>`, for example `claude-code:1111…`.

- [ ] **Step 1: Write the failing test**

`apps/collector/test/config.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hubDir,
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveConfig,
  savePersonal,
  saveState,
  saveToken,
  settingsFingerprint,
} from '../src/config.js';
import { tempDir, writeRaw } from './helpers.js';

describe('hubDir', () => {
  it('defaults to ~/.context-hub', () => {
    expect(hubDir({})).toBe(join(homedir(), '.context-hub'));
  });
  it('honours CONTEXT_HUB_HOME', () => {
    expect(hubDir({ CONTEXT_HUB_HOME: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('config', () => {
  it('returns defaults when nothing is saved: nothing tracked, warn levels', () => {
    expect(loadConfig(tempDir())).toEqual({
      server_url: '',
      tracked: [],
      skipped: [],
      aliases: {},
      assignments: {},
      personal: { card: 'warn', list: 'warn' },
    });
  });

  it('round-trips and creates the folder', () => {
    const dir = join(tempDir(), 'nested', 'hub');
    const cfg = { ...loadConfig(dir), server_url: 'https://hub.example.com', tracked: ['local:demo'] };
    saveConfig(dir, cfg);
    expect(loadConfig(dir)).toEqual(cfg);
  });

  it('fills in fields missing from an older file', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), JSON.stringify({ server_url: 'https://h', tracked: ['a'] }));
    expect(loadConfig(dir)).toMatchObject({ tracked: ['a'], skipped: [], personal: { card: 'warn', list: 'warn' } });
  });

  it('fails with a clear message when the file is not valid JSON', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'config.json'), '{oops');
    expect(() => loadConfig(dir)).toThrow(/config\.json is not valid JSON/);
  });
});

describe('state, personal list and token', () => {
  it('state defaults to empty and round-trips', () => {
    const dir = tempDir();
    expect(loadState(dir)).toEqual({ fingerprint: '', files: {} });
    const state = {
      fingerprint: 'abc',
      files: { '/a.jsonl': { size: 1, mtimeMs: 2, project_key: 'local:a', hash: 'h', synced_at: '2026-10-01T00:00:00Z' } },
    };
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  it('personal list defaults to empty and round-trips', () => {
    const dir = tempDir();
    expect(loadPersonal(dir)).toEqual([]);
    savePersonal(dir, [{ label: 'phone', value: '0812', level: 'full' }]);
    expect(loadPersonal(dir)).toEqual([{ label: 'phone', value: '0812', level: 'full' }]);
    expect(existsSync(join(dir, 'personal.json'))).toBe(true);
  });

  it('token is stored trimmed in its own file and is null when missing', () => {
    const dir = tempDir();
    expect(loadToken(dir)).toBeNull();
    saveToken(dir, '  tok-123 \n');
    expect(loadToken(dir)).toBe('tok-123');
    expect(readFileSync(join(dir, 'credentials'), 'utf8')).toBe('tok-123\n');
  });
});

describe('settingsFingerprint', () => {
  const dir = tempDir();
  const base = loadConfig(dir);
  const fp = (cfg = base, entries: Parameters<typeof settingsFingerprint>[1] = []) => settingsFingerprint(cfg, entries);

  it('is stable for the same settings', () => {
    expect(fp()).toBe(fp());
  });

  it.each([
    ['an alias', { ...base, aliases: { a: 'b' } }],
    ['an assignment', { ...base, assignments: { 'codex:s': 'local:x' } }],
    ['a personal level', { ...base, personal: { card: 'full' as const, list: 'warn' as const } }],
  ])('changes with %s', (_name, cfg) => {
    expect(fp(cfg)).not.toBe(fp());
  });

  it('changes with the personal list', () => {
    expect(fp(base, [{ label: 'phone', value: '0812' }])).not.toBe(fp());
  });

  it('does not change with the server URL, tracked or skipped lists', () => {
    expect(fp({ ...base, server_url: 'https://x', tracked: ['a'], skipped: ['b'] })).toBe(fp());
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/config.test.ts`
Expected: FAIL, cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

`apps/collector/src/config.ts`:

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/collector/test/config.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add collector config, state, personal list and token files"
```

---

### Task 10: Upload client and sync engine

**Files:**
- Create: `apps/collector/src/upload.ts`, `apps/collector/src/sync.ts`
- Test: `apps/collector/test/sync.test.ts`

**Interfaces:**
- Consumes: `ALL_ADAPTERS`, `Adapter`, `SessionFile`, `RawSession` (Tasks 6–8); `resolveProjectKey`, `applyOverrides`, `projectMatches`, `realGit`, `GitRunner` (Task 5); config functions (Task 9); `sanitizeSession`, `HashedSession`, `PersonalConfig` (core).
- Produces (in `upload.ts`):
  - `interface Remote { url: string; token: string; fetchImpl?: typeof fetch }`
  - `putSession(remote: Remote, session: HashedSession): Promise<void>` — `PUT {url}/api/sessions/{source}/{encoded id}`, gzip JSON, `Authorization: Bearer`.
  - `deleteRemote(remote: Remote, target: { project: string } | { source: string; id: string }): Promise<void>`
  - `getStatus(remote: Remote): Promise<unknown>`
- Produces (in `sync.ts`):
  - `interface SyncOptions { home: string; hubDir: string; dryRun?: boolean; project?: string; session?: string; adapters?: Adapter[]; git?: GitRunner; exists?: (p: string) => boolean; fetchImpl?: typeof fetch; now?: () => Date }`
  - `interface SyncReport { uploaded: SessionRef[]; wouldUpload: SessionRef[]; unchanged: number; secrets: Record<string, number>; personal: { session: string; type: string; count: number }[]; warnings: { session: string; bad_lines: number; unknown_records: number; dropped_blocks: number }[]; errors: string[] }`
  - `interface SessionRef { project: string; session: string }` where `session` is the session key `<source>:<id>`
  - `runSync(opts: SyncOptions): Promise<SyncReport>`
  - `interface ProjectRow { key: string; sessions: Record<string, number>; last_activity: string; tracked: boolean; last_synced: string | null }`
  - `listProjects(opts: Pick<SyncOptions, 'home' | 'hubDir' | 'adapters' | 'git' | 'exists'>): ProjectRow[]`

Behaviour to implement (spec section 7, "Sync steps"):
1. Discover with every adapter. An adapter that throws adds an error and the others continue.
2. Main sessions are processed before subagents. A subagent takes its parent's project key.
3. A file whose size and modified time match its state entry is not parsed again, unless the settings fingerprint changed.
4. Selection: `--session` picks that session and its subagents, tracked or not. Otherwise skipped sessions are dropped, then `--project` or the tracked list decides.
5. A selected session is sanitised and hashed. Same hash as the state entry: unchanged. Otherwise uploaded, or listed under `wouldUpload` in a dry run.
6. The state entry is written only after the server confirms the upload. After the first failed upload no further uploads are attempted.
7. A dry run writes nothing. The fingerprint is saved only when a real sync finishes without errors.

- [ ] **Step 1: Write the failing test**

`apps/collector/test/sync.test.ts`:

```ts
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadState, saveConfig, savePersonal, saveToken } from '../src/config.js';
import { listProjects, runSync, type SyncOptions } from '../src/sync.js';
import { tempDir, writeJsonl } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '44444444-4444-4444-8444-444444444444';
const KEY_A = 'github.com/me/alpha';

const cc = (sid: string, cwd: string, text: string) => ({
  type: 'user',
  sessionId: sid,
  cwd,
  timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: 'user', content: text },
});

interface Sent {
  method: string;
  url: string;
  auth: string | null;
  body: any;
}

let home: string;
let hub: string;
let sent: Sent[];
let failAfter: number;

/** A stand-in for the server: records requests, can start failing. */
const fakeFetch: typeof fetch = async (input, init) => {
  if (sent.length >= failAfter) return new Response('boom', { status: 500 });
  const headers = new Headers(init?.headers);
  const raw = init?.body as Uint8Array | undefined;
  sent.push({
    method: init?.method ?? 'GET',
    url: String(input),
    auth: headers.get('authorization'),
    body: raw ? JSON.parse(gunzipSync(raw).toString('utf8')) : null,
  });
  return new Response('{"ok":true}', { status: 200 });
};

const opts = (over: Partial<SyncOptions> = {}): SyncOptions => ({
  home,
  hubDir: hub,
  fetchImpl: fakeFetch,
  exists: () => true,
  git: (cwd, args) => {
    if (args[0] === 'remote') return cwd.includes('alpha') ? 'git@github.com:me/alpha.git' : null;
    return cwd.includes('alpha') ? '/work/alpha' : null;
  },
  now: () => new Date('2026-10-10T00:00:00Z'),
  ...over,
});

const proj = () => join(home, '.claude', 'projects', 'p');
const track = (...keys: string[]) => saveConfig(hub, { ...loadConfig(hub), tracked: keys });

beforeEach(() => {
  home = tempDir();
  hub = tempDir();
  sent = [];
  failAfter = Infinity;
  saveConfig(hub, { ...loadConfig(hub), server_url: 'https://hub.example.com/' });
  saveToken(hub, 'tok-1');
  writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question')]);
  writeJsonl(join(proj(), `${S2}.jsonl`), [cc(S2, '/tmp/beta', 'beta question')]);
});

describe('runSync: selection', () => {
  it('uploads nothing when nothing is tracked', async () => {
    const report = await runSync(opts());
    expect(report.uploaded).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('uploads only sessions of tracked projects', async () => {
    track(KEY_A);
    const report = await runSync(opts());
    expect(report.uploaded).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: `https://hub.example.com/api/sessions/claude-code/${S1}`,
      auth: 'Bearer tok-1',
    });
    expect(sent[0].body).toMatchObject({ project_key: KEY_A, source_session_id: S1 });
    expect(sent[0].body.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops a skipped session', async () => {
    track(KEY_A);
    saveConfig(hub, { ...loadConfig(hub), skipped: [`claude-code:${S1}`] });
    expect((await runSync(opts())).uploaded).toEqual([]);
  });

  it('--project limits the sync and accepts a short name', async () => {
    track(KEY_A, 'local:beta');
    const report = await runSync(opts({ project: 'beta' }));
    expect(report.uploaded.map((u) => u.project)).toEqual(['local:beta']);
  });

  it('--session uploads one session even when its project is not tracked', async () => {
    const report = await runSync(opts({ session: S2 }));
    expect(report.uploaded).toEqual([{ project: 'local:beta', session: `claude-code:${S2}` }]);
  });

  it('a subagent follows its parent: same project, uploaded with it, parent set', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), S1, 'subagents', 'agent-x.jsonl'), [cc(S1, '/somewhere/else', 'sub task')]);
    await runSync(opts());
    const sub = sent.find((s) => s.body.parent === S1)!;
    expect(sub.body).toMatchObject({ project_key: KEY_A, source_session_id: `${S1}/agent-x` });
    expect(sub.url).toBe(`https://hub.example.com/api/sessions/claude-code/${encodeURIComponent(`${S1}/agent-x`)}`);
  });
});

describe('runSync: change detection', () => {
  it('does not upload an unchanged session twice', async () => {
    track(KEY_A);
    await runSync(opts());
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('uploads again when the file grows', async () => {
    track(KEY_A);
    await runSync(opts());
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'alpha question'), cc(S1, '/work/alpha', 'more')]);
    const second = await runSync(opts());
    expect(second.uploaded).toHaveLength(1);
    expect(sent[1].body.messages).toHaveLength(2);
  });

  it('counts a touched file with the same content as unchanged', async () => {
    track(KEY_A);
    await runSync(opts());
    const later = new Date('2026-10-09T00:00:00Z');
    utimesSync(join(proj(), `${S1}.jsonl`), later, later);
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([]);
    expect(second.unchanged).toBe(1);
  });

  // Review Focus 4
  it('uploads again under the new key when an alias changes the project', async () => {
    track(KEY_A, 'local:renamed');
    await runSync(opts());
    saveConfig(hub, { ...loadConfig(hub), aliases: { [KEY_A]: 'local:renamed' } });
    const second = await runSync(opts());
    expect(second.uploaded).toEqual([{ project: 'local:renamed', session: `claude-code:${S1}` }]);
    expect(sent[1].body.project_key).toBe('local:renamed');
  });

  it('uploads again masked when a personal level is raised', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'my card 4242424242424242')]);
    const first = await runSync(opts());
    expect(first.personal).toEqual([{ session: `claude-code:${S1}`, type: 'card', count: 1 }]);
    expect(sent[0].body.messages[0].text).toContain('4242424242424242');

    saveConfig(hub, { ...loadConfig(hub), personal: { card: 'full', list: 'warn' } });
    await runSync(opts());
    expect(sent[1].body.messages[0].text).toBe('my card [REDACTED:card]');
  });
});

describe('runSync: safety', () => {
  it('strips secrets before upload and reports the count, never the value', async () => {
    track(KEY_A);
    const secret = 'gh' + 'p_' + 'a'.repeat(36);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', `token ${secret}`)]);
    const report = await runSync(opts());
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(report.secrets).toEqual({ github: 1 });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('never uploads the personal list itself, and the report holds no listed value', async () => {
    track(KEY_A);
    savePersonal(hub, [{ label: 'phone', value: '081234567890', level: 'full' }]);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'call 0812-3456-7890')]);
    const report = await runSync(opts());
    expect(JSON.stringify(sent)).not.toMatch(/0812[\s-]?3456[\s-]?7890/);
    expect(JSON.stringify(report)).not.toContain('081234567890');
    expect(report.personal).toEqual([{ session: `claude-code:${S1}`, type: 'phone', count: 1 }]);
  });

  it('a dry run sends nothing and writes no state', async () => {
    track(KEY_A);
    const report = await runSync(opts({ dryRun: true }));
    expect(report.wouldUpload).toEqual([{ project: KEY_A, session: `claude-code:${S1}` }]);
    expect(report.uploaded).toEqual([]);
    expect(sent).toEqual([]);
    expect(existsSync(join(hub, 'state.json'))).toBe(false);
  });

  // Review Focus 5
  it('keeps confirmed sessions synced and the rest pending when the server fails midway', async () => {
    track(KEY_A, 'local:beta');
    failAfter = 1;
    const first = await runSync(opts());
    expect(first.uploaded).toHaveLength(1);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toMatch(/500/);

    failAfter = Infinity;
    const second = await runSync(opts());
    expect(second.uploaded).toHaveLength(1);
    expect(second.uploaded[0].session).not.toBe(first.uploaded[0].session);
    expect(second.unchanged).toBe(1);
  });

  it('reports a missing token or server URL instead of trying to upload', async () => {
    track(KEY_A);
    saveConfig(hub, { ...loadConfig(hub), server_url: '' });
    const report = await runSync(opts());
    expect(report.errors[0]).toMatch(/hub init/);
    expect(sent).toEqual([]);
  });

  it('one failing adapter does not stop the others', async () => {
    track(KEY_A);
    const { ALL_ADAPTERS } = await import('../src/adapters/index.js');
    const broken = { source: 'codex' as const, discover: () => { throw new Error('disk on fire'); }, read: ALL_ADAPTERS[1].read };
    const report = await runSync(opts({ adapters: [broken, ALL_ADAPTERS[0]] }));
    expect(report.errors).toEqual(['codex: disk on fire']);
    expect(report.uploaded).toHaveLength(1);
  });

  it('passes adapter warnings through to the report', async () => {
    track(KEY_A);
    writeJsonl(join(proj(), `${S1}.jsonl`), [cc(S1, '/work/alpha', 'q'), { type: 'brand-new' }]);
    const report = await runSync(opts());
    expect(report.warnings).toEqual([{ session: `claude-code:${S1}`, bad_lines: 0, unknown_records: 1, dropped_blocks: 0 }]);
  });
});

describe('listProjects', () => {
  it('lists every project with counts, tracked flag and last sync', async () => {
    track(KEY_A);
    await runSync(opts());
    const rows = listProjects(opts()).sort((a, b) => a.key.localeCompare(b.key));
    expect(rows.map((r) => ({ key: r.key, sessions: r.sessions, tracked: r.tracked, last_synced: r.last_synced }))).toEqual([
      { key: KEY_A, sessions: { 'claude-code': 1 }, tracked: true, last_synced: '2026-10-10T00:00:00.000Z' },
      { key: 'local:beta', sessions: { 'claude-code': 1 }, tracked: false, last_synced: null },
    ]);
    expect(loadState(hub).files).not.toEqual({});
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/sync.test.ts`
Expected: FAIL, cannot resolve `../src/sync.js`.

- [ ] **Step 3: Write the upload client**

`apps/collector/src/upload.ts`:

```ts
import { gzipSync } from 'node:zlib';
import type { HashedSession } from '@context-hub/core';

export interface Remote {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function base(remote: Remote): string {
  return remote.url.replace(/\/+$/, '');
}

async function send(remote: Remote, method: string, path: string, body?: Uint8Array): Promise<Response> {
  const doFetch = remote.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${remote.token}` };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Encoding'] = 'gzip';
  }
  let res: Response;
  try {
    res = await doFetch(base(remote) + path, { method, headers, body });
  } catch (e) {
    throw new Error(`could not reach ${base(remote)}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`${method} ${path}: server answered ${res.status}`);
  return res;
}

export async function putSession(remote: Remote, session: HashedSession): Promise<void> {
  const path = `/api/sessions/${session.source}/${encodeURIComponent(session.source_session_id)}`;
  await send(remote, 'PUT', path, gzipSync(Buffer.from(JSON.stringify(session), 'utf8')));
}

export async function deleteRemote(
  remote: Remote,
  target: { project: string } | { source: string; id: string },
): Promise<void> {
  const path =
    'project' in target
      ? `/api/projects/${encodeURIComponent(target.project)}`
      : `/api/sessions/${target.source}/${encodeURIComponent(target.id)}`;
  await send(remote, 'DELETE', path);
}

export async function getStatus(remote: Remote): Promise<unknown> {
  return (await send(remote, 'GET', '/api/status')).json();
}
```

- [ ] **Step 4: Write the sync engine**

`apps/collector/src/sync.ts`:

```ts
import { existsSync } from 'node:fs';
import { sanitizeSession, type PersonalConfig } from '@context-hub/core';
import { ALL_ADAPTERS, type Adapter, type RawSession, type SessionFile } from './adapters/index.js';
import {
  loadConfig,
  loadPersonal,
  loadState,
  loadToken,
  saveState,
  settingsFingerprint,
  type Config,
  type State,
} from './config.js';
import { applyOverrides, projectMatches, realGit, resolveProjectKey, type GitRunner } from './project.js';
import { putSession, type Remote } from './upload.js';

export interface SyncOptions {
  /** The user's home folder, where the tools keep their history. */
  home: string;
  /** Where the collector keeps its own files. */
  hubDir: string;
  dryRun?: boolean;
  project?: string;
  /** A session id, with or without the "<source>:" prefix. */
  session?: string;
  adapters?: Adapter[];
  git?: GitRunner;
  exists?: (path: string) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SessionRef {
  project: string;
  session: string;
}

export interface SyncReport {
  uploaded: SessionRef[];
  wouldUpload: SessionRef[];
  unchanged: number;
  secrets: Record<string, number>;
  personal: { session: string; type: string; count: number }[];
  warnings: { session: string; bad_lines: number; unknown_records: number; dropped_blocks: number }[];
  errors: string[];
}

interface Scanned {
  file: SessionFile;
  sessionKey: string;
  parentKey: string | null;
  projectKey: string;
  /** True when size and mtime match the state entry and settings are unchanged. */
  same: boolean;
  /** Present only when the file had to be parsed to learn its project. */
  raw: RawSession | null;
}

interface Scan {
  cfg: Config;
  state: State;
  fingerprint: string;
  personal: PersonalConfig;
  items: Scanned[];
  errors: string[];
  read: (file: SessionFile) => RawSession;
}

/** Discovers every session file and works out its project key, parsing as little as possible. */
function scan(opts: Pick<SyncOptions, 'home' | 'hubDir' | 'adapters' | 'git' | 'exists'>): Scan {
  const cfg = loadConfig(opts.hubDir);
  const entries = loadPersonal(opts.hubDir);
  const state = loadState(opts.hubDir);
  const fingerprint = settingsFingerprint(cfg, entries);
  const force = state.fingerprint !== fingerprint;
  const adapters = opts.adapters ?? ALL_ADAPTERS;
  const deps = { git: opts.git ?? realGit, exists: opts.exists ?? existsSync };
  const errors: string[] = [];

  const files: SessionFile[] = [];
  for (const adapter of adapters) {
    try {
      files.push(...adapter.discover(opts.home));
    } catch (e) {
      errors.push(`${adapter.source}: ${(e as Error).message}`);
    }
  }
  files.sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null)); // main sessions first

  const bySource = new Map(adapters.map((a) => [a.source, a]));
  const read = (file: SessionFile): RawSession => bySource.get(file.source)!.read(file);
  const keyOf = new Map<string, string>();
  const items: Scanned[] = [];

  for (const file of files) {
    const sessionKey = `${file.source}:${file.id}`;
    const parentKey = file.parent ? `${file.source}:${file.parent}` : null;
    const prev = state.files[file.path];
    const same = !force && !!prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs;

    let raw: RawSession | null = null;
    let projectKey: string;
    try {
      if (parentKey && keyOf.has(parentKey)) {
        projectKey = keyOf.get(parentKey)!;
      } else if (same) {
        projectKey = prev.project_key;
      } else {
        raw = read(file);
        const resolved = resolveProjectKey(
          { cwd: raw.cwd, remoteHint: raw.remote_hint, pathHints: raw.path_hints },
          deps,
        );
        projectKey = applyOverrides(resolved, sessionKey, cfg);
      }
    } catch (e) {
      errors.push(`${sessionKey}: ${(e as Error).message}`);
      continue;
    }
    keyOf.set(sessionKey, projectKey);
    items.push({ file, sessionKey, parentKey, projectKey, same, raw });
  }

  return {
    cfg,
    state,
    fingerprint,
    personal: { card: cfg.personal.card, list: cfg.personal.list, entries },
    items,
    errors,
    read,
  };
}

function isSelected(item: Scanned, cfg: Config, opts: SyncOptions): boolean {
  if (opts.session) {
    const wanted = opts.session;
    const matches = (key: string | null) => key !== null && (key === wanted || key.slice(key.indexOf(':') + 1) === wanted);
    return matches(item.sessionKey) || matches(item.parentKey);
  }
  if (cfg.skipped.includes(item.sessionKey)) return false;
  if (item.parentKey && cfg.skipped.includes(item.parentKey)) return false;
  if (opts.project) return projectMatches(opts.project, item.projectKey);
  return cfg.tracked.includes(item.projectKey);
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const s = scan(opts);
  const report: SyncReport = {
    uploaded: [],
    wouldUpload: [],
    unchanged: 0,
    secrets: {},
    personal: [],
    warnings: [],
    errors: [...s.errors],
  };
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  const token = loadToken(opts.hubDir);
  let remote: Remote | null = null;
  if (!dryRun) {
    if (!s.cfg.server_url || !token) {
      report.errors.push('No server address or upload token. Run `hub init` first.');
      return report;
    }
    remote = { url: s.cfg.server_url, token, fetchImpl: opts.fetchImpl };
  }

  let stopped = false; // set after the first failed upload

  for (const item of s.items) {
    const { file, sessionKey, projectKey } = item;
    const prev = s.state.files[file.path];
    const remember = (hash: string | null, syncedAt: string | null): void => {
      if (dryRun) return;
      s.state.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, project_key: projectKey, hash, synced_at: syncedAt };
    };

    if (!isSelected(item, s.cfg, opts)) {
      remember(prev?.hash ?? null, prev?.synced_at ?? null);
      continue;
    }
    if (prev && item.same && prev.hash !== null) {
      report.unchanged++;
      continue;
    }
    if (stopped) continue;

    let raw: RawSession;
    try {
      raw = item.raw ?? s.read(file);
    } catch (e) {
      report.errors.push(`${sessionKey}: ${(e as Error).message}`);
      continue;
    }

    const result = sanitizeSession(
      {
        source: raw.source,
        source_session_id: raw.source_session_id,
        account_id: raw.account_id,
        project_key: projectKey,
        parent: raw.parent,
        title: raw.title,
        cwd: raw.cwd,
        git_branch: raw.git_branch,
        messages: raw.messages,
      },
      s.personal,
    );

    if (prev?.hash === result.session.content_hash) {
      report.unchanged++;
      remember(prev.hash, prev.synced_at);
      continue;
    }

    const ref: SessionRef = { project: projectKey, session: sessionKey };
    if (dryRun) {
      report.wouldUpload.push(ref);
    } else {
      try {
        await putSession(remote!, result.session);
      } catch (e) {
        report.errors.push((e as Error).message);
        stopped = true;
        continue;
      }
      report.uploaded.push(ref);
      remember(result.session.content_hash, now().toISOString());
    }

    for (const [type, n] of Object.entries(result.secrets)) report.secrets[type] = (report.secrets[type] ?? 0) + n;
    for (const [type, count] of Object.entries(result.personal)) report.personal.push({ session: sessionKey, type, count });
    const w = raw.warnings;
    if (w.bad_lines + w.unknown_records + w.dropped_blocks > 0) report.warnings.push({ session: sessionKey, ...w });
  }

  if (!dryRun) {
    // Keep forcing a full pass until one finishes cleanly.
    if (report.errors.length === 0) s.state.fingerprint = s.fingerprint;
    saveState(opts.hubDir, s.state);
  }
  return report;
}

export interface ProjectRow {
  key: string;
  /** Main sessions per tool. */
  sessions: Record<string, number>;
  last_activity: string;
  tracked: boolean;
  last_synced: string | null;
}

export function listProjects(opts: Pick<SyncOptions, 'home' | 'hubDir' | 'adapters' | 'git' | 'exists'>): ProjectRow[] {
  const s = scan(opts);
  const rows = new Map<string, ProjectRow>();
  for (const item of s.items) {
    if (item.file.parent !== null) continue;
    const row =
      rows.get(item.projectKey) ??
      ({ key: item.projectKey, sessions: {}, last_activity: '', tracked: s.cfg.tracked.includes(item.projectKey), last_synced: null } as ProjectRow);
    row.sessions[item.file.source] = (row.sessions[item.file.source] ?? 0) + 1;
    const activity = new Date(item.file.mtimeMs).toISOString();
    if (activity > row.last_activity) row.last_activity = activity;
    const synced = s.state.files[item.file.path]?.synced_at ?? null;
    if (synced && (!row.last_synced || synced > row.last_synced)) row.last_synced = synced;
    rows.set(item.projectKey, row);
  }
  return [...rows.values()];
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run apps/collector/test/sync.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 6: Run everything and the typecheck**

Run: `pnpm test`
Expected: PASS, every test file.

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add upload client and sync engine"
```

---

### Task 11: The `hub` command

**Files:**
- Create: `apps/collector/src/cli.ts`, `apps/collector/src/bin.ts`
- Create: `integrations/claude-code/hub-sync.md`
- Create: `README.md`
- Test: `apps/collector/test/cli.test.ts`

**Interfaces:**
- Consumes: `runSync`, `listProjects`, `SyncReport` (Task 10); config functions (Task 9); `deleteRemote`, `getStatus` (Task 10); `projectMatches` (Task 5); `Level` (core).
- Produces: `run(argv: string[], io: Io): Promise<number>` returning the exit code, and
  `interface Io { home: string; hubDir: string; out: (line: string) => void; err: (line: string) => void; ask: (question: string) => Promise<string>; fetchImpl?: typeof fetch; git?: GitRunner; exists?: (p: string) => boolean }`

Commands (spec section 7):

| Command | Behaviour |
|---|---|
| `hub init [--url U] [--token T]` | Saves the server URL and token; asks for whichever is missing |
| `hub projects` | One line per project: tracked mark, key, session counts, last activity, last synced |
| `hub track <project>` / `hub untrack <project>` | `<project>` is matched against discovered projects; an unknown name is an error |
| `hub skip <session>` / `hub unskip <session>` | `<session>` is `<source>:<id>` |
| `hub alias <from> <to>` | Both are project keys |
| `hub assign <session> <project>` | |
| `hub sync [--project P] [--session S] [--dry-run]` | Prints the report; exit code 1 when the report has errors |
| `hub forget <project>` / `hub forget --session <source>:<id>` | Asks "type yes to confirm" first |
| `hub status` | Prints the server's status JSON |
| `hub personal add <label>` | Asks for the value at a prompt |
| `hub personal list` | Labels and levels, never values |
| `hub personal remove <label>` | |
| `hub personal level <card or list or label> <level>` | |

- [ ] **Step 1: Write the failing test**

`apps/collector/test/cli.test.ts`:

```ts
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';
import { loadConfig, loadPersonal, loadToken } from '../src/config.js';
import { tempDir, writeJsonl } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
let io: Io;
let out: string[];
let err: string[];
let answers: string[];
let requests: { method: string; url: string }[];

beforeEach(() => {
  out = [];
  err = [];
  answers = [];
  requests = [];
  const home = tempDir();
  writeJsonl(join(home, '.claude', 'projects', 'p', `${S1}.jsonl`), [
    { type: 'user', sessionId: S1, cwd: '/work/alpha', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
  ]);
  io = {
    home,
    hubDir: tempDir(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ask: async () => answers.shift() ?? '',
    exists: () => true,
    git: (_cwd, args) => (args[0] === 'remote' ? 'git@github.com:me/alpha.git' : '/work/alpha'),
    fetchImpl: async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return new Response('{"sessions":1}', { status: 200 });
    },
  };
});

const KEY = 'github.com/me/alpha';

describe('hub init', () => {
  it('saves the URL and token from flags', async () => {
    expect(await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io)).toBe(0);
    expect(loadConfig(io.hubDir).server_url).toBe('https://hub.example.com');
    expect(loadToken(io.hubDir)).toBe('tok');
  });

  it('asks for what is missing', async () => {
    answers = ['https://hub.example.com', 'tok-asked'];
    expect(await run(['init'], io)).toBe(0);
    expect(loadToken(io.hubDir)).toBe('tok-asked');
  });

  it('rejects a URL that is not http or https', async () => {
    expect(await run(['init', '--url', 'hub.example.com', '--token', 't'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/must start with http/);
  });
});

describe('hub track / untrack / projects', () => {
  it('tracks by short name and stores the full key', async () => {
    expect(await run(['track', 'alpha'], io)).toBe(0);
    expect(loadConfig(io.hubDir).tracked).toEqual([KEY]);
  });

  it('refuses a project it cannot find, and lists what exists', async () => {
    expect(await run(['track', 'nope'], io)).toBe(1);
    expect(err.join('\n')).toContain(KEY);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
  });

  it('untrack removes it and tracking twice does not duplicate', async () => {
    await run(['track', 'alpha'], io);
    await run(['track', 'alpha'], io);
    expect(loadConfig(io.hubDir).tracked).toEqual([KEY]);
    await run(['untrack', 'alpha'], io);
    expect(loadConfig(io.hubDir).tracked).toEqual([]);
  });

  it('projects shows the key, the count and a tracked mark', async () => {
    await run(['track', 'alpha'], io);
    out = [];
    expect(await run(['projects'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/\[x\]\s+github\.com\/me\/alpha\s+claude-code: 1/);
  });
});

describe('hub skip / alias / assign', () => {
  it('stores each override', async () => {
    await run(['skip', `claude-code:${S1}`], io);
    await run(['alias', 'local:a', KEY], io);
    await run(['assign', `claude-code:${S1}`, 'local:special'], io);
    expect(loadConfig(io.hubDir)).toMatchObject({
      skipped: [`claude-code:${S1}`],
      aliases: { 'local:a': KEY },
      assignments: { [`claude-code:${S1}`]: 'local:special' },
    });
    await run(['unskip', `claude-code:${S1}`], io);
    expect(loadConfig(io.hubDir).skipped).toEqual([]);
  });

  it('rejects a session without a source prefix', async () => {
    expect(await run(['skip', S1], io)).toBe(1);
    expect(err.join('\n')).toMatch(/<source>:<id>/);
  });
});

describe('hub sync', () => {
  beforeEach(async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    await run(['track', 'alpha'], io);
    out = [];
  });

  it('dry run prints what would be uploaded and sends nothing', async () => {
    expect(await run(['sync', '--dry-run'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Would upload 1 session/);
    expect(out.join('\n')).toContain(KEY);
    expect(requests).toEqual([]);
  });

  it('uploads and prints a summary', async () => {
    expect(await run(['sync'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Uploaded 1 session/);
    expect(requests).toEqual([{ method: 'PUT', url: `https://hub.example.com/api/sessions/claude-code/${S1}` }]);
  });

  it('exits 1 and prints the error when the server refuses', async () => {
    io.fetchImpl = async () => new Response('no', { status: 401 });
    expect(await run(['sync'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/401/);
  });
});

describe('hub forget', () => {
  beforeEach(async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
  });

  it('deletes a project after confirmation', async () => {
    answers = ['yes'];
    expect(await run(['forget', KEY], io)).toBe(0);
    expect(requests).toEqual([{ method: 'DELETE', url: `https://hub.example.com/api/projects/${encodeURIComponent(KEY)}` }]);
  });

  it('does nothing without confirmation', async () => {
    answers = ['no'];
    expect(await run(['forget', KEY], io)).toBe(1);
    expect(requests).toEqual([]);
  });

  it('deletes one session with --session', async () => {
    answers = ['yes'];
    expect(await run(['forget', '--session', `claude-code:${S1}`], io)).toBe(0);
    expect(requests[0]).toEqual({ method: 'DELETE', url: `https://hub.example.com/api/sessions/claude-code/${S1}` });
  });
});

describe('hub personal', () => {
  it('add asks for the value, list never prints it', async () => {
    answers = ['0812-3456-7890'];
    expect(await run(['personal', 'add', 'phone'], io)).toBe(0);
    expect(loadPersonal(io.hubDir)).toEqual([{ label: 'phone', value: '0812-3456-7890' }]);
    out = [];
    await run(['personal', 'list'], io);
    expect(out.join('\n')).toContain('phone');
    expect(out.join('\n')).not.toContain('0812');
  });

  it('level sets card, list and a single entry', async () => {
    answers = ['0812-3456-7890'];
    await run(['personal', 'add', 'phone'], io);
    await run(['personal', 'level', 'card', 'partial'], io);
    await run(['personal', 'level', 'list', 'full'], io);
    await run(['personal', 'level', 'phone', 'off'], io);
    expect(loadConfig(io.hubDir).personal).toEqual({ card: 'partial', list: 'full' });
    expect(loadPersonal(io.hubDir)[0].level).toBe('off');
  });

  it('rejects an unknown level and an unknown label', async () => {
    expect(await run(['personal', 'level', 'card', 'loud'], io)).toBe(1);
    expect(await run(['personal', 'level', 'nobody', 'full'], io)).toBe(1);
  });

  it('remove deletes the entry', async () => {
    answers = ['x-value-123'];
    await run(['personal', 'add', 'thing'], io);
    await run(['personal', 'remove', 'thing'], io);
    expect(loadPersonal(io.hubDir)).toEqual([]);
  });
});

describe('hub status and usage', () => {
  it('status prints what the server returns', async () => {
    await run(['init', '--url', 'https://hub.example.com', '--token', 'tok'], io);
    out = [];
    expect(await run(['status'], io)).toBe(0);
    expect(out.join('\n')).toContain('"sessions": 1');
  });

  it('an unknown command prints usage and exits 1', async () => {
    expect(await run(['dance'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: hub/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/collector/test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Write the command**

`apps/collector/src/cli.ts`:

```ts
import { parseArgs } from 'node:util';
import type { Level } from '@context-hub/core';
import {
  loadConfig,
  loadPersonal,
  loadToken,
  saveConfig,
  savePersonal,
  saveToken,
  type Config,
} from './config.js';
import { projectMatches, type GitRunner } from './project.js';
import { listProjects, runSync, type SyncReport } from './sync.js';
import { deleteRemote, getStatus, type Remote } from './upload.js';

export interface Io {
  home: string;
  hubDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  git?: GitRunner;
  exists?: (path: string) => boolean;
}

const USAGE = `Usage: hub <command>

  init [--url URL] [--token TOKEN]     save the server address and upload token
  projects                             list projects found on this PC
  track <project> | untrack <project>  choose which projects are uploaded
  skip <session> | unskip <session>    exclude one session (<source>:<id>)
  alias <from> <to>                    merge or rename a project key
  assign <session> <project>           set the project of one session
  sync [--project P] [--session S] [--dry-run]
  forget <project> | forget --session <source>:<id>
  status                               ask the server for its status
  personal add <label> | list | remove <label> | level <card|list|label> <level>`;

const LEVELS: Level[] = ['off', 'warn', 'partial', 'full'];
const SESSION_KEY = /^(claude-code|codex|antigravity):.+$/;

class Fail extends Error {}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Fail(`Missing ${what}.\n\n${USAGE}`);
  return value;
}

function sessionKey(value: string | undefined): string {
  const v = need(value, 'session');
  if (!SESSION_KEY.test(v)) throw new Fail(`A session is written as <source>:<id>, for example claude-code:1234. Got "${v}".`);
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
  return { url: cfg.server_url, token, fetchImpl: io.fetchImpl };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printReport(io: Io, report: SyncReport, dryRun: boolean): void {
  const list = dryRun ? report.wouldUpload : report.uploaded;
  io.out(`${dryRun ? 'Would upload' : 'Uploaded'} ${plural(list.length, 'session')}. Unchanged: ${report.unchanged}.`);
  const perProject = new Map<string, number>();
  for (const ref of list) perProject.set(ref.project, (perProject.get(ref.project) ?? 0) + 1);
  for (const [project, n] of perProject) io.out(`  ${project}: ${n}`);

  const secrets = Object.entries(report.secrets);
  if (secrets.length > 0) io.out(`Secrets stripped: ${secrets.map(([t, n]) => `${t} ${n}`).join(', ')}`);
  for (const p of report.personal) io.out(`Personal data: ${p.type} x${p.count} in ${p.session}`);
  for (const w of report.warnings) {
    io.out(`Warning: ${w.session}: ${w.bad_lines} unreadable lines, ${w.unknown_records} unknown records, ${w.dropped_blocks} dropped blocks`);
  }
  for (const e of report.errors) io.err(`Error: ${e}`);
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
        options: { project: { type: 'string' }, session: { type: 'string' }, 'dry-run': { type: 'boolean' } },
      });
      const dryRun = values['dry-run'] === true;
      const report = await runSync({ ...scanOpts(io), fetchImpl: io.fetchImpl, dryRun, project: values.project, session: values.session });
      printReport(io, report, dryRun);
      return report.errors.length > 0 ? 1 : 0;
    }
    case 'forget': {
      const { values, positionals } = parseArgs({ args: rest, options: { session: { type: 'string' } }, allowPositionals: true });
      const r = remote(io);
      const what = values.session ? sessionKey(values.session) : need(positionals[0], 'project');
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
      io.out(JSON.stringify(await getStatus(remote(io)), null, 2));
      return 0;
    }
    case 'personal':
      await personal(io, rest);
      return 0;
    default:
      throw new Fail(USAGE);
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

```

`apps/collector/src/bin.ts` is the only file that touches the real terminal. It is kept separate so that importing `cli.ts` in a test never starts the program, and so a linked or shimmed install always runs:

```ts
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run, type Io } from './cli.js';
import { hubDir } from './config.js';

const io: Io = {
  home: homedir(),
  hubDir: hubDir(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

run(process.argv.slice(2), io).then((code) => process.exit(code));
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/collector/test/cli.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 5: Write the slash command and the README**

`integrations/claude-code/hub-sync.md`:

```markdown
---
description: Upload this project's new AI sessions to context-hub
---

Run this command and report its output to me in two or three lines:

`hub sync --project "$(git remote get-url origin 2>/dev/null || basename "$PWD")"`

If it prints an error, show me the error exactly and stop. Do not try to fix it.
```

`README.md`:

```markdown
# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

Part 1 of 4: the `hub` collector. The server is not built yet, so real
uploads have nowhere to go; `hub sync --dry-run` works today.

## Install the collector

    pnpm install
    pnpm --filter @context-hub/collector build
    cd apps/collector && pnpm link --global

## Use

    hub projects                 # what is on this PC
    hub track <project>          # nothing is uploaded until you track it
    hub sync --dry-run           # see what would be sent
    hub sync                     # send it

`hub personal add phone` adds one of your own values to the personal data
list. The default level is `warn`: the value is reported but still uploaded.
Raise it with `hub personal level list partial` or `full`.

To sync from inside Claude Code, copy
`integrations/claude-code/hub-sync.md` to `~/.claude/commands/`.

## Develop

    pnpm test
    pnpm typecheck
```

- [ ] **Step 6: Build and try it against real history**

Run: `pnpm --filter @context-hub/collector build`
Expected: `apps/collector/dist/bin.js` exists and its first line is `#!/usr/bin/env node`.

Run: `node apps/collector/dist/bin.js projects`
Expected: a list of the real projects on this PC, each with `[ ]` because nothing is tracked. No error.

Run: `node apps/collector/dist/bin.js sync --dry-run`
Expected: `Would upload 0 sessions. Unchanged: 0.` because nothing is tracked.

If `projects` prints warnings about unknown records, note the record type names in the commit message. They are format drift to handle in a follow-up, not a failure of this task.

- [ ] **Step 7: Run everything**

Run: `pnpm test`
Expected: PASS, every test file.

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add hub command, slash command and README"
```

---

## What this part leaves for later parts

- The server the collector uploads to (part 2). Until then `hub sync` without `--dry-run`, `hub status` and `hub forget` fail with "could not reach".
- Installing `hub` globally and copying the slash command into `~/.claude/commands/` change the user's machine. Do both only when the user asks, after part 2 is deployed.
- The server-side second secret check (spec section 8) imports `stripSecrets` from `@context-hub/core` in part 2.
