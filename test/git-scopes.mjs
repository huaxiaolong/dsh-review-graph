/**
 * git-scopes — exercise `lib/git.mjs` against a real repository.
 *
 * The parsers are checked through git's own output rather than through
 * fixtures: a temporary repository with a rename, staged, unstaged, untracked,
 * and second-branch history is built, then every scope is resolved and the
 * blobs are read back. The last check pins the read-only claim — the
 * repository's index must be byte-identical after all of it.
 *
 *   node test/git-scopes.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGitGraph } from '../index.js';
import {
  GIT_ENV,
  listCommitsBetween,
  pickBaseBranch,
  listBranches,
  listCommits,
  listTree,
  mergeStats,
  parseBranches,
  parseLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parseScope,
  readBlob,
  repoInfo,
  resolveScope,
} from '../lib/git.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/* ------------------------------------------------------- the git seam + repo */

/** The self-check's own seam: this file may use Node APIs the plugin may not. */
function git(args, { cwd, signal } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        signal,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...GIT_ENV },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

async function commit(cwd, message) {
  await git(['add', '-A'], { cwd });
  await git(['commit', '-qm', message], { cwd });
  const head = await git(['rev-parse', 'HEAD'], { cwd });
  return head.stdout.trim();
}

const root = await mkdtemp(join(tmpdir(), 'review-graph-git-'));
try {
  await git(['init', '-q', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
  await git(['config', 'user.name', 'selftest'], { cwd: root });
  await git(['config', 'commit.gpgsign', 'false'], { cwd: root });

  await writeFile(join(root, 'keep.ts'), 'a\nb\nc\n');
  await writeFile(join(root, 'old.ts'), 'x\ny\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'q.ts'), 'export const q = 1\n');
  const first = await commit(root, 'first');

  await git(['checkout', '-q', '-b', 'feature'], { cwd: root });
  await writeFile(join(root, 'feature.ts'), 'export const feature = true\n');
  const second = await commit(root, 'add feature');

  await git(['checkout', '-q', 'main'], { cwd: root });
  await writeFile(join(root, 'main.ts'), 'export const main = true\n');
  const third = await commit(root, 'add main');

  // Staged: a rename plus one modified file.
  await git(['mv', 'old.ts', 'renamed.ts'], { cwd: root });
  await writeFile(join(root, 'src', 'q.ts'), 'export const q = 2\n');
  await git(['add', 'src/q.ts'], { cwd: root });
  // Unstaged: one modified file. Untracked: one new file.
  await writeFile(join(root, 'keep.ts'), 'a\nB\nc\nd\n');
  await writeFile(join(root, 'fresh.ts'), 'one\ntwo\nthree\n');

  console.log('repository facts');
  const info = await repoInfo(git, root);
  check('repository located', info !== null && info.root.endsWith(root.split('/').pop()), JSON.stringify(info));
  check('branch and head resolved', info.branch === 'main' && info.head === third, JSON.stringify(info));
  check('a plain directory is not a repository', (await repoInfo(git, tmpdir())) === null);

  const branches = await listBranches(git, root);
  check(
    'branches list local and remote kinds',
    branches.some((entry) => entry.name === 'main' && entry.kind === 'local') &&
      branches.some((entry) => entry.name === 'feature' && entry.kind === 'local'),
    JSON.stringify(branches.map((entry) => `${entry.kind}:${entry.name}`))
  );

  const commits = await listCommits(git, root);
  check(
    "commits are the current branch's, newest first",
    commits.length === 2 && commits[0].sha === third && commits[0].subject === 'add main' && commits[1].sha === first,
    JSON.stringify(commits.map((entry) => entry.subject))
  );
  check(
    'listTree lists a revision tree',
    (await listTree(git, root, first)).sort().join(',') === 'README.md,keep.ts,old.ts,src/q.ts',
    JSON.stringify(await listTree(git, root, first))
  );

  console.log('scope specs');
  check('scope spec parses', parseScope('branch:feature')?.ref === 'feature');
  check('commit spec parses a sha', parseScope(`commit:${third}`)?.kind === 'commit');
  check('unknown kind rejected', parseScope('nope') === null);
  check('option-looking ref rejected', parseScope('commit:--upload-pack=x') === null);
  check('short hex rejected', parseScope('commit:abc') === null);
  check('bare ref on a ref-less kind rejected', parseScope('unstaged:main') === null);

  check(
    'a commit menu is the comparison delta, not the branch history',
    (await listCommitsBetween(git, root, 'main', 'feature')).map((entry) => entry.sha).join(',') === second,
    JSON.stringify((await listCommitsBetween(git, root, 'main', 'feature')).map((entry) => entry.subject))
  );
  check(
    'the other direction is that comparison\'s own delta',
    (await listCommitsBetween(git, root, 'feature', 'main')).map((entry) => entry.subject).join(',') === 'add main',
    JSON.stringify((await listCommitsBetween(git, root, 'feature', 'main')).map((entry) => entry.subject))
  );
  check(
    'a branch compared with itself has no delta',
    (await listCommitsBetween(git, root, 'main', 'main')).length === 0
  );

  console.log('default comparison base');
  check(
    'trunk is preferred over a sibling branch',
    pickBaseBranch(branches, 'feature') === 'main',
    String(pickBaseBranch(branches, 'feature'))
  );
  check(
    'a remote trunk stands in when no local one exists',
    pickBaseBranch(
      [
        { name: 'feature', kind: 'local' },
        { name: 'origin/main', kind: 'remote' },
      ],
      'feature'
    ) === 'origin/main'
  );
  check(
    'without another branch there is no base',
    pickBaseBranch([{ name: 'main', kind: 'local' }], 'main') === null
  );
  check(
    'a non-trunk sibling is still a base',
    pickBaseBranch(
      [
        { name: 'main', kind: 'local' },
        { name: 'topic', kind: 'local' },
      ],
      'main'
    ) === 'topic'
  );

  console.log('changed files per scope');
  const unstaged = await resolveScope(git, root, { kind: 'unstaged' });
  check(
    'unstaged reports the modified file with counts',
    unstaged.changed.length === 1 &&
      unstaged.changed[0].path === 'keep.ts' &&
      unstaged.changed[0].status === 'M' &&
      unstaged.changed[0].added === 2 &&
      unstaged.changed[0].deleted === 1,
    JSON.stringify(unstaged.changed)
  );
  check('unstaged reads contents from the working tree', unstaged.revision === null);

  const staged = await resolveScope(git, root, { kind: 'staged' });
  const renamed = staged.changed.find((entry) => entry.status === 'R');
  check(
    'staged reports the rename with both paths',
    renamed !== undefined && renamed.oldPath === 'old.ts' && renamed.path === 'renamed.ts',
    JSON.stringify(staged.changed)
  );
  check(
    'staged reports the second file',
    staged.changed.some((entry) => entry.path === 'src/q.ts' && entry.status === 'M' && entry.added === 1),
    JSON.stringify(staged.changed)
  );

  const uncommitted = await resolveScope(git, root, { kind: 'uncommitted' });
  const paths = uncommitted.changed.map((entry) => entry.path);
  check(
    'uncommitted adds the untracked file to the tracked diff',
    paths.includes('fresh.ts') && paths.includes('keep.ts') && paths.includes('src/q.ts'),
    JSON.stringify(paths)
  );
  check(
    'untracked entries are marked',
    uncommitted.changed.find((entry) => entry.path === 'fresh.ts')?.untracked === true
  );

  const oneCommit = await resolveScope(git, root, { kind: 'commit', ref: second });
  check(
    'a commit scope diffs that commit against its parent',
    oneCommit.changed.length === 1 && oneCommit.changed[0].path === 'feature.ts' && oneCommit.changed[0].status === 'A',
    JSON.stringify(oneCommit.changed)
  );
  check(
    'a commit scope reads contents at that commit',
    oneCommit.revision === second && oneCommit.label.startsWith(second.slice(0, 7))
  );

  const branch = await resolveScope(git, root, { kind: 'branch', ref: 'feature' });
  check(
    'a branch scope diffs the merge base against HEAD',
    branch.mergeBase === first &&
      branch.revision === 'HEAD' &&
      branch.changed.length === 1 &&
      branch.changed[0].path === 'main.ts',
    JSON.stringify({ mergeBase: branch.mergeBase, changed: branch.changed })
  );
  let unknownBranch;
  try {
    await resolveScope(git, root, { kind: 'branch', ref: 'nope' });
  } catch (error) {
    unknownBranch = error;
  }
  check('an unknown branch is refused', unknownBranch !== undefined, String(unknownBranch));

  console.log('history reads');
  check(
    'a blob reads the committed version, not the working tree',
    (await readBlob(git, root, first, 'src/q.ts')) === 'export const q = 1\n',
    JSON.stringify(await readBlob(git, root, first, 'src/q.ts'))
  );
  check(
    'a blob missing at that revision reads undefined',
    (await readBlob(git, root, first, 'main.ts')) === undefined
  );

  console.log('read-only posture');
  const index = join(root, '.git', 'index');
  const indexText = await readFile(index);
  await resolveScope(git, root, { kind: 'unstaged' });
  await resolveScope(git, root, { kind: 'uncommitted' });
  await resolveScope(git, root, { kind: 'staged' });
  check(
    'resolving scopes leaves the repository index untouched',
    Buffer.compare(indexText, await readFile(index)) === 0,
    `index mtime=${(await stat(index)).mtimeMs}`
  );

  console.log('host-side graph for a revision scope');
  const host = {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path };
      },
      async stat(target) {
        const info = await stat(target.targetKey);
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size };
      },
      async listDir(target) {
        const names = await (await import('node:fs/promises')).readdir(target.targetKey);
        const entries = [];
        for (const name of names) {
          const child = join(target.targetKey, name);
          const info = await stat(child);
          entries.push({
            name,
            type: info.isDirectory() ? 'directory' : 'file',
            target: { targetKey: child, displayPath: child },
          });
        }
        return entries;
      },
      async readText(target) {
        return readFile(target.targetKey, 'utf8');
      },
    },
  };

  const committed = await buildGitGraph(host, {
    exec: git,
    cwd: root,
    spec: { kind: 'commit', ref: second },
  });
  const committedFiles = committed.nodes.map((node) => node.id);
  check(
    'a commit graph reads the tree at that commit',
    committedFiles.includes('feature.ts') && !committedFiles.includes('main.ts'),
    JSON.stringify(committedFiles)
  );
  check(
    'a commit graph marks the commit\'s own change',
    committed.change.changedFiles.includes('feature.ts') && committed.git.revision === second,
    JSON.stringify({ changed: committed.change.changedFiles, revision: committed.git.revision })
  );
  check(
    'a commit graph carries the source description',
    committed.git.kind === 'commit' && committed.git.label.startsWith(second.slice(0, 7)),
    JSON.stringify(committed.git.label)
  );

  const worktree = await buildGitGraph(host, {
    exec: git,
    cwd: root,
    spec: { kind: 'staged' },
  });
  const worktreeFiles = worktree.nodes.map((node) => node.id);
  // The analyzer focuses on the change set plus its one-hop neighbourhood, so
  // an unrelated working-tree file is deliberately not a node here.
  check(
    'a worktree graph focuses on that scope\'s change set',
    worktreeFiles.includes('renamed.ts') &&
      worktreeFiles.includes('src/q.ts') &&
      !worktreeFiles.includes('fresh.ts'),
    JSON.stringify(worktreeFiles)
  );
  check(
    'a worktree graph reports the staged change set with counts',
    worktree.git.kind === 'staged' &&
      worktree.git.files.some((entry) => entry.path === 'renamed.ts' && entry.status === 'R') &&
      worktree.git.files.some((entry) => entry.path === 'src/q.ts' && entry.added === 1),
    JSON.stringify(worktree.git.files)
  );
  const realRoot = await realpath(root);
  check(
    'a worktree graph roots itself at the canonical repository path',
    worktree.root === realRoot && worktree.git.root === realRoot,
    `${worktree.root} vs ${realRoot}`
  );

  const uncommittedGraph = await buildGitGraph(host, {
    exec: git,
    cwd: realRoot,
    spec: { kind: 'uncommitted' },
  });
  const uncommittedNodes = uncommittedGraph.nodes.map((node) => node.id);
  check(
    'an uncommitted graph marks the untracked file as changed',
    uncommittedGraph.change.changedFiles.includes('fresh.ts') &&
      uncommittedNodes.includes('fresh.ts'),
    JSON.stringify({ changed: uncommittedGraph.change.changedFiles, nodes: uncommittedNodes })
  );

  console.log('a change set made only of a non-source file');
  const dotRepo = await mkdtemp(join(tmpdir(), 'review-graph-dot-'));
  try {
    await git(['init', '-q', '-b', 'main'], { cwd: dotRepo });
    await git(['config', 'user.email', 'selftest@example.invalid'], { cwd: dotRepo });
    await git(['config', 'user.name', 'selftest'], { cwd: dotRepo });
    await writeFile(join(dotRepo, '.gitignore'), 'node_modules\n');
    await writeFile(join(dotRepo, 'app.ts'), 'export const a = 1\n');
    await writeFile(join(dotRepo, 'README.md'), '# doc\n');
    await git(['add', '-A'], { cwd: dotRepo });
    await git(['commit', '-qm', 'first'], { cwd: dotRepo });
    await writeFile(join(dotRepo, '.gitignore'), 'node_modules\ndist\n');

    const dotGraph = await buildGitGraph(host, {
      exec: git,
      cwd: await realpath(dotRepo),
      spec: { kind: 'unstaged' },
    });
    check(
      'editing only .gitignore is not an empty graph',
      dotGraph.change.changedCount === 1 &&
        dotGraph.change.unresolved === 0 &&
        dotGraph.nodes.some((node) => node.id === '.gitignore'),
      JSON.stringify({ change: dotGraph.change, nodes: dotGraph.nodes.map((node) => node.id) })
    );
    check(
      'the universe is the sources plus the change set, nothing else',
      dotGraph.scan.filesIndexed === 2 && dotGraph.nodes.length === 1,
      JSON.stringify({ indexed: dotGraph.scan.filesIndexed, nodes: dotGraph.nodes.map((node) => node.id) })
    );
  } finally {
    await rm(dotRepo, { recursive: true, force: true });
  }

  console.log('parsers');
  check(
    'rename frames in name-status carry three fields',
    JSON.stringify(parseNameStatusZ(`R100\0old.ts\0renamed.ts\0M\0src/q.ts\0`)) ===
      JSON.stringify([
        { status: 'R', oldPath: 'old.ts', path: 'renamed.ts' },
        { status: 'M', path: 'src/q.ts' },
      ])
  );
  const numstatRename = parseNumstatZ(`0\t0\t\0old.ts\0renamed.ts\0`);
  check(
    'rename frames in numstat carry an empty third field',
    numstatRename.length === 1 &&
      numstatRename[0].path === 'renamed.ts' &&
      numstatRename[0].oldPath === 'old.ts' &&
      numstatRename[0].added === 0,
    JSON.stringify(numstatRename)
  );
  check(
    'binary counts stay null',
    parseNumstatZ(`-\t-\tlogo.png\0`)[0].added === null
  );
  check(
    'stats fold onto status by path',
    mergeStats([{ status: 'M', path: 'a.ts' }], [{ path: 'a.ts', added: 3, deleted: 1 }])[0].added === 3
  );
  check('log records split on NUL', parseLogZ(`sha1${'\x1f'}s1${'\x1f'}d${'\x1f'}a${'\x1f'}subject one\0`).length === 1);
  check(
    'branch lines split on the unit separator',
    parseBranches(`refs/heads/main\x1fmain\x1fabcd\x1f2026-01-01T00:00:00+00:00\n`)[0].kind === 'local'
  );
  check(
    'a remote HEAD symref is dropped',
    parseBranches(`refs/remotes/origin/HEAD\x1forigin/HEAD\x1fabcd\x1f\nrefs/remotes/origin/main\x1forigin/main\x1fabcd\x1f\n`).length === 1
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
