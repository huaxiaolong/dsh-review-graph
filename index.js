/**
 * review-graph — Host half.
 *
 * The graph is rendered in the browser (the Client view owns the rendering),
 * but it cannot always be *computed* there. This Host half does the three
 * things only the Host can do:
 *
 *   1. it makes the bundle mountable and gives the Plugin Manager a real entry;
 *   2. it exposes `review_graph` to the agent, so a change set can be turned
 *      into the same graph document *without* opening the UI;
 *   3. it resolves git change sources — unstaged, staged, uncommitted, one
 *      commit, or one branch against HEAD — and serves them to the view over
 *      an authenticated route. A committed revision's file contents are not in
 *      the working tree, so those graphs must be built here.
 *
 * Working-tree reading happens through `ctx.fs`, git through `ctx.subprocess`,
 * and the route rides `ctx.connection.fetch`, whose owner supplies browser
 * authentication.
 */

import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyze, SOURCE_EXT, IGNORED_DIRS, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, normalizeRel } from './lib/analyze-core.mjs';
import { parsePatch, wholeFile } from './lib/diff.mjs';
import {
  FLOW_LIMITS,
  FLOW_INSTRUCTION,
  flowCacheKey,
  flowAnswerText,
  flowPrompt,
  flowRecordText,
  parseFlowDocument,
  stableHash,
} from './lib/flow.mjs';
import {
  GIT_ENV,
  filePatch,
  listBranches,
  listCommits,
  listCommitsBetween,
  pickBaseBranch,
  listTree,
  parseScope,
  readBlob,
  repoInfo,
  resolveScope,
} from './lib/git.mjs';

export const name = 'review-graph';

/** Services this Host half needs before it may activate. */
export const inject = ['fs', 'tools'];

const DEFAULT_MAX_FILES = 3000;
/** Bytes of one git command's stdout retained. */
const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** Milliseconds one git command may run. */
const GIT_TIMEOUT_MS = 30_000;
/** Milliseconds a git child gets to exit after termination starts. */
const GIT_GRACE_MS = 2_000;
/**
 * Where generations survive a Host restart.
 *
 * The in-memory map already survives a page reload, but an application restart
 * would throw away a generation the user paid for. This is a cache, not a
 * record: it holds the document and its provenance, and the newest few survive.
 */
const FLOW_DISK_KEEP = 20;

/**
 * The one storage identity of a source: its repository and its change source.
 *
 * Deliberately blind to HEAD and to the conversation digest — those live inside
 * the entry, so a generation that no longer matches the material is still kept,
 * labelled stale, and left for the user to read or replace. One source, one
 * file: writing over it is the whole policy.
 */
export function flowStem(root, scope) {
  return stableHash(`${root}\u0000${scope}`);
}

/** The cache directory: `<DSH_HOME>/storages/review-graph-flows`. */
export function flowCacheDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'review-graph-flows');
}

/** Read one cached generation from disk, or null. */
async function readCachedFlow(dir, key) {
  try {
    const text = await readFile(join(dir, `${key}.json`), 'utf8');
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || typeof value.document !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/** Write one cached generation, then keep only the newest few. */
async function writeCachedFlow(dir, key, entry) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, `${key}.json`),
      `${JSON.stringify({
        document: entry.document,
        model: entry.model,
        provider: entry.provider,
        usage: entry.usage,
        generatedAt: entry.generatedAt,
        head: entry.head ?? null,
        contextHash: entry.contextHash ?? null,
        root: entry.root ?? null,
        scope: entry.scope ?? null,
      })}\n`,
      { mode: 0o600 }
    );
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    if (names.length <= FLOW_DISK_KEEP) return;
    const dated = [];
    for (const name of names) {
      try {
        dated.push({ name, time: (await stat(join(dir, name))).mtimeMs });
      } catch {
        /* a file that vanished is already pruned */
      }
    }
    dated.sort((left, right) => right.time - left.time);
    for (const stale of dated.slice(FLOW_DISK_KEEP)) {
      await rm(join(dir, stale.name), { force: true });
    }
  } catch {
    /* a cache that cannot be written must never fail a generation */
  }
}

/** Characters of prompt or answer the panel is handed for inspection. */
const DEBUG_MAX_CHARS = 24_000;

/** Clip inspection text, marking that it was cut. */
function clipDebug(text) {
  const value = String(text ?? '');
  return value.length <= DEBUG_MAX_CHARS ? value : `${value.slice(0, DEBUG_MAX_CHARS)}\n… (clipped)`;
}

/** Generations kept in memory, keyed by the material they describe. */
const FLOW_CACHE_LIMIT = 8;
/** Changed files whose excerpts are offered to the model. */
/* Every changed file's excerpt is sent; there is no file cap on the material. */

/** Commits the picker offers inside one branch comparison. */
const COMMIT_MENU_LIMIT = 200;
/** Parallel blob reads when a graph is built from a revision. */
const BLOB_CONCURRENCY = 8;

/* ---------------------------------------------------------------- git seam */

/**
 * Build the git execution seam over `ctx.subprocess`, with the posture the
 * shipped turn recorder uses: scrubbed ambient git configuration, no terminal
 * prompt, no optional locks (a read never rewrites `.git/index`), stable
 * message language, bounded output, and a deadline.
 * @param ctx host context carrying `subprocess`
 * @returns `exec(args, { cwd, signal }) → { exitCode, stdout, stderr }`
 */
export function createGitExec(ctx) {
  let executable;
  return async (args, options) => {
    const cwd = options?.cwd;
    const signal = options?.signal;
    executable ??= await ctx.subprocess.resolveExecutable('git');
    const deadline = AbortSignal.timeout(GIT_TIMEOUT_MS);
    const bound =
      signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: 16 * 1024 },
      },
      graceMs: GIT_GRACE_MS,
      signal: bound,
      env: { ...GIT_ENV },
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '' };
    const stderr = handle.collected.stderr?.readFrom(0) ?? { text: '' };
    return {
      exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : 1,
      stdout: stdout.text ?? '',
      stderr: stderr.text ?? '',
      truncated: stdout.lossy === true,
    };
  };
}

