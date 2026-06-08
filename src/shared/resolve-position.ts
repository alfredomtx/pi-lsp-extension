/**
 * Shared position resolver — resolves a symbol name to a file position.
 *
 * Used by position-based tools (hover, definition, references, rename, completions)
 * to allow the LLM to pass a symbol name instead of exact line/character.
 */

import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { extractSymbols, type SymbolInfo } from "../tree-sitter/symbol-extractor.js";
import { getLanguageIdFromPath } from "./language-map.js";
import { readFile } from "node:fs/promises";

export interface ResolvedPosition {
  line: number;       // 1-indexed (tool convention)
  character: number;  // 1-indexed
  symbolName: string;
  source: "lsp" | "tree-sitter" | "text";
}

type DocumentSymbolResponse = DocumentSymbol[] | SymbolInformation[] | null;
type Source = ResolvedPosition["source"];

interface SymbolCandidate {
  name: string;
  line: number;      // 1-indexed
  character: number; // 1-indexed
  parent?: string;
  path: string;
}

interface ParsedQuery {
  raw: string;
  symbol: string;
  parent?: string;
}

/**
 * Resolve a symbol name to a position in a file.
 *
 * Priority:
 * 1. LSP document symbols with ranked matching
 * 2. Exact identifier text match, useful for type/use-site queries like "Account"
 * 3. Tree-sitter symbol extraction
 */
export async function resolveSymbolPosition(
  filePath: string,
  query: string,
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): Promise<ResolvedPosition | null> {
  const parsed = parseQuery(query);

  // Try LSP document symbols first
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        const match = findInDocumentSymbols(symbols, parsed);
        if (match) return match;
      }
    } catch { /* fall through to text/tree-sitter */ }
  }

  const absPath = manager.resolvePath(filePath);
  let content: string | null = null;
  try {
    content = await readFile(absPath, "utf-8");
    const exactText = findExactIdentifierInText(content, parsed.symbol);
    if (exactText) return exactText;
  } catch { /* fall through */ }

  // Try tree-sitter fallback
  if (treeSitter) {
    try {
      content ??= await readFile(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          const match = findInSymbolInfos(symbols, parsed);
          if (match) return match;
        }
      }
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Get top-level symbol names from a file (for error hints).
 */
export async function getSymbolNames(
  filePath: string,
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): Promise<string[]> {
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        if ("selectionRange" in symbols[0]) {
          return (symbols as DocumentSymbol[]).map(s => s.name);
        }
        return (symbols as SymbolInformation[]).map(s => s.name);
      }
    } catch { /* fall through */ }
  }

  if (treeSitter) {
    try {
      const absPath = manager.resolvePath(filePath);
      const content = await readFile(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          return symbols.map(s => s.name);
        }
      }
    } catch { /* fall through */ }
  }

  return [];
}

function parseQuery(query: string): ParsedQuery {
  const raw = query.trim();
  for (const separator of ["::", "->", "."]) {
    const index = raw.lastIndexOf(separator);
    if (index > 0) {
      return {
        raw,
        parent: raw.slice(0, index).trim(),
        symbol: raw.slice(index + separator.length).trim(),
      };
    }
  }
  return { raw, symbol: raw };
}

// --- LSP DocumentSymbol matching ---

function findInDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
  query: ParsedQuery,
): ResolvedPosition | null {
  if (symbols.length === 0) return null;

  // Check if these are DocumentSymbol (hierarchical) or SymbolInformation (flat)
  if ("selectionRange" in symbols[0]) {
    return findInHierarchicalSymbols(symbols as DocumentSymbol[], query);
  }
  return findInFlatSymbols(symbols as SymbolInformation[], query);
}

function findInHierarchicalSymbols(
  symbols: DocumentSymbol[],
  query: ParsedQuery,
): ResolvedPosition | null {
  const candidates = flattenDocumentSymbols(symbols);
  return matchCandidates(candidates, query, "lsp");
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  parents: string[] = [],
): SymbolCandidate[] {
  const result: SymbolCandidate[] = [];
  for (const sym of symbols) {
    const path = [...parents, sym.name].join(".");
    result.push({
      name: sym.name,
      line: sym.selectionRange.start.line + 1,
      character: sym.selectionRange.start.character + 1,
      parent: parents[parents.length - 1],
      path,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, [...parents, sym.name]));
    }
  }
  return result;
}

