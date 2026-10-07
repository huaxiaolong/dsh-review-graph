#!/usr/bin/env node
/**
 * Inline lib/analyze-core.mjs into the client bundle.
 *
 * The Client module is loaded by the Web UI's module loader as a plain script
 * (`window.__ModuleLoader__.load({ factory(require) { ... } })`), so it cannot
 * use ESM imports. Rather than maintain a second copy of the analyzer, this
 * script pastes the core's function declarations into `client.js` between the
 * markers `/* @review-graph:core:start *​/` and `/* @review-graph:core:end *​/`.
 *
 * Run after editing analyze-core.mjs:   node build-client.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = join(here, "lib", "analyze-core.mjs");
const CLIENT = join(here, "client.js");

const START = "/* @review-graph:core:start */";
const END = "/* @review-graph:core:end */";

const core = readFileSync(CORE, "utf8");

// Keep only what the browser actually needs: the constants, the pure helpers,
// and analyze(). Drop the module header and any export keyword (the inlined
// text shares one function scope inside the client factory).
let body = core;
// Start at the first declaration the browser needs. Keep this as early as
// possible: anything the core declares before it (helpers) must be inlined too.
const firstDecl = body.search(/^export (const|function) /m);
if (firstDecl < 0) throw new Error("analyze-core.mjs: no exported declarations found");
body = body.slice(firstDecl);
body = body.replace(/\bexport (const|function) /g, "$1 ");
body = body.trimEnd();

// Indent to sit inside the factory.
body = body
  .split("\n")
  .map((line) => (line.trim() === "" ? "" : "      " + line))
  .join("\n");

const client = readFileSync(CLIENT, "utf8");
const start = client.indexOf(START);
const end = client.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  throw new Error("client.js: core markers are missing or out of order");
}

const next =
  client.slice(0, start + START.length) +
  "\n" +
  body +
  "\n      " +
  client.slice(end);

writeFileSync(CLIENT, next);
process.stdout.write(
  `inlined ${body.split("\n").length} lines of analyze-core into client.js\n`
);