/* ------------------------------------------------------------------- walk */

function extnameOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * Collect indexable source files under a root through `ctx.fs`.
 * @param ctx owning plugin context
 * @param root absolute workspace root
 * @param signal cancellation
 * @param limits `{ maxFiles, maxFileBytes, maxTotalBytes }`
 */
async function collectSourceFiles(ctx, root, signal, limits) {
  const rels = [];
  const absolute = new Map();
  const queue = [''];
  let totalBytes = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (signal.aborted) break;
    const dir = queue.shift();
    const dirPath = dir === '' ? root : root.replace(/\/+$/, '') + '/' + dir;
    let entries;
    try {
      const target = await ctx.fs.resolve(dirPath, { signal });
      const listing = await ctx.fs.listDir(target, signal);
      entries = listing;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir === '' ? entry.name : dir + '/' + entry.name;
      if (entry.type === 'directory') {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        queue.push(rel);
        continue;
      }
      if (entry.type !== 'file') continue;
      if (!SOURCE_EXT.has(extnameOf(entry.name))) continue;
      if (rels.length >= limits.maxFiles) {
        truncated = true;
        break;
      }
      let size = 0;
      try {
        const stat = await ctx.fs.stat(entry.target, signal);
        size = typeof stat?.size === 'number' ? stat.size : 0;
      } catch {
        continue;
      }
      if (size > limits.maxFileBytes) continue;
      if (totalBytes + size > limits.maxTotalBytes) {
        truncated = true;
        break;
      }
      totalBytes += size;
      rels.push(normalizeRel(rel));
      absolute.set(normalizeRel(rel), entry.target);
    }
    if (truncated) break;
  }

  return { rels, absolute, truncated, totalBytes };
}

/** Read every indexed file, tolerating binary and unreadable ones. */
async function readAll(ctx, absolute, signal) {
  const contents = new Map();
  for (const [rel, target] of absolute) {
    if (signal.aborted) break;
    try {
      contents.set(rel, await ctx.fs.readText(target, signal));
    } catch {
      /* binary, oversized, or unreadable: indexed as a node without edges */
    }
  }
  return contents;
}

/* ------------------------------------------------------------------ build */

/**
 * Resolve the workspace root the tool should analyze.
 * @returns an absolute path, or undefined when the agent has no workspace.
 */
function workspaceRootOf(ctx, exec) {
  const session = exec?.session;
  if (session !== undefined && session !== null) {
    const cwd = session.cwd ?? session.header?.cwd ?? session.workspaceRoot;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  }
  const agent = exec?.agent;
  const agentCwd = agent?.session?.cwd ?? agent?.cwd;
  if (typeof agentCwd === 'string' && agentCwd.length > 0) return agentCwd;
  return undefined;
}

/**
 * Build the review graph document for a workspace and change set.
 * @param ctx owning plugin context
 * @param options root, changed paths, caps, cancellation
 * @returns the graph document plus any extra warnings
 */
export async function buildGraph(ctx, options) {
  const root = options.root;
  const signal = options.signal ?? new AbortController().signal;
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  };

  const scan = await collectSourceFiles(ctx, root, signal, limits);
  const contents = await readAll(ctx, scan.absolute, signal);
  const changed = (options.changed ?? []).map(normalizeRel).filter((rel) => rel !== '');

  const graph = analyze({ root, changed, files: withChanged(scan.rels, changed.slice(0, limits.maxFiles)), contents });
  graph.scan.truncated = scan.truncated || changed.length > limits.maxFiles;
  graph.scan.bytesRead = scan.totalBytes;
  if (scan.truncated) {
    graph.warnings.push('workspace scan hit its size cap; some files were not indexed');
  }
  return graph;
}

/* -------------------------------------------------------------- git graphs */

/**
 * The file universe for one graph: the indexed sources, plus every changed path.
 *
 * A change set must always be visible. `.gitignore`, a workflow file, or a
 * lockfile is a real change even though only source files take part in the
 * reference analysis — and indexing every non-source file in a repository would
 * make the walk pay for files nobody reviews. Without this union a change set
 * made only of such files resolves to nothing and the view shows an empty state.
 * @param files indexed source paths
 * @param changed changed paths, already repository-relative
 * @returns `files` followed by the changed paths not already in it
 */
export function withChanged(files, changed) {
  const seen = new Set(files);
  const all = [...files];
  for (const rel of changed) {
    if (rel === '' || seen.has(rel)) continue;
    seen.add(rel);
    all.push(rel);
  }
  return all;
}

/** Whether a repository path is worth indexing, by the same rules as the walk. */
function isIndexablePath(rel) {
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.') || IGNORED_DIRS.has(segment)) return false;
  }
  return SOURCE_EXT.has(extnameOf(rel));
}

/** Run `worker` over `items` with a bounded number of overlapping calls. */
async function mapLimited(items, limit, worker, signal) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * Build the graph for one git change source.
 *
 * A revision scope (one commit, or a branch against its merge base) reads the
 * file universe and every blob *at that revision*: those bytes are not on disk,
 * so the analysis cannot be done in the browser. A working-tree scope
 * (unstaged, staged, uncommitted) reads through `ctx.fs` as usual, but still
 * analyses the repository root so its paths line up with git's.
 *
 * @param ctx host context carrying `fs`
 * @param options exec, cwd, parsed scope spec, caps, cancellation
 * @returns the same graph document the Client analyzer produces, plus `git`
 */
