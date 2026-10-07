/**
 * review-graph analyzer core.
 *
 * A zero-dependency, deterministic relationship analyzer over a set of source
 * files. Given the workspace root, the files to index, their contents, and the
 * set of changed files, it reports:
 *
 *   1. which changed files reference each other (imports + symbol references),
 *      so a reviewer can see connected clusters vs. truly isolated files;
 *   2. which changed files export symbols, and what those reach, so a flow view
 *      can be drawn from real syntax rather than guessed line numbers.
 *
 * The core is pure and synchronous: file access and the recursive walk belong
 * to the caller, so the same algorithm serves the CLI ({@link ../analyze.mjs})
 * and the DSH Host plugin (`../index.js`, which reads through `ctx.fs`).
 */


/**
 * POSIX directory portion of a workspace-relative path.
 *
 * `node:path` is unavailable in the browser build that inlines this module, and
 * the analyzer only ever deals in `/`-separated workspace-relative paths, so a
 * local implementation is both sufficient and portable.
 * @param path path to take the directory of
 * @returns the directory, or an empty string at the root
 */
export function dirname(path) {
  const value = String(path).replace(/\\/g, "/");
  const index = value.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return value.slice(0, index);
}

/**
 * Join path segments with `/`, dropping empty and `.` segments.
 * @param parts segments to join
 * @returns the joined path
 */
export function join(...parts) {
  const out = [];
  for (const part of parts) {
    for (const segment of String(part).replace(/\\/g, "/").split("/")) {
      if (segment === "" || segment === ".") continue;
      out.push(segment);
    }
  }
  return out.join("/");
}

/**
 * Lower-cased extension of a path. Implemented here rather than imported from
 * `node:path` because the browser build inlines this module verbatim and has
 * no Node builtins available.
 * @param path file path or bare name
 * @returns the extension including the dot, or an empty string
 */
export function extname(path) {
  const value = String(path);
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const dot = value.lastIndexOf(".");
  return dot > slash ? value.slice(dot).toLowerCase() : "";
}

export const SOURCE_EXT = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".scala",
  ".vue", ".svelte", ".sql", ".sh",
]);

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  "out", "target", ".next", ".nuxt", ".turbo", ".cache", "coverage",
  ".idea", ".vscode", ".dsh", "vendor", "Pods", ".gradle", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", "site-packages", ".terraform", ".tox",
]);

export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_REFS_PER_FILE = 400;

/* --------------------------------------------------------------- imports */

const JS_IMPORT_RE = [
  /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const PY_IMPORT_RE = [/^\s*from\s+([.\w]+)\s+import\s+/gm, /^\s*import\s+([.\w]+)/gm];
const RUST_IMPORT_RE = [/\bmod\s+([a-z_]\w*)\s*;/g, /\buse\s+crate::([a-z_][\w:]*)/g];
const JAVA_IMPORT_RE = [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm];
const C_INCLUDE_RE = [/^\s*#\s*include\s*["<]([^">]+)[">]/gm];
const RUBY_IMPORT_RE = [/\brequire(?:_relative)?\s*['"]([^'"]+)['"]/g];
const PHP_USE_RE = [/\buse\s+([\w\\]+)/g];

const JS_LIKE = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);

function importSpecsFor(file, text) {
  const ext = extname(file);
  const specs = [];
  const push = (raw) => {
    if (typeof raw === "string" && raw.length > 0) specs.push(raw);
  };
  const run = (list, source) => {
    for (const re of list) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(source)) !== null) push(m[1]);
    }
  };

  if (JS_LIKE.has(ext)) run(JS_IMPORT_RE, text);
  else if (ext === ".py") run(PY_IMPORT_RE, text);
  else if (ext === ".go") {
    const block = text.match(/import\s*\(([\s\S]*?)\)/);
    if (block !== null) {
      for (const m of block[1].matchAll(/"([^"]+)"/g)) push(m[1]);
    }
    const single = text.match(/import\s+(?:[\w.]+\s+)?"([^"]+)"/);
    if (single !== null) push(single[1]);
  } else if (ext === ".rs") run(RUST_IMPORT_RE, text);
  else if ([".java", ".kt", ".kts", ".scala"].includes(ext)) run(JAVA_IMPORT_RE, text);
  else if ([".c", ".h", ".cc", ".cpp", ".hpp"].includes(ext)) run(C_INCLUDE_RE, text);
  else if (ext === ".rb") run(RUBY_IMPORT_RE, text);
  else if (ext === ".php") {
    run(PHP_USE_RE, text);
    for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g)) push(m[1]);
  }
  return specs;
}

/* ------------------------------------------------------------- resolution */

const RESOLVE_SUFFIXES = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".vue", ".svelte",
  ".c", ".h", ".cc", ".cpp", ".hpp",
];

