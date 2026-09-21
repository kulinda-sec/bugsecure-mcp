import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { type DocumentNode, Kind, parse, Source } from 'graphql';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const OPERATIONS_DIR = join(REPO_ROOT, 'src', 'graphql', 'operations');
export const PRUNED_SCHEMA_PATH = join(REPO_ROOT, 'schema', 'bugsecure.graphql');
export const GENERATED_PATH = join(REPO_ROOT, 'src', 'graphql', 'generated.ts');

export interface OperationFile {
  /** Repo-relative, forward-slash path — stable across platforms. */
  readonly location: string;
  readonly document: DocumentNode;
}

/** Every `*.graphql` file under `dir`, parsed, in a deterministic order. */
export const loadOperations = (dir: string = OPERATIONS_DIR): OperationFile[] => {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.graphql'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => {
      const location = relative(REPO_ROOT, path).split(sep).join('/');
      return { location, document: parse(new Source(readFileSync(path, 'utf8'), location)) };
    });
};

/** All operation files merged into one document (fragments may span files). */
export const mergeOperations = (files: readonly OperationFile[]): DocumentNode => {
  return { kind: Kind.DOCUMENT, definitions: files.flatMap((f) => f.document.definitions) };
};
