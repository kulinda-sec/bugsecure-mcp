import * as z from 'zod';

import { SearchDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import {
  code,
  id,
  paginationInput,
  paginationOutput,
  page,
  safeSlug,
  slug,
  wrapped,
} from './shared/common.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 50;
/** Result types this tool can ask for (checked against what OAuth clients may search, api-surface.test.ts). */
export const SEARCH_TYPES = ['program', 'report', 'researcher'] as const;
const TYPES = SEARCH_TYPES;
/** Researchers are opt-in via `types`, matching the API's own default. */
const DEFAULT_TYPES = ['program', 'report'] as const;

export const search = defineTool({
  name: 'search',
  title: 'Search BugSecure',
  description:
    'Full-text search (French and English) over programmes the user may see; reports only with ' +
    'reports:read (own reports) or triage:read (reports of opted-in organisations); and, when `types` ' +
    'includes "researcher", public researcher profiles (title = username). Follow up with get_program, ' +
    'get_report, get_org_report or get_researcher_profile. Several types are merged by relevance, so ' +
    'paging is approximate; restrict `types` to page exhaustively.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().trim().min(2).max(200).describe('Search terms (at least 2 characters).'),
    types: z
      .array(z.enum(TYPES))
      .min(1)
      .max(TYPES.length)
      .optional()
      .describe('Result types to search. Defaults to programmes and reports.'),
    ...paginationInput(MAX_LIMIT),
  }),
  output: z.object({
    results: z.array(
      z.object({
        type: z.enum(TYPES),
        id: id(),
        slug: slug('Programme slug (programmes only).'),
        title: wrapped('For researchers: the username.'),
        status: code('machine-code').nullable(),
        highlight: wrapped('Excerpt; matches marked with <mark>.').nullable(),
        rank: z.number().describe('Relevance; higher is better.'),
      }),
    ),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    const { search: rows } = await graphql.request(
      SearchDocument,
      {
        query: input.query,
        types: input.types ? [...new Set(input.types)] : [...DEFAULT_TYPES],
        limit: input.limit,
        offset: input.offset,
      },
      { signal },
    );
    const results = rows.flatMap((r) => {
      const type = TYPES.find((t) => t === r.type);
      if (type === undefined) return []; // a result type this version does not know
      const src = `${type}:${r.id}`;
      return [
        {
          type,
          id: r.id,
          slug: safeSlug(r.slug),
          title: untrusted(`${src}:title`, r.title),
          status: r.status,
          highlight: untrusted(`${src}:excerpt`, r.highlight),
          rank: r.rank,
        },
      ];
    });
    return { data: { results, ...page(rows.length, input) } };
  },
});
