#!/usr/bin/env node
/**
 * Activix MCP adapter for the Pi LSP core.
 *
 * Read-only first version: status, warmup, diagnostics, symbols, definition,
 * references, hover, and a tree-sitter file overview.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { DiagnosticSeverity, SymbolKind } from "vscode-languageserver-protocol";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { delimiter } from "node:path";

import { LspManager, type ServerConfig } from "./lsp-manager.js";
import type { LspClient } from "./lsp-client.js";
import { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import { WorkspaceIndex } from "./tree-sitter/workspace-index.js";
import { extractSymbols, type SymbolInfo } from "./tree-sitter/symbol-extractor.js";
import { getLanguageIdFromPath } from "./shared/language-map.js";
import { resolveSymbolPosition } from "./shared/resolve-position.js";
import { blastRadius, inspectLucid } from "./activix/lucid.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const LOCAL_BIN = join(PACKAGE_ROOT, "node_modules", ".bin");
process.env.PATH = [LOCAL_BIN, process.env.PATH ?? ""].filter(Boolean).join(delimiter);

const DEFAULT_ROOT = process.env.ACTIVIX_LSP_DEFAULT_ROOT || process.argv[2] || process.cwd();
const DEFAULT_TIMEOUT_MS = Number(process.env.ACTIVIX_LSP_START_TIMEOUT_MS || 15_000);
const REQUEST_TIMEOUT_MS = Number(process.env.ACTIVIX_LSP_REQUEST_TIMEOUT_MS || 15_000);
const TOOL_TIMEOUT_MS = Number(process.env.ACTIVIX_LSP_TOOL_TIMEOUT_MS || 30_000);
const DIAGNOSTIC_SETTLE_MS = Number(process.env.ACTIVIX_LSP_DIAGNOSTIC_SETTLE_MS || 900);
const MAX_LINES = 120;
const MAX_BYTES = 20_000;

interface WorkspaceState {
  root: string;
  manager: LspManager;
  treeSitter: TreeSitterManager;
  treeSitterInit: Promise<void>;
  workspaceIndex: WorkspaceIndex;
  opened: Map<string, number>;
}

interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const workspaces = new Map<string, WorkspaceState>();

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [SymbolKind.File]: "file",
  [SymbolKind.Module]: "module",
  [SymbolKind.Namespace]: "namespace",
  [SymbolKind.Package]: "package",
  [SymbolKind.Class]: "class",
  [SymbolKind.Method]: "method",
  [SymbolKind.Property]: "property",
  [SymbolKind.Field]: "field",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Enum]: "enum",
  [SymbolKind.Interface]: "interface",
  [SymbolKind.Function]: "function",
  [SymbolKind.Variable]: "variable",
  [SymbolKind.Constant]: "constant",
  [SymbolKind.String]: "string",
  [SymbolKind.Number]: "number",
  [SymbolKind.Boolean]: "boolean",
  [SymbolKind.Array]: "array",
  [SymbolKind.Object]: "object",
  [SymbolKind.Key]: "key",
  [SymbolKind.Null]: "null",
  [SymbolKind.EnumMember]: "enum-member",
  [SymbolKind.Struct]: "struct",
  [SymbolKind.Event]: "event",
  [SymbolKind.Operator]: "operator",
  [SymbolKind.TypeParameter]: "type-param",
};

function localBin(name: string): string {
  const path = join(LOCAL_BIN, name);
  return existsSync(path) ? path : name;
}

function serverConfigs(): Record<string, ServerConfig> {
  const ts = { command: localBin("typescript-language-server"), args: ["--stdio"] };
  return {
    php: {
      command: localBin("intelephense"),
      args: ["--stdio"],
      settings: {
        intelephense: {
          files: { maxSize: 5_000_000 },
          environment: { phpVersion: "8.3.0" },
        },
      },
    },
    typescript: ts,
    javascript: ts,
    typescriptreact: ts,
    javascriptreact: ts,
    vue: { command: localBin("vue-language-server"), args: ["--stdio"] },
  };
}

function normalizeRoot(root?: unknown): string {
  const raw = typeof root === "string" && root.trim() ? root.trim() : DEFAULT_ROOT;
  return resolve(raw.replace(/^@/, ""));
}

function getWorkspace(rootArg?: unknown): WorkspaceState {
  const root = normalizeRoot(rootArg);
  let state = workspaces.get(root);
  if (state) return state;

  const treeSitter = new TreeSitterManager();
  state = {
    root,
    manager: new LspManager(root, serverConfigs()),
    treeSitter,
    treeSitterInit: treeSitter.init().catch((err) => {
      console.error(`[activix-lsp] tree-sitter init failed: ${err?.message ?? err}`);
    }),
    workspaceIndex: new WorkspaceIndex(root, treeSitter),
    opened: new Map(),
  };
  workspaces.set(root, state);
  return state;
}

function rel(state: WorkspaceState, absOrRel: string): string {
  const abs = isAbsolute(absOrRel) ? absOrRel : resolve(state.root, absOrRel);
  return relative(state.root, abs) || ".";
}

function normalizePath(state: WorkspaceState, filePath: unknown): string {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("path is required");
  }
  const clean = filePath.trim().replace(/^@/, "");
  return isAbsolute(clean) ? clean : resolve(state.root, clean);
}

function toolText(text: string, isError = false): TextResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function truncate(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): string {
  const lines = text.split("\n");
  let outLines = lines.slice(0, maxLines);
  let out = outLines.join("\n");
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    let bytes = 0;
    const kept: string[] = [];
    for (const line of outLines) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf8");
      if (bytes + lineBytes > maxBytes) break;
      kept.push(line);
      bytes += lineBytes;
    }
    outLines = kept;
    out = kept.join("\n");
  }
  if (outLines.length < lines.length) {
    out += `\n\n[truncated: showing ${outLines.length} of ${lines.length} lines]`;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestWithTimeout<T>(client: LspClient, method: string, params: unknown): Promise<T> {
  return withTimeout(client.sendRequest<T>(method, params), REQUEST_TIMEOUT_MS, method);
}

async function getReadyClientForLanguage(
  state: WorkspaceState,
  languageId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LspClient | null> {
  const start = Date.now();
  let client = await withTimeout(
    state.manager.getClientForLanguage(languageId),
    timeoutMs,
    `${languageId} language server startup`,
  ).catch(() => null);
  if (client) return client;

  while (Date.now() - start < timeoutMs) {
    client = state.manager.getRunningClient(languageId);
    if (client) return client;
    await sleep(750);
  }
  return state.manager.getRunningClient(languageId);
}

async function getReadyClientForFile(
  state: WorkspaceState,
  absPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LspClient | null> {
  const languageId = state.manager.getLanguageId(absPath);
  if (!languageId) return null;
  const client = await getReadyClientForLanguage(state, languageId, timeoutMs);
  if (!client) return null;
  await ensureDocumentOpen(state, client, absPath, languageId);
  return client;
}

async function ensureDocumentOpen(
  state: WorkspaceState,
  client: LspClient,
  absPath: string,
  languageId: string,
): Promise<void> {
  const uri = pathToFileURL(absPath).toString();
  if (state.opened.has(uri)) return;
  const text = await readFile(absPath, "utf8");
  client.didOpen(uri, languageId, 1, text);
  state.opened.set(uri, 1);
}

function severityName(severity?: number): string {
  switch (severity) {
    case DiagnosticSeverity.Error: return "error";
    case DiagnosticSeverity.Warning: return "warning";
    case DiagnosticSeverity.Information: return "info";
    case DiagnosticSeverity.Hint: return "hint";
    default: return "unknown";
  }
}

function formatDiagnostic(diag: Diagnostic, filePath: string): string {
  const line = diag.range.start.line + 1;
  const col = diag.range.start.character + 1;
  const source = diag.source ? ` [${diag.source}]` : "";
  const code = diag.code !== undefined ? ` (${diag.code})` : "";
  return `${filePath}:${line}:${col} ${severityName(diag.severity)}: ${diag.message}${code}${source}`;
}

function formatLocation(state: WorkspaceState, loc: Location): string {
  try {
    const abs = fileURLToPath(loc.uri);
    return `${rel(state, abs)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  } catch {
    return `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  }
}

function formatLocationLink(state: WorkspaceState, loc: LocationLink): string {
  try {
    const abs = fileURLToPath(loc.targetUri);
    return `${rel(state, abs)}:${loc.targetSelectionRange.start.line + 1}:${loc.targetSelectionRange.start.character + 1}`;
  } catch {
    return `${loc.targetUri}:${loc.targetSelectionRange.start.line + 1}:${loc.targetSelectionRange.start.character + 1}`;
  }
}

function kindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `kind(${kind})`;
}

function documentSymbolLines(sym: DocumentSymbol, indent = 0): string[] {
  const prefix = "  ".repeat(indent);
  const line = sym.range.start.line + 1;
  const result = [`${prefix}${kindName(sym.kind)} ${sym.name} (line ${line})`];
  for (const child of sym.children ?? []) result.push(...documentSymbolLines(child, indent + 1));
  return result;
}

function symbolInfoLine(state: WorkspaceState, sym: SymbolInformation | WorkspaceSymbol): string {
  let location = "";
  if ("location" in sym && sym.location) {
    try {
      const locObj = sym.location as Location;
      const abs = fileURLToPath(locObj.uri);
      location = ` ${rel(state, abs)}:${locObj.range?.start ? locObj.range.start.line + 1 : "?"}`;
    } catch {
      location = ` ${(sym.location as any).uri ?? ""}`;
    }
  }
  return `${kindName(sym.kind)} ${sym.name}${location}`;
}

function treeSymbolLines(sym: SymbolInfo, indent = 0): string[] {
  const prefix = "  ".repeat(indent);
  const result = [`${prefix}${kindName(sym.kind)} ${sym.name} (line ${sym.line})`];
  for (const child of sym.children ?? []) result.push(...treeSymbolLines(child, indent + 1));
  return result;
}

function shiftSymbolLines(symbols: SymbolInfo[], lineOffset: number): SymbolInfo[] {
  if (lineOffset === 0) return symbols;
  return symbols.map((symbol) => ({
    ...symbol,
    line: symbol.line + lineOffset,
    children: symbol.children ? shiftSymbolLines(symbol.children, lineOffset) : undefined,
  }));
}

function extractVueScript(content: string): { content: string; languageId: string; lineOffset: number } | null {
  const match = /<script\b([^>]*)>([\s\S]*?)<\/script>/i.exec(content);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const full = match[0];
  const contentStart = (match.index ?? 0) + full.indexOf(">") + 1;
  const lineOffset = content.slice(0, contentStart).split("\n").length - 1;
  const languageId = /lang=["']tsx?["']/i.test(attrs) ? "typescript" : "javascript";
  return { content: match[2] ?? "", languageId, lineOffset };
}

function hoverToText(hover: Hover | null): string {
  if (!hover) return "No hover information.";
  const c = hover.contents;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map(markedStringToText).join("\n").trim() || "No hover information.";
  }
  return c.value || "No hover information.";
}

function markedStringToText(value: MarkedString): string {
  if (typeof value === "string") return value;
  return value.value;
}

async function resolvePositionArgs(state: WorkspaceState, absPath: string, args: Record<string, unknown>) {
  let line = typeof args.line === "number" ? args.line : undefined;
  let character = typeof args.character === "number" ? args.character : undefined;
  const query = typeof args.query === "string" ? args.query : undefined;
  let resolvedFrom = "";

  if ((line === undefined || character === undefined) && query) {
    const resolvedPos = await resolveSymbolPosition(absPath, query, state.manager, state.treeSitter);
    if (!resolvedPos) throw new Error(`could not resolve query "${query}" in ${rel(state, absPath)}`);
    line = resolvedPos.line;
    character = resolvedPos.character;
    resolvedFrom = `Resolved "${query}" -> ${resolvedPos.symbolName} at ${line}:${character} [${resolvedPos.source}]\n\n`;
  }

  if (line === undefined || character === undefined) {
    throw new Error("either line/character or query is required");
  }

  return {
    position: { line: line - 1, character: character - 1 },
    resolvedFrom,
  };
}

async function toolStatus(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const statuses = state.manager.getStatus();
  const lines = [
    `root: ${state.root}`,
    `local bin: ${LOCAL_BIN}`,
    statuses.length === 0 ? "servers: none configured" : "servers:",
    ...statuses.map((s) => `- ${s.languageId}: ${s.command} ${s.running ? "running" : "idle"}${s.diagnosticsCount ? ` (${s.diagnosticsCount} diagnostics)` : ""}`),
  ];
  return toolText(lines.join("\n"));
}

async function toolWarmup(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const languages = Array.isArray(args.languages) && args.languages.length > 0
    ? args.languages.map(String)
    : ["php"];
  const results: string[] = [];
  for (const language of languages) {
    const client = await getReadyClientForLanguage(state, language, DEFAULT_TIMEOUT_MS);
    results.push(`${language}: ${client ? "ready" : "not ready"}`);
  }
  return toolText(`root: ${state.root}\n${results.join("\n")}`);
}

async function toolDiagnostics(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const path = String(args.path ?? "*");
  if (path === "*" || path === "") return workspaceDiagnostics(state);

  const absPath = normalizePath(state, path);
  const client = await getReadyClientForFile(state, absPath);
  if (!client) return toolText(state.manager.getUnavailableReason(absPath), true);

  await sleep(DIAGNOSTIC_SETTLE_MS);
  const uri = pathToFileURL(absPath).toString();
  const diagnostics = [...client.getDiagnostics(uri)].sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99));
  if (diagnostics.length === 0) return toolText(`No diagnostics for ${rel(state, absPath)}.`);
  const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error).length;
  const warnings = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning).length;
  const lines = diagnostics.map((d) => formatDiagnostic(d, rel(state, absPath)));
  return toolText(`${errors} error(s), ${warnings} warning(s)\n\n${truncate(lines.join("\n"))}`);
}

function workspaceDiagnostics(state: WorkspaceState): TextResult {
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const status of state.manager.getStatus().filter((s) => s.running)) {
    const client = state.manager.getRunningClient(status.languageId);
    if (!client) continue;
    for (const [uri, diagnostics] of client.getAllDiagnostics()) {
      for (const diagnostic of diagnostics) {
        try {
          const path = fileURLToPath(uri);
          lines.push(formatDiagnostic(diagnostic, rel(state, path)));
        } catch {
          lines.push(formatDiagnostic(diagnostic, uri));
        }
        if (diagnostic.severity === DiagnosticSeverity.Error) errors++;
        if (diagnostic.severity === DiagnosticSeverity.Warning) warnings++;
      }
    }
  }
  if (lines.length === 0) return toolText("No cached workspace diagnostics from running LSP servers.");
  return toolText(`${errors} error(s), ${warnings} warning(s), ${lines.length} diagnostic(s)\n\n${truncate(lines.join("\n"))}`);
}

async function toolSymbols(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const query = typeof args.query === "string" ? args.query : undefined;
  if (args.path) {
    const absPath = normalizePath(state, args.path);
    const client = await getReadyClientForFile(state, absPath);
    if (client) {
      try {
        const result = await requestWithTimeout<DocumentSymbol[] | SymbolInformation[] | null>(client, "textDocument/documentSymbol", {
          textDocument: { uri: pathToFileURL(absPath).toString() },
        });
        if (result?.length) {
          const first = result[0] as any;
          const lines = "range" in first
            ? (result as DocumentSymbol[]).flatMap((s) => documentSymbolLines(s))
            : (result as SymbolInformation[]).map((s) => symbolInfoLine(state, s));
          return toolText(`${lines.length} symbol(s) in ${rel(state, absPath)}\n\n${truncate(lines.join("\n"))}`);
        }
      } catch (err: any) {
        console.error(`[activix-lsp] document symbols failed for ${rel(state, absPath)}: ${err?.message ?? err}`);
      }
    }
    return treeFileOverview(state, absPath);
  }

  if (!query) return toolText("Provide path for document symbols or query for workspace symbols.", true);
  const language = String(args.language ?? "php");
  const client = await getReadyClientForLanguage(state, language);
  if (client) {
    try {
      const result = await requestWithTimeout<(SymbolInformation | WorkspaceSymbol)[] | null>(client, "workspace/symbol", { query });
      if (result?.length) {
        const lines = result.map((s) => symbolInfoLine(state, s));
        return toolText(`${result.length} workspace symbol(s) for "${query}" [${language}]\n\n${truncate(lines.join("\n"))}`);
      }
    } catch (err: any) {
      console.error(`[activix-lsp] workspace symbols failed for ${language}: ${err?.message ?? err}`);
    }
  }
  await state.treeSitterInit;
  await state.workspaceIndex.build();
  const results = state.workspaceIndex.search(query);
  if (results.length === 0) return toolText(`No workspace symbols found for "${query}".`);
  const lines = results.map((e) => `${kindName(e.kind)} ${e.name} ${rel(state, e.file)}:${e.line}`);
  return toolText(`${results.length} workspace symbol(s) for "${query}" [tree-sitter]\n\n${truncate(lines.join("\n"))}`);
}

async function treeFileOverview(state: WorkspaceState, absPath: string): Promise<TextResult> {
  await state.treeSitterInit;
  const languageId = getLanguageIdFromPath(absPath);
  if (!languageId) return toolText(`No language mapping for ${rel(state, absPath)}.`, true);
  const originalContent = await readFile(absPath, "utf8");
  let parseContent = originalContent;
  let parseLanguageId = languageId;
  let parsePath = absPath;
  let lineOffset = 0;
  let sourceLabel = "tree-sitter";

  if (languageId === "vue") {
    const script = extractVueScript(originalContent);
    if (!script) return toolText(`No <script> block found in ${rel(state, absPath)}.`);
    parseContent = script.content;
    parseLanguageId = script.languageId;
    parsePath = `${absPath}#script`;
    lineOffset = script.lineOffset;
    sourceLabel = `tree-sitter/vue-script-${parseLanguageId}`;
  }

  const tree = languageId === parseLanguageId
    ? await state.treeSitter.parse(absPath, parseContent)
    : await state.treeSitter.parseWithLanguage(parsePath, parseContent, parseLanguageId);
  if (!tree) return toolText(`No symbols found in ${rel(state, absPath)}.`);
  const symbols = shiftSymbolLines(extractSymbols(tree, parseLanguageId), lineOffset);
  if (symbols.length === 0) return toolText(`No symbols found in ${rel(state, absPath)}.`);
  const lines = symbols.flatMap((s) => treeSymbolLines(s));
  return toolText(`${lines.length} symbol(s) in ${rel(state, absPath)} [${sourceLabel}]\n\n${truncate(lines.join("\n"))}`);
}

async function toolOverview(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const absPath = normalizePath(state, args.path);
  return treeFileOverview(state, absPath);
}

async function toolActivixInspect(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  return toolText(truncate(await inspectLucid(state.root, args), 160, 30_000));
}

async function toolActivixBlastRadius(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  return toolText(truncate(await blastRadius(state.root, args), 180, 35_000));
}

async function toolDefinition(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const absPath = normalizePath(state, args.path);
  const client = await getReadyClientForFile(state, absPath);
  if (!client) return toolText(state.manager.getUnavailableReason(absPath), true);
  const { position, resolvedFrom } = await resolvePositionArgs(state, absPath, args);
  const result = await requestWithTimeout<Location | Location[] | LocationLink[] | null>(client, "textDocument/definition", {
    textDocument: { uri: pathToFileURL(absPath).toString() },
    position,
  });
  if (!result || (Array.isArray(result) && result.length === 0)) return toolText(`${resolvedFrom}No definition found.`);
  const locations = Array.isArray(result)
    ? ("targetUri" in (result[0] as any)
      ? (result as LocationLink[]).map((l) => formatLocationLink(state, l))
      : (result as Location[]).map((l) => formatLocation(state, l)))
    : [formatLocation(state, result as Location)];
  return toolText(`${resolvedFrom}${locations.length === 1 ? "Definition" : "Definitions"}:\n${locations.map((l) => `- ${l}`).join("\n")}`);
}

async function toolReferences(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const absPath = normalizePath(state, args.path);
  const client = await getReadyClientForFile(state, absPath);
  if (!client) return toolText(state.manager.getUnavailableReason(absPath), true);
  const { position, resolvedFrom } = await resolvePositionArgs(state, absPath, args);
  const includeDeclaration = args.includeDeclaration !== false;
  const limit = typeof args.limit === "number" ? args.limit : 80;
  const result = await requestWithTimeout<Location[] | null>(client, "textDocument/references", {
    textDocument: { uri: pathToFileURL(absPath).toString() },
    position,
    context: { includeDeclaration },
  });
  if (!result?.length) return toolText(`${resolvedFrom}No references found.`);
  const lines = result.slice(0, limit).map((l) => `- ${formatLocation(state, l)}`);
  const extra = result.length > limit ? `\n... and ${result.length - limit} more` : "";
  return toolText(`${resolvedFrom}${result.length} reference(s):\n${lines.join("\n")}${extra}`);
}

async function toolHover(args: Record<string, unknown>): Promise<TextResult> {
  const state = getWorkspace(args.root);
  const absPath = normalizePath(state, args.path);
  const client = await getReadyClientForFile(state, absPath);
  if (!client) return toolText(state.manager.getUnavailableReason(absPath), true);
  const { position, resolvedFrom } = await resolvePositionArgs(state, absPath, args);
  const hover = await requestWithTimeout<Hover | null>(client, "textDocument/hover", {
    textDocument: { uri: pathToFileURL(absPath).toString() },
    position,
  });
  return toolText(`${resolvedFrom}${truncate(hoverToText(hover), 80, 12_000)}`);
}

const tools = [
  {
    name: "status",
    description: "Show LSP server status for a workspace root.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string", description: "Workspace root. Defaults to configured Activix root." } },
    },
    handler: toolStatus,
  },
  {
    name: "warmup",
    description: "Start one or more language servers for a workspace root and wait briefly until ready.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        languages: { type: "array", items: { type: "string" }, description: "Language IDs, e.g. php, typescript, vue." },
      },
    },
    handler: toolWarmup,
  },
  {
    name: "diagnostics",
    description: "Get diagnostics for a file or cached workspace diagnostics with path='*'. Opens the file first so the LSP publishes diagnostics.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { root: { type: "string" }, path: { type: "string" } },
    },
    handler: toolDiagnostics,
  },
  {
    name: "symbols",
    description: "List document symbols for a file, or search workspace symbols by query. Uses LSP with tree-sitter fallback.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string", description: "File path for document symbols." },
        query: { type: "string", description: "Workspace symbol query." },
        language: { type: "string", description: "Language server to use for workspace query. Defaults to php." },
      },
    },
    handler: toolSymbols,
  },
  {
    name: "overview",
    description: "Tree-sitter file overview: classes/functions/methods without starting LSP. Good fast first read.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { root: { type: "string" }, path: { type: "string" } },
    },
    handler: toolOverview,
  },
  {
    name: "activix_inspect",
    description: "Activix CRM structural inspect: detect Lucid Feature/Operation/Job, model/API touchpoints, inbound references, and likely tests.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string", description: "Target file path. Preferred when known." },
        query: { type: "string", description: "Fallback filename/class query when path is unknown." },
        limit: { type: "number", description: "Max inbound reference hints. Defaults to 20." },
      },
    },
    handler: toolActivixInspect,
  },
  {
    name: "activix_blast_radius",
    description: "Activix CRM blast-radius helper: rank directly related files and focused checks for a target file or symbol.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        path: { type: "string", description: "Target file path. Preferred when known." },
        query: { type: "string", description: "Fallback filename/class query when path is unknown." },
        limit: { type: "number", description: "Max files/checks to return. Defaults to 80." },
      },
    },
    handler: toolActivixBlastRadius,
  },
  {
    name: "definition",
    description: "Go to definition for a position or symbol query in a file. Read-only.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        root: { type: "string" }, path: { type: "string" }, line: { type: "number" }, character: { type: "number" }, query: { type: "string" },
      },
    },
    handler: toolDefinition,
  },
  {
    name: "references",
    description: "Find references for a position or symbol query in a file. Read-only.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        root: { type: "string" }, path: { type: "string" }, line: { type: "number" }, character: { type: "number" }, query: { type: "string" }, includeDeclaration: { type: "boolean" }, limit: { type: "number" },
      },
    },
    handler: toolReferences,
  },
  {
    name: "hover",
    description: "Get hover/type info for a position or symbol query in a file. Read-only.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        root: { type: "string" }, path: { type: "string" }, line: { type: "number" }, character: { type: "number" }, query: { type: "string" },
      },
    },
    handler: toolHover,
  },
];

const server = new Server(
  { name: "activix-lsp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
  const tool = tools.find((candidate) => candidate.name === request.params.name);
  if (!tool) return toolText(`Unknown tool: ${request.params.name}`, true);
  try {
    return await withTimeout(
      tool.handler((request.params.arguments ?? {}) as Record<string, unknown>),
      TOOL_TIMEOUT_MS,
      `${tool.name} tool`,
    );
  } catch (err: any) {
    return toolText(err?.message ?? String(err), true);
  }
}) as any);

process.on("SIGINT", async () => {
  for (const state of workspaces.values()) {
    await state.manager.shutdownAll().catch(() => {});
    state.treeSitter.shutdown();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  for (const state of workspaces.values()) {
    await state.manager.shutdownAll().catch(() => {});
    state.treeSitter.shutdown();
  }
  process.exit(0);
});

await server.connect(new StdioServerTransport());