export async function buildGitGraph(ctx, options) {
  const exec = options.exec;
  const cwd = options.cwd;
  const signal = options.signal ?? new AbortController().signal;
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  };

  const info = await repoInfo(exec, cwd, signal);
  if (info === null) {
    throw new Error(`${cwd} is not inside a git repository`);
  }
  const scope = await resolveScope(exec, cwd, options.spec, signal);
  const root = info.root;

  const changed = [];
  for (const entry of scope.changed) {
    const rel = normalizeRel(entry.path);
    if (rel !== '' && !changed.includes(rel)) changed.push(rel);
  }
  // The change set rides on top of the indexed sources, so a branch diff of
  // thousands of files would otherwise blow past the index cap; the paths left
  // out stay listed and are reported as unresolved.
  const promoted = changed.slice(0, limits.maxFiles);

  let files;
  let contents;
  let truncated = false;
  let scan;

  if (scope.revision === null) {
    try {
      scan = await collectSourceFiles(ctx, root, signal, limits);
      files = withChanged(scan.rels, promoted);
      contents = await readAll(ctx, scan.absolute, signal);
      truncated = scan.truncated;
    } catch (error) {
      // A sandbox that refuses to walk the repository root may still allow the
      // session's own directory; the changed paths above it then stay unresolved.
      scan = await collectSourceFiles(ctx, cwd, signal, limits);
      files = withChanged(scan.rels, promoted);
      contents = await readAll(ctx, scan.absolute, signal);
      truncated = scan.truncated;
    }
  } else {
    const tree = await listTree(exec, root, scope.revision, signal);
    files = [];
    let totalBytes = 0;
    for (const rel of tree) {
      if (!isIndexablePath(rel)) continue;
      if (files.length >= limits.maxFiles) {
        truncated = true;
        break;
      }
      files.push(rel);
    }
    files = withChanged(files, promoted);
    contents = new Map();
    await mapLimited(
      files,
      BLOB_CONCURRENCY,
      async (rel) => {
        if (signal.aborted) return;
        const text = await readBlob(exec, root, scope.revision, rel, signal);
        if (typeof text !== 'string') return;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > limits.maxFileBytes) return;
        if (totalBytes + bytes > limits.maxTotalBytes) {
          truncated = true;
          return;
        }
        totalBytes += bytes;
        contents.set(rel, text);
      },
      signal
    );
  }

  const graph = analyze({ root, changed, files, contents });
  graph.scan.truncated = truncated || changed.length > promoted.length;
  graph.scan.bytesRead = scan?.totalBytes ?? 0;
  if (truncated) {
    graph.warnings.push('workspace scan hit its size cap; some files were not indexed');
  }
  graph.git = {
    kind: scope.kind,
    label: scope.label,
    ref: scope.ref ?? null,
    revision: scope.revision,
    mergeBase: scope.mergeBase,
    root,
    cwd,
    commit: scope.commit ?? null,
    files: scope.changed,
  };
  return graph;
}

/* ------------------------------------------------------------------- files */

/**
 * The change set of one git scope, without building a graph.
 *
 * The review pane lists these files, so it needs the list cheaply: resolving a
 * scope is a handful of read-only git commands, while a graph would read blobs.
 * @param ctx host context
 * @param options exec, cwd, parsed spec, cancellation
 * @returns `{ kind, label, ref, revision, mergeBase, files }`
 */
export async function scopeFiles(ctx, options) {
  const signal = options.signal ?? new AbortController().signal;
  const info = await repoInfo(options.exec, options.cwd, signal);
  if (info === null) throw new Error(`${options.cwd} is not inside a git repository`);
  const scope = await resolveScope(options.exec, options.cwd, options.spec, signal);
  return {
    kind: scope.kind,
    label: scope.label,
    ref: scope.ref ?? null,
    revision: scope.revision,
    mergeBase: scope.mergeBase,
    cwd: options.cwd,
    root: info.root,
    files: scope.changed.map((entry) => ({
      path: normalizeRel(entry.path),
      oldPath: entry.oldPath === undefined ? null : normalizeRel(entry.oldPath),
      status: entry.status,
      added: entry.added ?? null,
      deleted: entry.deleted ?? null,
      binary: entry.binary === true,
      untracked: entry.untracked === true,
    })),
  };
}

/* -------------------------------------------------------------------- diff */

/**
 * One file's comparison under a git change source, for the review pane.
 *
 * The whole-file fallback exists because an untracked file has no earlier side
 * for git to diff: it is not "no changes", it is "all new".
 * @param ctx host context carrying `fs`
 * @param options exec, cwd, parsed spec, new path, optional old path, cancellation
 * @returns `{ path, oldPath, status, scope, binary, additions, deletions, hunks }`
 */
export async function fileDiff(ctx, options) {
  const exec = options.exec;
  const signal = options.signal ?? new AbortController().signal;
  const info = await repoInfo(exec, options.cwd, signal);
  if (info === null) throw new Error(`${options.cwd} is not inside a git repository`);
  const root = info.root;
  const scope = await resolveScope(exec, options.cwd, options.spec, signal);

  const path = normalizeRel(options.path);
  if (path === '') throw new Error('path is required');
  const entry = scope.changed.find((item) => normalizeRel(item.path) === path);
  const declared = options.old === null || options.old === undefined || options.old === ''
    ? undefined
    : normalizeRel(options.old);
  // Both sides of a rename must be named, or git renders it as a plain addition.
  const oldPath = declared ?? (entry?.oldPath === undefined ? null : normalizeRel(entry.oldPath));
  const paths = oldPath === null ? [path] : [oldPath, path];

  const { patch, truncated } = await filePatch(exec, root, scope, paths, signal);
  const parsed = parsePatch(patch);
  const described = {
    path,
    oldPath,
    status: entry?.status ?? parsed.status ?? null,
    scope: {
      kind: scope.kind,
      label: scope.label,
      ref: scope.ref ?? null,
      revision: scope.revision,
    },
    truncated: truncated || parsed.binary,
  };

  if (parsed.hunks.length === 0 && !parsed.binary) {
    const whole = await wholeFileSide(ctx, root, path, entry, signal);
    if (whole !== undefined) return { ...described, ...whole };
  }
  return {
    ...described,
    binary: parsed.binary,
    additions: parsed.additions,
    deletions: parsed.deletions,
    hunks: parsed.hunks,
  };
}

