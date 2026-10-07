/**
 * review-graph — unified diff parsing.
 *
 * The Host turns one file's `git diff` into the structure the review pane
 * renders: hunks of added, removed, and context lines that each carry the line
 * number on the side they exist on, so the pane can gutter them and jump to a
 * line. Pure functions only, so the self-checks drive them with real git output.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Parse one file's unified diff.
 *
 * A path with no earlier version (an untracked file, or a pure addition) has no
 * `-` lines; a deleted file has no `+` lines. Both are ordinary parses, so the
 * pane never needs a special case beyond the empty-patch fallback.
 *
 * @param patch raw `git diff` output for a single path
 * @returns `{ oldPath, newPath, status, binary, additions, deletions, hunks }`
 */
export function parsePatch(patch) {
  const result = {
    oldPath: null,
    newPath: null,
    status: null,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
  const lines = String(patch).split('\n');
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // The split leaves one empty element after a trailing newline; a truly
    // empty line inside a hunk is a context line and must not be dropped.
    if (line === '' && index === lines.length - 1) continue;

    if (line.startsWith('diff --git ')) {
      hunk = null;
      continue;
    }
    if (line.startsWith('new file mode')) {
      result.status = 'A';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      result.status = 'D';
      continue;
    }
    if (line.startsWith('rename from ')) {
      result.oldPath = line.slice('rename from '.length);
      result.status = 'R';
      continue;
    }
    if (line.startsWith('rename to ')) {
      result.newPath = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('copy from ')) {
      result.oldPath = line.slice('copy from '.length);
      result.status = 'C';
      continue;
    }
    if (line.startsWith('copy to ')) {
      result.newPath = line.slice('copy to '.length);
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      result.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') result.oldPath ??= stripPrefix(path);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') result.newPath ??= stripPrefix(path);
      continue;
    }
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      hunk = {
        header: match[5] ?? '',
        oldStart: Number.parseInt(match[1], 10),
        oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
        newStart: Number.parseInt(match[3], 10),
        newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
        lines: [],
      };
      result.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (hunk === null) continue;

    if (line === NO_NEWLINE) {
      hunk.lines.push({ kind: 'note', text: 'no newline at end of file' });
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newLine });
      newLine += 1;
      result.additions += 1;
      continue;
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine });
      oldLine += 1;
      result.deletions += 1;
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
}

/** `a/src/x.ts` / `b/src/x.ts` → `src/x.ts`; a quoted path is left readable. */
function stripPrefix(path) {
  const unquoted =
    path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(.)/g, '$1') : path;
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) return unquoted.slice(2);
  return unquoted;
}

/**
 * A file that exists on one side only, rendered as one hunk.
 *
 * An untracked file has no earlier side for git to diff, and a binary file has
 * no lines at all, so the pane needs a representation for both.
 * @param text the file's text
 * @param kind `add` for a new file, `del` for a removed one
 * @returns the same shape `parsePatch` produces
 */
export function wholeFile(text, kind = 'add') {
  const content = String(text);
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const rows = body === '' ? [] : body.split('\n');
  const lines = rows.map((row, index) => ({
    kind,
    text: row,
    ...(kind === 'add' ? { newLine: index + 1 } : { oldLine: index + 1 }),
  }));
  return {
    oldPath: null,
    newPath: null,
    status: kind === 'add' ? 'A' : 'D',
    binary: false,
    additions: kind === 'add' ? rows.length : 0,
    deletions: kind === 'del' ? rows.length : 0,
    hunks:
      rows.length === 0
        ? []
        : [
            {
              header: '',
              oldStart: kind === 'del' ? 1 : 0,
              oldLines: kind === 'del' ? rows.length : 0,
              newStart: kind === 'add' ? 1 : 0,
              newLines: kind === 'add' ? rows.length : 0,
              lines,
            },
          ],
  };
}
