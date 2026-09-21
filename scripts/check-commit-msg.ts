/**
 * Commit message check, run by the `commit-msg` git hook:
 *
 *   node scripts/check-commit-msg.ts <path-to-message-file>
 *
 * Headers follow Conventional Commits (https://www.conventionalcommits.org):
 * `type(scope)!: summary`, which is what the changelog is written from.
 * Merge, revert and fixup!/squash! headers that git writes itself pass as-is.
 */
import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert'];
const HEADER = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9._/-]+\\))?!?: \\S`);
const GIT_GENERATED = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;
const MAX_HEADER = 100;

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: check-commit-msg.ts <message-file>\n');
  process.exit(2);
}

// The first line that is not a git comment is the header.
const header =
  readFileSync(file, 'utf8')
    .split('\n')
    .find((line) => !line.startsWith('#'))
    ?.trimEnd() ?? '';

const problems: string[] = [];
if (!GIT_GENERATED.test(header)) {
  if (!HEADER.test(header)) {
    problems.push(`the header must look like "type(scope): summary", with type one of: ${TYPES.join(', ')}`);
  }
  if (header.length > MAX_HEADER) {
    problems.push(`the header is ${String(header.length)} characters; keep it to ${String(MAX_HEADER)}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    [
      `✖ Commit message rejected: "${header}"`,
      ...problems.map((problem) => `  - ${problem}`),
      '  e.g. "fix(auth): refresh tokens under the credentials lock" (see CONTRIBUTING.md)',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}
