import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ActivixInspectArgs {
  path?: unknown;
  query?: unknown;
  limit?: unknown;
}

interface TargetFile {
  absPath: string;
  relPath: string;
  content: string;
}

interface ReferenceHit {
  file: string;
  line: number;
  text: string;
}

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hermes",
  ".idea",
  ".vscode",
  "bootstrap/cache",
  "node_modules",
  "storage",
  "vendor",
]);

const SCANNED_EXTENSIONS = new Set([".php", ".vue", ".ts", ".js"]);

export async function inspectLucid(root: string, args: ActivixInspectArgs): Promise<string> {
  const target = await resolveTarget(root, args);
  const info = inspectTarget(root, target);
  const className = info.className ?? stripExtension(basename(target.absPath));
  const references = await findReferences(root, className, target.relPath, numericLimit(args.limit, 20));

  const sections = [
    `Target: ${target.relPath}`,
    `Kind: ${info.kind}`,
    info.className ? `Class: ${info.className}` : undefined,
    info.namespace ? `Namespace: ${info.namespace}` : undefined,
    "",
    section("Lucid/structural patterns", info.patterns),
    section("Outbound dependencies", info.dependencies),
    section("Model/API touchpoints", info.touchpoints),
    section("Likely tests", likelyTests(target.relPath, className)),
    section("Inbound references", references.map(hit => `${hit.file}:${hit.line} ${hit.text}`)),
  ].filter((value): value is string => value !== undefined);

  return sections.join("\n");
}

export async function blastRadius(root: string, args: ActivixInspectArgs): Promise<string> {
  const target = await resolveTarget(root, args);
  const info = inspectTarget(root, target);
  const className = info.className ?? stripExtension(basename(target.absPath));
  const references = await findReferences(root, className, target.relPath, numericLimit(args.limit, 50));
  const tests = likelyTests(target.relPath, className);
  const directFiles = unique([
    ...info.dependencies.map(dependencyFile).filter(Boolean),
    ...references.map(hit => hit.file),
    ...tests,
  ]).slice(0, numericLimit(args.limit, 80));

  const risk = riskLevel(target.relPath, references.length, info.dependencies.length);
  const lines = [
    `Target: ${target.relPath}`,
    `Risk: ${risk}`,
    `Primary symbol: ${className}`,
    "",
    section("Why", blastReasons(target.relPath, info, references.length)),
    section("Direct blast-radius files", directFiles),
    section("Suggested focused checks", suggestedChecks(target.relPath, tests)),
  ];

  return lines.join("\n");
}

async function resolveTarget(root: string, args: ActivixInspectArgs): Promise<TargetFile> {
  const pathArg = stringArg(args.path);
  if (pathArg) {
    const absPath = isAbsolute(pathArg) ? pathArg : resolve(root, pathArg.replace(/^@/, ""));
    const content = await readFile(absPath, "utf8");
    return { absPath, relPath: relative(root, absPath), content };
  }

  const query = stringArg(args.query);
  if (!query) throw new Error("Provide path or query.");

  const files = await collectScannableFiles(root, 7000);
  const queryLower = query.toLowerCase();
  const exactBasename = files.find(file => stripExtension(basename(file)).toLowerCase() === queryLower);
  const preferred = exactBasename
    ?? files.find(file => file.toLowerCase().endsWith(`/${queryLower}.php`))
    ?? files.find(file => basename(file).toLowerCase().includes(queryLower));

  if (!preferred) throw new Error(`No file found for query "${query}".`);
  const absPath = resolve(root, preferred);
  const content = await readFile(absPath, "utf8");
  return { absPath, relPath: preferred, content };
}

function inspectTarget(root: string, target: TargetFile) {
  if (target.relPath.endsWith(".php")) return inspectPhp(root, target);
  return inspectFrontend(target);
}

