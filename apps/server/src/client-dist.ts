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

/** Inside PowerShell single quotes, where a quote is doubled. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// Windows PowerShell 5.1 has no &&, ||, ?? or ternary, and this runs through iex, so it never leaves the session:
// every stop is a return from the script block. It uses no backticks, so it can sit in a raw template.
const PS_INSTALLER = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $hubUrl = @URL@
  $bundleUrl = @BUNDLE_URL@
  $code = $env:HUB_CODE
  Remove-Item Env:HUB_CODE -ErrorAction SilentlyContinue

  # 1. Node 22 or newer. Nothing has been changed yet if this stops.
  $found = 'none'
  if (Get-Command node -ErrorAction SilentlyContinue) {
    try { $found = (& node -p 'process.versions.node').Trim() } catch { $found = 'none' }
  }
  $major = 0
  if ($found -match '^(\d+)\.') { $major = [int]$Matches[1] }
  if ($major -lt 22) {
    Write-Host ('context-hub needs Node 22 or newer (found: ' + $found + ').')
    Write-Host 'Install it with: winget install OpenJS.NodeJS.LTS'
    Write-Host 'then open a new terminal and paste the same line again. If more than 10 minutes have passed, get a new line from Sign-ins → Add a computer.'
    return
  }

  # 2. The bundle, downloaded aside first so a failed download leaves the old one working.
  $base = Join-Path $env:LOCALAPPDATA 'context-hub'
  $bin = Join-Path $base 'bin'
  $bundle = Join-Path $base 'hub.mjs'
  $launcher = Join-Path $bin 'hub.cmd'
  $partial = Join-Path $base 'hub.mjs.download'
  try {
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
  } catch {
    Write-Host ("Couldn't create " + $bin + ". Nothing was changed. Check that you can write to " + $env:LOCALAPPDATA + ", then paste the line again.")
    return
  }
  try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $partial
    Move-Item -Force -Path $partial -Destination $bundle
  } catch {
    Remove-Item $partial -ErrorAction SilentlyContinue
    Write-Host ("Couldn't download hub from " + $bundleUrl + ". Nothing was changed. Paste the line again.")
    return
  }

  # The launcher: hub.cmd runs the bundle with node.
  try {
    $cmd = '@echo off' + [Environment]::NewLine + 'node "' + $bundle + '" %*' + [Environment]::NewLine
    [IO.File]::WriteAllText($launcher, $cmd, [Text.Encoding]::Default)
  } catch {
    Write-Host ("Couldn't write " + $launcher + ". Nothing else was changed. Paste the line again.")
    return
  }

  $notes = @()
  $warns = @()

  # 3. PATH: the install folder goes first in the user's PATH (not the machine's), and in this session.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  try {
    $parts = @()
    if ($userPath) { $parts = @($userPath -split ';' | Where-Object { $_ -ne '' }) }
    $rest = @($parts | Where-Object { $_.TrimEnd('\') -ne $bin.TrimEnd('\') })
    $newUser = (@($bin) + $rest) -join ';'
    if ($newUser -ne $userPath) {
      [Environment]::SetEnvironmentVariable('Path', $newUser, 'User')
      $notes += ('Added ' + $bin + ' to the front of your PATH (user)')
    }
    $userPath = $newUser
  } catch {
    $warns += ("Couldn't update your PATH. Run hub by its full path: " + $launcher)
  }
  $session = @($env:Path -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $bin.TrimEnd('\') })
  $env:Path = (@($bin) + $session) -join ';'

  # 4. Old launchers of ours are renamed, not deleted, so they can be put back.
  $names = @('hub', 'hub.cmd', 'hub.ps1')
  $ours = 'context-hub|collector\\dist\\bin\.js|hub\.mjs'
  foreach ($dir in $session) {
    foreach ($name in $names) {
      $file = Join-Path $dir $name
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      $text = ''
      try { $text = Get-Content -LiteralPath $file -Raw -ErrorAction Stop } catch { }
      if ($text -match $ours) {
        try {
          Move-Item -Force -LiteralPath $file -Destination ($file + '.old')
          $notes += ('Renamed the old hub at ' + $file + ' to ' + $file + '.old')
        } catch {
          $warns += ("Couldn't rename the old hub at " + $file + '. This one is at ' + $launcher)
        }
      }
    }
  }

  # Which hub would a new window run? The machine's PATH comes before the user's.
  $order = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $userPath) -split ';' | Where-Object { $_ -ne '' })
  $winner = $null
  foreach ($dir in $order) {
    foreach ($name in $names) {
      $file = Join-Path $dir $name
      if ($winner -eq $null -and (Test-Path -LiteralPath $file -PathType Leaf)) { $winner = $file }
    }
  }
  if ($winner -ne $null -and $winner -ne $launcher) {
    $warns += ('Another hub at ' + $winner + ' comes first on PATH; this one is at ' + $launcher)
  }

  # 5. Hand over to hub setup.
  $setupArgs = @('--url', $hubUrl)
  if ($code) { $setupArgs += @('--code', $code) }
  foreach ($n in $notes) { $setupArgs += @('--note', $n) }
  foreach ($w in $warns) { $setupArgs += @('--warn', $w) }
  & node $bundle setup @setupArgs
}
`;

/**
 * The Windows PowerShell 5.1 installer served at /install.ps1, the same job as the sh one. The code arrives in
 * the HUB_CODE environment variable, set on the line that fetches this script, so it is never in a URL.
 */
export function installScriptPs1(publicUrl: string): string {
  const url = publicUrl.replace(/\/+$/, '');
  return PS_INSTALLER.replace('@URL@', () => psQuote(url)).replace('@BUNDLE_URL@', () => psQuote(`${url}/hub.mjs`));
}
