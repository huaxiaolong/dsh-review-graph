/**
 * review-graph — git change sources behind one execution seam.
 *
 * Everything here is read-only with respect to the repository: no `add`, no
 * `stash`, no index refresh. The caller supplies
 * `exec(args, { cwd, signal }) → { exitCode, stdout, stderr }`, so this whole
 * module is exercised by the self-checks against a real git without a harness,
 * and the Host half can back the same seam with `ctx.subprocess`.
 *
 * Scope specs are plain strings so they survive a URL:
 *   `unstaged` | `staged` | `uncommitted` | `commit:<sha>` | `branch:<ref>`
 */

/**
 * Environment every git child starts from. Mirrors the shipped turn recorder:
 * indexed ambient configuration is excluded, no terminal prompt, no optional
 * locks (so a read never touches `.git/index`), and stable message language.
 */
export const GIT_ENV = {
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** Accepted scope kinds. `turn` is served by the conversation recorder instead. */
export const SCOPE_KINDS = ['unstaged', 'staged', 'uncommitted', 'commit', 'branch'];

const NUL = '\0';
const US = '\x1f';

/** A revision id git may be asked about: no options, no paths, nothing exotic. */
const REVISION = /^[0-9a-fA-F]{4,40}$/;

/**
 * Parse one scope spec.
 * @param value the URL-facing scope string
 * @returns `{ kind, ref }`, or null when the spec is not a known scope
 */
export function parseScope(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const separator = value.indexOf(':');
  const kind = separator < 0 ? value : value.slice(0, separator);
  const ref = separator < 0 ? undefined : value.slice(separator + 1);
  if (!SCOPE_KINDS.includes(kind)) return null;
  if (kind === 'commit') {
    if (ref === undefined || !REVISION.test(ref)) return null;
    return { kind, ref };
  }
  if (kind === 'branch') {
    if (ref === undefined || ref.length === 0 || ref.length > 255) return null;
    return { kind, ref };
  }
  return ref === undefined ? { kind } : null;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parse `git diff --name-status -z`. A rename or copy contributes three fields
 * (`R100`, old path, new path); every other status contributes two.
 * @param text raw NUL-separated output
 * @returns entries carrying the letter status and the resulting path
 */
export function parseNameStatusZ(text) {
  const fields = String(text).split(NUL);
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status === '') continue;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index + 1] ?? '';
      const path = fields[index + 2] ?? '';
      index += 2;
      if (path !== '') entries.push({ status: letter, oldPath, path });
      continue;
    }
    const path = fields[index + 1] ?? '';
    index += 1;
    if (path !== '') entries.push({ status: letter, path });
  }
  return entries;
}

/**
 * Parse `git diff --numstat -z`. A binary file reports `-` for both counts; a
 * rename reports an empty third tab field followed by the two paths as their
 * own NUL fields.
 * @param text raw NUL-separated output
 * @returns per-path line counts, `null` for a binary side
 */
export function parseNumstatZ(text) {
  const fields = String(text).split(NUL);
  const stats = [];
  for (let index = 0; index < fields.length; index += 1) {
    const head = fields[index];
    if (head === '') continue;
    const parts = head.split('\t');
    if (parts.length < 3) continue;
    const added = countOf(parts[0]);
    const deleted = countOf(parts[1]);
    if (parts[2] === '') {
      const oldPath = fields[index + 1] ?? '';
      const path = fields[index + 2] ?? '';
      index += 2;
      if (path !== '') stats.push({ path, oldPath, added, deleted });
      continue;
    }
    stats.push({ path: parts[2], added, deleted });
  }
  return stats;
}

function countOf(field) {
  return field === '-' ? null : Number.parseInt(field, 10);
}

/**
 * Fold line counts onto status entries by resulting path.
 * @param entries `parseNameStatusZ` output
 * @param stats `parseNumstatZ` output
 * @returns entries carrying `added` / `deleted` / `binary`
 */
export function mergeStats(entries, stats) {
  const byPath = new Map(stats.map((entry) => [entry.path, entry]));
  return entries.map((entry) => {
    const stat = byPath.get(entry.path);
    return {
      ...entry,
      added: stat === undefined ? null : stat.added,
      deleted: stat === undefined ? null : stat.deleted,
      binary: stat !== undefined && stat.added === null,
    };
  });
}

