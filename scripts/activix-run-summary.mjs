#!/usr/bin/env node
/**
 * Run an Activix command, save the full log, and print a compact failure-focused summary.
 *
 * Usage:
 *   npm run activix:run -- ./activix test tests/Feature/FooTest.php
 *   node scripts/activix-run-summary.mjs -- npm run check
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { EOL } from "node:os";

const args = process.argv.slice(2);
const commandIndex = args[0] === "--" ? 1 : 0;
const command = args[commandIndex];
const commandArgs = args.slice(commandIndex + 1);

if (!command) {
  console.error("Usage: node scripts/activix-run-summary.mjs -- <command> [...args]");
  process.exit(2);
}

const cwd = process.cwd();
const logDir = resolve(cwd, ".activix", "logs");
mkdirSync(logDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const safeName = basename(command).replace(/[^A-Za-z0-9_.-]/g, "_");
const logPath = join(logDir, `activix-${timestamp}-${safeName}.log`);
const log = createWriteStream(logPath, { encoding: "utf8" });
const exactCommand = [command, ...commandArgs].map(shellQuote).join(" ");

log.write(`$ ${exactCommand}${EOL}`);
log.write(`cwd: ${cwd}${EOL}${EOL}`);

const child = spawn(command, commandArgs, {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

const retainedChunks = [];
let retainedBytes = 0;
const retainedLimit = 2_000_000;

child.stdout.on("data", chunk => capture("stdout", chunk));
child.stderr.on("data", chunk => capture("stderr", chunk));
child.on("error", error => {
  log.write(`${EOL}[spawn error] ${error.stack ?? error.message}${EOL}`);
  log.end();
  console.error(`Command failed to start: ${error.message}`);
  console.error(`Log: ${logPath}`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  log.write(`${EOL}exit_code: ${code ?? "null"}${signal ? ` signal: ${signal}` : ""}${EOL}`);
  log.end();
  const output = retainedChunks.join("");
  const summary = summarize(output, code ?? 0, signal);
  console.log(`Command: ${exactCommand}`);
  console.log(`Exit: ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
  console.log(`Log: ${logPath}`);
  console.log("");
  console.log(summary);
  process.exit(code ?? (signal ? 128 : 1));
});

function capture(streamName, chunk) {
  log.write(chunk);
  const text = chunk.toString("utf8");
  if (retainedBytes < retainedLimit) {
    retainedChunks.push(text);
    retainedBytes += Buffer.byteLength(text);
  }
  if (process.env.ACTIVIX_RUN_SUMMARY_PASSTHROUGH === "1") {
    process[streamName].write(chunk);
  }
}

function summarize(output, exitCode, signal) {
  const lines = output.split(/\r?\n/);
  const failingTests = extractUnique(lines, [
    /^\s*FAILED\s+(.+)$/,
    /^\s*FAIL\s+(.+)$/,
    /^\s*FAILED\s+Tests\\(.+)$/,
    /^\s*⨯\s+(.+)$/,
  ], 20);
  const stackFrames = extractUnique(lines, [
    /^\s*#\d+\s+(.+)$/,
    /^\s*at\s+(.+)$/,
    /^\s*(?:Error|TypeError|ReferenceError|RuntimeException|Exception|Illuminate\\[^:]+):\s+(.+)$/,
  ], 30);
  const usefulErrors = extractUnique(lines, [
    /(?:error|failed|failure|exception|fatal|timeout|timed out|segmentation fault|cannot find|not found|undefined|invalid)/i,
  ], 40);
  const tail = lines.slice(-35).filter(Boolean);

  const blocks = [];
  if (exitCode === 0 && !signal) {
    blocks.push("Status: passed");
  } else {
    blocks.push("Status: failed");
  }
  blocks.push(section("Failing tests", failingTests));
  blocks.push(section("Top errors", usefulErrors));
  blocks.push(section("Stack frames", stackFrames));
  blocks.push(section("Tail", tail));
  return blocks.join("\n\n");
}

function extractUnique(lines, patterns, limit) {
  const out = [];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const value = (match.length > 1 ? match[1] : line).trim();
      if (value && !out.includes(value)) out.push(value.slice(0, 260));
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

function section(title, lines) {
  if (!lines.length) return `${title}: none`;
  return `${title}:\n${lines.map(line => `- ${line}`).join("\n")}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
