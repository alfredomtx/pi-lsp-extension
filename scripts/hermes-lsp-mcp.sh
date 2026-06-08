#!/usr/bin/env bash
set -euo pipefail

export HERMES_LSP_DEFAULT_ROOT="${HERMES_LSP_DEFAULT_ROOT:-/Users/atorres/Documents/GitHub/activix-crm}"
export PATH="/Users/atorres/.nvm/versions/node/v22.22.0/bin:/Users/atorres/Documents/GitHub/configs/pi/extensions/pi-lsp-extension/node_modules/.bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

exec /Users/atorres/.nvm/versions/node/v22.22.0/bin/node \
  /Users/atorres/Documents/GitHub/configs/pi/extensions/pi-lsp-extension/node_modules/tsx/dist/cli.mjs \
  /Users/atorres/Documents/GitHub/configs/pi/extensions/pi-lsp-extension/src/mcp-server.ts \
  "$HERMES_LSP_DEFAULT_ROOT"
