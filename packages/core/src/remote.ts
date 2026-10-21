/** Hosts that people often reach through an SSH alias such as "github.com-work". */
const ALIASED_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

/**
 * Folds an SSH host alias back into its host, so "github.com-work/me/app" and
 * "github.com/me/app" are one project. Any other key comes back unchanged.
 */
export function canonicalKey(key: string): string {
  for (const host of ALIASED_HOSTS) {
    const alias = new RegExp(`^${host.replace(/\./g, '\\.')}[-_][\\w.-]+(?=/)`, 'i').exec(key);
    if (alias) return host + key.slice(alias[0].length);
  }
  return key;
}

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
  return canonicalKey(`${host}/${path}`.toLowerCase());
}
