/**
 * The API surface this server may touch, checked for every GraphQL document
 * it can send.
 *
 * BugSecure has two kinds of people on the receiving side of a report: an
 * organization's own members, who triage and grade the reports filed to their
 * programmes (the `triage:*` scopes and `grade:write`, each only for
 * organizations that opted in to it), and the platform's staff — its
 * assessors and administrators. This server is for the first kind only. It
 * must never offer a tool that performs a staff operation (deciding an appeal,
 * reviewing an organization's Critical grade, working BugSecure's escalation
 * queue, reviewing KYC documents, administering accounts, reading the audit
 * log…), even though the API would refuse it to an OAuth token anyway: a tool
 * that exists here advertises the capability, and a tool that can only ever
 * fail is a defect. Grading a report (`adjudicateReport`) is NOT staff-only:
 * an organization's Administrators and Triagers grade their own reports, and
 * the API lets a connected app do so as the organization, never as BugSecure.
 *
 * The checks, in order of how early they catch a mistake:
 *
 * 1. every operation file (`src/graphql/operations/**`) and the vendored
 *    schema's root types reference only root fields open to OAuth clients;
 * 2. every `graphql.request(…)` in `src/` sends a codegen'd document imported
 *    from `generated.ts`, and no source file carries an inline GraphQL
 *    operation — so (1) really covers everything that is sent;
 * 3. per tool: the root fields of the documents it sends are open to OAuth
 *    clients and covered by the tool's `requiredScopes`
 *    (plus its `optionalScopes`, for best-effort lookups — queries only: a
 *    mutation must be covered by `requiredScopes`, and a read-only tool sends
 *    none);
 * 4. every nested field a document selects is on the allowed list (the API
 *    refuses some fields to OAuth tokens, and one refused field fails the whole
 *    operation), and the `search` tool asks only for result types connected
 *    apps may search.
 *
 * Every check is an allowed list, maintained by hand on purpose: changing one
 * is a deliberate, reviewed edit, never a side effect of adding a tool. What
 * the API refuses, and what it reserves to BugSecure's staff, is not listed
 * here: anything not explicitly allowed fails, and the API enforces the rest.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  buildSchema,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLObjectType,
  Kind,
  type OperationTypeNode,
  parse,
  type SelectionSetNode,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { loadOperations, PRUNED_SCHEMA_PATH, REPO_ROOT } from '../../scripts/lib/operations.ts';
import * as generated from '../graphql/generated.js';
import type { Scope } from '../scopes.js';
import { isWriteTool } from './define-tool.js';
import { ALL_TOOLS } from './index.js';
import { SEARCH_TYPES } from './search.js';

type RootType = 'Query' | 'Mutation' | 'Subscription';
type RootField = `${RootType}.${string}`;

interface ScopeRequirement {
  readonly match: 'all' | 'any';
  readonly scopes: readonly Scope[];
}
const needs = (scope: Scope): ScopeRequirement => ({ match: 'all', scopes: [scope] });
const anyOf = (...scopes: Scope[]): ScopeRequirement => ({ match: 'any', scopes });

/**
 * Every root field the API opens to OAuth access tokens, and the scopes it
 * requires (mirrors the API's own OAuth scope allowlist). Anything absent is
 * refused to every connected app, so a tool using it could only ever fail.
 * Opening a new field here must follow the API opening it — never precede it.
 */
