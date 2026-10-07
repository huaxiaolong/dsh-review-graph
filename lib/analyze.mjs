#!/usr/bin/env node
/**
 * review-graph analyzer — standalone CLI.
 *
 * Thin wrapper around ./analyze-core.mjs: it owns the filesystem walk and the
 * stdin/stdout contract, so the core can stay pure and be reused by the DSH
 * Host plugin (../index.js) with `ctx.fs` reads.
 *
 * Usage:
 *   node analyze.mjs <workspaceRoot> [changedFile ...]
 *   node analyze.mjs <workspaceRoot> < changed-files.json
 *   node analyze.mjs --selftest
 *
 * Output: one JSON document on stdout.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyze,
  makeResolver,
  normalizeRel,
  SOURCE_EXT,
  IGNORED_DIRS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "./analyze-core.mjs";

/**
 * Recursively collect indexable source files under a root.
 * @param root Absolute workspace root.
 * @returns absolute paths, the byte total, and whether a cap was hit.
 */
export function walk(root) {
  const files = [];
  const stack = [root];
  let totalBytes = 0;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXT.has(extnameOf(entry.name))) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      let size;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      if (totalBytes + size > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += size;
      files.push(full);
    }
    if (truncated) break;
  }
  return { files, truncated, totalBytes };
}

function extnameOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

/**
 * Index a workspace synchronously and analyze it.
 * @param root Absolute workspace root.
 * @param changed Changed file paths.
 * @returns the graph document.
 */
export function analyzeWorkspace(root, changed) {
  const scan = walk(root);
  const contents = new Map();
  const rels = [];
  for (const abs of scan.files) {
    const rel = normalizeRel(relative(root, abs));
    rels.push(rel);
    try {
      contents.set(rel, readFileSync(abs, "utf8"));
    } catch {
      /* unreadable or binary: indexed as a node without edges */
    }
  }
  const graph = analyze({ root, changed, files: rels, contents });
  graph.scan.truncated = scan.truncated;
  graph.scan.bytesRead = scan.totalBytes;
  if (scan.truncated) {
    graph.warnings.push("workspace scan hit its size cap; some files were not indexed");
  }
  return graph;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function selftest() {
  const r = makeResolver(new Set(["a/b.ts", "a/c/index.ts", "a/d.py", "src/core/parser.ts"]));
  const cases = [
    [r("a/x.ts", "./b"), "a/b.ts"],
    [r("a/x.ts", "./c"), "a/c/index.ts"],
    [r("a/x.ts", "../a/d"), "a/d.py"],
    [r("src/core/store.ts", "./parser"), "src/core/parser.ts"],
    [r("a/x.ts", "react"), null],
  ];
  for (const [got, want] of cases) {
    if (got !== want) {
      process.stderr.write(`selftest failed: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}\n`);
      process.exit(1);
    }
  }
  process.stdout.write("selftest ok\n");
}

// Path-safe entrypoint check: file:// URL interpolation breaks on spaces and
// on Windows drive letters, which this app's install path contains.
const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntrypoint) {
  if (process.argv[2] === "--selftest") {
    selftest();
  } else {
    const root = resolve(process.argv[2] ?? process.cwd());
    let changed = process.argv.slice(3);
    if (changed.length === 0) {
      const stdin = readStdin().trim();
      if (stdin.length > 0) {
        try {
          const parsed = JSON.parse(stdin);
          if (Array.isArray(parsed)) changed = parsed.map(String);
        } catch {
          changed = stdin.split("\n").map((s) => s.trim()).filter(Boolean);
        }
      }
    }
    process.stdout.write(JSON.stringify(analyzeWorkspace(root, changed)));
  }
}
