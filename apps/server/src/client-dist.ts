import { readFileSync } from 'node:fs';

/** The `hub` command as one file, read once at startup. Null when it is not in this image. */
export function loadClientBundle(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Inside single quotes, so a quote in the address cannot end the string. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The POSIX sh installer served at /install. It puts the bundle and a `hub` launcher in the user's home,
 * installs the slash commands and never touches ~/.context-hub, so running it again is an update.
 */
export function installScript(publicUrl: string): string {
  const url = publicUrl.replace(/\/+$/, '');
  return [
    '#!/bin/sh',
    '# Installs the hub command. Run it again to update.',
    'set -eu',
    '',
    'if command -v node >/dev/null 2>&1; then',
    '  found=$(node -p \'process.versions.node\' 2>/dev/null || echo none)',
    'else',
    '  found=none',
    'fi',
    'major=${found%%.*}',
    'case "$major" in',
    '  none|"" | *[!0-9]*) major=0 ;;',
    'esac',
    'if [ "$major" -lt 22 ]; then',
    '  echo "context-hub needs Node 22 or newer (found: $found). Get it from https://nodejs.org."',
    '  exit 1',
    'fi',
    '',
    'DATA="${XDG_DATA_HOME:-$HOME/.local/share}/context-hub"',
    'BIN="$HOME/.local/bin"',
    'mkdir -p "$DATA" "$BIN"',
    '',
    'tmp=$(mktemp "$DATA/hub.mjs.XXXXXX")',
    'trap \'rm -f "$tmp" "$tmp.launcher"\' EXIT',
    `curl -fsSL ${quote(`${url}/hub.mjs`)} -o "$tmp"`,
    'mv "$tmp" "$DATA/hub.mjs"',
    '',
    'printf \'#!/bin/sh\\nexec node "%s" "$@"\\n\' "$DATA/hub.mjs" > "$tmp.launcher"',
    'chmod +x "$tmp.launcher"',
    'mv "$tmp.launcher" "$BIN/hub"',
    '',
    'case ":$PATH:" in',
    '  *":$BIN:"*) ;;',
    '  *)',
    '    echo "Add this line to your shell profile so the hub command is found:"',
    '    echo \'  export PATH="$HOME/.local/bin:$PATH"\'',
    '    ;;',
    'esac',
    '',
    '"$BIN/hub" install-commands',
    `echo "Installed. Next: hub login --url ${quote(url)}"`,
    '',
  ].join('\n');
}
