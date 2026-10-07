/**
 * diff-parse — exercise `lib/diff.mjs` against real git output.
 *
 * A temporary repository produces every shape the review pane must render:
 * modified, added, deleted, renamed, binary, an empty context line, a file
 * without a trailing newline, and an untracked file (which has no earlier side
 * for git to diff at all).
 *
 *   node test/diff-parse.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePatch, wholeFile } from '../lib/diff.mjs';
import { GIT_ENV } from '../lib/git.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function git(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      }
    );
  });
}

const root = await mkdtemp(join(tmpdir(), 'review-graph-diff-'));
try {
  await git(['init', '-q', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
  await git(['config', 'user.name', 'selftest'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });

  await writeFile(join(root, 'edited.ts'), 'one\ntwo\n\nfour\nfive\n');
  await writeFile(join(root, 'gone.ts'), 'bye\nbye\n');
  await writeFile(join(root, 'old-name.ts'), 'renamed body\n');
  await writeFile(join(root, 'blob.bin'), 'text\n');
  await writeFile(join(root, 'tail.ts'), 'no newline at end');
  await writeFile(join(root, 'src', 'nested.ts'), 'export const n = 1\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'first'], { cwd: root });

  await writeFile(join(root, 'edited.ts'), 'one\nTWO\n\nfour\nFIVE\nsix\n');
  await writeFile(join(root, 'added.ts'), 'brand\nnew\n');
  await git(['rm', '-q', 'gone.ts'], { cwd: root });
  await git(['mv', 'old-name.ts', 'new-name.ts'], { cwd: root });
  await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  await writeFile(join(root, 'tail.ts'), 'no newline at end, changed');
  // Only some changes are staged, so both sides of the index are covered:
  // `edited.ts`, `tail.ts` and `src/nested.ts` stay in the working tree.
  await git(['add', 'added.ts', 'blob.bin'], { cwd: root });
  await writeFile(join(root, 'src', 'nested.ts'), 'export const n = 2\n');
  await writeFile(join(root, 'untracked.ts'), 'fresh\nfile\n');

  const diffOf = async (path, extra = []) => {
    const result = await git(['diff', '--no-color', '--unified=3', ...extra, '--', path], { cwd: root });
    return parsePatch(result.stdout);
  };

  console.log('modified file');
  const edited = await diffOf('edited.ts');
  check('a modification parses into hunks', edited.hunks.length === 1, JSON.stringify(edited.hunks.length));
  check(
    'added and removed lines are counted',
    edited.additions === 3 && edited.deletions === 2,
    JSON.stringify({ additions: edited.additions, deletions: edited.deletions })
  );
  const kinds = edited.hunks[0].lines.map((line) => line.kind).join('');
  check(
    'context, removal, and addition keep their order',
    kinds.includes('ctx') && kinds.includes('del') && kinds.includes('add'),
    kinds
  );
  const added = edited.hunks[0].lines.find((line) => line.kind === 'add');
  const removed = edited.hunks[0].lines.find((line) => line.kind === 'del');
  check(
    'each line carries the number of the side it exists on',
    added.newLine === 2 && added.oldLine === undefined && removed.oldLine === 2 && removed.newLine === undefined,
    JSON.stringify({ added, removed })
  );
  check(
    'an empty context line survives parsing',
    edited.hunks[0].lines.some((line) => line.kind === 'ctx' && line.text === ''),
    JSON.stringify(edited.hunks[0].lines.map((line) => `${line.kind}:${JSON.stringify(line.text)}`))
  );
  check(
    'the hunk header is retained for the pane',
    typeof edited.hunks[0].header === 'string' && edited.hunks[0].newStart === 1,
    JSON.stringify(edited.hunks[0])
  );

  console.log('added, deleted, renamed, binary, tail');
  const addedFile = await diffOf('added.ts', ['--cached']);
  check(
    'a new file parses with a new-file status and only additions',
    addedFile.status === 'A' && addedFile.additions === 2 && addedFile.deletions === 0,
    JSON.stringify({ status: addedFile.status, additions: addedFile.additions })
  );
  const deletedFile = await diffOf('gone.ts', ['--cached']);
  check(
    'a deleted file parses with only removals',
    deletedFile.status === 'D' && deletedFile.deletions === 2 && deletedFile.additions === 0,
    JSON.stringify({ status: deletedFile.status, deletions: deletedFile.deletions })
  );
  // A pathspec holding only the new name cannot pair the rename, which is
  // exactly why the Host route takes the old path as a parameter.
  const singleSided = await diffOf('new-name.ts', ['--cached']);
  check(
    'a rename needs both paths in the pathspec',
    singleSided.status === 'A',
    JSON.stringify({ status: singleSided.status, oldPath: singleSided.oldPath })
  );
  const renamedFile = parsePatch(
    (await git(['diff', '--no-color', '--unified=3', '--cached', '--', 'old-name.ts', 'new-name.ts'], { cwd: root }))
      .stdout
  );
  check(
    'a rename keeps both paths when both are named',
    renamedFile.status === 'R' &&
      renamedFile.oldPath === 'old-name.ts' &&
      renamedFile.newPath === 'new-name.ts',
    JSON.stringify({ status: renamedFile.status, oldPath: renamedFile.oldPath, newPath: renamedFile.newPath })
  );
  const binaryFile = await diffOf('blob.bin', ['--cached']);
  check('a binary file is flagged instead of rendered', binaryFile.binary === true, JSON.stringify(binaryFile));
  const tail = await diffOf('tail.ts');
  check(
    'a missing final newline is noted, not invented as a line',
    tail.hunks[0].lines.some((line) => line.kind === 'note'),
    JSON.stringify(tail.hunks[0].lines.map((line) => line.kind))
  );

  console.log('untracked and synthetic sides');
  const untracked = wholeFile('fresh\nfile\n');
  check(
    'an untracked file renders as one all-added hunk',
    untracked.status === 'A' &&
      untracked.additions === 2 &&
      untracked.hunks[0].lines.every((line) => line.kind === 'add' && line.newLine >= 1),
    JSON.stringify(untracked)
  );
  check('an empty untracked file has no hunk', wholeFile('').hunks.length === 0);
  check(
    'a removal side numbers old lines',
    wholeFile('a\nb', 'del').hunks[0].lines.every((line) => line.kind === 'del' && line.oldLine >= 1)
  );
  check(
    'a file without a trailing newline does not gain a phantom line',
    wholeFile('single line').additions === 1,
    JSON.stringify(wholeFile('single line'))
  );

  console.log('degenerate input');
  check('an empty patch parses to nothing', parsePatch('').hunks.length === 0);
  check(
    'a patch with headers only parses to no hunks',
    parsePatch('diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n').hunks.length === 0
  );
  check(
    'a staged diff parses the same way as a worktree one',
    (await diffOf('added.ts', ['--cached'])).additions === 2
  );
  check(
    'the same path can have both a staged and an unstaged side',
    (await diffOf('edited.ts')).hunks.length === 1
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