function inspectPhp(root: string, target: TargetFile) {
  const namespace = firstMatch(target.content, /^namespace\s+([^;]+);/m);
  const className = firstMatch(target.content, /\b(?:final\s+|abstract\s+)?class\s+(\w+)/)
    ?? firstMatch(target.content, /\binterface\s+(\w+)/)
    ?? firstMatch(target.content, /\btrait\s+(\w+)/)
    ?? firstMatch(target.content, /\benum\s+(\w+)/);
  const kind = phpKind(target.relPath, target.content);
  const imports = [...target.content.matchAll(/^use\s+([^;]+);/gm)].map(match => match[1].trim());
  const runCalls = [...target.content.matchAll(/(?:->run|::run|run)\s*\(\s*([A-Z][\w\\]+)::class/g)].map(match => match[1]);
  const constructed = [...target.content.matchAll(/new\s+([A-Z][\w\\]+)/g)].map(match => match[1]);
  const modelTouchpoints = imports.filter(value => value.includes("Data\\Models"));
  const requests = imports.filter(value => value.includes("Http\\Requests") || value.includes("Requests\\"));
  const dependencies = unique([...runCalls, ...constructed, ...imports])
    .slice(0, 80)
    .map(dep => ({ label: dep, file: guessPhpFile(dep) }))
    .map(dep => dep.file ? `${dep.label} -> ${dep.file}` : dep.label);

  const patterns = [
    kind !== "PHP file" ? `Lucid kind: ${kind}` : undefined,
    runCalls.length ? `Runs jobs/operations: ${runCalls.length}` : undefined,
    requests.length ? `Request validation imports: ${requests.length}` : undefined,
    modelTouchpoints.length ? `Model imports: ${modelTouchpoints.length}` : undefined,
    /DB::|->query\(|::query\(/.test(target.content) ? "Direct query builder/Eloquent query usage" : undefined,
    /dispatch\(|::dispatch/.test(target.content) ? "Dispatches async job/event" : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    kind,
    className,
    namespace,
    patterns,
    dependencies,
    touchpoints: unique([...modelTouchpoints, ...requests]),
  };
}

function inspectFrontend(target: TargetFile) {
  const className = stripExtension(basename(target.absPath));
  const imports = [...target.content.matchAll(/^import\s+.*?from\s+["']([^"']+)["'];?/gm)].map(match => match[1]);
  const apiCalls = [...target.content.matchAll(/\$api\.([A-Za-z0-9_.]+)/g)].map(match => `$api.${match[1]}`);
  const hooks = [...target.content.matchAll(/\b(use[A-Z][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1]);
  const stores = [...target.content.matchAll(/\b(use[A-Z][A-Za-z0-9_]*Store)\s*\(/g)].map(match => match[1]);

  return {
    kind: frontendKind(target.relPath),
    className,
    namespace: undefined,
    patterns: [
      target.relPath.endsWith(".vue") ? "Vue single-file component" : undefined,
      hooks.length ? `Composition hooks: ${unique(hooks).join(", ")}` : undefined,
      stores.length ? `Pinia stores: ${unique(stores).join(", ")}` : undefined,
      apiCalls.length ? `API calls: ${unique(apiCalls).join(", ")}` : undefined,
    ].filter((value): value is string => Boolean(value)),
    dependencies: unique(imports),
    touchpoints: unique([...apiCalls, ...hooks, ...stores]),
  };
}

async function findReferences(root: string, symbol: string, excludeRelPath: string, limit: number): Promise<ReferenceHit[]> {
  if (!symbol || symbol.length < 3) return [];
  const files = await collectScannableFiles(root, 7000);
  const hits: ReferenceHit[] = [];
  const symbolPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);

  for (const relPath of files) {
    if (relPath === excludeRelPath) continue;
    const absPath = resolve(root, relPath);
    let content = "";
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }
    if (!symbolPattern.test(content)) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!symbolPattern.test(lines[index])) continue;
      hits.push({ file: relPath, line: index + 1, text: lines[index].trim().slice(0, 180) });
      break;
    }
    if (hits.length >= limit) break;
  }

  return hits;
}

async function collectScannableFiles(root: string, maxFiles: number): Promise<string[]> {
  const result: string[] = [];
  await walk(root, root, result, maxFiles);
  return result;
}

async function walk(root: string, dir: string, result: string[], maxFiles: number): Promise<void> {
  if (result.length >= maxFiles) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    const absPath = join(dir, entry.name);
    const relPath = relative(root, absPath);
    if (entry.isDirectory()) {
      if (shouldSkipDir(relPath)) continue;
      await walk(root, absPath, result, maxFiles);
      continue;
    }
    if (!entry.isFile() || !SCANNED_EXTENSIONS.has(extname(entry.name))) continue;
    result.push(relPath);
  }
}

function shouldSkipDir(relPath: string): boolean {
  const normalized = relPath.split("/").join("/");
  return [...EXCLUDED_DIRS].some(excluded => normalized === excluded || normalized.startsWith(`${excluded}/`));
}

function phpKind(relPath: string, content: string): string {
  if (relPath.includes("/Features/")) return "Lucid Feature";
  if (relPath.includes("/Operations/")) return "Lucid Operation";
  if (relPath.includes("/Jobs/")) return "Lucid Job";
  if (/extends\s+Feature\b/.test(content)) return "Lucid Feature";
  if (/extends\s+Operation\b/.test(content)) return "Lucid Operation";
  if (/extends\s+Job\b/.test(content)) return "Lucid Job";
  if (relPath.startsWith("tests/")) return "PHP test";
  if (relPath.includes("/Data/Models/")) return "Eloquent model";
  if (relPath.includes("/Http/Requests/")) return "Form request";
  return "PHP file";
}

function frontendKind(relPath: string): string {
  if (relPath.endsWith(".vue")) return "Vue component";
  if (relPath.includes("/__tests__/") || relPath.endsWith(".test.ts")) return "Frontend test";
  if (relPath.includes("/hooks/")) return "Vue composable";
  if (relPath.includes("/store/")) return "Frontend store";
  if (relPath.includes("/api/")) return "Frontend API module";
  return "Frontend file";
}

function guessPhpFile(classRef: string): string | undefined {
  const clean = classRef.replace(/^\\+/, "").replace(/::class$/, "");
  if (!clean.includes("\\")) return undefined;
  const relPath = `${clean.replace(/^App\\/, "app\\").replace(/\\/g, "/")}.php`;
  return relPath;
}

function dependencyFile(dependency: string): string {
  return dependency.includes(" -> ") ? dependency.split(" -> ").at(-1) ?? "" : "";
}

function likelyTests(relPath: string, className: string): string[] {
  const tests = [`tests/**/*${className}*Test.php`, `frontend/src/**/__tests__/*${className}*.test.ts`];
  if (relPath.startsWith("app/")) {
    tests.unshift(relPath.replace(/^app\//, "tests/").replace(/\.php$/, "Test.php"));
  }
  if (relPath.startsWith("frontend/src/")) {
    const dir = dirname(relPath);
    tests.unshift(`${dir}/__tests__/${className}.test.ts`);
  }
  return unique(tests);
}

function suggestedChecks(relPath: string, tests: string[]): string[] {
  const checks: string[] = [];
  if (relPath.endsWith(".php")) {
    checks.push(...tests.filter(test => test.endsWith(".php")).map(test => `./activix test ${test}`));
    checks.push("./activix composer check-style");
  }
  if (relPath.startsWith("frontend/") || relPath.endsWith(".vue") || relPath.endsWith(".ts")) {
    checks.push(...tests.filter(test => test.endsWith(".ts")).map(test => `cd frontend && npx vitest run ${test.replace(/^frontend\//, "")}`));
    checks.push("cd frontend && npm run lint && npm run format:check");
  }
  return unique(checks).slice(0, 12);
}

function blastReasons(relPath: string, info: ReturnType<typeof inspectTarget>, referenceCount: number): string[] {
  return [
    `${info.kind} in ${relPath}`,
    `${info.dependencies.length} outbound dependency hint(s)`,
    `${referenceCount} inbound reference hint(s)`,
    info.touchpoints.length ? `${info.touchpoints.length} model/API touchpoint(s)` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function riskLevel(relPath: string, references: number, dependencies: number): string {
  if (relPath.includes("/Features/") || relPath.includes("/Operations/") || references > 25 || dependencies > 25) return "medium-high";
  if (references > 10 || dependencies > 10) return "medium";
  return "low-medium";
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return `${title}: none found`;
  return `${title}:\n${lines.map(line => `- ${line}`).join("\n")}`;
}

function firstMatch(content: string, pattern: RegExp): string | undefined {
  return pattern.exec(content)?.[1];
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(200, value)) : fallback;
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
