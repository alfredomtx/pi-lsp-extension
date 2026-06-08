#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const root = process.env.HERMES_LSP_DEFAULT_ROOT || "/Users/atorres/Documents/GitHub/activix-crm";
const node = "/Users/atorres/.nvm/versions/node/v22.22.0/bin/node";
const tsx = `${pkg}/node_modules/tsx/dist/cli.mjs`;
const server = `${pkg}/src/mcp-server.ts`;
const expectedTools = new Set([
  "status",
  "warmup",
  "diagnostics",
  "symbols",
  "overview",
  "definition",
  "references",
  "hover",
  "activix_inspect",
  "activix_blast_radius",
]);

const transport = new StdioClientTransport({
  command: node,
  args: [tsx, server, root],
  env: process.env,
  stderr: "pipe",
});

transport.stderr?.on("data", chunk => {
  const text = chunk.toString("utf8").trim();
  if (text) process.stderr.write(`[mcp-server] ${text}\n`);
});

const client = new Client({ name: "hermes-lsp-smoke", version: "0.1.0" });

try {
  await withTimeout(client.connect(transport), 20_000, "connect");
  const tools = await withTimeout(client.listTools(), 20_000, "listTools");
  const names = new Set(tools.tools.map(tool => tool.name));
  const missing = [...expectedTools].filter(name => !names.has(name));
  if (missing.length) {
    throw new Error(`missing tools: ${missing.join(", ")}; found=${[...names].sort().join(", ")}`);
  }

  const status = await call("status", { root });
  assertIncludes(status, "php", "status includes php");
  assertIncludes(status, "vue", "status includes vue");

  const warmup = await call("warmup", { root, languages: ["php"] });
  assertIncludes(warmup, "php: ready", "php warmup");

  const phpFile = "app/Context.php";
  const tsFile = "frontend/src/components/sms/hooks/useSmsDrawer.ts";
  const vueFile = "frontend/src/components/sms/SmsConversationDrawer.vue";

  const phpOverview = await call("overview", { root, path: phpFile });
  assertIncludes(phpOverview, "symbol(s)", "php overview symbols");

  const phpSymbols = await call("symbols", { root, path: phpFile });
  assertIncludes(phpSymbols, "symbol(s)", "php document symbols");

  const accountHover = await call("hover", { root, path: phpFile, query: "Account" });
  assertIncludes(accountHover, "Resolved \"Account\"", "Account query resolved");
  if (accountHover.includes("-> account")) throw new Error(`Account query resolved to account() method:\n${accountHover}`);

  const contextAccountHover = await call("hover", { root, path: phpFile, query: "Context::account" });
  assertIncludes(contextAccountHover, "Resolved \"Context::account\"", "Class::member query resolved");

  const tsDiag = await call("diagnostics", { root, path: tsFile });
  assertIncludes(tsDiag, "No diagnostics", "TS diagnostics clean");

  const vueOverview = await call("overview", { root, path: vueFile });
  assertIncludes(vueOverview, "symbol(s)", "Vue overview symbols");

  const inspect = await call("activix_inspect", { root, path: phpFile, limit: 5 });
  assertIncludes(inspect, "Target: app/Context.php", "inspect target");
  assertIncludes(inspect, "Likely tests", "inspect likely tests");

  const blast = await call("activix_blast_radius", { root, path: vueFile, limit: 10 });
  assertIncludes(blast, "Direct blast-radius files", "blast radius files");
  assertIncludes(blast, "Suggested focused checks", "blast radius checks");

  console.log("tools:", [...names].sort().join(", "));
  console.log("smoke: ok");
} finally {
  await client.close().catch(() => {});
}

async function call(name, args) {
  const result = await withTimeout(client.callTool({ name, arguments: args }), 35_000, name);
  const text = (result.content ?? [])
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n");
  if (result.isError) throw new Error(`${name} returned error:\n${text}`);
  return text;
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)} in:\n${text}`);
}

async function withTimeout(promise, timeoutMs, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}