/** Read a file that has no other side to diff against, or undefined when it is gone. */
async function wholeFileSide(ctx, root, path, entry, signal) {
  try {
    const target = await ctx.fs.resolve(`${root}/${path}`, { signal });
    const info = await ctx.fs.stat(target, signal);
    if (info === undefined || info.type !== 'file') return undefined;
    if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) {
      return { binary: false, oversized: true, additions: 0, deletions: 0, hunks: [] };
    }
    const text = await ctx.fs.readText(target, signal);
    const whole = wholeFile(text, entry?.status === 'D' ? 'del' : 'add');
    return {
      binary: false,
      additions: whole.additions,
      deletions: whole.deletions,
      hunks: whole.hunks,
      status: entry?.status ?? whole.status,
    };
  } catch {
    // Unreadable or binary: the pane says so rather than showing nothing.
    return { binary: true, additions: 0, deletions: 0, hunks: [] };
  }
}

/* ------------------------------------------------------------- ai flows */

/**
 * Assemble one model stream into text.
 *
 * `BlockAssembler` belongs to a package this bundle cannot import (a
 * profile-installed plugin resolves from its own directory), so the two chunk
 * kinds that matter are read directly: `text-delta` carries text and the single
 * terminal `finish` carries the reason.
 * @param stream async iterable of chunks
 * @returns `{ text, failure, usage }`
 */
export async function collectStreamText(stream) {
  let text = '';
  let reasoning = '';
  let failure;
  let usage;
  let finish;
  const counts = { text: 0, reasoning: 0, other: 0 };
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      counts.text += 1;
      continue;
    }
    // A reasoning model streams its thinking separately; without this the
    // answer looks empty and the failure says nothing useful.
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text;
      counts.reasoning += 1;
      continue;
    }
    if (chunk.type === 'usage') {
      usage = chunk.usage ?? chunk;
      continue;
    }
    if (chunk.type === 'finish') {
      finish = chunk.reason?.kind ?? finish;
      const reason = chunk.reason;
      if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted' || reason.failure !== undefined)) {
        failure = reason.failure ?? { code: reason.kind, message: String(reason.kind) };
      }
      if (chunk.usage !== undefined) usage = chunk.usage;
      continue;
    }
    counts.other += 1;
  }
  return { text, reasoning, failure, usage, finish, counts };
}

/** The numbers a caller shows for one call, under whichever names they arrive. */
export function usageNumbers(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const input = usage.inputTokens ?? usage.promptTokens ?? usage.input;
  const output = usage.outputTokens ?? usage.completionTokens ?? usage.output;
  const numbers = {};
  if (Number.isFinite(input)) numbers.inputTokens = input;
  if (Number.isFinite(output)) numbers.outputTokens = output;
  return Object.keys(numbers).length === 0 ? null : numbers;
}

/**
 * Everything one generation is shown, without spending a token.
 *
 * The scope is resolved and the same graph the view renders is used for the
 * material, so the prompt and the picture can never disagree about what
 * changed.
 * @param ctx host context carrying `fs`
 * @param options exec, cwd, parsed spec, cancellation
 * @returns `{ prompt, material, scope, root, head }`
 */
export async function flowMaterial(ctx, options) {
  const exec = options.exec;
  const signal = options.signal ?? new AbortController().signal;
  const graph = await buildGitGraph(ctx, {
    exec,
    cwd: options.cwd,
    spec: options.spec,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    signal,
  });
  const described = graph.git ?? {};
  const root = described.root ?? options.cwd;
  const scope = {
    kind: described.kind,
    ref: described.ref ?? null,
    revision: described.revision ?? null,
    mergeBase: described.mergeBase ?? null,
  };

  const files = (described.files ?? []).map((entry) => ({
    path: normalizeRel(entry.path),
    oldPath: entry.oldPath === undefined || entry.oldPath === null ? null : normalizeRel(entry.oldPath),
    status: entry.status,
    added: entry.added ?? null,
    deleted: entry.deleted ?? null,
    untracked: entry.untracked === true,
  }));

  const symbols = {};
  for (const node of graph.nodes ?? []) {
    const names = (node.exports ?? []).map((item) => item.name).filter((name) => typeof name === 'string');
    if (names.length > 0) symbols[node.id] = names.slice(0, 16);
  }
  const edges = (graph.edges ?? []).map((edge) => ({
    from: edge.from,
    to: edge.to,
    kinds: Array.isArray(edge.kinds) ? edge.kinds : [],
  }));

  const snippets = [];
  for (const entry of files) {
    if (signal.aborted) break;
    const paths = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path];
    try {
      const { patch } = await filePatch(exec, root, scope, paths, signal);
      if (patch.trim() !== '') snippets.push({ path: entry.path, diff: patch });
    } catch {
      /* a file whose excerpt cannot be read simply has none */
    }
  }

  const info = await repoInfo(exec, options.cwd, signal);
  const prompt = flowPrompt({
    language: options.language,
    context: options.context,
    scopeLabel: described.label ?? scope.kind,
    branch: info?.branch ?? undefined,
    files,
    symbols,
    edges,
    snippets,
    limits: options.limits,
  });
  return { prompt, graph, files, scope, root, head: info?.head ?? null, branch: info?.branch ?? null };
}

/* ------------------------------------------------------------------ routes */

const NO_STORE = { 'cache-control': 'no-store' };

/** Answer a route, turning any failure into a readable message. */
async function answer(work) {
  try {
    const response = await work();
    return response ?? new Response('Not found.', { status: 404, headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status: 400, headers: NO_STORE });
  }
}

/**
 * Canonicalize a directory that git will report on.
 *
 * git answers with the real path, and on macOS `/tmp` and `/var` are symlinks,
 * so comparing the caller's path with `rev-parse --show-toplevel` would
 * otherwise disagree by a `private/` prefix.
 * @param value an absolute path
 * @returns the resolved path, or the input when it cannot be resolved
 */
