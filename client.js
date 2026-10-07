/*
 * review-graph — Client half.
 *
 * Registers a middle-column view tab (beside Conversation / Trajectory) that
 * renders the current turn's change set as a relationship graph:
 *
 *   - which changed files reference each other, and which are isolated
 *   - which changed file carries the most influence (inbound edges)
 *   - a symbol-level flow view derived from real exports
 *
 * Clicking a node opens that file in the right Sidebar preview at the exact
 * line, using the product's own `dsh-resource://file/...` address with the
 * `{ line }` parameter the built-in text preview already understands.
 *
 * Everything is computed in the browser from two product surfaces:
 *   - GET /api/changes.summary  → this turn's changed files
 *   - ctx.remote.workspaceFiles → directory listings and file contents
 *
 * The analyzer core between the @review-graph:core markers is inlined from
 * lib/analyze-core.mjs by build-client.mjs. Do not edit it here.
 */
/**
 * This file's own directory, captured while the script is still executing.
 *
 * The vendored Prism bundle sits beside this file and is fetched by URL: a
 * profile-installed plugin cannot `require('prismjs')`, and inlining 576KB of
 * grammars into the boot bundle would tax every session for a feature one tab
 * uses.
 */
const REVIEW_GRAPH_BASE = (() => {
  try {
    const script = document.currentScript;
    return script !== null && typeof script.src === 'string' && script.src !== ''
      ? script.src.replace(/[^/]*$/, '')
      : null;
  } catch {
    return null;
  }
})();