/**
 * Parse `git log -z --format=<fields joined by US>` into commits, newest first.
 * @param text raw output
 * @returns `{ sha, short, date, author, subject }` records
 */
export function parseLogZ(text) {
  return String(text)
    .split(NUL)
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha, short, date, author, ...subject] = record.split(US);
      return { sha, short, date, author, subject: subject.join(US) };
    })
    .filter((commit) => typeof commit.sha === 'string' && commit.sha.length > 0);
}

/**
 * Parse `git for-each-ref --format=<refname US short US sha US date>` lines.
 * @param text raw output
 * @returns branches with `kind: 'local' | 'remote'`
 */
export function parseBranches(text) {
  const branches = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const [refname, name, sha, date] = line.split(US);
    if (typeof refname !== 'string' || typeof name !== 'string' || name === '') continue;
    if (refname.endsWith('/HEAD')) continue;
    branches.push({
      name,
      sha: sha ?? '',
      date: date ?? '',
      kind: refname.startsWith('refs/remotes/') ? 'remote' : 'local',
    });
  }
  return branches;
}

/** Split `git ls-files -z` / `git ls-tree -z` output into paths. */
export function parseLinesZ(text) {
  return String(text)
    .split(NUL)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/* ------------------------------------------------------------------ queries */

/** Run one command that is allowed to fail; callers decide what a failure means. */
function probe(exec, args, cwd, signal) {
  return exec(args, { cwd, signal });
}

/** Run one command that must succeed. */
async function must(exec, args, cwd, signal, what) {
  const result = await probe(exec, args, cwd, signal);
  if (result.exitCode !== 0) {
    const detail = String(result.stderr ?? '').trim() || `exit ${result.exitCode}`;
    throw new Error(`${what ?? `git ${args[0]}`} failed: ${detail}`);
  }
  return String(result.stdout ?? '');
}

/**
 * Locate the repository enclosing a working directory.
 * @returns `{ root, head, branch, detached }`, or null outside a repository
 */
export async function repoInfo(exec, cwd, signal) {
  const top = await probe(exec, ['rev-parse', '--show-toplevel'], cwd, signal);
  if (top.exitCode !== 0) return null;
  const root = String(top.stdout ?? '').trim();
  if (root === '') return null;
  const head = await probe(exec, ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, signal);
  const branch = await probe(exec, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal);
  const name = branch.exitCode === 0 ? String(branch.stdout ?? '').trim() : '';
  return {
    root,
    head: head.exitCode === 0 ? String(head.stdout ?? '').trim() : null,
    branch: name === '' || name === 'HEAD' ? null : name,
    detached: name === 'HEAD',
  };
}

/** Every local and remote branch, local first and newest first within a kind. */
export async function listBranches(exec, root, signal) {
  const text = await must(
    exec,
    ['for-each-ref', '--sort=-committerdate', `--format=%(refname)${US}%(refname:short)${US}%(objectname:short)${US}%(committerdate:iso-strict)`, 'refs/heads', 'refs/remotes'],
    root,
    signal,
    'git for-each-ref'
  );
  const branches = parseBranches(text);
  branches.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1;
    return 0;
  });
  return branches;
}

/** Recent commits on HEAD, newest first. */
export async function listCommits(exec, root, signal, limit = 50) {
  const text = await must(
    exec,
    ['log', '-z', `-n${limit}`, `--format=%H${US}%h${US}%aI${US}%an${US}%s`],
    root,
    signal,
    'git log'
  );
  return parseLogZ(text);
}

/**
 * Commits reachable from `to` but not from `from` — the delta one branch
 * comparison covers, and what a commit picker inside that comparison should
 * offer. This is the two-dot form; the *diff* of the same comparison stays
 * three-dot (merge base), exactly as a pull request lists commits and diffs.
 * @returns commits newest first
 */
export async function listCommitsBetween(exec, root, from, to, signal, limit = 200) {
  const text = await must(
    exec,
    ['log', '-z', `-n${limit}`, `--format=%H${US}%h${US}%aI${US}%an${US}%s`, `${from}..${to}`],
    root,
    signal,
    `git log ${from}..${to}`
  );
  return parseLogZ(text);
}