async function canonical(value) {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

/** The absolute, existing working directory a request names. */
async function cwdOf(ctx, request) {
  const value = new URL(request.url).searchParams.get('cwd');
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/')) {
    throw new Error('cwd must be an absolute path');
  }
  await ctx.fs.resolve(value, { signal: request.signal });
  return await canonical(value);
}

/**
 * Serve the git change sources to the view inside Connection's auth fence.
 * @param ctx host context carrying `connection`, `fs`, and `subprocess`
 * @param exec the git seam
 * @returns a disposer removing every route
 */
export function registerGitRoutes(ctx, exec) {
  const state = ctx.connection.fetch.register({
    path: '/api/review-graph.state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) =>
      answer(async () => {
        const cwd = await cwdOf(ctx, request);
        const info = await repoInfo(exec, cwd, request.signal);
        if (info === null) {
          return Response.json({ available: false, cwd }, { headers: NO_STORE });
        }
        const branches = await listBranches(exec, info.root, request.signal);
        const requested = new URL(request.url).searchParams.get('base');
        const base =
          requested === null || requested === ''
            ? pickBaseBranch(branches, info.branch)
            : requested;
        if (base !== null && !branches.some((branch) => branch.name === base)) {
          return new Response(`unknown branch ${base}`, { status: 400, headers: NO_STORE });
        }
        // The commit menu is the comparison's own delta: the commits the
        // current branch adds over the base, which is empty when the two are
        // the same. Without another branch to compare against, the picker
        // falls back to the current branch's recent history.
        const commits =
          base === null
            ? await listCommits(exec, info.root, request.signal, 50)
            : await listCommitsBetween(exec, info.root, base, 'HEAD', request.signal, COMMIT_MENU_LIMIT);
        return Response.json(
          {
            available: true,
            cwd,
            root: info.root,
            branch: info.branch,
            detached: info.detached,
            head: info.head,
            base,
            branches,
            commits,
          },
          { headers: NO_STORE }
        );
      }),
  });

  const graph = ctx.connection.fetch.register({
    path: '/api/review-graph.graph',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) =>
      answer(async () => {
        const url = new URL(request.url);
        const cwd = await cwdOf(ctx, request);
        const spec = parseScope(url.searchParams.get('scope') ?? '');
        if (spec === null) return new Response('Unknown change source.', { status: 400 });
        const maxFiles = Number.parseInt(url.searchParams.get('maxFiles') ?? '', 10);
        const document = await buildGitGraph(ctx, {
          exec,
          cwd,
          spec,
          maxFiles: Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
          signal: request.signal,
        });
        return Response.json(document, { headers: NO_STORE });
      }),
  });

  const files = ctx.connection.fetch.register({
    path: '/api/review-graph.files',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) =>
      answer(async () => {
        const url = new URL(request.url);
        const cwd = await cwdOf(ctx, request);
        const spec = parseScope(url.searchParams.get('scope') ?? '');
        if (spec === null) return new Response('Unknown change source.', { status: 400 });
        const document = await scopeFiles(ctx, { exec, cwd, spec, signal: request.signal });
        return Response.json(document, { headers: NO_STORE });
      }),
  });

  const diff = ctx.connection.fetch.register({
    path: '/api/review-graph.diff',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) =>
      answer(async () => {
        const url = new URL(request.url);
        const cwd = await cwdOf(ctx, request);
        const spec = parseScope(url.searchParams.get('scope') ?? '');
        if (spec === null) return new Response('Unknown change source.', { status: 400 });
        const path = url.searchParams.get('path');
        if (typeof path !== 'string' || path === '') {
          return new Response('path is required.', { status: 400 });
        }
        const document = await fileDiff(ctx, {
          exec,
          cwd,
          spec,
          path,
          old: url.searchParams.get('old'),
          signal: request.signal,
        });
        return Response.json(document, { headers: NO_STORE });
      }),
  });

  return () => {
    state();
    graph();
    files();
    diff();
  };
}

/**
 * Serve the AI business flows: a plan that spends nothing, and the generation
 * the user asked for.
 *
 * Generation is never automatic — the route exists so an explicit click can
 * spend tokens, and its answer is cached per material so the same change set is
 * not paid for twice.
 * @param ctx host context carrying `connection`, `subprocess`, `llm`, and `fs`
 * @param exec the git seam
 * @returns a disposer removing the route
 */