function findInFlatSymbols(
  symbols: SymbolInformation[],
  query: ParsedQuery,
): ResolvedPosition | null {
  const candidates: SymbolCandidate[] = symbols.map(sym => ({
    name: sym.name,
    line: sym.location.range.start.line + 1,
    character: sym.location.range.start.character + 1,
    parent: sym.containerName ?? undefined,
    path: [sym.containerName, sym.name].filter(Boolean).join("."),
  }));
  return matchCandidates(candidates, query, "lsp");
}

// --- Tree-sitter SymbolInfo matching ---

function findInSymbolInfos(
  symbols: SymbolInfo[],
  query: ParsedQuery,
): ResolvedPosition | null {
  const candidates = flattenSymbolInfos(symbols);
  return matchCandidates(candidates, query, "tree-sitter");
}

function flattenSymbolInfos(
  symbols: SymbolInfo[],
  parents: string[] = [],
): SymbolCandidate[] {
  const result: SymbolCandidate[] = [];
  for (const sym of symbols) {
    const path = [...parents, sym.name].join(".");
    result.push({
      name: sym.name,
      line: sym.line,
      character: 1, // tree-sitter symbols don't have column precision for the name
      parent: parents[parents.length - 1],
      path,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenSymbolInfos(sym.children, [...parents, sym.name]));
    }
  }
  return result;
}

// --- Shared matching logic ---

function matchCandidates(
  candidates: SymbolCandidate[],
  query: ParsedQuery,
  source: Source,
): ResolvedPosition | null {
  const scoped = query.parent
    ? candidates.filter(candidate => parentMatches(candidate, query.parent!))
    : candidates;

  return matchByPriority(scoped, query.symbol, source)
    ?? (scoped === candidates ? null : matchByPriority(candidates, query.symbol, source));
}

function parentMatches(candidate: SymbolCandidate, parent: string): boolean {
  const normalizedParent = normalizeName(parent);
  return normalizeName(candidate.parent ?? "") === normalizedParent
    || normalizeQualified(candidate.path).startsWith(`${normalizeQualified(parent)}.`);
}

function matchByPriority(
  candidates: SymbolCandidate[],
  query: string,
  source: Source,
): ResolvedPosition | null {
  const normalizedQuery = normalizeName(query);
  const queryHasUppercase = /[A-Z]/.test(query);

  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(candidate, query, normalizedQuery, queryHasUppercase) }))
    .filter(entry => entry.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.index - b.index);

  const best = ranked[0]?.candidate;
  if (!best) return null;
  return { line: best.line, character: best.character, symbolName: best.name, source };
}

function scoreCandidate(candidate: SymbolCandidate, query: string, normalizedQuery: string, queryHasUppercase: boolean): number {
  const name = candidate.name;
  const normalizedName = normalizeName(name);
  const qualifiedName = normalizeQualified(candidate.path);
  const normalizedQualifiedQuery = normalizeQualified(query);

  if (name === query) return 0;
  if (normalizedName === normalizedQuery && !queryHasUppercase) return 10;
  if (qualifiedName === normalizedQualifiedQuery) return 15;
  if (!queryHasUppercase && normalizedName.startsWith(normalizedQuery) && normalizedQuery.length >= 3) return 30;
  if (!queryHasUppercase && normalizedName.includes(normalizedQuery) && normalizedQuery.length >= 3) return 50;

  return Number.POSITIVE_INFINITY;
}

function normalizeName(value: string): string {
  return value.trim().replace(/^[$#]+/, "").toLowerCase();
}

function normalizeQualified(value: string): string {
  return value
    .trim()
    .replace(/::|->/g, ".")
    .split(".")
    .map(part => normalizeName(part))
    .filter(Boolean)
    .join(".");
}

function findExactIdentifierInText(content: string, query: string): ResolvedPosition | null {
  if (!query || !/^[A-Za-z_$][\w$]*$/.test(query)) return null;
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(query)}(?![A-Za-z0-9_$])`, "g");
  const match = pattern.exec(content);
  if (!match) return null;

  const before = content.slice(0, match.index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const character = match.index - lastNewline;
  return { line, character, symbolName: query, source: "text" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
