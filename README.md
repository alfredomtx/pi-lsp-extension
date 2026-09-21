# Activix LSP MCP adapter

Read-only MCP adapter around the Pi LSP core. Default target workspace is Activix CRM.

## Start command

Pi MCP config should point at:

```bash
/Users/atorres/Documents/GitHub/configs/pi/extensions/pi-lsp-extension/scripts/activix-lsp-mcp.sh
```

The wrapper sets:

- `ACTIVIX_LSP_DEFAULT_ROOT=/Users/atorres/Documents/GitHub/activix-crm`
- Node from `PATH`, or `ACTIVIX_LSP_NODE_BIN`
- local `node_modules/.bin` for language servers

## Tools

Core LSP/code-intel tools:

- `status`
- `warmup`
- `diagnostics`
- `symbols`
- `overview`
- `definition`
- `references`
- `hover`

Activix helpers:

- `activix_inspect`: structural inspect for Lucid Features/Operations/Jobs, model/API touchpoints, inbound references, and likely tests.
- `activix_blast_radius`: ranked related files + focused checks for a target file or symbol.

## Reliability guardrails

The MCP server has three timeout layers:

- language-server startup timeout: `ACTIVIX_LSP_START_TIMEOUT_MS`, default `15000`
- per-LSP-request timeout: `ACTIVIX_LSP_REQUEST_TIMEOUT_MS`, default `15000`
- whole-tool timeout: `ACTIVIX_LSP_TOOL_TIMEOUT_MS`, default `30000`

Vue document-symbol failures fall back to parsing the `<script>` block with tree-sitter.

## Activix command output trimmer

Use this when a command is noisy but the agent needs exact command, exit code, top failures, and full log path:

```bash
npm run activix:run -- ./activix test tests/Feature/ExampleTest.php
npm run activix:run -- npm run check
```

Full logs go under `.activix/logs/`. Set `ACTIVIX_RUN_SUMMARY_PASSTHROUGH=1` to stream raw command output too.

## Verification

Run:

```bash
PATH=/Users/atorres/.nvm/versions/node/v22.22.0/bin:$PATH npm run check
scripts/test-activix-lsp-mcp.sh
```

After adding/removing MCP tools, restart the Pi MCP client so the tool schema refreshes.