const INDEX_NAMES = [
  "index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs",
  "__init__.py", "mod.rs", "index.vue", "index.svelte",
];

export function normalizeRel(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

export function makeResolver(fileSet) {
  return function resolveSpec(fromRel, raw) {
    if (typeof raw !== "string" || raw.length === 0) return null;

    const fromExt = extname(fromRel);
    const isRelative = raw.startsWith(".");
    const isAbsoluteSpec = raw.startsWith("/");
    const isInclude = [".c", ".h", ".cc", ".cpp", ".hpp"].includes(fromExt);
    const isPyRelative = fromExt === ".py" && /^\.+/.test(raw);

    const candidates = [];
    if (isRelative || isPyRelative || isAbsoluteSpec || isInclude) {
      const baseDir = dirname(fromRel);
      if (isPyRelative) {
        const dots = raw.match(/^\.+/)[0].length;
        const rest = raw.slice(dots).replace(/\./g, "/");
        candidates.push(normalizeRel(join(baseDir, ...Array(dots).fill(".."), rest)));
      } else if (isAbsoluteSpec) {
        candidates.push(normalizeRel(raw));
      } else {
        candidates.push(normalizeRel(join(baseDir, raw)));
      }
    } else {
      // Bare specifier: workspace-root relative, or a dotted/qualified name.
      candidates.push(normalizeRel(raw.replace(/[.:]/g, "/")));
      candidates.push(normalizeRel(raw));
    }

    for (const candidate of candidates) {
      const hit = probe(candidate);
      if (hit !== null) return hit;
    }
    return null;

    function probe(candidate) {
      if (candidate === "" || candidate.startsWith("..")) return null;
      for (const suffix of RESOLVE_SUFFIXES) {
        if (fileSet.has(candidate + suffix)) return candidate + suffix;
      }
      for (const index of INDEX_NAMES) {
        const key = normalizeRel(join(candidate, index));
        if (fileSet.has(key)) return key;
      }
      return null;
    }
  };
}

/* ---------------------------------------------------------------- symbols */

const KEYWORDS = new Set([
  "if", "else", "for", "while", "return", "function", "class", "const", "let",
  "var", "new", "typeof", "instanceof", "in", "of", "do", "switch", "case",
  "break", "continue", "try", "catch", "finally", "throw", "await", "async",
  "yield", "import", "export", "default", "from", "this", "super", "true",
  "false", "null", "undefined", "void", "delete", "and", "or", "not", "is",
  "def", "self", "elif", "except", "with", "as", "lambda", "pass", "raise",
  "global", "nonlocal", "assert", "del", "print", "int", "str", "float",
  "bool", "list", "dict", "set", "tuple", "len", "range", "type", "func",
  "package", "struct", "interface", "map", "chan", "go", "defer", "select",
  "range", "fn", "mut", "impl", "trait", "pub", "use", "match", "where",
  "mod", "crate", "static", "unsafe", "dyn", "ref", "public", "private",
  "protected", "final", "abstract", "synchronized", "extends", "implements",
  "throws", "val", "fun", "object", "when", "override", "open", "data",
  "sealed", "init", "string", "number", "boolean", "any", "unknown", "never",
  "Promise", "Array", "Object", "Math", "JSON", "console", "window",
  "document", "process", "require", "module", "exports", "React", "props",
  "state", "render", "constructor",
]);

export function exportsFor(file, text) {
  const ext = extname(file);
  const out = [];
  const seen = new Set();
  const add = (name, line) => {
    if (typeof name !== "string" || name.length < 2) return;
    if (KEYWORDS.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push({ name, line, kind: "function" });
  };
  const lineOf = (index) => text.slice(0, index).split("\n").length;

  const patterns = [];
  if (JS_LIKE.has(ext)) {
    patterns.push(
      /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
      /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
    );
  } else if (ext === ".py") {
    patterns.push(/^\s*def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm);
  } else if (ext === ".go") {
    patterns.push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)\s+struct/gm);
  } else if (ext === ".rs") {
    patterns.push(/\bfn\s+([a-z_]\w*)/g, /\bstruct\s+([A-Z]\w*)/g, /\benum\s+([A-Z]\w*)/g);
  } else if ([".java", ".kt", ".kts", ".cs", ".scala", ".swift", ".php", ".rb"].includes(ext)) {
    patterns.push(
      /\b(?:public|private|protected|internal|open|static|final)\s+[\w<>[\],?\s]*?([A-Za-z_]\w*)\s*\(/g,
      /\b(?:fun|function|def)\s+([A-Za-z_]\w*)/g,
    );
  }

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) add(m[1], lineOf(m.index));
  }
  return out.slice(0, 120);
}

/* ---------------------------------------------------------------- analyze */

