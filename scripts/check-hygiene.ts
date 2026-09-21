/**
 * Repository hygiene checks that no linter covers.
 *
 *   node scripts/check-hygiene.ts            # part of `pnpm run check`
 *   node scripts/check-hygiene.ts --release  # also before publishing
 *
 * Always: no invisible or bidirectional Unicode characters in tracked text
 * files (they can hide what code does — "Trojan Source" — and GitHub flags
 * them). Tests spell such characters as escapes (`'\u202E'`) instead. And no
 * unresolved merge-conflict markers, including the form Prettier leaves after
 * reformatting a Markdown file that still has them (`> > > > > > > theirs`,
 * `\=======`), which no longer looks like a conflict to git.
 *
 * With --release: no `TODO(lead)` placeholder left in anything that ships in
 * the npm package or is shown on the public repository.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { REPO_ROOT } from './lib/operations.ts';

// Unicode Default_Ignorable_Code_Point covers them all: bidi controls,
// zero-width characters, word joiner, BOM, soft hyphen, variation selectors,
// the tag block.
const HIDDEN = /\p{Default_Ignorable_Code_Point}/u;
const TEXT_FILE =
  /\.(?:ts|js|mjs|cjs|json|ya?ml|md|graphql|txt)$|^(?:Dockerfile|LICENSE|NOTICE|CODEOWNERS|\.[a-z]+rc)$/;

/** Shipped in the package or rendered on the public repository. */
const PUBLIC_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'NOTICE',
  'package.json',
  '.github/CODEOWNERS',
];
const PLACEHOLDER = 'TODO(lead)';

const trackedFiles = (): string[] => {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((f) => f !== '' && TEXT_FILE.test(f.split('/').pop() ?? ''));
};

const findLines = (file: string, test: (line: string) => boolean): string[] => {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, file), 'utf8');
  } catch {
    return []; // listed but deleted in the working tree
  }
  return text.split('\n').flatMap((line, i) => (test(line) ? [`${file}:${String(i + 1)}`] : []));
};

// `<<<<<<< ours`, `>>>>>>> theirs`, `||||||| base`, and Prettier's Markdown mangling of them:
// `>>>>>>>` becomes nested blockquote markers (`> > > > > > >`) and `=======` an escaped `\=======`.
const CONFLICT_MARKER = /^\s*(?:<{7}(?:\s|$)|>{7}(?:\s|$)|\|{7}(?:\s|$)|(?:>\s){6}>(?:\s|$)|\\={7}\s*$)/;
// A bare `=======` is also a Markdown/RST underline; it only counts next to another marker.
const SEPARATOR = /^\s*={7}\s*$/;

const conflictLines = (file: string): string[] => {
  const markers = findLines(file, (l) => CONFLICT_MARKER.test(l));
  return markers.length === 0 ? [] : [...markers, ...findLines(file, (l) => SEPARATOR.test(l))];
};

const { values } = parseArgs({ options: { release: { type: 'boolean', default: false } } });
const problems: string[] = [];

const files = trackedFiles();
for (const where of files.flatMap((f) => findLines(f, (l) => HIDDEN.test(l)))) {
  problems.push(`${where}: invisible or bidirectional Unicode character (write it as an escape)`);
}
for (const where of files.flatMap(conflictLines)) {
  problems.push(`${where}: unresolved merge-conflict marker`);
}
if (values.release) {
  for (const where of PUBLIC_DOCS.flatMap((f) => findLines(f, (l) => l.includes(PLACEHOLDER)))) {
    problems.push(`${where}: unresolved ${PLACEHOLDER} placeholder in a public document`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
}
