#!/usr/bin/env bash
set -euo pipefail

ROOT="${ACTIVIX_LSP_DEFAULT_ROOT:-/Users/atorres/Documents/GitHub/activix-crm}"
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${ACTIVIX_LSP_NODE_BIN:-$(dirname "$(command -v node || echo /usr/bin/node)")}"
export PATH="$NODE_BIN:$PKG/node_modules/.bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export ACTIVIX_LSP_DEFAULT_ROOT="$ROOT"
export ACTIVIX_LSP_START_TIMEOUT_MS="${ACTIVIX_LSP_START_TIMEOUT_MS:-15000}"
export ACTIVIX_LSP_REQUEST_TIMEOUT_MS="${ACTIVIX_LSP_REQUEST_TIMEOUT_MS:-15000}"
export ACTIVIX_LSP_TOOL_TIMEOUT_MS="${ACTIVIX_LSP_TOOL_TIMEOUT_MS:-30000}"

cd "$PKG"
BEFORE_MCP_PIDS="$(pgrep -f "mcp-server.ts|tsx/dist/cli.mjs .*mcp-server" 2>/dev/null || true)"

echo "== TypeScript check =="
npm run check

echo "== Programmatic MCP smoke =="
node scripts/test-activix-lsp-mcp.mjs

echo "== Orphan process check =="
AFTER_MCP_PIDS="$(pgrep -f "mcp-server.ts|tsx/dist/cli.mjs .*mcp-server" 2>/dev/null || true)"
NEW_PIDS="$(comm -13 <(printf '%s\n' "$BEFORE_MCP_PIDS" | sed '/^$/d' | sort) <(printf '%s\n' "$AFTER_MCP_PIDS" | sed '/^$/d' | sort) || true)"
if [ -n "$NEW_PIDS" ]; then
  ps -o pid,ppid,etime,command -p "$(printf '%s' "$NEW_PIDS" | paste -sd, -)" || true
  echo "warning: new MCP process(es) remained after smoke test" >&2
elif [ -n "$AFTER_MCP_PIDS" ]; then
  echo "no new orphan mcp-server.ts process found; existing gateway-owned process(es) unchanged"
else
  echo "no orphan mcp-server.ts process found"
fi
