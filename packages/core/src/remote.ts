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