const OPEN_TO_OAUTH: Readonly<Record<RootField, ScopeRequirement>> = {
  // programs:read
  'Query.programs': needs('programs:read'),
  'Query.program': needs('programs:read'),
  'Query.programBySlug': needs('programs:read'),
  'Query.publicProgramActivity': needs('programs:read'),
  'Query.myInvitedPrograms': needs('programs:read'),
  'Query.leaderboard': needs('programs:read'),
  'Query.researcherProfile': needs('programs:read'),
  'Query.researcherPublicProfile': needs('programs:read'),
  'Query.search': needs('programs:read'), // reports only with reports:read / triage:read
  'Query.verifyCertificate': needs('programs:read'),
  'Query.certificateSigningKeys': needs('programs:read'),
  'Query.taxonomyProfile': needs('programs:read'),
  'Query.termsDocument': needs('programs:read'),
  'Query.termsVersions': needs('programs:read'),
  'Query.badgeCatalog': anyOf('programs:read', 'profile:read'),
  'Query.researcherStats': anyOf('programs:read', 'profile:read'),
  // profile:read
  'Query.me': needs('profile:read'),
  'Query.myProfile': needs('profile:read'),
  'Query.myBadges': needs('profile:read'),
  'Query.notifications': needs('profile:read'),
  'Query.unreadNotificationCount': needs('profile:read'),
  'Query.myCertificates': needs('profile:read'),
  'Query.myKycStatus': needs('profile:read'),
  'Query.researcherActivity': needs('profile:read'),
  // reports:read (researcher side) / triage:read (organization side)
  'Query.report': anyOf('reports:read', 'triage:read'),
  'Query.reports': anyOf('reports:read', 'triage:read'),
  'Query.reportComments': anyOf('reports:read', 'triage:read'),
  'Query.reportTransitions': anyOf('reports:read', 'triage:read'),
  'Query.reportAdjudication': anyOf('reports:read', 'triage:read'),
  'Query.reportAppeals': anyOf('reports:read', 'triage:read'),
  // reports:write
  'Mutation.submitReport': needs('reports:write'),
  'Mutation.raiseAppeal': needs('reports:write'),
  'Mutation.addReportComment': anyOf('reports:write', 'triage:write'),
  // triage:read (member of an organization that opted in)
  'Query.checkDuplicates': needs('triage:read'),
  'Query.programStats': needs('triage:read'),
  'Query.reportTrends': needs('triage:read'),
  'Query.severityDistribution': needs('triage:read'),
  'Query.payoutSummary': needs('triage:read'),
  'Query.organizationStanding': needs('triage:read'),
  'Query.myOrganizations': needs('triage:read'),
  'Query.myPrograms': needs('triage:read'),
  'Query.organizationCertificates': needs('triage:read'),
  // triage:write
  'Mutation.updateReportStatus': needs('triage:write'),
  'Mutation.assignTriageAnalyst': needs('triage:write'),
  // grade:write (member of an organization that opted in to AI grading; as the organization only)
  'Mutation.adjudicateReport': needs('grade:write'),
  // notifications:write (only notifications the token can read)
  'Mutation.markNotificationAsRead': needs('notifications:write'),
  'Mutation.markAllNotificationsAsRead': needs('notifications:write'),
  // profile:write (own researcher profile; never the avatar)
  'Mutation.updateResearcherProfile': needs('profile:write'),
  // disclosures:write (drafting only, own reports; the scope also reads the draft)
  'Query.reportDisclosureDraft': needs('disclosures:write'),
  'Mutation.saveReportDisclosure': needs('disclosures:write'),
};

/**
 * Every nested field an operation may select, as `Type.field`: exactly what
 * the operations select today, each checked against the API's OAuth field
 * middleware (some fields are refused to every connected app, and one refused
 * field fails the whole operation). A field missing here fails the test below:
 * check it against the API's field rules first, then add it to
 * `api-surface.fields.json`. The API's refused fields are deliberately not
 * listed in this public repository.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'tools', 'api-surface.fields.json'), 'utf8')) as string[],
);

/** `search` result types a connected app may ask for (the API's search resolver knows no others). */
const SEARCHABLE_TYPES: readonly string[] = ['program', 'report', 'researcher'];

const ROOT_TYPE: Readonly<Record<OperationTypeNode, RootType>> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

/** Why `field` may not be sent, or `undefined` when it may. */
const refusal = (field: RootField): string | undefined =>
  OPEN_TO_OAUTH[field] === undefined
    ? `${field} is not open to OAuth clients: add it to OPEN_TO_OAUTH (with its scopes) only once the API ` +
      'opens it to OAuth tokens. Operations reserved to BugSecure staff are never opened, whatever the scopes.'
    : undefined;

/** `Type.field` for every nested field `document` selects, resolved against `schema`. */
const selectedFields = (document: DocumentNode, schema: ReturnType<typeof buildSchema>): string[] => {
  const typeInfo = new TypeInfo(schema);
  const fields: string[] = [];
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field: (node) => {
        const parent = typeInfo.getParentType();
        if (parent !== null && parent !== undefined) fields.push(`${parent.name}.${node.name.value}`);
      },
    }),
  );
  return fields;
};

/**
 * The root fields each operation of `document` selects, following fragment
 * spreads and inline fragments at the root (aliases do not hide a field: the
 * field name is what the API resolves).
 */