export function registerFlowRoute(ctx, exec, recorder, options = {}) {
  const cache = new Map();
  /**
   * What the last attempt for a source failed with.
   *
   * In memory, not on disk: a failure is worth showing once, beside the button
   * that would try again, and stale advice is worse than none.
   */
  const failures = new Map();
  const dir = options.cacheDir ?? flowCacheDir();

  /** The stored entry for a source: memory first, then the one file. */
  const recall = async (stem) => {
    const held = cache.get(stem);
    if (held !== undefined) return held;
    const stored = await readCachedFlow(dir, stem);
    if (stored === null) return undefined;
    cache.set(stem, stored);
    return stored;
  };

  /**
   * Every provider/model pair this profile advertises.
   *
   * The session log usually names the model, but it only records a *change* of
   * selection, so a first generation may have none. Reading the adapters'
   * catalogs here means a caller always has something valid to name — and a
   * chooser to spend less on.
   * @returns `{ providers, models }`
   */
  const catalog = async () => {
    const providers = [];
    const models = [];
    for (const entry of ctx.llm.listProviders()) {
      const id =
        typeof entry?.id === 'string'
          ? entry.id
          : typeof entry?.provider === 'string'
            ? entry.provider
            : undefined;
      if (id === undefined) continue;
      providers.push(id);
      try {
        for (const model of (await ctx.llm.listModels(id)) ?? []) {
          if (typeof model?.id !== 'string' || model.id === '') continue;
          models.push({
            provider: id,
            model: model.id,
            name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          });
        }
      } catch {
        /* a provider that cannot be enumerated still appears in `providers` */
      }
    }
    return { providers, models };
  };

  /** Run one stream, keeping only the last `FLOW_CACHE_LIMIT` generations. */
  const remember = async (stem, entry) => {
    cache.set(stem, entry);
    while (cache.size > FLOW_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    // Awaited: a generation is durable before the caller is told it succeeded.
    await writeCachedFlow(dir, stem, entry);
    return entry;
  };

  /**
   * Append the debug record, when the caller asked for one.
   *
   * Recording is opt-in because the appended message joins the model's context
   * on every later turn; a missing service or a session that is not live in this
   * Host is reported instead of failing the generation.
   */
  const record = (options) => {
    const sessions = recorder?.ctx?.sessions;
    if (sessions === undefined) return { recorded: false, recordError: 'this composition has no session service' };
    let session;
    try {
      session = sessions.get(options.sessionId);
    } catch (error) {
      return { recorded: false, recordError: error instanceof Error ? error.message : String(error) };
    }
    if (session === undefined) {
      return { recorded: false, recordError: `session ${options.sessionId} is not live in this host` };
    }
    // A click is a request and the flows are its answer, so the conversation
    // gets the pair: the one line the user asked for, then what came back.
    try {
      session.append(
        'user/message',
        {
          role: 'user',
          content: [{ type: 'text', text: options.text }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' }
      );
    } catch (error) {
      return { recorded: false, recordError: error instanceof Error ? error.message : String(error) };
    }
    if (typeof options.answer !== 'string' || options.answer.trim() === '') {
      return { recorded: true, recordedAnswer: false };
    }
    try {
      session.append(
        'assistant/message',
        {
          message: { role: 'assistant', content: [{ type: 'text', text: options.answer }] },
        },
        { surfaceOp: 'append' }
      );
      return { recorded: true, recordedAnswer: true };
    } catch (error) {
      return {
        recorded: true,
        recordedAnswer: false,
        recordError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const route = ctx.connection.fetch.register({
    path: '/api/review-graph.flow',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request) =>
      answer(async () => {
        const url = new URL(request.url);
        const cwd = await cwdOf(ctx, request);
        const spec = parseScope(url.searchParams.get('scope') ?? '');
        if (spec === null) return new Response('Unknown change source.', { status: 400 });

        const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
        const pick = (name) => {
          const value = url.searchParams.get(name) ?? body?.[name];
          return typeof value === 'string' && value !== '' ? value : undefined;
        };
        // A session usually names both; when it only names the model, the first
        // registered provider is the same default the plan advertises.
        const { providers, models } = await catalog();
        const requestedProvider = pick('provider');
        const requestedModel = pick('model');
        // The session's own model wins; otherwise the first advertised pair, so
        // a first generation has a valid default instead of a refusal.
        const chosen =
          models.find((entry) => entry.model === requestedModel && (requestedProvider === undefined || entry.provider === requestedProvider)) ??
          models.find((entry) => entry.model === requestedModel) ??
          models[0];
        const provider = requestedProvider ?? chosen?.provider;
        const model = requestedModel ?? chosen?.model;
        const rebuild = pick('rebuild') === 'true' || body?.rebuild === true;
        const wantRecord = pick('record') === 'true' || body?.record === true;
        const recordSession = pick('sessionId');
        const instruction = pick('instruction') ?? FLOW_INSTRUCTION;
        // Sizing and reasoning are the caller's choices: this only bounds them.
        const reasoningEffort = pick('reasoningEffort');

        // The conversation is client-supplied and already bounded there; the
        // Host only clips it again so a hand-made request cannot grow the prompt.
        const context = (pick('context') ?? '').slice(0, FLOW_LIMITS.contextChars);
        const material = await flowMaterial(ctx, {
          exec,
          cwd,
          spec,
          context,
          signal: request.signal,
        });
        const scopeId = `${spec.kind}:${spec.ref ?? ''}`;
        const stem = flowStem(material.root, scopeId);
        const contextHash = stableHash(context);
        const stored = await recall(stem);
        // Fresh means the same material *and* the same conversation: anything
        // else is kept, but it is presented as the previous answer.
        const fresh =
          stored !== undefined && stored.head === material.head && stored.contextHash === contextHash;

        if (request.method !== 'POST') {
          const efforts = await (async () => {
            if (model === undefined) return [];
            try {
              const resolved = await ctx.llm.resolveModel(provider, model);
              const advertised =
                resolved?.reasoningEfforts ?? resolved?.reasoning?.efforts ?? resolved?.efforts;
              return Array.isArray(advertised) ? advertised.filter((id) => typeof id === 'string') : [];
            } catch {
              // A provider that cannot describe its models offers no choice here.
              return [];
            }
          })();
          // Out of date means the *code* moved on. The conversation digest is a
          // different thing: it changes whenever the session grows — including
          // when a generation records itself into the conversation — and telling
          // someone their answer is stale because they kept talking is wrong.
          const staleReason =
            stored === undefined || stored.head === material.head ? null : 'head';
          const contextMoved = stored !== undefined && stored.contextHash !== contextHash;
          return Response.json(
            {
              diskCached: stored !== undefined,
              // Always offered, stale or not: what the last generation said is
              // the user's to read, and regenerating is their call.
              last:
                stored === undefined
                  ? null
                  : {
                      document: stored.document,
                      model: stored.model,
                      provider: stored.provider,
                      usage: stored.usage,
                      generatedAt: stored.generatedAt,
                      head: stored.head,
                      staleReason,
                      // Reported, not treated as staleness: a new generation
                      // would read this, the previous answer did not.
                      contextMoved,
                    },
              plan: {
                scope: material.graph.git?.label ?? spec.kind,
                files: material.files.length,
                promptBytes: material.prompt.bytes,
                // Every figure the card prints comes from here, and each is
                // labelled for what it is: the excerpts are not the prompt.
                excerptFiles: material.prompt.withExcerpts,
                excerptBytes: material.prompt.excerptBytes,
                contextBytes: context.length,
                maxOutputTokens: FLOW_LIMITS.maxOutputTokens,
                provider: provider ?? null,
                model: model ?? null,
                rebuild,
              },
              providers,
              models,
              // Empty means the adapter does not advertise efforts; the pane
              // then offers only "follow the provider".
              efforts,
              cached:
                stored === undefined || !fresh
                  ? null
                  : { model: stored.model, generatedAt: stored.generatedAt },
              // The one failure a caller can act on: this model spends its whole
              // budget thinking, so another one is the fix.
              lastFailure: failures.get(stem) ?? null,
              reasoningEffort: reasoningEffort ?? null,
            },
            { headers: NO_STORE }
          );
        }

        if (fresh && !rebuild) {
          const recordedForCache =
            wantRecord && recordSession !== undefined
              ? record({
                  sessionId: recordSession,
                  text: flowRecordText({
                    instruction,
                    provider: stored.provider,
                    model: stored.model,
                    scope: material.graph.git?.label ?? spec.kind,
                    generatedAt: stored.generatedAt,
                    cached: true,
                    usage: stored.usage,
                  }),
                  answer: flowAnswerText(stored.document),
                })
              : wantRecord
                ? { recorded: false, recordError: 'no sessionId was given' }
                : {};
          return Response.json(
            {
              ...stored.document,
              cached: true,
              // An entry stored before this was normalised has no model; report
              // the one this request resolved rather than nothing.
              model: stored.model ?? model ?? null,
              provider: stored.provider,
              usage: stored.usage,
              generatedAt: stored.generatedAt,
              debug: {
                instruction,
                system: clipDebug(stored.system),
                user: clipDebug(stored.prompt),
                raw: clipDebug(stored.raw),
                promptBytes: (stored.prompt ?? '').length,
              },
              ...recordedForCache,
            },
            { headers: NO_STORE }
          );
        }
        if (model === undefined) {
          return new Response(
            'no model selected: this profile advertises no model catalog, so pass `provider` and `model` explicitly',
            { status: 400, headers: NO_STORE }
          );
        }

        let collected;
        try {
          const stream = ctx.llm.stream({
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: material.prompt.user }] }],
            system: material.prompt.system,
            maxTokens: FLOW_LIMITS.maxOutputTokens,
            // Sent only when the caller named one: an effort the adapter does
            // not know would fail the whole call, so the default is silence.
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            purpose: 'review-graph-flow',
            signal: request.signal,
          });
          collected = await collectStreamText(stream);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(`the model call failed: ${message}`, { status: 502, headers: NO_STORE });
        }
        if (collected.failure !== undefined) {
          const failure = collected.failure;
          const code = failure.code ?? 'UNKNOWN';
          failures.set(stem, { code, at: new Date().toISOString() });
          return new Response(`${code}: ${failure.message ?? code}`, { status: 502, headers: NO_STORE });
        }

        // Visible text is the answer. A model that streamed only its reasoning is
        // tried too — some emit the JSON there — but its prose is never treated
        // as an answer, which is what made the first real failure unreadable.
        const visible = collected.text.trim();
        const parsedVisible = visible === '' ? { ok: false, problems: [] } : parseFlowDocument(visible);
        const parsed = parsedVisible.ok
          ? parsedVisible
          : collected.reasoning.trim() === ''
            ? { ok: false, problems: ['the answer carried no text'] }
            : parseFlowDocument(collected.reasoning);
        if (!parsed.ok) {
          const spentAllOnReasoning =
            visible === '' && collected.counts.reasoning > 0 && collected.finish === 'max-tokens';
          const diagnosis = [
            `finish=${collected.finish ?? 'none'}`,
            `text chunks=${collected.counts.text}`,
            `reasoning chunks=${collected.counts.reasoning}`,
            `other chunks=${collected.counts.other}`,
            `answer ${(visible === '' ? collected.reasoning : visible).length} chars`,
            `output limit ${FLOW_LIMITS.maxOutputTokens} tokens`,
          ].join(', ');
          const head = (visible === '' ? collected.reasoning : visible).slice(0, 300).replace(/\s+/g, ' ').trim();
          const reason = spentAllOnReasoning
            ? 'the model spent its whole output budget on reasoning and never wrote a visible answer — choose a model that does not think out loud (a larger budget does not help: it used all of it)'
            : parsed.problems.join('; ') || 'the answer was not a usable flow document';
          if (spentAllOnReasoning) {
            failures.set(stem, { code: 'REASONING_BUDGET', at: new Date().toISOString() });
          } else {
            failures.delete(stem);
          }
          return new Response(
            `the model answer was unusable: ${reason} (${diagnosis})` +
              (head === '' ? ' — the model streamed no text at all' : ` — head: ${head}`),
            { status: 502, headers: NO_STORE }
          );
        }
        const fromReasoning = !parsedVisible.ok;
        const document = {
          ...parsed.value,
          ...(fromReasoning ? { fromReasoning: true } : {}),
          basis: {
            scope: material.graph.git?.label ?? spec.kind,
            revision: material.scope.revision,
            files: material.files.map((file) => file.path).slice(0, FLOW_LIMITS.files),
            promptBytes: material.prompt.bytes,
          },
        };
        const entry = {
          document,
          // Normalised, both of them: `undefined` is dropped by JSON.stringify,
          // so the stored document would come back without a model at all.
          model: model ?? null,
          provider: provider ?? null,
          usage: usageNumbers(collected.usage),
          generatedAt: new Date().toISOString(),
          // Kept so a later cache hit can record the same record without paying
          // for the generation again.
          prompt: material.prompt.user,
          system: material.prompt.system,
          raw: visible,
          head: material.head,
          contextHash,
          root: material.root,
          scope: scopeId,
        };
        await remember(stem, entry);
        const recorded =
          wantRecord && recordSession !== undefined
            ? record({
                sessionId: recordSession,
                text: flowRecordText({
                  instruction,
                  provider: entry.provider,
                  model,
                  scope: material.graph.git?.label ?? spec.kind,
                  generatedAt: entry.generatedAt,
                  cached: false,
                  usage: entry.usage,
                }),
                answer: flowAnswerText(entry.document),
              })
            : wantRecord
              ? { recorded: false, recordError: 'no sessionId was given' }
              : {};
        return Response.json(
          {
            ...document,
            cached: false,
            model: model ?? null,
            provider: entry.provider,
            usage: entry.usage,
            generatedAt: entry.generatedAt,
            debug: {
              instruction,
              system: clipDebug(material.prompt.system),
              user: clipDebug(material.prompt.user),
              raw: clipDebug(visible),
              promptBytes: material.prompt.bytes,
            },
            ...recorded,
          },
          { headers: NO_STORE }
        );
      }),
  });

  return () => route();
}

/**
 * Register the agent-facing `review_graph` tool.
 * @param ctx host context carrying `fs` and `tools`
 */
export function apply(ctx) {
  // `subprocess` and `connection` are optional: without them the agent tool
  // still graphs a working tree, and only the git sources and the view's route
  // are unavailable. Requiring them in `inject` would stop the plugin mounting
  // in a composition that has neither.
  const git = { ctx: undefined, exec: undefined };
  ctx.inject(['subprocess'], (gitCtx) => {
    git.ctx = gitCtx;
    gitCtx.effect(() => () => {
      git.ctx = undefined;
      git.exec = undefined;
    }, 'review-graph: git seam');
  });

  registerTool(ctx, git);
  ctx.inject(['connection', 'subprocess'], (webCtx) => {
    const exec = createGitExec(webCtx);
    webCtx.effect(() => registerGitRoutes(webCtx, exec), 'review-graph: git routes');
  });
  // The AI flows need a model provider as well, and they are registered in
  // their own context: a service is only reachable through the context that
  // declared it, so the callback's ctx is the one that may read `ctx.llm`. A
  // profile without an adapter then simply has no flow route, and the graphs
  // and reviews are unaffected.
  ctx.inject(['connection', 'subprocess', 'llm'], (flowCtx) => {
    const exec = createGitExec(flowCtx);
    // The optional session service is resolved in its own context, so the route
    // exists with or without it and only the debug record depends on it.
    const recorder = { ctx: undefined };
    flowCtx.inject(['sessions'], (sessionCtx) => {
      recorder.ctx = sessionCtx;
      sessionCtx.effect(() => () => {
        recorder.ctx = undefined;
      }, 'review-graph: session recorder');
    });
    flowCtx.effect(() => registerFlowRoute(flowCtx, exec, recorder), 'review-graph: flow route');
  });
}

/**
 * Register the agent-facing `review_graph` tool.
 * @param ctx host context carrying `fs` and `tools`
 * @param git holder whose `ctx` is set while `subprocess` is available
 */
function registerTool(ctx, git) {
  const tools = ctx.tools;
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.info?.('review-graph: no tools service; the agent tool was not registered');
    return;
  }

  const definition = {
    name: 'review_graph',
    description:
      'Build a relationship graph for a change set. Returns which files reference which (imports and cross-file symbol references), which changed files form connected clusters and which are isolated, the blast-radius ranking (files referenced by the most changed files), and a symbol-level flow list taken from real exports — every node carries file and line so callers can render a clickable graph. `scope` selects a git change source — unstaged, staged, uncommitted, one commit, or one branch against its merge base — and reads the files as they are at that revision; without `scope`, `changed` names the paths to mark and the working tree is analyzed. Use it before reviewing a change set to understand independence and impact.',
    // `ctx.tools.register` takes the *wire-level* definition: raw JSON Schema
    // from the enforced subset (no `minimum`/`maximum`; `type: 'json'` is an
    // authoring-DSL type that only `defineTool` compiles away). This Host half
    // deliberately imports nothing from dsh — a profile-installed bundle
    // resolves from its own directory, which holds no `@deepseek-ai/*`.
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Absolute workspace root to analyze. Omit to use the current session working directory.',
        },
        scope: {
          type: 'string',
          description:
            'Git change source: unstaged, staged, uncommitted, commit:<sha>, or branch:<ref> (three-dot, against the merge base). Omit to use `changed`.',
        },
        changed: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Changed file paths (absolute or workspace-relative). Ignored when `scope` is given.',
        },
        maxFiles: {
          type: 'integer',
          description: `Maximum source files to index, at least 1. Default ${DEFAULT_MAX_FILES}.`,
        },
      },
    },
    // An annotation-only schema is the registry's unconstrained-JSON form; the
    // graph document is arbitrary JSON. `render` is mandatory — without it
    // `register` throws and the tool never reaches the model.
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const signal = exec?.signal;
      const root = args?.root ?? workspaceRootOf(ctx, exec);
      if (typeof root !== 'string' || root.length === 0) {
        throw new Error(
          'review_graph needs a workspace: pass `root`, or run it in a session with a working directory.'
        );
      }
      const maxFiles = Number.isSafeInteger(args?.maxFiles) ? args.maxFiles : DEFAULT_MAX_FILES;

      if (typeof args?.scope === 'string' && args.scope.length > 0) {
        const spec = parseScope(args.scope);
        if (spec === null) {
          throw new Error(
            `unknown scope ${JSON.stringify(args.scope)}: expected unstaged, staged, uncommitted, commit:<sha>, or branch:<ref>`
          );
        }
        if (git.ctx === undefined) {
          throw new Error('this composition has no subprocess capability, so git scopes are unavailable');
        }
        git.exec ??= createGitExec(git.ctx);
        return await buildGitGraph(ctx, {
          exec: git.exec,
          cwd: await canonical(root),
          spec,
          maxFiles,
          signal,
        });
      }

      return await buildGraph(ctx, {
        root,
        changed: Array.isArray(args?.changed) ? args.changed : [],
        maxFiles,
        signal,
      });
    },
  };

  try {
    tools.register(definition);
  } catch (error) {
    ctx.logger?.warn?.(`review-graph: could not register the review_graph tool: ${error}`);
  }
}
