import * as z from 'zod';

import { GetTaxonomyDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { code, ifShaped, paginationInput, paginationOutput, wrapped } from './shared/common.js';
import { TAXONOMY_NODE_ID } from './shared/taxonomy.js';
import { defineTool } from './define-tool.js';

export const getTaxonomy = defineTool({
  name: 'get_taxonomy',
  title: 'Get the vulnerability taxonomy',
  description:
    'The published vulnerability taxonomy every BugSecure grade is judged against: each node’s id, name, ' +
    'baseline priority (1 = most severe, null = varies), and default CVSS vector and CWE where the ' +
    'taxonomy maps one. grade_report needs a node id from here. Filter with `query` (matched against ids ' +
    'and names) rather than paging through the whole list.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe('Case-insensitive words that must all appear in the node id or name, e.g. "stored xss".'),
    ...paginationInput(200, 50),
  }),
  output: z.object({
    taxonomyId: code('taxonomy-version'),
    taxonomyVersion: code('taxonomy-version'),
    nodes: z.array(
      z.object({
        id: code('taxonomy-node-id', 'grade_report `vrtNodeId`.'),
        name: wrapped(),
        priority: z
          .number()
          .int()
          .nullable()
          .describe('Baseline priority, 1 (critical) to 5 (informational); null = varies with context.'),
        cvssVector: code('cvss-vector', 'Default vector for this node.').nullable(),
        cweId: code('cwe-id').nullable(),
      }),
    ),
    total: z.number().int().describe('Nodes matching the query.'),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    const { taxonomyProfile: t } = await graphql.request(GetTaxonomyDocument, {}, { signal });
    const words = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matching = t.nodes.filter((n) => {
      if (!TAXONOMY_NODE_ID.test(n.id)) return false;
      const haystack = `${n.id.replaceAll('_', ' ')} ${n.name}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    const slice = matching.slice(input.offset, input.offset + input.limit);
    return {
      data: {
        taxonomyId: t.taxonomyId,
        taxonomyVersion: t.taxonomyVersion,
        nodes: slice.map((n) => ({
          id: n.id,
          name: untrusted(`taxonomy:${n.id}:name`, n.name),
          priority: n.priority,
          cvssVector: ifShaped('cvss-vector', n.cvssVector),
          cweId: ifShaped('cwe-id', n.cweId),
        })),
        total: matching.length,
        offset: input.offset,
        limit: input.limit,
        nextOffset: input.offset + input.limit < matching.length ? input.offset + input.limit : null,
      },
    };
  },
});