const rootFieldsOf = (document: DocumentNode): Map<string, RootField[]> => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  const collect = (root: RootType, set: SelectionSetNode, seen: Set<string>): RootField[] =>
    set.selections.flatMap((selection): RootField[] => {
      switch (selection.kind) {
        case Kind.FIELD:
          return selection.name.value.startsWith('__') ? [] : [`${root}.${selection.name.value}`];
        case Kind.INLINE_FRAGMENT:
          return collect(root, selection.selectionSet, seen);
        case Kind.FRAGMENT_SPREAD: {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (seen.has(name)) return [];
          // An unknown fragment is a document that cannot be checked: fail loudly.
          if (fragment === undefined) throw new Error(`fragment ${name} is not defined in the document`);
          return collect(root, fragment.selectionSet, new Set([...seen, name]));
        }
      }
    });
  const result = new Map<string, RootField[]>();
  for (const def of document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const name = def.name?.value ?? '(anonymous)';
    result.set(name, [...new Set(collect(ROOT_TYPE[def.operation], def.selectionSet, new Set()))]);
  }
  return result;
};

/** Every non-test TypeScript source file under `src/`, except generated code. */
const sourceFiles = (): string[] =>
  readdirSync(join(REPO_ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => path !== join(REPO_ROOT, 'src', 'graphql', 'generated.ts'))
    .sort();

const repoPath = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/');

const GENERATED_MODULE = /(^|\/)graphql\/generated\.js$/;
const INLINE_OPERATION = /^\s*(?:query|mutation|subscription)\b[^{}]*\{/;

interface SourceScan {
  /** Exported names of the generated documents passed to `.request(…)`. */
  readonly documents: string[];
  /** Tool names this file defines (`defineTool({ name: '…' })`). */
  readonly tools: string[];
  /** Ways this file could send a document the checks do not see. */
  readonly problems: string[];
}

const scanSource = (path: string): SourceScan => {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const where = (node: ts.Node): string =>
    `${repoPath(path)}:${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`;

  // local binding → exported name, for imports from generated.ts
  const imported = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!GENERATED_MODULE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imported.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }

  const documents: string[] = [];
  const tools: string[] = [];
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'request') {
        const [first] = node.arguments;
        const name = first !== undefined && ts.isIdentifier(first) ? imported.get(first.text) : undefined;
        if (name === undefined) {
          problems.push(
            `${where(node)}: .request(…) must be passed a document imported from graphql/generated.js`,
          );
        } else {
          documents.push(name);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'defineTool') {
        const [definition] = node.arguments;
        const nameProperty =
          definition !== undefined && ts.isObjectLiteralExpression(definition)
            ? definition.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name',
              )
            : undefined;
        if (nameProperty === undefined || !ts.isStringLiteral(nameProperty.initializer)) {
          problems.push(
            `${where(node)}: defineTool needs a literal \`name\` for this check to attribute its documents`,
          );
        } else {
          tools.push(nameProperty.initializer.text);
        }
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) &&
      INLINE_OPERATION.test(node.text)
    ) {
      problems.push(`${where(node)}: inline GraphQL operation; put it in src/graphql/operations/ instead`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { documents, tools, problems };
};

const generatedDocument = (name: string): DocumentNode => {
  const value: unknown = (generated as Record<string, unknown>)[name];
  if (!(value instanceof generated.TypedDocumentString))
    throw new Error(`generated.ts exports no document ${name}`);
  return parse(value.toString());
};

const satisfies = (granted: readonly Scope[], requirement: ScopeRequirement): boolean =>
  requirement.match === 'all'
    ? requirement.scopes.every((s) => granted.includes(s))
    : requirement.scopes.some((s) => granted.includes(s));

describe('API surface: only what the API opens to connected apps', () => {
  it('refuses anything not on the allowed list (sanity: the check is not vacuous)', () => {
    const document = parse(`
      fragment Hidden on Mutation { outcome: someStaffDecision(input: {}) }
      mutation Innocent { ... on Mutation { ...Hidden } }
    `);
    const fields = [...rootFieldsOf(document).values()].flat();
    expect(fields).toEqual(['Mutation.someStaffDecision']);
    expect(refusal('Mutation.someStaffDecision')).toMatch(/not open to OAuth clients/);
    expect(refusal('Mutation.login')).toMatch(/not open to OAuth clients/);
    // Grading is the organization's to do (grade:write), not a staff operation.
    expect(refusal('Mutation.adjudicateReport')).toBeUndefined();
    expect(refusal('Query.programs')).toBeUndefined();
  });

  it('operations select only nested fields on the allowed list', () => {
    const schema = buildSchema(readFileSync(PRUNED_SCHEMA_PATH, 'utf8'));
    const files = loadOperations();
    const fragments = files.flatMap((f) =>
      f.document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION),
    );
    const problems = files.flatMap((f) => {
      const merged: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [...f.document.definitions, ...fragments],
      };
      return selectedFields(merged, schema)
        .filter(
          (field) =>
            !field.startsWith('Query.') && !field.startsWith('Mutation.') && !ALLOWED_FIELDS.has(field),
        )
        .map(
          (field) =>
            `${f.location}: selects ${field}, which is not on the allowed list; check the API's OAuth field rules, then add it to api-surface.fields.json`,
        );
    });
    expect(problems).toEqual([]);
  });

  it('flags a nested field not on the allowed list (sanity: the check is not vacuous)', () => {
    const schema = buildSchema(`
      type Query { reportComments: [ReportCommentModel!]! }
      type ReportCommentModel { id: ID! somethingNew: String! }
    `);
    const fields = selectedFields(parse('query Q { reportComments { id somethingNew } }'), schema);
    expect(fields.filter((f) => f !== 'Query.reportComments' && !ALLOWED_FIELDS.has(f))).toEqual([
      'ReportCommentModel.somethingNew',
    ]);
  });

  it('search asks only for result types connected apps may search', () => {
    expect(SEARCH_TYPES.filter((t) => !SEARCHABLE_TYPES.includes(t))).toEqual([]);
  });

  it('operation files reference only fields open to OAuth clients', () => {
    const files = loadOperations();
    expect(files.length).toBeGreaterThan(0);
    // Fragments may live in another file, so resolve them across all files.
    const fragments = files.flatMap((f) =>
      f.document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION),
    );
    const problems = files.flatMap((f) => {
      const merged: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [...f.document.definitions, ...fragments],
      };
      return [...rootFieldsOf(merged)].flatMap(([operation, fields]) =>
        fields.flatMap((field) => {
          const why = refusal(field);
          return why === undefined ? [] : [`${f.location} (${operation}): ${why}`];
        }),
      );
    });
    expect(problems).toEqual([]);
  });

  it('the vendored schema exposes only fields open to OAuth clients', () => {
    const schema = buildSchema(readFileSync(PRUNED_SCHEMA_PATH, 'utf8'));
    const roots: [RootType, GraphQLObjectType | null | undefined][] = [
      ['Query', schema.getQueryType()],
      ['Mutation', schema.getMutationType()],
      ['Subscription', schema.getSubscriptionType()],
    ];
    const fields = roots.flatMap(([root, type]) =>
      Object.keys(type?.getFields() ?? {}).map((name): RootField => `${root}.${name}`),
    );
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.flatMap((f) => refusal(f) ?? [])).toEqual([]);
  });

  describe('sources', () => {
    const scans = new Map(sourceFiles().map((path) => [repoPath(path), scanSource(path)]));

    it('send only codegen documents, from the file that defines the tool', () => {
      const problems = [...scans].flatMap(([path, scan]) => [
        ...scan.problems,
        // A request outside a tool file could not be attributed to a tool below.
        ...(scan.documents.length > 0 && scan.tools.length !== 1
          ? [`${path}: sends GraphQL documents but defines ${String(scan.tools.length)} tools (expected 1)`]
          : []),
      ]);
      expect(problems).toEqual([]);
    });

    it('attribute every registered tool to exactly one source file', () => {
      const defined = [...scans.values()].flatMap((s) => s.tools).sort();
      expect(defined).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    });

    it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
      '%s sends only fields open to OAuth clients, within its scopes',
      (name, tool) => {
        const scan = [...scans.values()].find((s) => s.tools.includes(name));
        expect(scan?.documents.length ?? 0).toBeGreaterThan(0);
        const problems = (scan?.documents ?? []).flatMap((documentName) =>
          [...rootFieldsOf(generatedDocument(documentName))].flatMap(([operation, fields]) =>
            fields.flatMap((field) => {
              const why = refusal(field);
              if (why !== undefined) return [`${name} → ${operation}: ${why}`];
              const requirement = OPEN_TO_OAUTH[field];
              // Optional scopes serve best-effort READS only: a mutation needs the required scopes.
              const mutation = field.startsWith('Mutation.');
              if (mutation && !isWriteTool(tool))
                return [`${name} → ${operation}: a read-only tool sends the mutation ${field}`];
              const usable = [...tool.requiredScopes, ...(mutation ? [] : (tool.optionalScopes ?? []))];
              return requirement !== undefined && !satisfies(usable, requirement)
                ? [
                    `${name} → ${operation}: ${field} needs ${requirement.match} of [${requirement.scopes.join(', ')}] ` +
                      `but the tool requires [${tool.requiredScopes.join(', ')}] and uses [${(tool.optionalScopes ?? []).join(', ')}] when granted`,
                  ]
                : [];
            }),
          ),
        );
        expect(problems).toEqual([]);
      },
    );
  });
});