window.__ModuleLoader__.load({
  id: 'dsh-review-graph',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    /* @review-graph:core:start */
      function dirname(path) {
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
      function join(...parts) {
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
      function extname(path) {
        const value = String(path);
        const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
        const dot = value.lastIndexOf(".");
        return dot > slash ? value.slice(dot).toLowerCase() : "";
      }

      const SOURCE_EXT = new Set([
        ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
        ".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php",
        ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".scala",
        ".vue", ".svelte", ".sql", ".sh",
      ]);

      const IGNORED_DIRS = new Set([
        ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
        "out", "target", ".next", ".nuxt", ".turbo", ".cache", "coverage",
        ".idea", ".vscode", ".dsh", "vendor", "Pods", ".gradle", ".mypy_cache",
        ".pytest_cache", ".ruff_cache", "site-packages", ".terraform", ".tox",
      ]);

      const MAX_FILES = 5000;
      const MAX_FILE_BYTES = 512 * 1024;
      const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
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

      function normalizeRel(p) {
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

      function makeResolver(fileSet) {
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

      function exportsFor(file, text) {
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
      function analyze({ root, changed = [], files, contents, now = () => new Date() }) {
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
      /* @review-graph:core:end */

    /* ----------------------------------------------------------- constants */

    const CHANGED_FILES_PATH = '/api/changes.summary';
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    const NODE_W = 156;
    const NODE_H = 34;
    /**
     * How many references the overview draws at once.
     *
     * Not a hard limit: the view says how many it left out and offers to draw
     * them, so a dense change set is readable first and complete on request.
     */
    const EDGE_BUDGET = 600;
    /**
     * Two panels the reader asked to hide, kept behind a flag rather than
     * deleted: the right-hand column of hints and file rows, and the bottom
     * panel that lists a node's members. Both are dense text over a picture that
     * is meant to be read at a glance. Flip either to `true` to bring it back.
     */
    const SHOW_SIDE_PANEL = false;
    const SHOW_NODE_DETAIL = false;
    const COL_GAP = 84;
    const ROW_GAP = 16;
    const BAND_GAP = 46;
    const MARGIN = 28;

    const VIEW_ID = 'review-graph';
    const NS = 'review-graph';

    const COPY = {
      zh: {
        view: '变更关系图',
        overview: '总览图',
        zenOn: '收起工具栏，把高度让给图',
        zenOff: '展开工具栏',
        nodeIsolated: '黄色：本次改动里没有任何引用关系的文件',
        nodeConnected: (count) => `与其他改动文件有 ${count} 条引用关系`,
        refresh: '重新分析',
        analyzing: '正在分析工作区…',
        reading: (done, total) => `读取文件 ${done}/${total}`,
        empty: '这一轮没有改动文件。',
        noSession: '当前会话没有工作目录。',
        noChanges: '没有读取到变更清单（需要 workspaceChanges 插件）。',
        changed: '已改动',
        neighbour: '关联',
        isolated: '独立',
        isolatedTitle: '独立改动',
        isolatedHint: '这些改动文件与本次其它改动没有任何引用关系，说明它们是彼此独立的一件事。',
        clustersTitle: '关联簇',
        clustersHint: '同一簇内的改动文件互相引用，应作为一个整体审阅。',
        influenceTitle: '影响面',
        influenceHint: '被最多改动文件引用的文件；改这里最容易波及别处。',
        stats: (n, c, iso) => `${n} 个改动文件 · ${c} 个关联簇 · ${iso} 个独立`,
        legend: '图例',
        edges: (i, r) => `import ${i} · 引用 ${r}`,
        open: '在右侧栏打开',
        openAt: (line) => `打开并定位到第 ${line} 行`,
        copyPath: '复制路径',
        copied: '已复制',
        scopeAll: '全部已改动',
        scopeTurn: (turn) => `第 ${turn} 轮`,
        sourceTitle: '变更来源',
        sourceTurn: '上一轮（对话）',
        sourceUnstaged: '未暂存',
        sourceStaged: '已暂存',
        sourceUncommitted: '未提交',
        sourceCommit: '已提交',
        sourceBranch: '分支对比',
        statusAdded: '新增',
        statusModified: '修改',
        statusDeleted: '删除',
        statusRenamed: '重命名',
        statusCopied: '复制',
        statusType: '类型变更',
        statusUntracked: '未跟踪',
        pickCommit: '选择提交…',
        baseTitle: '对比基准',
        noCommits: (base) => `与 ${base} 没有差异，没有可选的提交。`,
        noBase: '（没有其他分支可作为对比基准）',
        reviewTitle: '变更审查',
        reviewOpenFile: '在文件中打开',
        reviewNoDiff: '这个文件在该变更来源下没有文本差异。',
        reviewBinary: '二进制文件，无法按文本比对。',
        reviewOversized: '文件超出内联比对的上限。',
        reviewCoarse: '差异过大，已退化为整文件替换。',
        reviewLoading: '正在读取差异…',
        reviewFailed: (message) => `读取差异失败：${message}`,
        reviewNoHunks: '这个文件只改了模式或路径，没有行级差异。',
        reviewNoNewline: '文件末尾没有换行',
        reviewLineOutsideDiff: (from, to) =>
          `第 ${from}${to > from ? `–${to}` : ''} 行不在本差异的上下文里，已定位到最近的改动块`,
        fit: '适应窗口',
        fitTitle: '把整张图缩放到可见范围',
        edgesHidden: (hidden, total) => `已按强度隐藏 ${hidden} 条弱引用（共 ${total} 条）`,
        edgesShowAll: '显示全部引用',
        reviewFiles: (n) => `${n} 个文件`,
        reviewPrev: '上一个文件',
        reviewNext: '下一个文件',
        reviewPick: '变更文件',
        aiTab: '业务流程（AI）',
        aiIntroTitle: '用模型把这次变更翻译成业务流程',
        aiIntroBody:
          '会调用当前会话的模型做一次推理，**消耗 token**。它会把这次变更拆成若干块受影响的业务，每块给出改动前 / 改动后的流程，并标注依据的文件与行，可直接跳到审查界面。',
        aiContext: (files, bytes, talk, output) =>
          `上下文：${files} 个文件的变更片段（约 ${bytes}，不截断）` +
          (talk > 0 ? ` + 对话摘要（${talk} 条消息）` : '') +
          (output > 0 ? ` · 输出上限 ${output} tok` : ''),
        aiNoTalk: '（这段会话还没读到可用于推理的消息）',
        aiModel: (name) => `模型：${name}`,
        aiModelUnknown: '模型：未从会话读到，将使用默认 provider',
        aiNoModel: '还没有确定用哪个模型：请确认对话区已选择模型，或稍后重试（计划加载完成后即可）。',
        aiGenerate: '生成',
        aiGenerating: '正在推理…（会消耗 token）',
        aiRebuild: '重新生成',
        aiCached: '缓存结果',
        aiNoAdapters: '这个 profile 没有挂模型适配器，无法生成。',
        aiPickFlow: '受影响业务',
        aiBefore: '原版流程',
        aiAfter: '改动后',
        aiEmptySide: '（这一侧没有可展示的步骤）',
        aiNoAnchor: '这个节点没有给出文件，已打开该来源的审查面板。',
        aiNoAnchorNode: '模型没有为这个步骤标注文件，点击会打开该来源的审查面板',
        noOpenResource: '当前没有可用的侧栏打开方式（openResource 不可用）。',
        aiLow: '低置信',
        aiGeneratedAt: (time) => `生成于 ${time}`,
        aiCacheHit: '缓存命中，直接加载，不花 token',
        aiCacheDisk: 'Host 上有这次变更的缓存（重启后也能恢复）',
        aiCacheNone: 'Host 上没有这次变更的缓存，生成会花 token',
        aiLastFailure: (code) =>
          code === 'REASONING_BUDGET'
            ? '上次失败：这个模型把整个输出预算都花在推理上（加大预算也没用，它会全部用掉）。请在上面的模型下拉里换一个不做长推理的模型。'
            : `上次失败：${code}`, 
        aiCacheMemory: '本次页面已生成，切页签不丢（刷新后需重新加载）',
        aiStale: '已过期',
        aiStaleHead: 'HEAD 已经变了（分支上有新提交），这是上一次的结果',
        aiStaleContext: '对话摘要变了，这是上一次的结果',
        aiStaleBoth: 'HEAD 与对话摘要都变了，这是上一次的结果',
        aiStaleKeep: '仍可参考；要不要重新生成由你决定。',
        aiRecord: '记入对话（调试）',
        aiRecordHint:
          '打开后这次生成会把**你的请求**（例如「生成流程图解释所有变更的代码」）加一行出处信息写进会话——不含代码、prompt 正文或回答，它也会进入后续每轮的模型上下文（多花 token）。',
        aiInstruction: '生成流程图解释所有变更的代码',
        aiDebug: '查看发送内容与原始回答',
        aiDebugHint: '只在这个面板里显示，不写进对话、不花 token。',
        aiDebugSystem: 'System prompt',
        aiDebugUser: '发给模型的用户消息',
        aiDebugRaw: '模型原始回答',
        aiEffort: '推理强度',
        aiEffortDefault: '默认（跟随 provider）',
        aiEffortUnknown: '默认（该 provider 不公布档位）',
        aiRecorded: '已记入对话',
        aiRecordFailed: (why) => `未记入对话：${why}`,
        aiNeedScope: '先在上面的「变更来源」里选一个 git 来源（未暂存 / 已暂存 / 未提交 / 已提交 / 分支对比）——AI 需要它作为上下文；轮次来源没有对应的 git 材料。',
        pickBranch: '选择分支…',
        gitHead: (branch) => `分支 ${branch}`,
        noRepo: '（当前目录不在 git 仓库里）',
        emptyScope: '这个变更来源没有改动。',
        emptyUnresolved: (n) => `有 ${n} 个变更文件不在可分析集合里（非源码文件也会列在图中，若仍未出现请反馈）。`,
        gitUnavailable: '（git 来源不可用）',
        truncated: '工作区超出索引上限，部分文件未分析。',
        unresolved: (n) => `${n} 个改动路径不在索引内（可能是新增/删除文件）。`,
        zoomReset: '重置视图',
        collapse: '收起详情',
        error: '分析失败',
        retry: '重试',
      },
      en: {
        view: 'Change graph',
        overview: 'Overview',
        zenOn: 'Hide the toolbar and give its height to the picture',
        zenOff: 'Show the toolbar',
        nodeIsolated: 'Yellow: nothing in this change refers to it or from it',
        nodeConnected: (count) => `${count} reference links with other changed files`,
        refresh: 'Re-analyze',
        analyzing: 'Analyzing workspace…',
        reading: (done, total) => `Reading files ${done}/${total}`,
        empty: 'No files changed in this turn.',
        noSession: 'This session has no working directory.',
        noChanges: 'No change list available (the workspaceChanges plugin is required).',
        changed: 'Changed',
        neighbour: 'Related',
        isolated: 'Isolated',
        isolatedTitle: 'Isolated changes',
        isolatedHint: 'These changed files reference nothing else in this change set — they are independent pieces of work.',
        clustersTitle: 'Clusters',
        clustersHint: 'Changed files in one cluster reference each other and belong in one review pass.',
        influenceTitle: 'Blast radius',
        influenceHint: 'Files referenced by the most changed files; edits here ripple the furthest.',
        stats: (n, c, iso) => `${n} changed · ${c} clusters · ${iso} isolated`,
        legend: 'Legend',
        edges: (i, r) => `import ${i} · ref ${r}`,
        open: 'Open in Sidebar',
        openAt: (line) => `Open at line ${line}`,
        copyPath: 'Copy path',
        copied: 'Copied',
        scopeAll: 'All changed',
        scopeTurn: (turn) => `Turn ${turn}`,
        sourceTitle: 'Change source',
        sourceTurn: 'Last turn (chat)',
        sourceUnstaged: 'Unstaged',
        sourceStaged: 'Staged',
        sourceUncommitted: 'Uncommitted',
        sourceCommit: 'Committed',
        sourceBranch: 'Against a branch',
        statusAdded: 'added',
        statusModified: 'modified',
        statusDeleted: 'deleted',
        statusRenamed: 'renamed',
        statusCopied: 'copied',
        statusType: 'type',
        statusUntracked: 'untracked',
        pickCommit: 'Pick a commit…',
        baseTitle: 'Compare against',
        noCommits: (base) => `No commits differ from ${base}.`,
        noBase: '(no other branch to compare against)',
        reviewTitle: 'Review',
        reviewOpenFile: 'Open in file',
        reviewNoDiff: 'This file has no textual difference in this change source.',
        reviewBinary: 'Binary file, no text comparison.',
        reviewOversized: 'The file is past the inline comparison limit.',
        reviewCoarse: 'The difference is large; it degraded to a whole-file replacement.',
        reviewLoading: 'Reading the difference…',
        reviewFailed: (message) => `Could not read the difference: ${message}`,
        reviewNoHunks: 'Only the mode or the path changed; there are no line differences.',
        reviewNoNewline: 'no newline at end of file',
        reviewLineOutsideDiff: (from, to) =>
          `Line ${from}${to > from ? `–${to}` : ''} is outside this diff's context; the nearest change block is marked`,
        fit: 'Fit',
        fitTitle: 'Scale the whole graph into view',
        edgesHidden: (hidden, total) => `${hidden} weak references hidden of ${total}`,
        edgesShowAll: 'Draw all references',
        reviewFiles: (n) => `${n} file(s)`,
        reviewPrev: 'Previous file',
        reviewNext: 'Next file',
        reviewPick: 'Changed files',
        aiTab: 'Business flow (AI)',
        aiIntroTitle: 'Ask the model what business processes this change touches',
        aiIntroBody:
          'Calls the session model once and **costs tokens**. It splits the change into the business processes it affects, gives each one before and after the change, and names the files and lines it used so a node can open the review pane.',
        aiContext: (files, bytes, talk, output) =>
          `Context: the excerpts of ${files} files (about ${bytes}, uncut)` +
          (talk > 0 ? ` + a conversation digest (${talk} messages)` : '') +
          (output > 0 ? ` · output limit ${output} tok` : ''),
        aiNoTalk: '(this session holds no messages to reason from yet)',
        aiModel: (name) => `Model: ${name}`,
        aiModelUnknown: 'Model: not read from this session; the default provider will be used',
        aiNoModel: 'No model is known yet. Check that the conversation has one selected, or try again in a moment.',
        aiGenerate: 'Generate',
        aiGenerating: 'Thinking… (this spends tokens)',
        aiRebuild: 'Regenerate',
        aiCached: 'cached',
        aiNoAdapters: 'This profile mounts no model adapter, so this cannot run.',
        aiPickFlow: 'Affected processes',
        aiBefore: 'Before',
        aiAfter: 'After',
        aiEmptySide: '(nothing to show on this side)',
        aiNoAnchor: 'This step names no file, so the source\'s review was opened instead.',
        aiNoAnchorNode: 'The model anchored no file to this step; clicking opens the source review',
        noOpenResource: 'No sidebar face is available to open this in (openResource is missing).',
        aiLow: 'low confidence',
        aiGeneratedAt: (time) => `generated ${time}`,
        aiCacheHit: 'Cache hit: loaded without spending tokens',
        aiCacheDisk: 'The Host holds this change set (it survives a restart)',
        aiCacheNone: 'The Host holds nothing for this change set: generating spends tokens',
        aiLastFailure: (code) =>
          code === 'REASONING_BUDGET'
            ? 'The last attempt failed because this model spent its whole output budget on reasoning (a larger budget would not help — it uses all of it). Pick a model above that does not think out loud.'
            : `The last attempt failed: ${code}`,
        aiCacheMemory: 'Generated in this page; a view switch keeps it, a reload does not',
        aiStale: 'Out of date',
        aiStaleHead: 'HEAD moved on (the branch has new commits); this is the previous result',
        aiStaleContext: 'The conversation digest changed; this is the previous result',
        aiStaleBoth: 'HEAD and the conversation digest both moved; this is the previous result',
        aiStaleKeep: 'Still readable — regenerating is your call.',
        aiRecord: 'Record in the conversation (debug)',
        aiRecordHint:
          'Writes this generation\'s **request** (the instruction you asked for) plus one line of provenance into the session — no code, no prompt body, no answer. It still joins the model context of every later turn (more tokens).',
        aiInstruction: 'Explain the changed code with a business-flow diagram',
        aiDebug: 'Inspect what was sent and what came back',
        aiDebugHint: 'Shown in this panel only; nothing is written to the conversation and nothing is spent.',
        aiDebugSystem: 'System prompt',
        aiDebugUser: 'User message sent to the model',
        aiDebugRaw: 'Raw model answer',
        aiEffort: 'Reasoning effort',
        aiEffortDefault: 'Default (follows the provider)',
        aiEffortUnknown: 'Default (this provider names none)',
        aiRecorded: 'Recorded in the conversation',
        aiRecordFailed: (why) => `Not recorded: ${why}`,
        aiNeedScope: 'Pick a git change source above (unstaged / staged / uncommitted / committed / against a branch) — the AI needs one as context; a turn has no git material of its own.',
        pickBranch: 'Pick a branch…',
        gitHead: (branch) => `on ${branch}`,
        noRepo: '(not a git repository)',
        emptyScope: 'This change source has no changes.',
        emptyUnresolved: (n) => `${n} changed file(s) are outside the analysable set.`,
        gitUnavailable: '(git sources unavailable)',
        truncated: 'Workspace exceeded the index cap; some files were skipped.',
        unresolved: (n) => `${n} changed path(s) are not in the index (added or deleted files).`,
        zoomReset: 'Reset view',
        collapse: 'Hide details',
        error: 'Analysis failed',
        retry: 'Retry',
      },
    };

    /* --------------------------------------------------------------- utils */

    function normalizeRelPath(path) {
      const out = [];
      for (const seg of String(path).replace(/\\/g, '/').split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
          else out.push('..');
          continue;
        }
        out.push(seg);
      }
      return out.join('/');
    }

    function encodePath(path) {
      return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    }

    /** The product's Sidebar address for one workspace-relative file. */
    function sessionFileAddress(sessionId, relativePath) {
      const normalized = normalizeRelPath(relativePath);
      return (
        FILE_ADDRESS_PREFIX +
        'session/' +
        encodeURIComponent(sessionId) +
        '/' +
        encodePath(normalized)
      );
    }

    function isSourcePath(path) {
      return SOURCE_EXT.has(extnameOf(path));
    }

    function extnameOf(path) {
      if (typeof path !== 'string') return '';
      const slash = path.lastIndexOf('/');
      const dot = path.lastIndexOf('.');
      return dot > slash ? path.slice(dot).toLowerCase() : '';
    }

    function isIgnoredDir(name) {
      return name.startsWith('.') || IGNORED_DIRS.has(name);
    }

    /* ------------------------------------------------------------- fetching */

    async function fetchSummary(sessionId, seq, signal) {
      const url =
        CHANGED_FILES_PATH +
        '?' +
        new URLSearchParams({ sessionId, seq: String(seq) }).toString();
      const response = await fetch(url, { signal });
      if (!response.ok) return null;
      const value = await response.json();
      if (
        value === null ||
        typeof value !== 'object' ||
        !Array.isArray(value.files)
      ) {
        return null;
      }
      return value;
    }

    /* --------------------------------------------------------- review pane */

    const REVIEW_KIND = 'review-graph';
    /** The product's own turn-review address; only a turn can be opened there. */
    const CHANGES_REVIEW_ADDRESS = 'dsh-resource://changes-review/session/';
    const REVIEW_ADDRESS = 'dsh-resource://review-graph/session/';
    const DIFF_PATH = '/api/review-graph.diff';
    const FILES_PATH = '/api/review-graph.files';
    const FLOW_PATH = '/api/review-graph.flow';

    /**
     * Generations kept across view switches.
     *
     * The middle column unmounts an inactive view, so component state would be
     * lost the moment the user looks elsewhere — the request itself is not
     * cancelled, only its result dropped. This store lives with the plugin
     * (one page load), and a page reload still recovers for free from the
     * Host's own cache.
     */
    const flowClientCache = new Map();

    /** A short stable digest, so the same material maps to the same entry. */
    function flowKeyOf(parts) {
      const text = parts.filter((part) => typeof part === 'string').join('\u0000');
      let hash = 0x811c9dc5;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, '0');
    }
    /** The product's own turn comparison, reused when the source is a turn. */
    const PRODUCT_DIFF_PATH = '/api/changes.diff';

    /**
     * The Sidebar address of a review: one file, or — with no path — the whole
     * change source, which the pane walks file by file.
     */
    function reviewAddress(sessionId, path) {
      const base = REVIEW_ADDRESS + encodeURIComponent(sessionId);
      return path === undefined || path === null || path === ''
        ? base
        : `${base}/${encodePath(normalizeRelPath(path))}`;
    }

    /** Read a review address back, or undefined when it is not one. */
    function parseReviewAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(REVIEW_ADDRESS)) return undefined;
      const rest = address.slice(REVIEW_ADDRESS.length);
      const slash = rest.indexOf('/');
      try {
        if (slash < 0) {
          const only = decodeURIComponent(rest);
          return only === '' ? undefined : { sessionId: only, path: null };
        }
        const sessionId = decodeURIComponent(rest.slice(0, slash));
        const path = rest
          .slice(slash + 1)
          .split('/')
          .map((segment) => decodeURIComponent(segment))
          .join('/');
        if (sessionId === '' || path === '') return undefined;
        return { sessionId, path };
      } catch {
        return undefined;
      }
    }

    /** Move through a change set by one file, wrapping at both ends. */
    function stepFile(files, current, delta) {
      if (!Array.isArray(files) || files.length === 0) return current;
      const index = files.findIndex((file) => file.path === current);
      if (index < 0) return files[0].path;
      return files[(index + delta + files.length) % files.length].path;
    }

    /** The tab type claiming this plugin's review addresses. */
    function reviewDefinition(titleOf) {
      return {
        id: REVIEW_KIND,
        kind: REVIEW_KIND,
        patterns: [`${REVIEW_ADDRESS}**`],
        canOpen: (address) => parseReviewAddress(address) !== undefined,
        title: (address) => {
          const parsed = parseReviewAddress(address);
          if (parsed === undefined) return address;
          // The scope address carries no file (`path` is null): naming it after
          // a path would throw here, inside the registry's own claim, which is
          // how a click turned into a fallback to the plain text preview.
          if (typeof parsed.path !== 'string' || parsed.path === '') {
            return titleOf('reviewTitle');
          }
          const slash = parsed.path.lastIndexOf('/');
          return `${titleOf('reviewTitle')}: ${slash < 0 ? parsed.path : parsed.path.slice(slash + 1)}`;
        },
      };
    }

    /**
     * Convert the product's turn comparison into the line shape this pane draws.
     *
     * `/api/changes.diff` hands back hunk lines as `+…`/`-…`/` …` strings and
     * refuses with `binary` or `oversized`; normalizing it here keeps one
     * renderer for both the turn source and the git sources.
     */
    function adaptProductDiff(value) {
      if (value === null || typeof value !== 'object') return null;
      if (value.kind === 'binary') return { binary: true, additions: 0, deletions: 0, hunks: [] };
      if (value.kind !== 'text') {
        return { binary: false, oversized: true, additions: 0, deletions: 0, hunks: [] };
      }
      const hunks = [];
      let additions = 0;
      let deletions = 0;
      for (const source of value.hunks ?? []) {
        let oldLine = source.oldStart;
        let newLine = source.newStart;
        const lines = [];
        for (const raw of source.lines ?? []) {
          const marker = typeof raw === 'string' ? raw[0] : ' ';
          const text = typeof raw === 'string' ? raw.slice(1) : '';
          if (marker === '+') {
            lines.push({ kind: 'add', text, newLine });
            newLine += 1;
            additions += 1;
          } else if (marker === '-') {
            lines.push({ kind: 'del', text, oldLine });
            oldLine += 1;
            deletions += 1;
          } else {
            lines.push({ kind: 'ctx', text, oldLine, newLine });
            oldLine += 1;
            newLine += 1;
          }
        }
        hunks.push({
          header: '',
          oldStart: source.oldStart,
          oldLines: source.oldLines,
          newStart: source.newStart,
          newLines: source.newLines,
          lines,
        });
      }
      return { binary: false, additions, deletions, hunks, coarse: value.coarse === true };
    }

    /** Flow-diagram geometry, and the one layout the diagrams are drawn from. */
    const FLOW_NODE_W = 190;
    const FLOW_NODE_H = 46;
    const FLOW_H_GAP = 26;
    const FLOW_V_GAP = 36;

    /**
     * Lay one side of a flow out top-down, the way a reviewer draws it.
     *
     * Longest-path layering from the roots: every node sits one layer below the
     * deepest node that leads to it, a layer centres its nodes, and an edge may
     * span layers so a branch can merge again. Pure, so the self-checks drive it.
     * @param side `{ nodes, edges }` from a validated document
     * @returns `{ width, height, nodes, edges }` with a position per node
     */
    function layoutFlow(side) {
      const nodes = Array.isArray(side?.nodes) ? side.nodes : [];
      const edges = Array.isArray(side?.edges) ? side.edges : [];
      if (nodes.length === 0) return { width: 0, height: 0, nodes: [], edges: [] };
      const known = new Set(nodes.map((node) => node.id));
      const outgoing = new Map(nodes.map((node) => [node.id, []]));
      const incoming = new Map(nodes.map((node) => [node.id, []]));
      for (const edge of edges) {
        if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
        outgoing.get(edge.from).push(edge.to);
        incoming.get(edge.to).push(edge.from);
      }
      const layer = new Map();
      const queue = nodes.filter((node) => incoming.get(node.id).length === 0).map((node) => node.id);
      for (const id of queue) layer.set(id, 0);
      let guard = nodes.length * 4;
      while (queue.length > 0 && guard-- > 0) {
        const id = queue.shift();
        const base = layer.get(id) ?? 0;
        for (const next of outgoing.get(id)) {
          if ((layer.get(next) ?? -1) < base + 1) layer.set(next, base + 1);
          queue.push(next);
        }
      }
      for (const node of nodes) if (!layer.has(node.id)) layer.set(node.id, 0);

      const layers = new Map();
      for (const node of nodes) {
        const index = layer.get(node.id);
        if (!layers.has(index)) layers.set(index, []);
        layers.get(index).push(node.id);
      }
      const depth = Math.max(...[...layers.keys()]) + 1;
      const widest = Math.max(...[...layers.values()].map((ids) => ids.length));
      const width = Math.max(320, widest * FLOW_NODE_W + (widest - 1) * FLOW_H_GAP) + 16;
      const positions = new Map();
      let y = 8;
      for (let index = 0; index < depth; index += 1) {
        const ids = layers.get(index) ?? [];
        const span = ids.length * FLOW_NODE_W + (ids.length - 1) * FLOW_H_GAP;
        let x = (width - span) / 2;
        for (const id of ids) {
          positions.set(id, { x, y });
          x += FLOW_NODE_W + FLOW_H_GAP;
        }
        y += FLOW_NODE_H + FLOW_V_GAP;
      }
      return {
        width,
        height: y - FLOW_V_GAP + 12,
        nodes: nodes.map((node) => ({ ...node, ...positions.get(node.id) })),
        edges: edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)),
      };
    }

    /**
     * One side of a flow, drawn: boxes, a dashed box for a decision, arrows with
     * their branch labels. Clicking a box opens the review pane at its anchor.
     */
    function FlowDiagram(props) {
      const { side, sideName, onOpen, emptyText, noAnchorText, selectedId } = props;
      const layout = useMemo(() => layoutFlow(side), [side]);
      if (layout.nodes.length === 0) {
        return h('div', { style: { fontSize: 11, opacity: 0.5 } }, emptyText);
      }
      const at = new Map(layout.nodes.map((node) => [node.id, node]));
      /** The step the reader opened, in this side of the diagram. */
      const isSelected = (node) =>
        selectedId !== undefined && selectedId !== null && selectedId === node.id;
      const arrow = 'flow-arrow';
      return h(
        'svg',
        {
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          width: '100%',
          style: { maxHeight: 520, display: 'block' },
          role: 'img',
        },
        h(
          'defs',
          null,
          h(
            'marker',
            {
              id: arrow,
              viewBox: '0 0 10 10',
              refX: 9,
              refY: 5,
              markerWidth: 6,
              markerHeight: 6,
              orient: 'auto',
            },
            h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-text-tertiary, rgba(127,127,127,.8))' })
          )
        ),
        layout.edges.map((edge, index) => {
          const from = at.get(edge.from);
          const to = at.get(edge.to);
          const x1 = from.x + FLOW_NODE_W / 2;
          const y1 = from.y + FLOW_NODE_H;
          const x2 = to.x + FLOW_NODE_W / 2;
          const y2 = to.y;
          const mid = (y1 + y2) / 2;
          return h(
            'g',
            { key: `edge-${index}` },
            h('path', {
              d:
                x1 === x2
                  ? `M ${x1} ${y1} L ${x2} ${y2}`
                  : `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
              fill: 'none',
              stroke: 'var(--dsw-alias-text-tertiary, rgba(127,127,127,.55))',
              strokeWidth: 1,
              markerEnd: `url(#${arrow})`,
            }),
            edge.label === '' || edge.label === undefined
              ? null
              : h(
                  'text',
                  {
                    x: x1 === x2 ? x1 + 6 : (x1 + x2) / 2,
                    y: mid,
                    fontSize: 10,
                    fill: 'var(--dsw-alias-text-tertiary, rgba(127,127,127,.9))',
                    textAnchor: x1 === x2 ? 'start' : 'middle',
                  },
                  edge.label
                )
          );
        }),
        layout.nodes.map((node) =>
          h(
            'g',
            {
              key: node.id,
              onClick: () => onOpen(node, sideName),
              style: { cursor: 'pointer' },
            },
            h('title', null, (node.files ?? []).length === 0 ? noAnchorText : (node.files ?? []).join('\n')),
            h('rect', {
              x: node.x,
              y: node.y,
              width: FLOW_NODE_W,
              height: FLOW_NODE_H,
              rx: 10,
              fill: isSelected(node)
                ? 'var(--dsw-alias-bg-info-tertiary, rgba(88,166,255,.14))'
                : 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.08))',
              // The step that was opened stays marked, so the reader can see
              // which box the code in the pane belongs to.
              stroke:
                isSelected(node)
                  ? 'var(--dsw-alias-border-focus, rgba(88,166,255,.95))'
                  : node.confidence === 'low'
                    ? 'var(--dsw-alias-border-warning, rgba(210,153,34,.8))'
                    : (node.files ?? []).length === 0
                      ? 'var(--dsw-alias-border-tertiary, rgba(127,127,127,.28))'
                      : 'var(--dsw-alias-border-secondary, rgba(127,127,127,.4))',
              strokeWidth: isSelected(node) ? 2 : 1,
              // What is dashed: a decision, or a step the model did not anchor to
              // a file — the second one cannot open code and says so on hover.
              strokeDasharray: node.kind === 'decision' ? '5 3' : (node.files ?? []).length === 0 ? '2 3' : undefined,
            }),
            h(
              'foreignObject',
              { x: node.x + 8, y: node.y + 4, width: FLOW_NODE_W - 16, height: FLOW_NODE_H - 8 },
              h(
                'div',
                {
                  style: {
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    fontSize: 12.5,
                    lineHeight: 1.3,
                    overflow: 'hidden',
                  },
                },
                node.label
              )
            )
          )
        )
      );
    }

    /* ------------------------------------------------------------ syntax */

    /**
     * A small, self-contained tokenizer for the diff view.
     *
     * The product's own file preview highlights code, but it is a bundle a
     * plugin may not import, and no slot renders code for someone else; so the
     * pane colours its own lines. This is a scanner, not a parser: it knows
     * comments, strings, numbers, keywords and types, and it treats anything
     * else as plain text. The invariant the checks hold it to is lossless —
     * joining the tokens of a line reproduces that line exactly.
     */
    const C_LIKE = [
      'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
      'default', 'defer', 'delete', 'do', 'dyn', 'elif', 'else', 'enum', 'export', 'extends',
      'extern', 'false', 'final', 'finally', 'fn', 'for', 'from', 'func', 'function', 'go',
      'goto', 'if', 'impl', 'implements', 'import', 'in', 'instanceof', 'interface', 'internal',
      'is', 'lambda', 'let', 'match', 'mod', 'move', 'mut', 'namespace', 'new', 'nil', 'none',
      'not', 'null', 'of', 'or', 'package', 'pass', 'private', 'protected', 'pub', 'public',
      'raise', 'readonly', 'ref', 'return', 'sealed', 'sizeof', 'static', 'strictfp', 'struct',
      'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'trait', 'transient', 'true',
      'try', 'type', 'typeof', 'undefined', 'unsafe', 'use', 'using', 'var', 'virtual', 'void',
      'volatile', 'where', 'while', 'with', 'yield', 'def', 'and', 'assert', 'del', 'except',
      'global', 'nonlocal', 'self', 'elif', 'print',
    ];
    const C_TYPES = [
      'any', 'bool', 'boolean', 'byte', 'char', 'double', 'f32', 'f64', 'float', 'i8', 'i16',
      'i32', 'i64', 'int', 'i128', 'long', 'number', 'object', 'short', 'string', 'str', 'symbol',
      'u8', 'u16', 'u32', 'u64', 'u128', 'uint', 'unknown', 'usize', 'isize', 'bigint', 'never',
      'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise', 'Map', 'Set', 'List', 'Dict',
    ];
    const TS_EXTRA = ['declare', 'infer', 'keyof', 'namespace', 'readonly', 'satisfies', 'type', 'override'];

    const SYNTAX = {
      ts: { line: '//', block: ['/*', '*/'], strings: ['"', "'"], template: true, keywords: new Set([...C_LIKE, ...TS_EXTRA]), types: new Set(C_TYPES) },
      py: { line: '#', block: null, strings: ['"', "'"], template: false, keywords: new Set(C_LIKE), types: new Set(C_TYPES) },
      clike: { line: '//', block: ['/*', '*/'], strings: ['"', "'"], template: false, keywords: new Set(C_LIKE), types: new Set(C_TYPES) },
      sql: {
        line: '--',
        block: ['/*', '*/'],
        strings: ["'", '"'],
        template: false,
        keywords: new Set(['select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'view', 'drop', 'alter', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'distinct', 'limit', 'offset', 'union', 'all', 'case', 'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'constraint']),
        types: new Set(['int', 'integer', 'bigint', 'smallint', 'text', 'varchar', 'char', 'boolean', 'bool', 'date', 'timestamp', 'timestamptz', 'numeric', 'decimal', 'real', 'double', 'json', 'jsonb', 'uuid', 'serial']),
      },
      sh: { line: '#', block: null, strings: ['"', "'"], template: false, keywords: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'return', 'local', 'export', 'readonly', 'shift', 'source', 'exit', 'set', 'unset', 'trap', 'eval', 'exec']), types: new Set([]) },
      data: { line: '#', block: null, strings: ['"', "'"], template: false, keywords: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']), types: new Set([]) },
      html: { line: null, block: ['<!--', '-->'], strings: ['"', "'"], template: false, keywords: new Set([]), types: new Set([]) },
      css: { line: null, block: ['/*', '*/'], strings: ['"', "'"], template: false, keywords: new Set(['important', 'media', 'supports', 'keyframes', 'import', 'from', 'to']), types: new Set([]) },
    };

    const EXTENSION_LANGUAGE = {
      ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts',
      py: 'py', pyi: 'py',
      go: 'clike', rs: 'clike', java: 'clike', kt: 'clike', kts: 'clike', swift: 'clike',
      c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', hpp: 'clike', cs: 'clike',
      scala: 'clike', php: 'clike', m: 'clike', mm: 'clike', dart: 'clike', ex: 'clike', exs: 'clike',
      sql: 'sql',
      sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh',
      json: 'data', yaml: 'data', yml: 'data', toml: 'data', ini: 'data', env: 'data',
      html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
      css: 'css', scss: 'css', less: 'css',
    };

    /** Prism's own name for a language, by extension. */
    const PRISM_LANGUAGE = {
      ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
      mts: 'typescript', cts: 'typescript',
      py: 'python', pyi: 'python',
      go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
      c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
      scala: 'scala', php: 'php', m: 'objectivec', mm: 'objectivec', dart: 'dart', ex: 'elixir', exs: 'elixir',
      rb: 'ruby', lua: 'lua', pl: 'perl', r: 'r', jl: 'julia', hs: 'haskell', clj: 'clojure',
      sql: 'sql', graphql: 'graphql',
      sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
      json: 'json', json5: 'json5', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', env: 'bash',
      html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
      css: 'css', scss: 'scss', less: 'less', sass: 'sass', md: 'markdown', markdown: 'markdown',
      diff: 'diff', patch: 'diff', dockerfile: 'docker', tf: 'hcl', proto: 'protobuf',
    };

    /** Prism's language name for a path, or null when it has no grammar for it. */
    function prismLanguageForPath(path) {
      if (typeof path !== 'string') return null;
      const dot = path.lastIndexOf('.');
      const slash = path.lastIndexOf('/');
      if (dot < 0 || dot < slash) return null;
      return PRISM_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? null;
    }

    /** Prism token types onto the kinds this pane colours. */
    const PRISM_KIND = {
      comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment',
      string: 'string', char: 'string', 'template-string': 'string', regex: 'string',
      number: 'number', boolean: 'number',
      keyword: 'keyword', builtin: 'keyword', important: 'keyword', atrule: 'keyword',
      'class-name': 'type', 'maybe-class-name': 'type', function: 'type', type: 'type',
      tag: 'keyword', 'attr-name': 'type', 'attr-value': 'string', selector: 'type',
      operator: 'punct', punctuation: 'punct',
    };

    /** Flatten Prism's token tree onto our spans, keeping the text lossless. */
    function flattenPrismTokens(node, out, inherited) {
      if (typeof node === 'string') {
        if (node !== '') out.push({ text: node, kind: inherited ?? 'plain' });
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) flattenPrismTokens(item, out, inherited);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const alias = Array.isArray(node.alias) ? node.alias[0] : node.alias;
      const kind = PRISM_KIND[node.type] ?? PRISM_KIND[alias] ?? inherited ?? 'plain';
      flattenPrismTokens(node.content, out, kind);
    }

    /**
     * Tokenize one line with Prism, if it has a grammar for the language.
     * @returns token arrays per line, or null when Prism cannot handle it
     */
    function highlightWithPrism(prism, lines, language) {
      if (prism === null || prism === undefined || typeof prism.tokenize !== 'function') return null;
      const grammar = prism.languages?.[language];
      if (grammar === undefined) return null;
      return lines.map((line) => {
        const text = String(line ?? '');
        if (text === '') return [{ text: '', kind: 'plain' }];
        const tokens = [];
        flattenPrismTokens(prism.tokenize(text, grammar), tokens, null);
        return tokens.length === 0 ? [{ text, kind: 'plain' }] : tokens;
      });
    }

    /** Load the vendored Prism bundle once, from beside this file. */
    const prismLoad = { started: false, promise: null };

    function loadPrism() {
      if (typeof window !== 'undefined' && window.Prism) return Promise.resolve(window.Prism);
      if (prismLoad.promise !== null) return prismLoad.promise;
      if (REVIEW_GRAPH_BASE === null || typeof document === 'undefined') return Promise.resolve(null);
      prismLoad.promise = new Promise((resolve) => {
        const element = document.createElement('script');
        element.src = `${REVIEW_GRAPH_BASE}prism.bundle.js`;
        element.async = true;
        element.onload = () => resolve(typeof window !== 'undefined' ? window.Prism ?? null : null);
        // A missing bundle is not an error: the built-in scanner still colours.
        element.onerror = () => resolve(null);
        document.head.appendChild(element);
      });
      return prismLoad.promise;
    }

    /** The highlighter for one file, Prism when it is there and the scanner otherwise. */
    function useHighlighter(path) {
      const [prism, setPrism] = useState(
        typeof window !== 'undefined' && window.Prism ? window.Prism : null
      );
      useEffect(() => {
        if (prism !== null) return undefined;
        let live = true;
        loadPrism().then((loaded) => {
          if (live && loaded !== null) setPrism(loaded);
        });
        return () => {
          live = false;
        };
      }, [prism]);
      return useCallback(
        (lines) => {
          const language = prismLanguageForPath(path);
          const viaPrism = prism === null ? null : highlightWithPrism(prism, lines, language);
          return viaPrism ?? highlightLines(lines, languageForPath(path));
        },
        [prism, path]
      );
    }

    /** The tokenizer family for a path, or null when the file is not code. */
    function languageForPath(path) {
      if (typeof path !== 'string') return null;
      const dot = path.lastIndexOf('.');
      if (dot < 0) return null;
      return EXTENSION_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? null;
    }

    /** Colours for each token kind, tokens first and a readable fallback behind. */
    const SYNTAX_STYLE = {
      comment: { color: 'var(--dsw-alias-text-tertiary, rgba(127,127,127,.85))', fontStyle: 'italic' },
      string: { color: 'var(--dsw-alias-text-success, rgba(126,231,135,.92))' },
      number: { color: 'var(--dsw-alias-text-info, rgba(121,192,255,.95))' },
      keyword: { color: 'var(--dsw-alias-text-danger, rgba(255,123,114,.95))' },
      type: { color: 'var(--dsw-alias-text-warning, rgba(210,168,255,.95))' },
      punct: {},
      plain: {},
    };

    /**
     * Tokenize a block of lines, carrying comment and template state across them.
     * @param lines the text of each line, in order
     * @param language a `languageForPath` answer
     * @returns one token array per line; joining a line's tokens reproduces it
     */
    function highlightLines(lines, language) {
      const spec = SYNTAX[language] ?? null;
      const out = [];
      let inBlock = false;
      let inTemplate = false;
      for (const raw of lines) {
        const text = String(raw ?? '');
        if (spec === null) {
          out.push([{ text, kind: 'plain' }]);
          continue;
        }
        const tokens = [];
        const push = (value, kind) => {
          if (value !== '') tokens.push({ text: value, kind });
        };
        let index = 0;
        while (index < text.length) {
          const rest = text.slice(index);
          if (inBlock) {
            const close = spec.block === null ? -1 : rest.indexOf(spec.block[1]);
            if (close < 0) {
              push(rest, 'comment');
              break;
            }
            const end = close + spec.block[1].length;
            push(rest.slice(0, end), 'comment');
            index += end;
            inBlock = false;
            continue;
          }
          if (inTemplate) {
            let cursor = 0;
            let closed = false;
            while (cursor < rest.length) {
              if (rest[cursor] === '\\') { cursor += 2; continue; }
              if (rest[cursor] === '`') { closed = true; break; }
              cursor += 1;
            }
            if (!closed) {
              push(rest, 'string');
              break;
            }
            push(rest.slice(0, cursor + 1), 'string');
            index += cursor + 1;
            inTemplate = false;
            continue;
          }
          if (spec.line !== null && spec.line !== undefined && rest.startsWith(spec.line)) {
            push(rest, 'comment');
            break;
          }
          if (spec.block !== null && rest.startsWith(spec.block[0])) {
            const close = rest.indexOf(spec.block[1], spec.block[0].length);
            if (close < 0) {
              push(rest, 'comment');
              inBlock = true;
              break;
            }
            const end = close + spec.block[1].length;
            push(rest.slice(0, end), 'comment');
            index += end;
            continue;
          }
          const char = rest[0];
          if (spec.strings.includes(char)) {
            let cursor = 1;
            let closed = false;
            while (cursor < rest.length) {
              if (rest[cursor] === '\\') { cursor += 2; continue; }
              if (rest[cursor] === char) { closed = true; break; }
              cursor += 1;
            }
            const end = closed ? cursor + 1 : rest.length;
            push(rest.slice(0, end), 'string');
            index += end;
            continue;
          }
          if (spec.template === true && char === '`') {
            push(char, 'string');
            index += 1;
            inTemplate = true;
            continue;
          }
          const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
          if (word !== null) {
            const value = word[0];
            push(value, spec.keywords.has(value) ? 'keyword' : spec.types.has(value) ? 'type' : 'plain');
            index += value.length;
            continue;
          }
          const number = /^\d[\w.]*/.exec(rest);
          if (number !== null) {
            push(number[0], 'number');
            index += number[0].length;
            continue;
          }
          const space = /^\s+/.exec(rest);
          if (space !== null) {
            push(space[0], 'plain');
            index += space[0].length;
            continue;
          }
          push(char, 'punct');
          index += 1;
        }
        out.push(tokens.length === 0 ? [{ text: '', kind: 'plain' }] : tokens);
      }
      return out;
    }

    const DIFF_LINE_STYLE = {
      add: { background: 'var(--dsw-alias-bg-success-tertiary, rgba(46,160,67,.16))' },
      del: { background: 'var(--dsw-alias-bg-danger-tertiary, rgba(248,81,73,.16))' },
      ctx: {},
      note: { opacity: 0.55, fontStyle: 'italic' },
    };

    /**
     * The review pane: one file's comparison, under the change source the view
     * had selected when the node was clicked.
     *
     * The source travels in the address's `params`, because the pane mounts
     * later than the click and may outlive the view's own state.
     */
    function ReviewPane(props) {
      const { t } = props;
      const base = typeof t === 'function' ? t : (key) => String(key);
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
      const tab = info?.tab;
      const address = tab?.contentId ?? tab?.navigation?.address ?? tab?.address;
      const params = tab?.navigation?.params ?? {};
      const parsed = parseReviewAddress(address);
      const [state, setState] = useState({ phase: 'loading' });
      const [changeSet, setChangeSet] = useState(null);
      const [selected, setSelected] = useState(parsed?.path ?? null);

      const highlight = useHighlighter(selected ?? parsed?.path ?? '');
      const scope = typeof params.scope === 'string' ? params.scope : 'unstaged';
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      const seq = Number.isSafeInteger(params.seq) ? params.seq : undefined;
      const index = Number.isSafeInteger(params.index) ? params.index : undefined;
      const line = Number.isSafeInteger(params.line) ? params.line : undefined;
      // Declared after `line`: a `const` that reads it above its declaration is
      // a TDZ crash, and a crash here blanks the whole pane.
      /** Which column the anchored line lives in, when the caller knew. */
      const targetSide = params.side === 'before' ? 'before' : params.side === 'after' ? 'after' : null;
      /** The anchored range is inclusive; a single line is a range of one. */
      const endLine =
        Number.isSafeInteger(params.endLine) && params.endLine > (line ?? 0)
          ? params.endLine
          : line;
      const inRange = (value) =>
        line !== undefined && typeof value === 'number' && value >= line && value <= endLine;
      // A line that survives unchanged can sit outside every hunk, so the pane
      // says so in its header and marks the nearest block. Computed here, at the
      // pane's own scope: both the header and the body read it, and a value
      // declared inside the body is invisible to the header.
      const diffHunks = state.document?.hunks ?? [];
      const covers = (hunk) =>
        line !== undefined &&
        (targetSide === 'before'
          ? line >= hunk.oldStart && line <= hunk.oldStart + Math.max(hunk.oldLines, 1)
          : line >= hunk.newStart && line <= hunk.newStart + Math.max(hunk.newLines, 1));
      const matchedInDiff =
        line === undefined
          ? true
          : diffHunks.some((hunk) =>
              hunk.lines.some(
                (entry) =>
                  (targetSide !== 'after' && inRange(entry.oldLine)) ||
                  (targetSide !== 'before' && inRange(entry.newLine))
              )
            );
      const nearest = matchedInDiff || line === undefined ? -1 : diffHunks.findIndex(covers);
      /** A turn review is the product's own pane; it has no git change set. */
      const productScoped = typeof cwd !== 'string';

      // The change set of the whole source, so the pane walks it file by file
      // instead of being one file's dead end.
      // The column keeps one tab, so a new file arrives as a new navigation.
      useEffect(() => {
        if (typeof params.path === 'string' && params.path !== '') setSelected(params.path);
      }, [params.path, parsed?.sessionId]);

      useEffect(() => {
        if (parsed === undefined || productScoped) return undefined;
        const controller = new AbortController();
        (async () => {
          try {
            const query = new URLSearchParams({ cwd, scope });
            const response = await fetch(`${FILES_PATH}?${query.toString()}`, {
              signal: controller.signal,
            });
            if (!response.ok) return;
            const value = await response.json();
            if (controller.signal.aborted) return;
            setChangeSet(value);
            setSelected((current) => current ?? value?.files?.[0]?.path ?? null);
          } catch {
            /* the list is an aid; the diff still reports its own failure */
          }
        })();
        return () => controller.abort();
      }, [cwd, scope, productScoped, parsed?.sessionId]);

      useEffect(() => {
        if (parsed === undefined) {
          setState({ phase: 'error', message: base('reviewNoDiff') });
          return undefined;
        }
        const controller = new AbortController();
        (async () => {
          try {
            setState({ phase: 'loading' });
            let document;
            if (productScoped) {
              // A turn already has the product's comparison; reuse it.
              if (seq === undefined || index === undefined || parsed.path === null) {
                throw new Error(base('reviewNoDiff'));
              }
              const query = new URLSearchParams({
                sessionId: parsed.sessionId,
                seq: String(seq),
                index: String(index),
              });
              const response = await fetch(`${PRODUCT_DIFF_PATH}?${query.toString()}`, {
                signal: controller.signal,
              });
              if (!response.ok) throw new Error(`${response.status}`);
              document = adaptProductDiff(await response.json());
              if (document === null) throw new Error(`${response.status}`);
            } else {
              const wanted = selected ?? parsed.path;
              if (typeof wanted !== 'string' || wanted === '') {
                setState({ phase: 'empty' });
                return;
              }
              const entry = (changeSet?.files ?? []).find((file) => file.path === wanted);
              // Both sides of a rename, or git renders the move as an addition.
              const query = new URLSearchParams({ cwd, scope, path: wanted });
              if (typeof entry?.oldPath === 'string' && entry.oldPath !== '') {
                query.set('old', entry.oldPath);
              }
              const response = await fetch(`${DIFF_PATH}?${query.toString()}`, {
                signal: controller.signal,
              });
              if (!response.ok) {
                const detail = (await response.text()).trim();
                throw new Error(detail === '' ? `${response.status}` : detail);
              }
              document = await response.json();
            }
            if (controller.signal.aborted) return;
            setState({ phase: 'ready', document });
          } catch (cause) {
            if (controller.signal.aborted) return;
            setState({
              phase: 'error',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        })();
        return () => controller.abort();
      }, [address, cwd, scope, selected, seq, index, parsed?.path, productScoped, changeSet, base]);

      const files = changeSet?.files ?? [];
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
            flexWrap: 'wrap',
          },
        },
        h(
          'span',
          { style: { fontSize: 12, fontWeight: 600, wordBreak: 'break-all' } },
          selected ?? parsed?.path ?? base('reviewTitle')
        ),
        files.length > 0 ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, base('reviewFiles')(files.length)) : null,
        state.phase === 'ready'
          ? h(
              'span',
              { style: { fontSize: 11, opacity: 0.75 } },
              `+${state.document.additions ?? 0} −${state.document.deletions ?? 0}`
            )
          : null,
        state.phase === 'ready' && typeof params.label === 'string'
          ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, params.label)
          : null,
        state.phase === 'ready' && line !== undefined && nearest >= 0
          ? h(
              'span',
              { style: { fontSize: 11, opacity: 0.75 } },
              base('reviewLineOutsideDiff')(line, endLine ?? line)
            )
          : null,
        h('div', { style: { flex: 1 } }),
        files.length > 1
          ? h(
              'span',
              { style: { display: 'flex', gap: 2 } },
              h(
                Button,
                { title: base('reviewPrev'), onClick: () => setSelected(stepFile(files, selected, -1)) },
                '\u2039'
              ),
              h(
                Button,
                { title: base('reviewNext'), onClick: () => setSelected(stepFile(files, selected, 1)) },
                '\u203a'
              )
            )
          : null,
        // The tab's own actions resolve in this tab's session, so the plain
        // preview stays one click away without another injected service.
        parsed !== undefined &&
        tab?.actions !== undefined &&
        typeof tab.actions.openResource === 'function'
          ? h(
              Button,
              {
                onClick: () =>
                  tab.actions.openResource(
                    sessionFileAddress(parsed.sessionId, selected ?? parsed.path ?? ''),
                    line === undefined ? undefined : { params: { line } }
                  ),
              },
              base('reviewOpenFile')
            )
          : null
      );

      let body;
      if (state.phase === 'loading') {
        body = h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, base('reviewLoading'));
      } else if (state.phase === 'empty') {
        body = h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, base('reviewNoDiff'));
      } else if (state.phase === 'error') {
        body = h(
          'div',
          { style: { padding: 16, fontSize: 12, opacity: 0.8 } },
          base('reviewFailed')(state.message)
        );
      } else if (state.document.binary === true) {
        body = h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, base('reviewBinary'));
      } else if (state.document.oversized === true) {
        body = h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, base('reviewOversized'));
      } else if ((state.document.hunks ?? []).length === 0) {
        body = h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, base('reviewNoHunks'));
      } else {
        const rows = [];
        for (const [hunkIndex, hunk] of diffHunks.entries()) {
          const tokensByLine = highlight(
            hunk.lines.map((entry) => (entry.kind === 'note' ? '' : entry.text))
          );
          rows.push(
            h(
              'div',
              {
                key: `hunk-${hunkIndex}`,
                style: {
                  fontSize: 11,
                  opacity: 0.7,
                  padding: '2px 8px',
                  ...(hunkIndex === nearest
                    ? {
                        boxShadow:
                          'inset 3px 0 0 0 var(--dsw-alias-border-focus, rgba(88,166,255,.95))',
                      }
                    : {}),
                  background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.08))',
                  fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, monospace)',
                },
              },
              `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
            )
          );
          for (const [lineIndex, row] of hunk.lines.entries()) {
            const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'note' ? '' : ' ';
            const oldHit = inRange(row.oldLine) && targetSide !== 'after';
            const newHit = inRange(row.newLine) && targetSide !== 'before';
            const target = oldHit || newHit;
            rows.push(
              h(
                'div',
                {
                  key: `line-${hunkIndex}-${lineIndex}`,
                  style: {
                    display: 'flex',
                    gap: 8,
                    padding: '0 8px',
                    whiteSpace: 'pre',
                    fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, monospace)',
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    ...DIFF_LINE_STYLE[row.kind],
                    // A left bar only: a row background paints over the red
                    // removal and green addition fills.
                    ...(target
                      ? {
                          boxShadow: 'inset 3px 0 0 0 var(--dsw-alias-border-focus, rgba(88,166,255,.95))',
                        }
                      : {}),
                  },
                },
                h(
                  'span',
                  {
                    style: {
                      minWidth: 40,
                      textAlign: 'right',
                      opacity: oldHit ? 1 : 0.45,
                      fontWeight: oldHit ? 700 : 400,
                    },
                  },
                  row.oldLine === undefined ? '' : String(row.oldLine)
                ),
                h(
                  'span',
                  {
                    style: {
                      minWidth: 40,
                      textAlign: 'right',
                      opacity: newHit ? 1 : 0.45,
                      fontWeight: newHit ? 700 : 400,
                    },
                  },
                  row.newLine === undefined ? '' : String(row.newLine)
                ),
                h('span', { style: { opacity: 0.6, minWidth: 8 } }, marker),
                h(
                  'span',
                  null,
                  row.kind === 'note'
                    ? base('reviewNoNewline')
                    : (tokensByLine[lineIndex] ?? [{ text: row.text, kind: 'plain' }]).map((token, tokenIndex) =>
                        h(
                          'span',
                          { key: `token-${tokenIndex}`, style: SYNTAX_STYLE[token.kind] ?? {} },
                          token.text
                        )
                      )
                )
              )
            );
          }
        }
        body = h('div', { style: { overflow: 'auto', padding: '6px 0', flex: 1 } }, rows);
      }

      const rail =
        files.length > 0
          ? h(
              'div',
              {
                style: {
                  width: 220,
                  minWidth: 160,
                  borderRight: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
                  overflow: 'auto',
                  padding: '6px 4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                },
              },
              h(
                'div',
                { style: { fontSize: 10, opacity: 0.55, padding: '2px 6px 6px' } },
                base('reviewPick')
              ),
              files.map((file) =>
                h(
                  'button',
                  {
                    key: file.path,
                    type: 'button',
                    onClick: () => setSelected(file.path),
                    title: file.path,
                    style: {
                      appearance: 'none',
                      border: 'none',
                      textAlign: 'left',
                      font: 'inherit',
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: '4px 6px',
                      borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                      color: 'inherit',
                      wordBreak: 'break-all',
                      background:
                        file.path === selected
                          ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.16))'
                          : 'transparent',
                    },
                  },
                  h(
                    'span',
                    { style: { opacity: 0.6, marginRight: 6 } },
                    file.untracked === true ? 'A' : file.status
                  ),
                  file.path
                )
              )
            )
          : null;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        header,
        state.phase === 'ready' && state.document.coarse === true
          ? h('div', { style: { padding: '6px 12px', fontSize: 11, opacity: 0.7 } }, base('reviewCoarse'))
          : null,
        h(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0 } },
          rail,
          h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, body)
        )
      );
    }

    /* ------------------------------------------------------------------ git */

    /** Authenticated Host routes serving git change sources. */
    const GIT_STATE_PATH = '/api/review-graph.state';
    const GIT_GRAPH_PATH = '/api/review-graph.graph';

    /** Git status letters as the sidebar labels them. */
    const STATUS_COPY = {
      A: 'statusAdded',
      M: 'statusModified',
      D: 'statusDeleted',
      R: 'statusRenamed',
      C: 'statusCopied',
      T: 'statusType',
    };

    /**
     * The scope spec for the current source selection.
     * @returns the spec, or null while a commit/branch is still unpicked
     */
    function scopeSpecFor(source, refs) {
      if (source === 'turn') return null;
      if (source === 'commit') {
        return typeof refs.commit === 'string' && refs.commit !== ''
          ? `commit:${refs.commit}`
          : null;
      }
      if (source === 'branch') {
        return typeof refs.base === 'string' && refs.base !== '' ? `branch:${refs.base}` : null;
      }
      return source;
    }

    /**
     * The commit a picker should show as selected.
     *
     * The menu is one comparison's delta, so a commit that the current base no
     * longer offers must not stay selected.
     * @param commits the menu the Host returned for this base
     * @param current the selected sha
     * @returns a sha present in the menu, or null when the menu is empty
     */
    function pickCommitRef(commits, current) {
      const list = Array.isArray(commits) ? commits : [];
      if (typeof current === 'string' && list.some((commit) => commit.sha === current)) {
        return current;
      }
      return list[0]?.sha ?? null;
    }

    /* ------------------------------------------------------------ workspace */

    /**
     * Unwrap one RemoteResult envelope.
     *
     * Every unary `ctx.remote` call resolves to `{ ok: true, value }` or
     * `{ ok: false, error }` — the payload is never the result itself. A raw
     * payload is still accepted, so these helpers can be driven directly.
     * @param result the awaited Remote call
     * @returns the payload, or undefined when the call failed
     */
    function unwrapRemote(result) {
      if (result === undefined || result === null || typeof result !== 'object') {
        return undefined;
      }
      if (result.ok === false) return undefined;
      if (result.ok === true) return result.value;
      return result;
    }

    /**
     * Recursively list indexable source files under a workspace root.
     * @returns a Map of workspace-relative path → absolute path.
     */
    async function listSourceFiles(remote, sessionId, root, signal, onProgress) {
      const found = new Map();
      const queue = [''];
      let dirs = 0;
      let truncated = false;

      while (queue.length > 0) {
        if (signal.aborted) break;
        const dir = queue.shift();
        const absolute = dir === '' ? root : root.replace(/\/+$/, '') + '/' + dir;
        dirs += 1;
        if (onProgress !== undefined && dirs % 8 === 0) onProgress(found.size, 0);
        const result = await remote.workspaceFiles.list(sessionId, absolute, signal);
        const listing = unwrapRemote(result);
        if (listing === undefined) {
          // One unreadable subdirectory is skipped; an unlistable root is the
          // whole view, so it surfaces instead of silently graphing nothing.
          if (dir === '') {
            throw new Error(
              result?.error?.message ?? 'the workspace root could not be listed'
            );
          }
          continue;
        }
        if (listing.truncated === true) truncated = true;
        const entries = Array.isArray(listing.entries) ? listing.entries : [];
        for (const entry of entries) {
          const rel = dir === '' ? entry.name : dir + '/' + entry.name;
          if (entry.type === 'directory') {
            if (isIgnoredDir(entry.name)) continue;
            if (found.size + queue.length > MAX_FILES) {
              truncated = true;
              continue;
            }
            queue.push(rel);
            continue;
          }
          if (entry.type !== 'file') continue;
          if (!isSourcePath(entry.name)) continue;
          if (found.size >= MAX_FILES) {
            truncated = true;
            break;
          }
          found.set(rel, absolute + '/' + entry.name);
        }
        if (truncated) break;
      }
      return { files: found, truncated };
    }

    /**
     * The file universe for one graph: indexed sources plus every changed path.
     *
     * A `.gitignore`, a workflow file, or a lockfile is a real change even
     * though only source files take part in the reference analysis. Without
     * this union such a change set resolves to nothing and the view shows an
     * empty state with no explanation.
     */
    function withChanged(files, changed) {
      const seen = new Set(files);
      const all = [...files];
      for (const rel of changed) {
        if (rel === '' || seen.has(rel)) continue;
        seen.add(rel);
        all.push(rel);
      }
      return all;
    }

    /** Read the text of indexed files, bounded, reporting progress. */
    async function readSourceFiles(remote, sessionId, entries, signal, onProgress) {
      const contents = new Map();
      let done = 0;
      const list = [...entries];
      const CONCURRENCY = 6;
      let cursor = 0;

      async function worker() {
        while (cursor < list.length) {
          if (signal.aborted) return;
          const index = cursor;
          cursor += 1;
          const [rel, absolute] = list[index];
          try {
            const result = await remote.workspaceFiles.read(
              sessionId,
              absolute,
              {},
              signal
            );
            const file = unwrapRemote(result);
            if (typeof file?.text === 'string') contents.set(rel, file.text);
          } catch {
            /* unreadable or binary: indexed as a node without edges */
          }
          done += 1;
          if (onProgress !== undefined && done % 10 === 0) onProgress(done, list.length);
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return contents;
    }

    /**
     * Discover this session's change set across turns from the session log.
     * @param sessionEvents the session's event array
     * @returns turns ascending, each with its summary and announcing sequence
     */
    async function collectTurns(sessionEvents, sessionId, signal) {
      const turns = [];
      const events = Array.isArray(sessionEvents) ? sessionEvents : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event === undefined || event === null) continue;
        if (event.type !== 'workspace/changes') continue;
        const turn = event.data === undefined ? undefined : event.data.turn;
        if (!Number.isSafeInteger(turn)) continue;
        if (turns.some((entry) => entry.turn === turn)) continue;
        const summary = await fetchSummary(sessionId, event.seq, signal).catch(() => null);
        if (summary === null) continue;
        turns.push({ turn, seq: event.seq, summary });
        if (turns.length >= 12) break;
      }
      turns.sort((a, b) => a.turn - b.turn);
      return turns;
    }

    function changedPathsOf(turns, mode) {
      if (turns.length === 0) return [];
      if (mode === 'all') {
        const seen = new Set();
        for (const t of turns) {
          for (const file of t.summary.files) {
            const path = normalizeRelPath(file.path);
            if (path !== '') seen.add(path);
          }
        }
        return [...seen];
      }
      const turn = turns.find((t) => String(t.turn) === String(mode)) ?? turns[turns.length - 1];
      return turn.summary.files
        .map((file) => normalizeRelPath(file.path))
        .filter((path) => path !== '');
    }

    /* -------------------------------------------------------------- layout */

    /**
     * Layered left-to-right layout, keeping each connected cluster on its own
     * horizontal band so independent changes read as visually separate.
     */
    /**
     * A locale copy, whether it is a string or a function, and never a crash.
     *
     * The view is rendered from a dictionary that a build or a locale can leave
     * incomplete; a missing plural helper must not empty the tab.
     */
    /**
     * The model a generation will use.
     *
     * The conversation owns the model, the plan's catalogue is the fallback, and
     * the plan reports the pair it resolved as a last resort. Anything else
     * returns `null` — so the caller must handle "no model yet" rather than
     * reading a property off nothing.
     */
    function modelForGeneration(sessionModel, plan) {
      const session = sessionModel ?? null;
      if (session !== null && typeof session.model === 'string' && session.model !== '') {
        return { provider: session.provider ?? null, model: session.model };
      }
      const first = plan?.models?.[0];
      if (first !== undefined && first !== null && typeof first.model === 'string' && first.model !== '') {
        return { provider: first.provider ?? null, model: first.model };
      }
      if (typeof plan?.plan?.model === 'string' && plan.plan.model !== '') {
        return { provider: plan.plan.provider ?? null, model: plan.plan.model };
      }
      return null;
    }

    function copyText(t, key, ...args) {
      const value = t === null || t === undefined ? undefined : t[key];
      if (typeof value === 'function') return value(...args);
      if (typeof value === 'string') return value;
      return key;
    }

    /** Every edge of one class as a single `d`, so one path draws them all. */
    function edgePath(edges, layout, changed) {
      const parts = [];
      for (const edge of edges) {
        if ((edge.changedPair === true) !== changed) continue;
        const from = layout.positions.get(edge.from);
        const to = layout.positions.get(edge.to);
        if (from === undefined || to === undefined) continue;
        // Centre to centre, bowed towards the middle of the picture: the curve
        // reads as "these two are related" without the crossings a straight line
        // between lanes produces. The boxes are drawn over the ends.
        const x1 = from.x + NODE_W / 2;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x + NODE_W / 2;
        const y2 = to.y + NODE_H / 2;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const bowX = midX + ((layout.center?.x ?? midX) - midX) * 0.3;
        const bowY = midY + ((layout.center?.y ?? midY) - midY) * 0.3;
        parts.push(`M${x1},${y1} Q${bowX},${bowY} ${x2},${y2}`);
      }
      return parts.join(' ');
    }

    /**
     * The strongest `budget` edges, in their original order.
     *
     * A dense change set has more file-to-file references than anyone can read
     * at once, and drawing them all is what makes the view slow and unreadable.
     * A changed pair wins over a plain reference, then the reference count, then
     * the original order, so the picture is stable between renders.
     * @param edges the candidate edges
     * @param budget how many to keep
     */
    function strongestEdges(edges, budget) {
      if (!Number.isFinite(budget) || edges.length <= budget) return edges.slice();
      const ranked = edges
        .map((edge, index) => ({ edge, index }))
        .sort((left, right) => {
          const changed =
            (right.edge.changedPair === true ? 1 : 0) - (left.edge.changedPair === true ? 1 : 0);
          if (changed !== 0) return changed;
          const weight = (right.edge.weight ?? 0) - (left.edge.weight ?? 0);
          if (weight !== 0) return weight;
          return left.index - right.index;
        })
        .slice(0, Math.max(budget, 0));
      ranked.sort((left, right) => left.index - right.index);
      return ranked.map((entry) => entry.edge);
    }

    /**
     * Lay the changed files out in lanes, one lane per call depth.
     *
     * The entry (a file nobody in this change calls) sits in the middle, the
     * files it calls ring around it, and every further ring is one call deeper.
     * A left-to-right or top-down strip collapsed into a single unreadable line
     * as soon as the change set had breadth. Lanes give every file one slot on
     * a fixed pitch, so nothing can overlap and nothing has to be tuned.
     */
    function layoutGraph(nodes, edges, componentCount) {
      // Nothing to lay out: an empty canvas still needs a size, or the fit maths
      // divides by zero and the picture comes out as NaN.
      if (nodes.length === 0) {
        return {
          positions: new Map(),
          width: 320,
          height: 200,
          center: { x: 160, y: 100 },
          layer: new Map(),
          lanes: [],
        };
      }
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const outgoing = new Map();
      const incoming = new Map();
      for (const n of nodes) {
        outgoing.set(n.id, []);
        incoming.set(n.id, []);
      }
      for (const e of edges) {
        if (!byId.has(e.from) || !byId.has(e.to)) continue;
        outgoing.get(e.from).push(e.to);
        incoming.get(e.to).push(e.from);
      }

      // Longest-path depth from the entries, cycle tolerant.
      const depth = new Map();
      const indegree = new Map();
      for (const n of nodes) indegree.set(n.id, incoming.get(n.id).length);
      const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
      for (const id of queue) depth.set(id, 0);
      let guard = nodes.length * 4;
      while (queue.length > 0 && guard-- > 0) {
        const id = queue.shift();
        const base = depth.get(id) ?? 0;
        for (const next of outgoing.get(id)) {
          if ((depth.get(next) ?? -1) < base + 1) depth.set(next, base + 1);
          indegree.set(next, (indegree.get(next) ?? 1) - 1);
          if (indegree.get(next) === 0) queue.push(next);
        }
      }
      for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

      // Columns by call depth: lane 0 holds the entries, lane 1 what they call,
      // and so on. Every file gets one slot of a fixed size, and the slots are
      // laid out on a pitch wider than a box, so two boxes can never overlap —
      // that is a property of the layout, not something to tune.
      const lanes = [];
      for (const node of nodes) {
        const level = depth.get(node.id) ?? 0;
        while (lanes.length <= level) lanes.push([]);
        lanes[level].push(node.id);
      }

      const LANE_W = NODE_W + 44;
      const LANE_GAP = 48;
      const ROW_H = NODE_H + 20;
      // Within a lane, children stay near the files that call them.
      for (let level = 0; level < lanes.length; level += 1) {
        lanes[level].sort((a, b) => {
          const mean = (id) => {
            const parents = incoming.get(id);
            if (parents.length === 0) return -1;
            const positions = parents.map((parent) => {
              const lane = depth.get(parent) ?? 0;
              return lanes[lane] === undefined ? -1 : lanes[lane].indexOf(parent);
            });
            return positions.reduce((total, value) => total + value, 0) / positions.length;
          };
          return mean(a) - mean(b) || a.localeCompare(b);
        });
      }

      const tallest = Math.max(1, ...lanes.map((ids) => ids.length));
      const positions = new Map();
      lanes.forEach((ids, level) => {
        // Lanes are centred on each other, so a chain reads left to right and a
        // wide lane does not push its neighbours around.
        const offset = ((tallest - ids.length) * ROW_H) / 2;
        ids.forEach((id, row) => {
          positions.set(id, {
            x: MARGIN + level * (LANE_W + LANE_GAP),
            y: MARGIN + offset + row * ROW_H,
          });
        });
      });

      const width = MARGIN * 2 + lanes.length * LANE_W + Math.max(0, lanes.length - 1) * LANE_GAP;
      const height = MARGIN * 2 + tallest * ROW_H - (tallest > 0 ? ROW_H - NODE_H : 0);
      // The entry lane is the left edge, so edges bow towards the left of the
      // picture rather than towards a middle that does not exist.
      const center = { x: MARGIN + LANE_W / 2, y: MARGIN + (tallest * ROW_H) / 2 };
      return { positions, width, height, center, layer: depth, lanes };
    }

    /* --------------------------------------------------------------- pieces */

    function Chip(props) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            borderRadius: 'var(--dsw-alias-radius-full, 999px)',
            background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.12))',
            fontSize: 11,
            color: 'var(--dsw-alias-text-secondary, inherit)',
            whiteSpace: 'nowrap',
          },
        },
        props.children
      );
    }

    /**
     * A render error inside a view must say what broke.
     *
     * Three times now a bad identifier in this plugin produced a tab that simply
     * went blank, which tells the reader nothing and hides the cause. The product
     * logs the failure, but a log is not where someone is looking; this catches
     * the same error and puts its message on screen.
     */
    class ViewBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // Also to the console, with the component's name, for a bug report.
        try {
          console.error('[review-graph] view crashed', this.props.label, error);
        } catch {
          /* a console that refuses is not worth failing over */
        }
      }

      render() {
        const error = this.state.error;
        if (error === null || error === undefined) return this.props.children;
        return h(
          'div',
          {
            style: {
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 12,
              lineHeight: 1.6,
            },
          },
          h(
            'div',
            { style: { fontWeight: 600 } },
            `${this.props.label}: ${error instanceof Error ? error.message : String(error)}`
          ),
          h(
            'div',
            { style: { opacity: 0.7 } },
            'This is a plugin defect, not your change set. The message above names it.'
          )
        );
      }
    }

    function Button(props) {
      const [hover, setHover] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            appearance: 'none',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.28))',
            background:
              props.active === true
                ? 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.2))'
                : hover
                  ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.12))'
                  : 'transparent',
            color: 'inherit',
            borderRadius: 'var(--dsw-alias-radius-md, 8px)',
            padding: '4px 10px',
            fontSize: 12,
            lineHeight: 1.5,
            cursor: props.disabled === true ? 'default' : 'pointer',
            opacity: props.disabled === true ? 0.5 : 1,
            font: 'inherit',
          },
        },
        props.children
      );
    }

    function Section(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          {
            style: {
              fontSize: 11,
              letterSpacing: '.02em',
              textTransform: 'uppercase',
              color: 'var(--dsw-alias-text-tertiary, rgba(127,127,127,.9))',
            },
          },
          props.title
        ),
        props.children
      );
    }

    function FileRow(props) {
      const { node, onOpen, onCopy, t, status } = props;
      const [hover, setHover] = useState(false);
      return h(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '6px 8px',
            borderRadius: 'var(--dsw-alias-radius-md, 8px)',
            background: hover ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.12))' : 'transparent',
          },
        },
        h(
          'button',
          {
            type: 'button',
            onClick: () => onOpen(node.id, undefined),
            title: t.open,
            style: {
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              padding: 0,
              textAlign: 'left',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              wordBreak: 'break-all',
            },
          },
          node.id
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, opacity: 0.75 } },
          h('span', null, `→ ${node.inbound} · ↔ ${node.degree}`),
          status !== null && status !== undefined
            ? h(
                'span',
                {
                  style: {
                    padding: '0 4px',
                    borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                    background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.16))',
                  },
                },
                status.counts === null ? status.label : `${status.label} ${status.counts}`
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              onClick: () => onCopy(node.id),
              style: {
                appearance: 'none',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                padding: 0,
                font: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
                textDecoration: 'underline',
                opacity: 0.8,
              },
            },
            t.copyPath
          )
        )
      );
    }

    function Detail(props) {
      const { node, t, onOpen, onCopy, onClose } = props;
      if (node === undefined || node === null) return null;
      return h(
        'div',
        {
          style: {
            borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: '38%',
            overflow: 'auto',
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' } },
          h('div', { style: { fontSize: 12, fontWeight: 600, wordBreak: 'break-all' } }, node.id),
          h(
            'button',
            {
              type: 'button',
              onClick: onClose,
              title: t.collapse,
              style: {
                appearance: 'none',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                font: 'inherit',
                opacity: 0.6,
              },
            },
            '×'
          )
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          node.changed ? h(Chip, null, t.changed) : h(Chip, null, t.neighbour),
          h(Chip, null, `in ${node.inbound}`),
          h(Chip, null, `deg ${node.degree}`)
        ),
        node.exports.length > 0
          ? h(
              Section,
              { title: 'exports' },
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                node.exports.map((item) =>
                  h(
                    'button',
                    {
                      key: item.name,
                      type: 'button',
                      onClick: () => onOpen(node.id, item.line),
                      title: t.openAt(item.line),
                      style: {
                        appearance: 'none',
                        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.28))',
                        background: 'transparent',
                        color: 'inherit',
                        borderRadius: 'var(--dsw-alias-radius-sm, 6px)',
                        padding: '1px 6px',
                        fontSize: 11,
                        fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)',
                        cursor: 'pointer',
                      },
                    },
                    `${item.name}:${item.line}`
                  )
                )
              )
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 6 } },
          h(Button, { onClick: () => onOpen(node.id, undefined) }, t.open),
          h(Button, { onClick: () => onCopy(node.id) }, t.copyPath)
        )
      );
    }

    function GraphCanvas(props) {
      // `scopeLabel` names the change source: it comes from the parent, because
      // a name that only exists there is not a name this component can read.
      const { graph, selected, onSelect, onOpen, t, scopeLabel } = props;
      const container = useRef(null);
      const [scale, setScale] = useState(1);
      /** The reader may raise the edge budget when the picture is too reduced. */
      const [edgeBudget, setEdgeBudget] = useState(EDGE_BUDGET);
      const [offset, setOffset] = useState({ x: 0, y: 0 });
      const dragging = useRef(null);

      // Only the files this change set touches, and only the references among
      // them: a file the commit did not touch must not appear at all, however
      // strongly the commit points at it.
      const visibleNodes = useMemo(() => graph.nodes.filter((node) => node.changed), [graph]);

      const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

      const visibleEdges = useMemo(
        () => graph.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to)),
        [graph, visibleIds]
      );

      // No grouping layer: the files are the picture, placed by who calls whom,
      // callers above their callees.

      // Focus first: a node's own neighbourhood is what the reader asked for by
      // selecting it, and it removes the hairball in one step.
      const focusedEdges = useMemo(
        () =>
          selected === null || selected === undefined
            ? visibleEdges
            : visibleEdges.filter((edge) => edge.from === selected || edge.to === selected),
        [visibleEdges, selected]
      );
      const drawnEdges = useMemo(
        () => strongestEdges(focusedEdges, edgeBudget),
        [focusedEdges, edgeBudget]
      );
      const hiddenEdges = focusedEdges.length - drawnEdges.length;

      // Laid out from the full edge set, so focusing a node never moves it.
      const layout = useMemo(
        () => layoutGraph(visibleNodes, visibleEdges, graph.change.componentCount),
        [visibleNodes, visibleEdges, graph.change.componentCount]
      );

      const nodeById = useMemo(() => new Map(visibleNodes.map((n) => [n.id, n])), [visibleNodes]);

      /** Frame the whole graph: opening a dense commit should not need a drag. */
      const fit = useCallback(() => {
        const element = container.current;
        if (element === null || element === undefined) return;
        const box = element.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return;
        const next = Math.min(
          1,
          Math.max(0.05, Math.min(box.width / Math.max(layout.width, 1), box.height / Math.max(layout.height, 1)))
        );
        setScale(next);
        setOffset({
          x: (box.width - layout.width * next) / 2,
          y: (box.height - layout.height * next) / 2,
        });
      }, [layout.width, layout.height]);

      // Framed once per graph, never per interaction. Focusing a node changes
      // the drawn edge set and therefore the picture's size; refitting on that is
      // what made every click rescale the view. Only a new source or a new change
      // set reframes it — and the button reframes on demand.
      const fitRef = useRef(fit);
      fitRef.current = fit;
      // Only names this component has: the filter is gone, and the change source
      // arrives as `scopeLabel` rather than as the parent's local variable.
      const fitKey = [
        graph.change.head ?? '',
        graph.change.base ?? '',
        scopeLabel ?? '',
        visibleNodes.length,
      ].join('|');
      useEffect(() => {
        fitRef.current();
      }, [fitKey]);

      const onWheel = useCallback((event) => {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 0.92 : 1.08;
        setScale((current) => Math.min(3, Math.max(0.25, current * factor)));
      }, []);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return;
        dragging.current = {
          x: event.clientX,
          y: event.clientY,
          origin: offset,
          moved: false,
        };
      }, [offset]);

      const onPointerMove = useCallback((event) => {
        const state = dragging.current;
        if (state === null || state === undefined) return;
        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
        setOffset({ x: state.origin.x + dx, y: state.origin.y + dy });
      }, []);

      const onPointerUp = useCallback(() => {
        dragging.current = null;
      }, []);

      return h(
        'div',
        {
          ref: container,
          style: { position: 'relative', flex: 1, minHeight: 200, overflow: 'hidden' },
          onWheel,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerLeave: onPointerUp,
        },
        // The picture says what it left out, and draws it on request.
        hiddenEdges > 0
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  zIndex: 1,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '3px 8px',
                  borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                  background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.14))',
                  fontSize: 11,
                },
              },
              h('span', null, copyText(t, 'edgesHidden', hiddenEdges, focusedEdges.length)),
              h(
                Button,
                { onClick: () => setEdgeBudget(focusedEdges.length) },
                copyText(t, 'edgesShowAll')
              )
            )
          : null,
        // One row for every control that floats over the picture: two buttons
        // each placed at the same corner is how they overlapped.
        h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 1,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            },
          },
          props.toolbar ?? null,
          h(Button, { onClick: fit, title: copyText(t, 'fitTitle') }, copyText(t, 'fit'))
        ),
        h(
          'svg',
          {
            width: '100%',
            height: '100%',
            style: { display: 'block', cursor: 'grab', touchAction: 'none' },
          },
          h(
            'defs',
            null,
            h(
              'marker',
              {
                id: 'rg-arrow',
                viewBox: '0 0 8 8',
                refX: 7,
                refY: 4,
                markerWidth: 5,
                markerHeight: 5,
                orient: 'auto-start-reverse',
              },
              h('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--dsw-alias-text-tertiary, #888)' })
            )
          ),
          h(
            'g',
            { transform: `translate(${offset.x},${offset.y}) scale(${scale})` },
            // Two batched paths, not one element per edge: a dense change set
            // used to put thousands of nodes in the DOM.
            // Thin enough that a dense change set stays readable, visible
            // enough that the relations are there without clicking a node: a
            // line nobody can see is the same as no line.
            h('path', {
              d: edgePath(drawnEdges, layout, true),
              fill: 'none',
              stroke: selected === null || selected === undefined
                ? 'var(--dsw-alias-text-secondary, #999)'
                : 'var(--dsw-alias-brand-primary, #3a83f7)',
              strokeWidth: selected === null || selected === undefined ? 0.7 : 1.4,
              markerEnd: 'url(#rg-arrow)',
              opacity: 0.8,
            }),
            h('path', {
              d: edgePath(drawnEdges, layout, false),
              fill: 'none',
              stroke: 'var(--dsw-alias-border-secondary, #bbb)',
              strokeWidth: 0.5,
              markerEnd: 'url(#rg-arrow)',
              opacity: 0.45,
            }),
            visibleNodes.map((node) => {
              const pos = layout.positions.get(node.id);
              if (pos === undefined) return null;
              const isSelected = selected === node.id;
              // Yellow means the file changed but has no reference relationship
              // with any other file in this change: it stands alone.
              const isolated = node.changed && node.degree === 0;
              const stroke = !node.changed
                ? 'var(--dsw-alias-border-secondary, rgba(127,127,127,.4))'
                : isolated
                  ? 'var(--dsw-alias-warning-primary, #d99a00)'
                  : 'var(--dsw-alias-brand-primary, #3a83f7)';
              return h(
                'g',
                {
                  key: node.id,
                  transform: `translate(${pos.x},${pos.y})`,
                  style: { cursor: 'pointer' },
                  onPointerDown: (event) => event.stopPropagation(),
                  // One click is the whole gesture: mark the node and open the
                  // change set at that file, the way the flow diagram does. A
                  // double click would make the obvious action the second one.
                  onClick: (event) => {
                    event.stopPropagation();
                    onSelect(node.id);
                    onOpen(node.id, undefined);
                  },
                },
                h('rect', {
                  width: NODE_W,
                  height: NODE_H,
                  rx: 8,
                  fill: isSelected
                    ? 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.22))'
                    : 'var(--dsw-alias-bg-primary, transparent)',
                  stroke,
                  strokeWidth: isSelected ? 2 : node.changed ? 1.5 : 1,
                }),
                h(
                  'text',
                  {
                    x: 10,
                    y: NODE_H / 2 + 4,
                    fontSize: 11,
                    fill: 'var(--dsw-alias-text-primary, currentColor)',
                  },
                  node.label.length > 20 ? node.label.slice(0, 19) + '…' : node.label
                ),
                node.inbound > 0
                  ? h(
                      'text',
                      {
                        x: NODE_W - 8,
                        y: NODE_H / 2 + 4,
                        fontSize: 10,
                        textAnchor: 'end',
                        fill: 'var(--dsw-alias-text-tertiary, #999)',
                      },
                      String(node.inbound)
                    )
                  : null,
                h(
                  'title',
                  null,
                  [
                    node.id,
                    node.dir,
                    isolated ? copyText(t, 'nodeIsolated') : copyText(t, 'nodeConnected', node.degree),
                  ]
                    .filter(Boolean)
                    .join('\n')
                )
              );
            })
          )
        ),
        h(
          'div',
          {
            style: {
              position: 'absolute',
              right: 8,
              bottom: 8,
              display: 'flex',
              gap: 6,
            },
          },
          h(
            Button,
            {
              onClick: () => {
                setScale(1);
                setOffset({ x: 0, y: 0 });
              },
              title: t.zoomReset,
            },
            `${Math.round(scale * 100)}%`
          )
        )
      );
    }

    function ReviewGraphView(props) {
      const {
        sessionId,
        root,
        sessionEvents,
        sessionModel,
        conversation,
        t,
        remote,
        sidebarRight,
      } = props;

      const [status, setStatus] = useState({ phase: 'loading', done: 0, total: 0 });
      const [turns, setTurns] = useState([]);
      const [scope, setScope] = useState('last');
      const [source, setSource] = useState('turn');
      const [baseRef, setBaseRef] = useState(null);
      const [commitRef, setCommitRef] = useState(null);
      const [gitState, setGitState] = useState(null);
      const [gitNotice, setGitNotice] = useState(null);
      const [graph, setGraph] = useState(null);
      const [mode, setMode] = useState('overview');
      /**
       * Hiding this view's own toolbar.
       *
       * The tab strip above and the composer below belong to the product's
       * shell, not to this slot, so a plugin cannot hide those; what it can do
       * is give back the rows it owns, which on a short sidebar is most of the
       * difference.
       */
      const [zen, setZen] = useState(false);
      const [aiPlan, setAiPlan] = useState(null);

      // The conversation area owns the model; this pane only falls back, and it
      // may legitimately have none yet (no selection event, plan still loading).
      // Declared here, before every consumer: a dependency array is evaluated
      // during render, so a later declaration is a temporal-dead-zone crash.
      const aiModel = useMemo(() => modelForGeneration(sessionModel, aiPlan), [sessionModel, aiPlan]);
      const [aiDocument, setAiDocument] = useState(null);
      const [aiError, setAiError] = useState(null);
      const [aiBusy, setAiBusy] = useState(false);
      const [aiFlow, setAiFlow] = useState(0);
      /** Which step was opened, so its box stays marked. */
      const [aiNode, setAiNode] = useState(null);
      // A different diagram has different steps: the mark is dropped with it.
      useEffect(() => {
        setAiNode(null);
      }, [aiFlow, aiDocument]);
      /** The pair a generation will use: the session's own, or a chosen one. */
      /** The conversation area's model; this pane never chooses its own. */
      // derived below, once the session and the plan are both known
      /** Off by default: a record joins the model context on later turns. */
      const [aiRecord, setAiRecord] = useState(false);
      const [aiDebug, setAiDebug] = useState(false);
      const [aiStale, setAiStale] = useState(null);
      /** Reasoning strength, when the provider names its options. */
      const [aiEffort, setAiEffort] = useState('');
      const [selected, setSelected] = useState(null);
      const [copied, setCopied] = useState(null);
      const [error, setError] = useState(null);
      const [nonce, setNonce] = useState(0);
      const [openError, setOpenError] = useState(null);

      // 2) Walk + read + analyze whenever the scope or the refresh nonce changes.
      useEffect(() => {
        if (sessionId === undefined || root === undefined) return undefined;
        const controller = new AbortController();

        (async () => {
          try {
            setError(null);
            // A git source is computed on the Host: a committed revision's bytes
            // are not on disk, so the browser cannot index them.
            if (source !== 'turn') {
              const spec = scopeSpecFor(source, { base: baseRef, commit: commitRef });
              if (spec === null) {
                setGraph(null);
                setTurns([]);
                setStatus({ phase: 'ready', done: 0, total: 0 });
                return;
              }
              setStatus({ phase: 'indexing', done: 0, total: 0 });
              const response = await fetch(
                `${GIT_GRAPH_PATH}?cwd=${encodeURIComponent(root)}&scope=${encodeURIComponent(spec)}`,
                { signal: controller.signal }
              );
              if (!response.ok) {
                const detail = (await response.text()).trim();
                throw new Error(
                  detail === '' ? `git change source failed (${response.status})` : detail
                );
              }
              const document = await response.json();
              if (controller.signal.aborted) return;
              setTurns([]);
              setGraph(document);
              setStatus({ phase: 'ready', done: 0, total: 0 });
              return;
            }
            setStatus({ phase: 'indexing', done: 0, total: 0 });
            const listing = await listSourceFiles(
              remote,
              sessionId,
              root,
              controller.signal,
              (done) => {
                if (!controller.signal.aborted) setStatus({ phase: 'indexing', done, total: 0 });
              }
            );
            if (controller.signal.aborted) return;

            setStatus({ phase: 'reading', done: 0, total: listing.files.size });
            const contents = await readSourceFiles(
              remote,
              sessionId,
              listing.files,
              controller.signal,
              (done, total) => {
                if (!controller.signal.aborted) setStatus({ phase: 'reading', done, total });
              }
            );
            if (controller.signal.aborted) return;

            setStatus({ phase: 'computing', done: 0, total: 0 });
            const discovered = await collectTurns(sessionEvents, sessionId, controller.signal);
            if (controller.signal.aborted) return;
            setTurns(discovered);

            const changed = changedPathsOf(discovered, scope === 'last' ? 'last' : scope);
            const result = analyze({
              root,
              changed,
              files: withChanged([...listing.files.keys()], changed),
              contents,
            });
            result.scan.truncated = listing.truncated;
            if (listing.truncated) result.warnings.push(t.truncated);
            if (result.change.unresolved > 0) {
              result.warnings.push(t.unresolved(result.change.unresolved));
            }
            if (!controller.signal.aborted) {
              setGraph(result);
              setStatus({ phase: 'ready', done: 0, total: 0 });
            }
          } catch (cause) {
            if (!controller.signal.aborted) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setStatus({ phase: 'error', done: 0, total: 0 });
            }
          }
        })();

        return () => controller.abort();
      }, [sessionId, root, scope, nonce, remote, sessionEvents, source, baseRef, commitRef]);

      // A git source reports each path's status and line counts. Declared
      // before the callbacks that depend on it: a dependency array is evaluated
      // during the render that defines the callback.
      const gitFiles = useMemo(() => {
        const byPath = new Map();
        for (const entry of graph?.git?.files ?? []) byPath.set(entry.path, entry);
        return byPath;
      }, [graph]);

      /** Identity of one generation: session, source, directory, conversation. */
      const aiKey = useMemo(
        () =>
          flowKeyOf([
            sessionId,
            scopeSpecFor(source, { base: baseRef, commit: commitRef }) ?? 'unstaged',
            root,
            conversation?.text,
          ]),
        [sessionId, source, baseRef, commitRef, root, conversation]
      );

      // Restore what this plugin already generated for the same material, so a
      // view switch does not look like a lost run.
      // A different commit, branch or source is a different question. The answer
      // on screen belongs to the previous one, and leaving it there made every
      // selection look like a cache hit.
      const scopeIdentity = `${source}|${baseRef ?? ''}|${commitRef ?? ''}`;
      useEffect(() => {
        setAiDocument(null);
        setAiStale(null);
        setAiError(null);
      }, [scopeIdentity]);

      const restored = useMemo(() => flowClientCache.get(aiKey) ?? null, [aiKey]);
      useEffect(() => {
        if (restored === null) return;
        setAiDocument(restored.document);
        if (restored.plan !== undefined && restored.plan !== null) setAiPlan(restored.plan);
      }, [restored, aiKey]);

      // Declared before the effects that call it: a dependency array is
      // evaluated during the render that defines the callback.
      const generateFlow = useCallback(
        async (rebuild) => {
          if (root === undefined || aiBusy) return;
          setAiBusy(true);
          setAiError(null);
          try {
            const query = new URLSearchParams({
              cwd: root,
              scope: scopeSpecFor(source, { base: baseRef, commit: commitRef }) ?? 'unstaged',
            });
            const body = { rebuild: rebuild === true };
            if (conversation !== null && conversation !== undefined) body.context = conversation.text;
            if (aiEffort !== '') body.reasoningEffort = aiEffort;
            if (aiRecord) {
              body.record = true;
              body.instruction = t.aiInstruction;
              if (typeof sessionId === 'string') body.sessionId = sessionId;
            }
            if (aiModel === null) {
              // Reading a property off nothing here is what broke Generate in a
              // real session: say what is missing instead.
              setAiError(copyText(t, 'aiNoModel'));
              setAiBusy(false);
              return;
            }
            const chosenProvider = aiModel.provider;
            const chosenModel = aiModel.model;
            if (chosenProvider !== undefined) body.provider = chosenProvider;
            if (chosenModel !== undefined) body.model = chosenModel;
            const response = await fetch(`${FLOW_PATH}?${query.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (!response.ok) {
              const detail = (await response.text()).trim() || `${response.status}`;
              setAiError(detail);
              flowClientCache.set(aiKey, {
                ...(flowClientCache.get(aiKey) ?? {}),
                document: null,
                error: detail,
              });
              return;
            }
            const value = await response.json();
            setAiDocument(value);
            setAiFlow(0);
            flowClientCache.set(aiKey, {
              ...(flowClientCache.get(aiKey) ?? {}),
              document: value,
              error: null,
            });
          } catch (cause) {
            setAiError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setAiBusy(false);
          }
        },
        [
          root,
          source,
          baseRef,
          commitRef,
          sessionModel,
          aiModel,
          conversation,
          aiRecord,
          sessionId,
          aiBusy,
          aiKey,
          aiEffort,
        ]
      );

      /** What a generation would read, fetched only while the AI tab is open. */
      useEffect(() => {
        if (mode !== 'ai' || root === undefined || aiPlan !== null) return undefined;
        if (source === 'turn') return undefined;
        const controller = new AbortController();
        (async () => {
          try {
            const query = new URLSearchParams({
              cwd: root,
              scope: scopeSpecFor(source, { base: baseRef, commit: commitRef }) ?? 'unstaged',
            });
            if (sessionModel?.provider !== undefined) query.set('provider', sessionModel.provider);
            if (sessionModel?.model !== undefined) query.set('model', sessionModel.model);
            if (conversation !== null && conversation !== undefined) {
              query.set('context', conversation.text);
            }
            const response = await fetch(`${FLOW_PATH}?${query.toString()}`, {
              signal: controller.signal,
            });
            if (!response.ok) {
              const detail = (await response.text()).trim();
              if (!controller.signal.aborted) setAiError(detail || `${response.status}`);
              return;
            }
            const value = await response.json();
            if (controller.signal.aborted) return;
            setAiPlan(value);
            // An out-of-date answer is shown, not hidden: the reviewer may be
            // comparing against it, and only they decide whether to regenerate.
            if (value?.last?.document !== undefined && value.last.document !== null) {
              setAiStale(value.last);
              setAiDocument((current) => current ?? value.last.document);
            }
            const held = flowClientCache.get(aiKey);
            if (held !== undefined) flowClientCache.set(aiKey, { ...held, plan: value });
            // The Host still holds this generation, so recovering it costs
            // nothing: a cached answer is returned without a model call.
            if (
              value?.cached != null &&
              value?.last == null &&
              (flowClientCache.get(aiKey)?.document ?? null) === null
            ) {
              void generateFlow(false);
            }
          } catch {
            /* the tab then simply offers no plan */
          }
        })();
        return () => controller.abort();
      }, [mode, root, source, baseRef, commitRef, sessionModel, conversation, aiPlan, aiKey, generateFlow]);



      /** Open the review pane at the file and line one AI node was based on. */
      const openAnchor = useCallback(
        (node, side) => {
          if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
            setOpenError(t.noOpenResource);
            return;
          }
          setOpenError(null);
          const anchor = (node.anchors ?? [])[0];
          const path = anchor?.path ?? (node.files ?? [])[0];
          const scope =
            scopeSpecFor(source, { base: baseRef, commit: commitRef }) ?? 'unstaged';
          const base = { cwd: root, scope };
          // A step of the original flow points at the old side of the diff, a
          // step of the new flow at the new side.
          if (side === 'before' || side === 'after') base.side = side;
          // Remember the box: the reader needs to see which step this code is.
          setAiNode(typeof node?.id === 'string' ? `${side ?? ''}:${node.id}` : null);
          if (Number.isSafeInteger(anchor?.line)) base.line = anchor.line;
          if (Number.isSafeInteger(anchor?.endLine)) base.endLine = anchor.endLine;
          // A node the model did not ground in a file still deserves an answer:
          // open the source's review rather than doing nothing at all.
          const attempts =
            typeof path === 'string' && path !== ''
              ? [
                  { address: reviewAddress(sessionId), params: { ...base, path: normalizeRelPath(path) } },
                  { address: sessionFileAddress(sessionId, path), params: base.line === undefined ? undefined : { params: { line: base.line } } },
                  { address: reviewAddress(sessionId), params: base },
                ]
              : [{ address: reviewAddress(sessionId), params: base }];
          for (const attempt of attempts) {
            try {
              // The same address for every file: the column keeps ONE review tab
              // and navigates inside it instead of stacking a tab per file.
              sidebarRight.openResource(attempt.address, { params: attempt.params });
              if (typeof path !== 'string' || path === '') setOpenError(t.aiNoAnchor);
              return;
            } catch (cause) {
              setOpenError(cause instanceof Error ? cause.message : String(cause));
            }
          }
        },
        [sidebarRight, root, source, baseRef, commitRef, sessionId, t]
      );

      /** The turn a changed path belongs to, for the product's review pane. */
      const turnCoordinatesFor = useCallback(
        (path) => {
          const wanted = normalizeRelPath(path);
          for (let index = turns.length - 1; index >= 0; index -= 1) {
            const fileIndex = turns[index].summary.files.findIndex(
              (file) => normalizeRelPath(file.path) === wanted
            );
            if (fileIndex >= 0) {
              return { seq: turns[index].seq, turn: turns[index].turn, index: fileIndex };
            }
          }
          return null;
        },
        [turns]
      );

      /** Open the whole source's review: every changed file, walkable in place. */
      const openFile = useCallback(
        (path, line) => {
          if (sidebarRight !== undefined && typeof sidebarRight.openResource === 'function') {
            // A turn already has the product's own review pane — a turn's start
            // and end snapshot — so use it instead of a second renderer.
            if (source === 'turn') {
              const coordinates = turnCoordinatesFor(path);
              if (coordinates !== null) {
                try {
                  const address =
                    `${CHANGES_REVIEW_ADDRESS}${encodeURIComponent(sessionId)}/` +
                    `${coordinates.seq}/${coordinates.turn}`;
                  sidebarRight.openResource(address, { params: { index: coordinates.index } });
                  return;
                } catch {
                  /* fall through to this plugin's own pane */
                }
              }
            }
            // A git source has no turn snapshot, so the plugin's pane renders
            // the comparison; the source travels in params because the pane
            // mounts later and may outlive this view's state.
            try {
              const params = {
                cwd: root,
                scope: scopeSpecFor(source, { base: baseRef, commit: commitRef }) ?? 'unstaged',
                path: normalizeRelPath(path),
              };
              if (line !== undefined && line !== null) params.line = line;
              const label = graph?.git?.label;
              if (typeof label === 'string') params.label = label;
              sidebarRight.openResource(reviewAddress(sessionId), { params });
              return;
            } catch {
              /* no review type registered, or no session surface is mounted */
            }
          }
          const address = sessionFileAddress(sessionId, path);
          const options =
            line === undefined || line === null ? undefined : { params: { line } };
          try {
            // The Sidebar service is the only resource face a conversation view
            // gets; the Sidebar tab's own `tab.actions` belongs to tab slots.
            if (sidebarRight !== undefined && typeof sidebarRight.openResource === 'function') {
              sidebarRight.openResource(address, options);
              return;
            }
            setOpenError('no openResource face is available');
          } catch (cause) {
            setOpenError(cause instanceof Error ? cause.message : String(cause));
          }
        },
        [
          sessionId,
          sidebarRight,
          root,
          source,
          baseRef,
          commitRef,
          gitFiles,
          graph,
          turns,
          turnCoordinatesFor,
        ]
      );

      const copyPath = useCallback((path) => {
        const write = navigator.clipboard?.writeText?.(path);
        if (write !== undefined) {
          write.then(
            () => {
              setCopied(path);
              setTimeout(() => setCopied(null), 1400);
            },
            () => undefined
          );
        }
      }, []);

      const stats = graph?.change ?? { changedCount: 0, componentCount: 0, isolatedFiles: [] };
      const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null;

      const influence = useMemo(() => {
        if (graph === null) return [];
        return graph.nodes
          .filter((n) => n.changed && n.inbound > 0)
          .sort((a, b) => b.inbound - a.inbound || b.degree - a.degree)
          .slice(0, 6);
      }, [graph]);

      const isolated = useMemo(
        () => (graph === null ? [] : graph.nodes.filter((n) => n.changed && n.degree === 0)),
        [graph]
      );

      const clusters = useMemo(() => {
        if (graph === null) return [];
        return graph.components.filter((c) => c.files.length > 1).slice(0, 6);
      }, [graph]);


      const statusLabelOf = useCallback(
        (entry) => {
          if (entry === null || entry === undefined) return null;
          const label = t[STATUS_COPY[entry.status] ?? ''] ?? entry.status;
          const counts =
            entry.untracked === true
              ? t.statusUntracked
              : entry.added === null && entry.deleted === null
                ? null
                : `+${entry.added ?? 0} −${entry.deleted ?? 0}`;
          return { label, counts };
        },
        [t]
      );

      /* ------------------------------------------------------- git sources */

      // Repository facts, fetched once per root: whether the git sources can be
      // offered at all, plus the commit and branch menus.
      useEffect(() => {
        if (root === undefined) return undefined;
        const controller = new AbortController();
        (async () => {
          try {
            const query = new URLSearchParams({ cwd: root });
            if (typeof baseRef === 'string' && baseRef !== '') query.set('base', baseRef);
            const response = await fetch(`${GIT_STATE_PATH}?${query.toString()}`, {
              signal: controller.signal,
            });
            if (!response.ok) {
              // No route (or a Host without the capability) is a different
              // problem from "this directory is not a repository".
              if (!controller.signal.aborted) {
                setGitState(null);
                setGitNotice('unavailable');
              }
              return;
            }
            const value = await response.json();
            if (!controller.signal.aborted) {
              const available = value?.available === true;
              setGitState(available ? value : null);
              setGitNotice(available ? null : 'no-repo');
              // The Host names the comparison base when none was asked for.
              if (available && baseRef === null) setBaseRef(value.base ?? null);
            }
          } catch {
            /* no repository, no route, or aborted: git sources stay hidden */
          }
        })();
        return () => controller.abort();
      }, [root, nonce, baseRef]);

      // The commit menu belongs to one comparison, so switching base or source
      // re-picks the selection instead of keeping a commit that is gone.
      useEffect(() => {
        if (source !== 'commit') return;
        setCommitRef((current) => pickCommitRef(gitState?.commits, current));
      }, [source, gitState]);

      /* ------------------------------------------------------------ render */

      const selectStyle = {
        font: 'inherit',
        fontSize: 12,
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.28))',
        borderRadius: 'var(--dsw-alias-radius-md, 8px)',
        padding: '3px 6px',
        maxWidth: 220,
      };

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
            flexWrap: 'wrap',
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 4 } },
          h(
            Button,
            { active: mode === 'overview', onClick: () => setMode('overview') },
            t.overview
          ),
          h(Button, { active: mode === 'ai', onClick: () => setMode('ai') }, t.aiTab)
        ),
        graph !== null
          ? h(
              'span',
              { style: { fontSize: 11, opacity: 0.75 } },
              t.stats(stats.changedCount, stats.componentCount, isolated.length)
            )
          : null,
        h('div', { style: { flex: 1 } }),
        source === 'turn' && turns.length > 1
          ? h(
              'select',
              {
                value: scope === 'last' ? String(turns[turns.length - 1].turn) : scope,
                onChange: (event) => setScope(event.target.value),
                style: selectStyle,
              },
              [
                h('option', { key: 'last', value: String(turns[turns.length - 1].turn) },
                  t.scopeTurn(turns[turns.length - 1].turn)),
                h('option', { key: 'all', value: 'all' }, t.scopeAll),
                ...turns.slice(0, -1).reverse().map((turn) =>
                  h('option', { key: turn.turn, value: String(turn.turn) }, t.scopeTurn(turn.turn))
                ),
              ]
            )
          : null,
        h(
          'select',
          {
            value: source,
            onChange: (event) => {
              setSource(event.target.value);
              // The state is `commitRef`; the old name threw on every change.
              setCommitRef(null);
            },
            title: t.sourceTitle,
            style: selectStyle,
          },
          [
            h('option', { key: 'turn', value: 'turn' }, t.sourceTurn),
            ...(gitState === null
              ? [
                  // Silence would read as "the feature is missing"; the reason
                  // is usually that this session's directory is not a repository.
                  h(
                    'option',
                    { key: 'no-repo', value: 'turn', disabled: true },
                    gitNotice === 'unavailable' ? t.gitUnavailable : t.noRepo
                  ),
                ]
              : [
                  h('option', { key: 'unstaged', value: 'unstaged' }, t.sourceUnstaged),
                  h('option', { key: 'staged', value: 'staged' }, t.sourceStaged),
                  h('option', { key: 'uncommitted', value: 'uncommitted' }, t.sourceUncommitted),
                  h('option', { key: 'commit', value: 'commit' }, t.sourceCommit),
                  h('option', { key: 'branch', value: 'branch' }, t.sourceBranch),
                ]),
          ]
        ),
        (source === 'commit' || source === 'branch') && gitState !== null
          ? h(
              'select',
              {
                value: baseRef ?? '',
                onChange: (event) => {
                  setBaseRef(event.target.value);
                  setCommitRef(null);
                },
                title: t.baseTitle,
                style: selectStyle,
              },
              (gitState.branches ?? []).length === 0
                ? [h('option', { key: 'none', value: '' }, t.noBase)]
                : (gitState.branches ?? []).map((branch) =>
                    h(
                      'option',
                      { key: `${branch.kind}:${branch.name}`, value: branch.name },
                      branch.kind === 'remote' ? `${branch.name} (remote)` : branch.name
                    )
                  )
            )
          : null,
        source === 'commit' && gitState !== null
          ? h(
              'select',
              {
                value: commitRef ?? '',
                onChange: (event) => setCommitRef(event.target.value),
                title: t.pickCommit,
                style: selectStyle,
                disabled: (gitState.commits ?? []).length === 0,
              },
              (gitState.commits ?? []).length === 0
                ? [h('option', { key: 'none', value: '' }, t.pickCommit)]
                : (gitState.commits ?? []).map((commit) =>
                    h(
                      'option',
                      { key: commit.sha, value: commit.sha },
                      `${commit.short} ${commit.subject}`.slice(0, 72)
                    )
                  )
            )
          : null,
        source === 'commit' && gitState !== null && (gitState.commits ?? []).length === 0
          ? h(
              'span',
              { style: { fontSize: 11, opacity: 0.7 } },
              t.noCommits(baseRef ?? gitState.branch ?? 'HEAD')
            )
          : null,
        gitState !== null && gitState.branch !== null && source !== 'turn'
          ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, t.gitHead(gitState.branch))
          : null,
        // "Review all changes" is gone: clicking any file already opens the whole
        // change set at that file, so a button that opens the same pane without a
        // file was a second way to do one thing.
        mode !== 'ai'
          ? h(Button, { onClick: () => setNonce((n) => n + 1), title: t.refresh }, t.refresh)
          : null
      );

      if (sessionId === undefined || root === undefined) {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          header,
          h('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } }, t.noSession)
        );
      }

      if (status.phase !== 'ready' && status.phase !== 'error') {
        const label =
          status.phase === 'reading'
            ? t.reading(status.done, status.total)
            : t.analyzing;
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          header,
          h(
            'div',
            { style: { padding: 16, fontSize: 12, opacity: 0.75, display: 'flex', gap: 8 } },
            label
          )
        );
      }

      if (status.phase === 'error') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          header,
          h(
            'div',
            { style: { padding: 16, fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' } },
            `${t.error}: ${error ?? ''}`,
            h(Button, { onClick: () => setNonce((n) => n + 1) }, t.retry)
          )
        );
      }

      const selectedFlow = (aiDocument?.flows ?? [])[aiFlow] ?? null;

      /** One side of a comparison, drawn. */
      const flowColumn = (side, title, sideName) =>
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 11, opacity: 0.6 } }, title),
          h(FlowDiagram, {
            side,
            sideName,
            selectedId: aiNode !== null && aiNode.startsWith(`${sideName}:`) ? aiNode.slice(sideName.length + 1) : null,
            onOpen: openAnchor,
            emptyText: t.aiEmptySide,
            noAnchorText: t.aiNoAnchorNode,
          })
        );

      if (mode === 'ai') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          header,
          // Nothing is generated until the user asks, because it costs tokens.
          h(
            'div',
            {
              style: {
                padding: 12,
                borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              },
            },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(Button, {
                active: source !== 'turn',
                onClick: () => generateFlow(aiDocument !== null),
              },
                aiBusy ? t.aiGenerating : aiDocument === null ? t.aiGenerate : t.aiRebuild),
              aiDocument !== null
                ? h('span', { style: { fontSize: 11, opacity: 0.7 } },
                    [t.aiModel(aiDocument.model), aiDocument.usage?.outputTokens !== undefined ? `${aiDocument.usage.outputTokens} tok` : null,
                     aiDocument.cached === true ? t.aiCached : null,
                     typeof aiDocument.generatedAt === 'string' ? t.aiGeneratedAt(aiDocument.generatedAt.slice(0, 19).replace('T', ' ')) : null]
                      .filter(Boolean).join(' · '))
                : h('span', { style: { fontSize: 11, opacity: 0.7 } },
                    aiModel === null
                      ? t.aiModelUnknown
                      : t.aiModel(`${aiModel.provider ?? ''} ${aiModel.model}`.trim())),
              h(
                'label',
                {
                  title: t.aiRecordHint,
                  style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, opacity: 0.8 },
                },
                h('input', {
                  type: 'checkbox',
                  checked: aiRecord,
                  onChange: (event) => setAiRecord(event.target.checked === true),
                }),
                t.aiRecord
              ),
              (aiPlan?.efforts ?? []).length > 0
                ? h(
                    'label',
                    {
                      title: t.aiEffort,
                      style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, opacity: 0.8 },
                    },
                    t.aiEffort,
                    h(
                      'select',
                      {
                        value: aiEffort,
                        onChange: (event) => setAiEffort(event.target.value),
                        style: selectStyle,
                      },
                      [
                        h('option', { key: 'default', value: '' }, t.aiEffortDefault),
                        ...(aiPlan?.efforts ?? []).map((id) =>
                          h('option', { key: id, value: id }, id)
                        ),
                      ]
                    )
                  )
                : null,
            ),
            openError !== null
              ? h('div', { style: { fontSize: 11, opacity: 0.85, fontWeight: 600 } }, openError)
              : null,
            aiError !== null
              ? h(
                  'div',
                  { style: { fontSize: 11, opacity: 0.85, whiteSpace: 'pre-wrap', lineHeight: 1.5 } },
                  aiError
                )
              : null,
            aiDocument?.recorded === true
              ? h('div', { style: { fontSize: 11, opacity: 0.7 } }, t.aiRecorded)
              : aiDocument?.recorded === false
                ? h('div', { style: { fontSize: 11, opacity: 0.8 } }, t.aiRecordFailed(aiDocument.recordError ?? ''))
                : null,
            // Saying which cache an answer would come from is the difference
            // between "it worked" and "I cannot tell".
            aiStale !== null
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      fontSize: 11,
                      padding: '4px 8px',
                      borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                      background: 'var(--dsw-alias-bg-warning-tertiary, rgba(210,153,34,.16))',
                    },
                  },
                  h('span', { style: { fontWeight: 700 } }, t.aiStale),
                  h(
                    'span',
                    null,
                    `${t[
                      aiStale.staleReason === 'both'
                        ? 'aiStaleBoth'
                        : aiStale.staleReason === 'context'
                          ? 'aiStaleContext'
                          : 'aiStaleHead'
                    ]} · ${typeof aiStale.generatedAt === 'string' ? aiStale.generatedAt.slice(0, 19).replace('T', ' ') : ''} · ${t.aiStaleKeep}`
                  )
                )
              : null,
            aiPlan?.lastFailure !== undefined && aiPlan?.lastFailure !== null
              ? h(
                  'div',
                  {
                    style: {
                      fontSize: 11,
                      lineHeight: 1.6,
                      padding: '4px 8px',
                      borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                      background: 'var(--dsw-alias-bg-warning-tertiary, rgba(210,153,34,.16))',
                    },
                  },
                  t.aiLastFailure(aiPlan.lastFailure.code)
                )
              : null,
            aiDocument !== null
              ? h(
                  'div',
                  { style: { fontSize: 11, opacity: 0.7 } },
                  aiDocument.cached === true
                    ? t.aiCacheHit
                    : aiDocument.recorded === true
                      ? t.aiCacheMemory
                      : null
                )
              : aiPlan !== null
                ? h(
                    'div',
                    { style: { fontSize: 11, opacity: 0.7 } },
                    aiPlan.cached !== null && aiPlan.cached !== undefined
                      ? t.aiCacheDisk
                      : aiPlan.diskCached === true
                        ? t.aiCacheDisk
                        : t.aiCacheNone
                  )
                : null,
            aiDocument === null && aiError === null
              ? h(
                  'div',
                  { style: { fontSize: 11, opacity: 0.7, lineHeight: 1.6 } },
                  source === 'turn'
                    ? t.aiNeedScope
                    : aiPlan === null
                      ? t.analyzing
                      : aiPlan.plan.files === 0
                        ? t.emptyScope
                        : [
                            t.aiIntroBody,
                            t.aiContext(
                              aiPlan.plan.excerptFiles ?? aiPlan.plan.files,
                              `${Math.round((aiPlan.plan.excerptBytes ?? 0) / 1024)}KB`,
                              conversation?.messages ?? 0,
                              aiPlan.plan.maxOutputTokens ?? 0
                            ),
                          ].join(' ')
                )
              : null
          ),
          aiDocument === null
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: 12,
                    overflow: 'auto',
                    flex: 1,
                    minHeight: 0,
                  },
                },
                (aiDocument.flows ?? []).length > 1
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('span', { style: { fontSize: 11, opacity: 0.6 } }, t.aiPickFlow),
                      h(
                        'select',
                        {
                          value: String(aiFlow),
                          onChange: (event) => setAiFlow(Number.parseInt(event.target.value, 10) || 0),
                          style: selectStyle,
                        },
                        aiDocument.flows.map((flow, index) =>
                          h('option', { key: flow.id, value: String(index) }, flow.title)
                        )
                      )
                    )
                  : null,
                selectedFlow === null
                  ? null
                  : h(
                      'div',
                      { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
                      flowColumn(selectedFlow.before, t.aiBefore, 'before'),
                      flowColumn(selectedFlow.after, t.aiAfter, 'after')
                    ),
                // Summary, risks and basis are gone: the diagram is the answer,
                // and a wall of prose under it was never read.,
                // Debugging lives here rather than in the conversation: the
                // material is what the user must *not* be quoted as saying.
                aiDocument.debug === undefined
                  ? null
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h(
                        Button,
                        { active: aiDebug, onClick: () => setAiDebug((value) => !value) },
                        t.aiDebug
                      ),
                      aiDebug
                        ? h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                            h('div', { style: { fontSize: 10, opacity: 0.55 } }, t.aiDebugHint),
                            ...[
                              [t.aiDebugSystem, aiDocument.debug.system],
                              [t.aiDebugUser, aiDocument.debug.user],
                              [t.aiDebugRaw, aiDocument.debug.raw],
                            ].map(([label, text], index) =>
                              h(
                                'div',
                                { key: `debug-${index}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                                h('div', { style: { fontSize: 10, opacity: 0.6 } }, label),
                                h(
                                  'pre',
                                  {
                                    style: {
                                      margin: 0,
                                      maxHeight: 220,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      fontSize: 10,
                                      lineHeight: 1.5,
                                      padding: 6,
                                      borderRadius: 'var(--dsw-alias-radius-sm, 4px)',
                                      background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.08))',
                                    },
                                  },
                                  text ?? ''
                                )
                              )
                            )
                          )
                        : null
                    )
              )
        );
      }

      if (graph === null || graph.change.changedCount === 0) {
        // An empty graph always has a reason, and saying it is the difference
        // between "this feature is broken" and "nothing changed here".
        const scopeEmpty = graph !== null && source !== 'turn' && (graph.git?.files?.length ?? 0) === 0;
        // An empty commit menu is its own reason: the comparison has no delta,
        // so there is no commit to graph yet.
        const emptyMenu = source === 'commit' && (gitState?.commits ?? []).length === 0;
        const unresolved = graph?.change?.unresolved ?? 0;
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          header,
          h(
            'div',
            { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.7 } },
            emptyMenu
              ? t.noCommits(baseRef ?? gitState?.branch ?? 'HEAD')
              : scopeEmpty
                ? t.emptyScope
                : t.empty,
            unresolved > 0 ? h('div', null, t.emptyUnresolved(unresolved)) : null,
            ...(graph?.warnings ?? []).map((warning, index) =>
              h('div', { key: `warning-${index}` }, String(warning))
            )
          )
        );
      }

      const sidebar = h(
        'div',
        {
          style: {
            width: 268,
            borderLeft: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
            overflow: 'auto',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          },
        },
        isolated.length > 0
          ? h(
              Section,
              { title: t.isolatedTitle },
              h('div', { style: { fontSize: 11, opacity: 0.65, lineHeight: 1.5 } }, t.isolatedHint),
              isolated.map((node) =>
                h(FileRow, {
                  key: node.id,
                  node,
                  onOpen: openFile,
                  onCopy: copyPath,
                  t,
                  status: statusLabelOf(gitFiles.get(node.id)),
                })
              )
            )
          : null,
        clusters.length > 0
          ? h(
              Section,
              { title: t.clustersTitle },
              h('div', { style: { fontSize: 11, opacity: 0.65, lineHeight: 1.5 } }, t.clustersHint),
              clusters.map((cluster) =>
                h(
                  'div',
                  {
                    key: cluster.id,
                    style: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4 },
                  },
                  h(
                    'div',
                    { style: { fontSize: 11, opacity: 0.6 } },
                    `#${cluster.id + 1} · ${cluster.files.length} files · ${cluster.internalEdges} edges`
                  ),
                  cluster.files.map((file) =>
                    h(
                      'button',
                      {
                        key: file,
                        type: 'button',
                        onClick: () => openFile(file, undefined),
                        style: {
                          appearance: 'none',
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          padding: 0,
                          textAlign: 'left',
                          font: 'inherit',
                          fontSize: 12,
                          cursor: 'pointer',
                          wordBreak: 'break-all',
                        },
                      },
                      file
                    )
                  )
                )
              )
            )
          : null,
        influence.length > 0
          ? h(
              Section,
              { title: t.influenceTitle },
              h('div', { style: { fontSize: 11, opacity: 0.65, lineHeight: 1.5 } }, t.influenceHint),
              influence.map((node) =>
                h(FileRow, {
                  key: node.id,
                  node,
                  onOpen: openFile,
                  onCopy: copyPath,
                  t,
                  status: statusLabelOf(gitFiles.get(node.id)),
                })
              )
            )
          : null,
        copied !== null
          ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, `${t.copied}: ${copied}`)
          : null
      );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        zen ? null : header,
        // One view, not four tabs: the picture is always the changed files and
        // their references, so there is nothing to filter by.
        h(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0 } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: { position: 'relative', display: 'flex', flex: 1, minHeight: 0 } },
              h(GraphCanvas, {
                graph,
                selected,
                onSelect: setSelected,
                onOpen: openFile,
                t,
                scopeLabel: graph.git?.label ?? '',
                // Rendered by the canvas in its own control row, so the two
                // floating buttons are laid out together and cannot collide.
                toolbar: h(
                  Button,
                  {
                    onClick: () => setZen((value) => !value),
                    title: copyText(t, zen ? 'zenOff' : 'zenOn'),
                  },
                  zen ? '⌄' : '⌃'
                ),
              })
            )
          ),
          SHOW_SIDE_PANEL ? sidebar : null
        ),
        openError !== null
          ? h(
              'div',
              {
                style: {
                  padding: '4px 12px',
                  fontSize: 11,
                  color: 'var(--dsw-alias-warning-primary, #d99a00)',
                },
              },
              `open failed: ${openError}`
            )
          : null,
        graph.warnings.length > 0
          ? h(
              'div',
              {
                style: {
                  padding: '4px 12px',
                  fontSize: 11,
                  opacity: 0.6,
                  borderTop:
                    '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
                },
              },
              graph.warnings.join(' · ')
            )
          : null,
        SHOW_NODE_DETAIL
          ? h(Detail, {
              node: selectedNode,
              t,
              onOpen: openFile,
              onCopy: copyPath,
              onClose: () => setSelected(null),
            })
          : null
      );
    }

    /* ------------------------------------------------------------ register */

    /**
     * The middle-column view tab declaration. `label` is re-read on every
     * render, so it resolves through the locale service bound to this plugin.
     */
    function reviewGraphDefinition(bindLocale) {
      return {
        name: 'conversation.view',
        id: VIEW_ID,
        order: 20,
        locale: NS,
        label: () => bindLocale('view'),
        inject: () => ({}),
      };
    }

    /**
     * Read a value from the sessions list store and stay subscribed to it.
     *
     * The session standard kit's `useSession` is a *session snapshot* selector
     * (open state, paging flags); the workspace root lives on the sessions list
     * record instead, so it is read here with an explicit subscription rather
     * than guessed from that snapshot.
     */
    function useSessionsRecord(sessions, sessionId, pick) {
      const read = useCallback(() => {
        if (sessions?.list === undefined || sessionId === undefined) return undefined;
        try {
          const record = sessions.list.getSnapshot()?.byId?.[sessionId];
          return record === undefined ? undefined : pick(record);
        } catch {
          return undefined;
        }
      }, [sessions, sessionId, pick]);

      const [value, setValue] = useState(read);

      useEffect(() => {
        setValue(read());
        const list = sessions?.list;
        if (list === undefined || typeof list.subscribe !== 'function') return undefined;
        return list.subscribe(() => setValue(read()));
      }, [read, sessions]);

      return value;
    }

    const pickCwd = (record) => record?.cwd ?? record?.workspaceRoot ?? undefined;

    /**
     * Project the change announcements out of a session event window.
     *
     * The log is not a field on the session or on the list row: it is the
     * binding's `eventSource`, a `MutableSessionEventSource` whose cached
     * snapshot carries wrapper entries shaped `{ event, type }`. Only
     * `workspace/changes` is kept, because the window also carries high-rate
     * assistant frames and the view re-indexes the workspace whenever this
     * array's identity changes.
     * @param eventSource the binding's event source, when one is materialized
     * @returns ascending change events, or undefined without a source
     */
    function pickChangeEvents(eventSource) {
      if (eventSource === undefined || eventSource === null) return undefined;
      try {
        const snapshot =
          typeof eventSource.getSnapshot === 'function'
            ? eventSource.getSnapshot()
            : undefined;
        const entries = snapshot?.entries;
        if (!Array.isArray(entries)) return undefined;
        const events = [];
        for (const entry of entries) {
          const event =
            entry !== null && typeof entry === 'object' ? entry.event ?? entry : entry;
          if (event === undefined || event === null) continue;
          if (event.type !== 'workspace/changes') continue;
          events.push(event);
        }
        return events;
      } catch {
        return undefined;
      }
    }

    /** Whether two projections describe the same announcements. */
    function sameChangeEvents(a, b) {
      if (a === b) return true;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] === b[i]) continue;
        if (a[i].seq !== b[i].seq) return false;
        const turnA = a[i].data === undefined ? undefined : a[i].data.turn;
        const turnB = b[i].data === undefined ? undefined : b[i].data.turn;
        if (turnA !== turnB) return false;
      }
      return true;
    }

    /** Flatten one message's text blocks. */
    function messageText(message) {
      if (message === null || typeof message !== 'object') return '';
      const content = message.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      return parts.join('\n');
    }

    /** Clip one excerpt, marking that it was cut. */
    function clip(text, limit) {
      const value = String(text ?? '').trim();
      return value.length <= limit ? value : `${value.slice(0, limit)}…`;
    }

    /**
     * What the conversation was about, for the business-flow prompt.
     *
     * git says what changed; only the conversation says why. The session log is
     * the source: the last user requests, what the assistant said it did, and
     * the product's own compaction summary when the session is long. Everything
     * is bounded, and the total is capped so the prompt cannot grow unnoticed.
     * @param eventSource the binding's event source
     * @returns `{ text, messages }`, or null when the log holds nothing useful
     */
    function conversationDigest(eventSource, limits = {}) {
      const maxChars = limits.maxChars ?? 4000;
      const maxUser = limits.maxUser ?? 3;
      const maxAssistant = limits.maxAssistant ?? 2;
      if (eventSource === undefined || eventSource === null) return null;
      let entries;
      try {
        const snapshot =
          typeof eventSource.getSnapshot === 'function' ? eventSource.getSnapshot() : undefined;
        entries = snapshot?.entries;
      } catch {
        return null;
      }
      if (!Array.isArray(entries)) return null;

      const users = [];
      const assistants = [];
      let summary = '';
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = entries[index]?.event ?? entries[index];
        const type = event?.type;
        if (type === 'user/message') {
          const text = clip(messageText(event.data), 900);
          if (text !== '') users.push(text);
        } else if (type === 'assistant/message') {
          const text = clip(messageText(event.data?.message), 600);
          if (text !== '') assistants.push(text);
        } else if (type === 'compaction/summary' && summary === '') {
          const text = clip(
            typeof event.data?.summary === 'string'
              ? event.data.summary
              : messageText(event.data?.message),
            1200
          );
          if (text !== '') summary = text;
        }
        if (users.length >= maxUser && assistants.length >= maxAssistant && summary !== '') break;
      }

      const parts = [];
      if (summary !== '') parts.push(`Earlier session summary:\n${summary}`);
      if (users.length > 0) {
        parts.push(`User requests (oldest first):\n${[...users].reverse().map((text) => `- ${text}`).join('\n')}`);
      }
      if (assistants.length > 0) {
        parts.push(`What was done (oldest first):\n${[...assistants].reverse().map((text) => `- ${text}`).join('\n')}`);
      }
      const text = clip(parts.join('\n\n'), maxChars);
      if (text === '') return null;
      return { text, messages: users.length + assistants.length + (summary === '' ? 0 : 1) };
    }

    /** The conversation digest, kept live. */
    function useConversationDigest(sessions, sessionId) {
      const source = useMemo(() => {
        if (sessions === undefined || sessionId === undefined) return undefined;
        try {
          return sessions.binding(sessionId)?.eventSource;
        } catch {
          return undefined;
        }
      }, [sessions, sessionId]);
      const [digest, setDigest] = useState(() => conversationDigest(source));
      useEffect(() => {
        setDigest(conversationDigest(source));
        if (source === undefined || typeof source.subscribe !== 'function') return undefined;
        return source.subscribe(() => setDigest(conversationDigest(source)));
      }, [source]);
      return digest;
    }

    /**
     * The model the session last selected, read from its own log.
     *
     * `model/selection` is appended by the session controller, so the view can
     * ask the Host to bill the same model the user is already talking to
     * without a second picker. Field names are read defensively because the
     * selection object is owned by that service.
     * @param eventSource the binding's event source
     * @returns `{ provider, model }`, or null when the log names neither
     */
    function pickSessionModel(eventSource) {
      if (eventSource === undefined || eventSource === null) return null;
      try {
        const snapshot =
          typeof eventSource.getSnapshot === 'function' ? eventSource.getSnapshot() : undefined;
        const entries = snapshot?.entries;
        if (!Array.isArray(entries)) return null;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const event = entries[index]?.event ?? entries[index];
          if (event?.type !== 'model/selection') continue;
          const data = event.data ?? {};
          const provider = data.provider ?? data.route?.provider ?? data.selection?.provider;
          const model = data.model ?? data.route?.model ?? data.selection?.model;
          if (typeof provider === 'string' || typeof model === 'string') {
            return {
              provider: typeof provider === 'string' ? provider : undefined,
              model: typeof model === 'string' ? model : undefined,
            };
          }
          return null;
        }
        return null;
      } catch {
        return null;
      }
    }

    /** The session's last model selection, kept live. */
    function useSessionModel(sessions, sessionId) {
      const source = useMemo(() => {
        if (sessions === undefined || sessionId === undefined) return undefined;
        try {
          return sessions.binding(sessionId)?.eventSource;
        } catch {
          return undefined;
        }
      }, [sessions, sessionId]);
      const [model, setModel] = useState(() => pickSessionModel(source));
      useEffect(() => {
        setModel(pickSessionModel(source));
        if (source === undefined || typeof source.subscribe !== 'function') return undefined;
        return source.subscribe(() => setModel(pickSessionModel(source)));
      }, [source]);
      return model;
    }

    /**
     * Read the session's change announcements and stay subscribed to them.
     *
     * `eventSource.subscribe` is notification-only — it never calls the
     * listener on registration — so the first read happens here. A streamed
     * token frame republishes the window constantly; the projected array keeps
     * its identity unless a `workspace/changes` announcement actually changed,
     * which is what keeps the workspace index from being rebuilt per frame.
     */
    function useChangeEvents(sessions, sessionId) {
      const [events, setEvents] = useState(undefined);

      const source = useMemo(() => {
        if (sessions === undefined || sessionId === undefined) return undefined;
        try {
          const binding = sessions.binding(sessionId);
          return binding?.eventSource;
        } catch {
          return undefined;
        }
      }, [sessions, sessionId]);

      useEffect(() => {
        const read = () => {
          const next = pickChangeEvents(source);
          setEvents((previous) => (sameChangeEvents(previous, next) ? previous : next));
        };
        read();
        if (source === undefined || typeof source.subscribe !== 'function') {
          return undefined;
        }
        return source.subscribe(read);
      }, [source]);

      return events;
    }

    /**
     * View body. The framework hands it the session standard kit plus the
     * child-render share; the sessions list and the Remote face are captured at
     * registration time.
     */
    function ReviewGraphBody(bodyProps) {
      const { sessionId, useSession, t } = bodyProps;
      const base = typeof t === 'function' ? t : (key) => String(key);
      // The copy table mixes plain strings with small formatters. The locale
      // service resolves strings through the function, so the formatters ride
      // along as properties of that same function.
      const translate = base;
      for (const [key, entry] of Object.entries(COPY.zh)) {
        if (entry === undefined || entry === null) continue;
        if (typeof entry === 'function') translate[key] = entry;
        else translate[key] = base(key);
      }
      for (const [key, entry] of Object.entries(COPY.en)) {
        if (entry === undefined || entry === null) continue;
        if (translate[key] === undefined) {
          translate[key] = typeof entry === 'function' ? entry : base(key);
        }
      }
      const sessions = bodyProps.sessions;
      const remote = bodyProps.remote;
      const sidebarRight = bodyProps.sidebarRight;

      const fromStore = useSessionsRecord(sessions, sessionId, pickCwd);
      const changeEvents = useChangeEvents(sessions, sessionId);
      const sessionModel = useSessionModel(sessions, sessionId);
      const conversation = useConversationDigest(sessions, sessionId);

      const fromBinding = useMemo(() => {
        if (sessions === undefined || sessionId === undefined) return undefined;
        try {
          const binding = sessions.binding(sessionId);
          return binding?.session?.cwd ?? binding?.session?.workspaceRoot ?? undefined;
        } catch {
          return undefined;
        }
      }, [sessions, sessionId]);

      // Last resort: the session snapshot selector, in case a product build
      // exposes the working directory there.
      const selectRoot = useCallback(
        (session) => session?.cwd ?? session?.workspaceRoot ?? undefined,
        []
      );
      const fromSnapshot =
        typeof useSession === 'function' ? useSession(selectRoot) : undefined;

      return h(ReviewGraphView, {
        sessionId,
        root: fromStore ?? fromBinding ?? fromSnapshot,
        sessionEvents: changeEvents,
        sessionModel,
        conversation,
        remote,
        sidebarRight,
        t: translate,
      });
    }

    return {
      // `remote.workspaceFiles` is its own registered service — the Remote
      // carrier alone is not enough. Cordis answers `ctx.remote.workspaceFiles`
      // with `cannot get property "remote.workspaceFiles" without inject`
      // unless the dotted name is declared, exactly as the shipped file panes do.
      inject: [
        'slots',
        'locale',
        'sessions',
        'sidebarRight',
        'sidebarRightTabs',
        'remote',
        'remote.workspaceFiles',
      ],
      /**
       * Internal handles for the self-checks. The module loader and the slot
       * registry only read `apply` / `inject`, so this stays inert at runtime.
       */
      __test__: {
        ReviewGraphView,
        ReviewGraphBody,
        layoutGraph,
        modelForGeneration,
        analyze,
        unwrapRemote,
        listSourceFiles,
        readSourceFiles,
        pickChangeEvents,
        sameChangeEvents,
        scopeSpecFor,
        pickCommitRef,
        withChanged,
        reviewAddress,
        parseReviewAddress,
        adaptProductDiff,
        stepFile,
        pickSessionModel,
        conversationDigest,
        layoutFlow,
        graphCanvas: GraphCanvas,
        strongestEdges,
        edgePath,
        languageForPath,
        highlightLines,
        prismLanguageForPath,
        highlightWithPrism,
        flattenPrismTokens,
      },
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }),
          'review-graph: dictionaries'
        );

        const titleOf = (key) => {
          try {
            return ctx.locale.bind(NS)(key);
          } catch {
            return COPY.en[key] ?? String(key);
          }
        };

        // The review pane: this plugin's own resource type, so a node click can
        // open a comparison instead of the plain text preview. The default
        // priority band is `extension`, the highest, which is right for a type
        // from outside the product.
        ctx.effect(
          () => ctx.sidebarRightTabs.register(reviewDefinition(titleOf)),
          'review-graph: review type'
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: REVIEW_KIND, locale: NS },
                (paneProps) =>
                  h(
                    ViewBoundary,
                    { label: 'review pane' },
                    ReviewPane({ ...paneProps, t: titleOf })
                  )
              )
            ),
          'review-graph: review pane'
        );

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                reviewGraphDefinition((key) => {
                  try {
                    return ctx.locale.bind(NS)(key);
                  } catch {
                    return COPY.en[key] ?? String(key);
                  }
                }),
                (bodyProps) =>
                  h(
                    ViewBoundary,
                    { label: 'review graph' },
                    h(ReviewGraphBody, {
                      ...bodyProps,
                      sessions: ctx.sessions,
                      remote: ctx.remote,
                      sidebarRight: ctx.sidebarRight,
                    })
                  )
              )
            ),
          'review-graph: view'
        );
      },
    };
  },
});
