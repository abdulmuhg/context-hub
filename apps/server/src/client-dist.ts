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

// Written as a template with the sh expansions as $\{…} so none of them is read as a JavaScript one.
const SH_INSTALLER = `#!/bin/sh
# Installs the hub command and sets this computer up. Run it again to update or repair.
set -eu

HUB_URL=@URL@

code=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code)
      code="$\{2:-}"
      if [ $# -gt 1 ]; then shift; fi
      ;;
    --code=*) code="$\{1#--code=}" ;;
  esac
  shift
done

# 1. Node 22 or newer. Nothing has been changed yet if this stops.
if command -v node >/dev/null 2>&1; then
  found=$(node -p 'process.versions.node' 2>/dev/null || echo none)
else
  found=none
fi
major=$\{found%%.*}
case "$major" in
  none|"" | *[!0-9]*) major=0 ;;
esac
if [ "$major" -lt 22 ]; then
  echo "context-hub needs Node 22 or newer (found: $found)."
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    echo "Install it with: brew install node"
  else
    echo "Install it from: https://nodejs.org"
  fi
  echo "then open a new terminal and paste the same line again. If more than 10 minutes have passed, get a new line from Sign-ins → Add a computer."
  exit 1
fi

DATA="$\{XDG_DATA_HOME:-$HOME/.local/share}/context-hub"
BIN="$HOME/.local/bin"
mkdir -p "$DATA" "$BIN"

# 2. The bundle, downloaded aside first so a failed download leaves the old one working.
tmp=$(mktemp "$DATA/hub.mjs.XXXXXX")
trap 'rm -f "$tmp" "$tmp.launcher"' EXIT
if ! curl -fsSL @BUNDLE_URL@ -o "$tmp"; then
  echo "Couldn't download hub from $HUB_URL/hub.mjs. Nothing was changed. Paste the line again."
  exit 1
fi
mv "$tmp" "$DATA/hub.mjs"

printf '#!/bin/sh\\nexec node "%s" "$@"\\n' "$DATA/hub.mjs" > "$tmp.launcher"
chmod +x "$tmp.launcher"
mv "$tmp.launcher" "$BIN/hub"

# What is left in "$@" from here on is passed to hub setup as notes and warnings for the checklist.
set --

# 3. PATH: the install folder goes first in the login shell's profile, once.
first=$(command -v hub 2>/dev/null || true)
need_path=0
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) need_path=1 ;;
esac
if [ "$need_path" = 1 ] || { [ -n "$first" ] && [ "$first" != "$BIN/hub" ]; }; then
  case "$\{SHELL:-}" in
    */zsh) profile="$HOME/.zshrc" ;;
    */bash) profile="$HOME/.bashrc" ;;
    *) profile="$HOME/.profile" ;;
  esac
  if grep -qs '# added by context-hub' "$profile" 2>/dev/null; then
    :
  elif printf '\\nexport PATH="$HOME/.local/bin:$PATH" # added by context-hub\\n' >> "$profile" 2>/dev/null; then
    set -- "$@" --note "Added ~/.local/bin to the front of PATH in $profile (open a new terminal to use hub by name)"
  else
    set -- "$@" --warn "Couldn't update $profile. Run hub by its full path: $BIN/hub"
  fi
fi

# 4. Old launchers of ours that would win are renamed, not deleted, so they can be put back.
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  IFS=$old_ifs
  if [ -n "$dir" ] && [ -f "$dir/hub" ] && [ "$dir/hub" != "$BIN/hub" ]; then
    other="$dir/hub"
    if grep -qE 'context-hub|collector/dist/bin\\.js|hub\\.mjs' "$other" 2>/dev/null; then
      if mv -f "$other" "$other.old" 2>/dev/null; then
        set -- "$@" --note "Renamed the old hub at $other to $other.old"
      else
        set -- "$@" --warn "Couldn't rename the old hub at $other. This one is at $BIN/hub"
      fi
    elif [ "$other" = "$first" ]; then
      set -- "$@" --warn "Another hub at $other comes first on PATH; this one is at $BIN/hub"
    fi
  fi
  IFS=:
done
IFS=$old_ifs

# 5. Hand over to hub setup, with the terminal for input when there is one.
if (exec </dev/tty) 2>/dev/null; then
  "$BIN/hub" setup --url "$HUB_URL" $\{code:+--code "$code"} "$@" </dev/tty
else
  "$BIN/hub" setup --url "$HUB_URL" $\{code:+--code "$code"} "$@"
fi
`;

/**
 * The POSIX sh installer served at /install. It checks Node, puts the bundle and a `hub` launcher in the
 * user's home, fixes PATH, then hands over to `hub setup`. It never touches ~/.context-hub, so running it
 * again is an update. The code arrives as `--code` and never appears in a URL.
 */
export function installScript(publicUrl: string): string {
  const url = publicUrl.replace(/\/+$/, '');
  return SH_INSTALLER.replace('@URL@', () => quote(url)).replace('@BUNDLE_URL@', () => quote(`${url}/hub.mjs`));
}