/**
 * The branch a comparison should start against.
 *
 * A user expects the repository's trunk — `main`, then `master`, then the
 * remote's copy of either — before an arbitrary sibling branch, and a branch
 * other than the one being compared in every case.
 * @param branches `listBranches` output
 * @param current the checked-out branch, or null when detached
 * @returns the branch name, or null when this repository has no other branch
 */
export function pickBaseBranch(branches, current) {
  const others = branches.filter((branch) => branch.name !== current);
  if (others.length === 0) return null;
  const trunk = ['main', 'master', 'develop', 'dev'];
  for (const name of trunk) {
    const local = others.find((branch) => branch.name === name && branch.kind === 'local');
    if (local !== undefined) return local.name;
  }
  for (const name of trunk) {
    const remote = others.find((branch) => branch.name === `origin/${name}`);
    if (remote !== undefined) return remote.name;
  }
  return (others.find((branch) => branch.kind === 'local') ?? others[0]).name;
}

/** One commit's identifying line, for a scope label and the commit picker. */
export async function commitInfo(exec, root, sha, signal) {
  const text = await must(
    exec,
    ['show', '-s', '-z', `--format=%H${US}%h${US}%aI${US}%an${US}%s`, sha],
    root,
    signal,
    `git show ${sha}`
  );
  const [commit] = parseLogZ(text);
  if (commit === undefined) throw new Error(`unknown commit ${sha}`);
  return commit;
}

/** Changed paths for one `diff` / `diff-tree` invocation, with line counts. */
async function diffEntries(exec, root, signal, command, args) {
  const status = await must(
    exec,
    [command, '--name-status', '-z', '-M', ...args],
    root,
    signal,
    `git ${command}`
  );
  const numstat = await probe(exec, [command, '--numstat', '-z', '-M', ...args], root, signal);
  const stats = numstat.exitCode === 0 ? parseNumstatZ(String(numstat.stdout ?? '')) : [];
  return mergeStats(parseNameStatusZ(status), stats);
}

/**
 * Changed paths introduced by one commit.
 *
 * `git diff <sha>` would compare the commit against the *working tree*, and
 * `<sha>^!` degrades to exactly that, so the parent is resolved explicitly: a
 * merge commit is compared against its first parent, and a root commit — which
 * has none — falls back to `diff-tree --root`.
 */
async function commitEntries(exec, root, sha, signal) {
  const parent = await firstParent(exec, root, sha, signal);
  if (parent !== null) return diffEntries(exec, root, signal, 'diff', [parent, sha]);
  return diffEntries(exec, root, signal, 'diff-tree', ['--root', '-r', sha]);
}

/** A commit's first parent, or null for a root commit. */
export async function firstParent(exec, root, sha, signal) {
  const result = await probe(exec, ['rev-parse', '--verify', '--quiet', `${sha}^1`], root, signal);
  if (result.exitCode !== 0) return null;
  const parent = String(result.stdout ?? '').trim();
  return parent === '' ? null : parent;
}

/**
 * One file's patch under a resolved scope, for the review pane.
 *
 * Both sides of a rename belong in the pathspec: git cannot pair a rename when
 * only one of the two names is named, and would render it as a plain addition.
 * @param exec the git seam
 * @param root repository root
 * @param scope `resolveScope` output
 * @param paths the new path, plus the old one when the scope reports a rename
 * @param signal cancellation
 * @returns `{ patch, truncated }` — the raw unified diff and whether output hit its cap
 */
