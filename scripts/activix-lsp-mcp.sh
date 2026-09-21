#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ACTIVIX_LSP_DEFAULT_ROOT:-/Users/atorres/Documents/GitHub/activix-crm}"
NODE_BIN="${ACTIVIX_LSP_NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "node not found; set ACTIVIX_LSP_NODE_BIN" >&2; exit 127; }
export ACTIVIX_LSP_DEFAULT_ROOT="$ROOT"
export PATH="$(dirname "$NODE_BIN"):$SCRIPT_DIR/../node_modules/.bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

exec "$NODE_BIN"   "$SCRIPT_DIR/../node_modules/tsx/dist/cli.mjs"   "$SCRIPT_DIR/../src/mcp-server.ts"   "$ACTIVIX_LSP_DEFAULT_ROOT"
