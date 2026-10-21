#!/usr/bin/env bash
# Checks, one flag at a time, that `claude -p` works the way `hub sync` runs it.
# Run it from Git Bash (Windows) or a terminal (macOS), in the context-hub repo:
#
#   bash scripts/check-claude-p.sh
#
# Each step is one tiny call on your Claude plan (9 calls in all). The first step
# that hangs or fails is the one to look at. Nothing is uploaded anywhere.

set -u
LIMIT=${LIMIT:-90}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t chs)
cd "$WORK" || exit 1

# The same clean environment the collector uses: no ANTHROPIC_* or CLAUDE* variables, except CLAUDE_CONFIG_DIR.
UNSET=()
while IFS= read -r name; do UNSET+=(-u "$name"); done < <(env | cut -d= -f1 | grep -iE '^(ANTHROPIC_|CLAUDE)' | grep -iv '^CLAUDE_CONFIG_DIR$')
clean() { env "${UNSET[@]}" "$@"; }

SCHEMA='{"type":"object","properties":{"goal":{"type":"string"}},"required":["goal"],"additionalProperties":false}'
PROMPT='[1] USER: Let us use SQLite for the hub.
[2] ASSISTANT: Agreed. One file, and FTS5 for search.'

echo "== Setup"
echo "claude:       $(command -v claude || echo 'not found')"
echo "version:      $(clean claude --version 2>&1 | head -1)"
echo "signed in:    $(clean claude auth status --json 2>/dev/null | grep -oE '"(loggedIn|authMethod)": *[^,]*' | tr '\n' ' ')"
if command -v tasklist >/dev/null 2>&1; then
  running=$(tasklist 2>/dev/null | grep -ciE '^(claude|Claude)\.exe')
else
  running=$(pgrep -ilf 'claude' 2>/dev/null | grep -vc "check-claude-p")
fi
echo "claude processes already running: $running  (run this once with Claude Code fully closed, once with it open)"
echo "working folder: $WORK"
echo

# step <name> <stdin-or-empty> <claude args...>
step() {
  local name=$1 input=$2; shift 2
  local start end status out
  start=$(date +%s)
  if [ -n "$input" ]; then
    out=$(printf '%s' "$input" | clean timeout "$LIMIT" claude "$@" 2>&1); status=$?
  else
    out=$(clean timeout "$LIMIT" claude "$@" </dev/null 2>&1); status=$?
  fi
  end=$(date +%s)
  if [ "$status" = 124 ]; then
    echo "✗ $name: HUNG, no answer in ${LIMIT}s"
    return 1
  fi
  local summary
  summary=$(printf '%s' "$out" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const o = JSON.parse(s);
        const models = Object.keys(o.modelUsage || {}).join(",") || "-";
        const so = o.structured_output === undefined ? "" : " structured_output=" + JSON.stringify(o.structured_output).slice(0, 80);
        console.log((o.is_error ? "ERROR " : "ok ") + "is_error=" + o.is_error + " model=" + models + so + (o.is_error ? " result=" + String(o.result).slice(0, 160) : ""));
      } catch { console.log("NOT JSON: " + s.replace(/\s+/g, " ").slice(0, 200)); }
    });' 2>/dev/null)
  if [ "$status" = 0 ] && [[ "$summary" == ok* ]]; then
    echo "✓ $name: $((end - start))s, $summary"
    return 0
  fi
  echo "✗ $name: exit $status after $((end - start))s, $summary"
  return 1
}

failed=0
echo "== Steps (each adds to the one before)"
# Every step passes --no-session-persistence, so nothing is added to your history.
# Step 1 only shows how your own settings behave (a proxy in their env block, for example); hub does not use them.
step "1 plain, with your own settings (not how hub runs it)" "" -p "Say hi in two words." --output-format json --no-session-persistence || echo "  (step 1 does not count: hub skips your user settings)"
step "2 + skip your user settings (as hub does)" "" -p "Say hi in two words." --output-format json --no-session-persistence --setting-sources project || failed=1
step "2b + model and effort" "" -p "Say hi in two words." --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low || failed=1
step "3 + prompt on stdin (as hub does)" "$PROMPT" -p --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low || failed=1
step "4 + no tools" "$PROMPT" -p --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low --tools "" || failed=1
step "5 + safe mode, no MCP servers" "$PROMPT" -p --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low --tools "" --safe-mode --strict-mcp-config || failed=1
step "6 + system prompt" "$PROMPT" -p --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low --tools "" --safe-mode --strict-mcp-config --system-prompt "State the goal of this transcript." || failed=1
step "7 + JSON schema (the full hub call)" "$PROMPT" -p --output-format json --no-session-persistence --setting-sources project --model claude-sonnet-5-5 --effort low --tools "" --safe-mode --strict-mcp-config --system-prompt "State the goal of this transcript." --json-schema "$SCHEMA" || failed=1

echo
echo "== Step 8: the collector's own code (ClaudeCodeLlm, real digest prompt and schema)"
( cd "$REPO" && CHECK_LIMIT=$LIMIT timeout $((LIMIT + 60)) npx --yes tsx scripts/check-claude-llm.mts ) || failed=1

echo
if [ "$failed" = 0 ]; then echo "All steps passed: hub sync can write summaries on this computer."; else echo "Some steps failed. Send the lines above (they hold no secrets) back to the session."; fi
rm -rf "$WORK"