/**
 * Build the review graph.
 * @param options.root Absolute workspace root.
 * @param options.changed Changed file paths (absolute or root-relative).
 * @param options.readFile (absPath) => string | undefined — supplied by the caller
 *   so the same algorithm serves the CLI and the host plugin.
 * @param options.listFiles (root) => absolute paths — defaults to a recursive walk.
 * @returns the graph document.
 */
export function analyze({ root, changed = [], files, contents, now = () => new Date() }) {
  const rels = files === undefined ? [] : [...files].map(normalizeRel).filter((r) => r !== "");
  const fileSet = new Set(rels);

  const texts = new Map();
  const exportsByFile = new Map();
  for (const rel of rels) {
    const text = contents === undefined ? undefined : contents.get(rel);
    if (typeof text === "string") {
      texts.set(rel, text);
      exportsByFile.set(rel, exportsFor(rel, text));
    } else {
      exportsByFile.set(rel, []);
    }
  }

  const resolveSpec = makeResolver(fileSet);

  // Edge aggregation: one edge per (from, to) pair, with every observed kind.
  const pairs = new Map();
  const addEdge = (from, to, kind, line) => {
    if (from === to) return;
    const key = from + "\u0000" + to;
    const existing = pairs.get(key);
    if (existing === undefined) {
      pairs.set(key, { from, to, kinds: [kind], count: 1, lines: line === undefined ? [] : [line] });
      return;
    }
    existing.count += 1;
    if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
    if (line !== undefined && existing.lines.length < 12) existing.lines.push(line);
  };

  const lineOfIn = (text, index) => text.slice(0, index).split("\n").length;

  // Pass 1 — import edges, and the identifier set each file contributes.
  const tokensByFile = new Map();
  for (const [rel, text] of texts) {
    for (const raw of importSpecsFor(rel, text)) {
      const hit = resolveSpec(rel, raw);
      if (hit !== null) addEdge(rel, hit, "import");
    }
    const tokens = new Set();
    for (const item of exportsByFile.get(rel) ?? []) tokens.add(item.name);
    for (const m of text.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) {
      const tok = m[0];
      if (KEYWORDS.has(tok)) continue;
      tokens.add(tok);
      if (tokens.size > MAX_REFS_PER_FILE) break;
    }
    tokensByFile.set(rel, tokens);
  }

  // Pass 2 — cross-file symbol references (a file that names another file's
  // exported symbol is treated as referencing it, unless an import edge exists).
  const symbolOwners = new Map();
  for (const [rel, exported] of exportsByFile) {
    for (const item of exported) {
      const list = symbolOwners.get(item.name);
      if (list === undefined) symbolOwners.set(item.name, [rel]);
      else if (list.length < 24) list.push(rel);
    }
  }

  for (const [rel, tokens] of tokensByFile) {
    const text = texts.get(rel) ?? "";
    const owners = new Set();
    for (const token of tokens) {
      const found = symbolOwners.get(token);
      if (found === undefined) continue;
      for (const owner of found) if (owner !== rel) owners.add(owner);
      if (owners.size > 60) break;
    }
    for (const owner of owners) {
      if (pairs.has(rel + "\u0000" + owner)) continue;
      const stem = owner.split("/").pop().replace(/\.[a-z]+$/i, "");
      const idx = stem.length > 2 ? text.indexOf(stem) : -1;
      addEdge(rel, owner, "reference", idx >= 0 ? lineOfIn(text, idx) : undefined);
    }
  }

  // Match the requested changed paths against the indexed tree.
  const focus = new Set();
  const changedResolved = [];
  for (const raw of changed) {
    const normalized = normalizeRel(raw);
    if (normalized === "") continue;
    let key = fileSet.has(normalized) ? normalized : null;
    if (key === null) {
      let best = null;
      for (const candidate of fileSet) {
        if (candidate === normalized || candidate.endsWith("/" + normalized)) {
          if (best === null || candidate.length < best.length) best = candidate;
        }
      }
      key = best;
    }
    if (key !== null && !focus.has(key)) {
      focus.add(key);
      changedResolved.push(key);
    }
  }
  const scope = focus.size > 0 ? focus : fileSet;
  const changedFileSet = focus.size > 0 ? focus : new Set();

  const allPairs = [...pairs.values()];

  // Connectivity over the changed files only — the independence signal.
  const adjacency = new Map();
  for (const f of scope) adjacency.set(f, new Set());
  for (const e of allPairs) {
    if (scope.has(e.from) && scope.has(e.to)) {
      adjacency.get(e.from).add(e.to);
      adjacency.get(e.to).add(e.from);
    }
  }
  const componentOf = new Map();
  let componentCount = 0;
  for (const f of scope) {
    if (componentOf.has(f)) continue;
    const id = componentCount++;
    const queue = [f];
    componentOf.set(f, id);
    while (queue.length > 0) {
      const cur = queue.pop();
      for (const next of adjacency.get(cur) ?? []) {
        if (componentOf.has(next)) continue;
        componentOf.set(next, id);
        queue.push(next);
      }
    }
  }

  // Render the changed set plus its one-hop neighbourhood.
  const include = new Set(scope);
  for (const e of allPairs) {
    if (scope.has(e.from)) include.add(e.to);
    if (scope.has(e.to)) include.add(e.from);
  }

  const edgeRows = allPairs
    .filter((e) => include.has(e.from) && include.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      kinds: e.kinds,
      kind: e.kinds[0],
      count: e.count,
      lines: e.lines,
      changedPair: changedFileSet.has(e.from) && changedFileSet.has(e.to),
      withinComponent:
        componentOf.has(e.from) && componentOf.has(e.to) &&
        componentOf.get(e.from) === componentOf.get(e.to),
    }))
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  const degree = new Map();
  const inboundFromChanged = new Map();
  for (const e of edgeRows) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (changedFileSet.has(e.from)) {
      inboundFromChanged.set(e.to, (inboundFromChanged.get(e.to) ?? 0) + 1);
    }
  }

  const nodes = [...include]
    .map((rel) => ({
      id: rel,
      label: rel.split("/").pop(),
      dir: dirname(rel) === "." ? "" : dirname(rel),
      changed: changedFileSet.has(rel),
      component: componentOf.has(rel) ? componentOf.get(rel) : null,
      degree: degree.get(rel) ?? 0,
      inbound: inboundFromChanged.get(rel) ?? 0,
      exports: (exportsByFile.get(rel) ?? []).slice(0, 24),
    }))
    .sort((a, b) => Number(b.changed) - Number(a.changed) || a.id.localeCompare(b.id));

  const components = [];
  for (let i = 0; i < componentCount; i += 1) {
    const members = [...scope].filter((f) => componentOf.get(f) === i).sort();
    const memberSet = new Set(members);
    components.push({
      id: i,
      files: members,
      internalEdges: edgeRows.filter((e) => memberSet.has(e.from) && memberSet.has(e.to)).length,
    });
  }
  components.sort((a, b) => b.files.length - a.files.length || a.id - b.id);

  // Flow view: symbol-level nodes for changed files plus one hop of callees.
  const flowNodes = [];
  const flowEdges = [];
  const flowSeen = new Set();
  const flowEdgeSeen = new Set();

  const pushFlowNode = (rel, item, isChanged) => {
    const id = rel + "#" + item.name;
    if (flowSeen.has(id)) return null;
    flowSeen.add(id);
    flowNodes.push({
      id,
      label: item.name,
      file: rel,
      line: item.line,
      startLine: item.line,
      endLine: item.line,
      kind: item.kind,
      changed: isChanged,
    });
    return id;
  };

  const calleesOf = new Map();
  for (const e of allPairs) {
    if (!changedFileSet.has(e.from) && !changedFileSet.has(e.to)) continue;
    const list = calleesOf.get(e.from);
    if (list === undefined) calleesOf.set(e.from, [e.to]);
    else if (!list.includes(e.to)) list.push(e.to);
  }

  for (const rel of scope) {
    for (const item of (exportsByFile.get(rel) ?? []).slice(0, 12)) {
      const fromId = pushFlowNode(rel, item, true);
      if (fromId === null) continue;
      for (const target of (calleesOf.get(rel) ?? []).slice(0, 8)) {
        for (const callee of (exportsByFile.get(target) ?? []).slice(0, 6)) {
          const toId = pushFlowNode(target, callee, changedFileSet.has(target));
          if (toId === null) continue;
          const edgeKey = fromId + "\u0000" + toId;
          if (flowEdgeSeen.has(edgeKey)) continue;
          flowEdgeSeen.add(edgeKey);
          flowEdges.push({ from: fromId, to: toId, kind: "call" });
        }
      }
    }
  }

  const warnings = [];
  if (focus.size > 0 && changedResolved.length < changed.length) {
    warnings.push(
      changed.length - changedResolved.length +
        " requested path(s) were not found in the indexed tree"
    );
  }

  return {
    version: 1,
    root,
    builtAt: now().toISOString(),
    scan: { filesIndexed: rels.length, truncated: false },
    change: {
      changedFiles: changedResolved,
      changedCount: changedResolved.length,
      componentCount,
      isolatedFiles: components.filter((c) => c.files.length === 1).map((c) => c.files[0]),
      unresolved: changed.length - changedResolved.length,
    },
    components,
    nodes,
    edges: edgeRows,
    flow: { nodes: flowNodes, edges: flowEdges },
    warnings,
  };
}

function shadowedAll(scope, symbolOwners, tokensByFile) {
  if (symbolOwners.size === 0) return false;
  for (const rel of scope) if ((tokensByFile.get(rel) ?? new Set()).size > 0) return false;
  return true;
}
