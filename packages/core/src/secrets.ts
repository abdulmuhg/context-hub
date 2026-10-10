interface Rule {
  type: string;
  re: RegExp;
  /** Builds the replacement from the match groups. Default: the bare marker. */
  replace?: (groups: string[], marker: string) => string;
}

const ENV_NAME = '[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH)[A-Z0-9_]*';

// Order matters: specific formats first, the broad env-line rule last.
// Rules with a distinctive prefix have no leading word boundary, so a token glued to
// preceding word characters (e.g. at a truncation seam) is still caught.
const RULES: Rule[] = [
  {
    type: 'private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // Fallback: a block cut off before its END line. Only lines that look like key
  // material are taken (base64 runs, armor headers, a blank line before more base64),
  // with real or JSON-escaped newlines, so prose that merely quotes the header survives.
  {
    type: 'private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\r?\n|\\r\\n|\\n)(?:[A-Za-z0-9+/=]{16,}|(?:Proc-Type|DEK-Info|Version|Comment|Hash): [^\n\\]*|[ \t]*(?=(?:\r?\n|\\r\\n|\\n)[A-Za-z0-9+/=]{16,})))*/g,
  },
  { type: 'github', re: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { type: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { type: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'google', re: /AIza[0-9A-Za-z_-]{35}/g },
  { type: 'slack', re: /xox[a-z]-[A-Za-z0-9-]{10,}/g },
  { type: 'stripe', re: /[sr]k_live_[A-Za-z0-9]{16,}/g },
  { type: 'npm', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { type: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    type: 'auth_header',
    re: /(Authorization["']?\s*:\s*["']?(?:Bearer|Basic)\s+)([^\s"',}[]+)/gi,
    replace: (g, marker) => g[0] + marker,
  },
  {
    type: 'password',
    // The password runs to the last "@" of the authority, so "/" and "@" inside it are covered.
    // The user name may be empty (redis://:pw@host). "host:port/" is not "user:password":
    // the lookahead rejects a short digit run followed by a path, so dev URLs such as
    // http://localhost:5173/@vite/client are left alone. The length bound keeps it linear.
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)(?!\d{1,5}(?:[/?#\s]|$))([^\s[]{1,256}?)(@[^\s/@]+)(?=[\s/]|$)/gi,
    replace: (g, marker) => g[0] + marker + g[2],
  },
  {
    type: 'env',
    re: new RegExp(`^(\\s*(?:export\\s+)?${ENV_NAME}\\s*[=:]\\s*)(?!["']?\\[REDACTED:)("[^"\\n]*"|'[^'\\n]*'|\\S+)`, 'gm'),
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