export async function filePatch(exec, root, scope, paths, signal) {
  const flags = ['--no-color', '--no-ext-diff', '--unified=3'];
  const tail = ['--', ...paths];
  let args;
  if (scope.kind === 'staged') {
    args = ['diff', ...flags, '--cached', ...tail];
  } else if (scope.kind === 'uncommitted') {
    args = ['diff', ...flags, 'HEAD', ...tail];
  } else if (scope.kind === 'commit') {
    const parent = await firstParent(exec, root, scope.ref, signal);
    args =
      parent === null
        ? ['diff-tree', ...flags, '--root', '-r', '-p', scope.ref, ...tail]
        : ['diff', ...flags, parent, scope.ref, ...tail];
  } else if (scope.kind === 'branch') {
    args = ['diff', ...flags, scope.mergeBase, 'HEAD', ...tail];
  } else {
    args = ['diff', ...flags, ...tail];
  }
  const result = await probe(exec, args, root, signal);
  if (result.exitCode !== 0) {
    const detail = String(result.stderr ?? '').trim() || `exit ${result.exitCode}`;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return { patch: String(result.stdout ?? ''), truncated: result.truncated === true };
}

/**
 * Resolve one scope into its changed files and the revision its file contents
 * must be read from.
 *
 * `revision: null` means the change is against the working tree, so contents
 * come from disk; a revision means the analysis must read blobs at that
 * revision, because the files as they stand on disk are not that version.
 *
 * @param exec the git seam
 * @param cwd any directory inside the repository
 * @param spec `parseScope` output
 * @param signal cancellation
 * @returns `{ kind, ref, label, revision, mergeBase, changed }`
 */
export async function resolveScope(exec, cwd, spec, signal) {
  const info = await repoInfo(exec, cwd, signal);
  if (info === null) throw new Error('not a git repository');
  const root = info.root;

  if (spec.kind === 'commit') {
    const commit = await commitInfo(exec, root, spec.ref, signal);
    const changed = await commitEntries(exec, root, commit.sha, signal);
    return {
      kind: 'commit',
      ref: commit.sha,
      label: `${commit.short} ${commit.subject}`.trim(),
      revision: commit.sha,
      mergeBase: null,
      commit,
      changed,
    };
  }

  if (spec.kind === 'branch') {
    const branches = await listBranches(exec, root, signal);
    const known = branches.find((branch) => branch.name === spec.ref);
    if (known === undefined) throw new Error(`unknown branch ${spec.ref}`);
    if (info.head === null) throw new Error('this repository has no commits yet');
    const base = await probe(exec, ['merge-base', spec.ref, 'HEAD'], root, signal);
    if (base.exitCode !== 0) {
      throw new Error(`${spec.ref} and HEAD have no common ancestor`);
    }
    const mergeBase = String(base.stdout ?? '').trim();
    const changed = await diffEntries(exec, root, signal, 'diff', [mergeBase, 'HEAD']);
    return {
      kind: 'branch',
      ref: known.name,
      label: `${known.name}...HEAD`,
      revision: 'HEAD',
      mergeBase,
      changed,
    };
  }

  if (spec.kind === 'staged') {
    const changed = await diffEntries(exec, root, signal, 'diff', ['--cached']);
    return { kind: 'staged', label: 'Staged changes', revision: null, mergeBase: null, changed };
  }

  if (spec.kind === 'uncommitted') {
    const tracked = info.head === null ? [] : await diffEntries(exec, root, signal, 'diff', ['HEAD']);
    const untracked = parseLinesZ(
      await must(exec, ['ls-files', '--others', '--exclude-standard', '-z'], root, signal, 'git ls-files')
    ).map((path) => ({ path, status: 'A', oldPath: undefined, added: null, deleted: null, binary: false, untracked: true }));
    const seen = new Set(tracked.map((entry) => entry.path));
    return {
      kind: 'uncommitted',
      label: 'Uncommitted changes',
      revision: null,
      mergeBase: null,
      changed: [...tracked, ...untracked.filter((entry) => !seen.has(entry.path))],
    };
  }

  const changed = await diffEntries(exec, root, signal, 'diff', []);
  return { kind: 'unstaged', label: 'Unstaged changes', revision: null, mergeBase: null, changed };
}

/**
 * Read one file's content at a revision.
 * @returns the text, or undefined when the file does not exist there
 */
export async function readBlob(exec, root, revision, path, signal) {
  const result = await probe(exec, ['show', `${revision}:${path}`], root, signal);
  return result.exitCode === 0 ? String(result.stdout ?? '') : undefined;
}

/**
 * List every file in a revision's tree.
 * @returns repository-relative paths
 */
export async function listTree(exec, root, revision, signal) {
  return parseLinesZ(
    await must(exec, ['ls-tree', '-r', '-z', '--name-only', revision], root, signal, 'git ls-tree')
  );
}
