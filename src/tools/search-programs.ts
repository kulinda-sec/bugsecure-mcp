import * as z from 'zod';

import { ListInvitedProgramsDocument, SearchProgramsDocument } from '../graphql/generated.js';
import { idInput, page, paginationInput, paginationOutput } from './shared/common.js';
import { defineTool } from './define-tool.js';
import { ProgramSummarySchema, toProgramSummary } from './shared/program.js';

const MAX_LIMIT = 50;

export const searchPrograms = defineTool({
  name: 'search_programs',
  title: 'Search bug bounty programmes',
  description:
    'Search the public BugSecure catalogue of active bug bounty programmes. Filter by free-text query, ' +
    'organization or reward range; results are paginated with limit/offset. Returns summaries only — ' +
    'call get_program with an id for scope, rules and the reward grid. invited: true lists instead the ' +
    'private programmes the user was invited to.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      invited: z
        .boolean()
        .default(false)
        .describe('List the private programmes you were invited to (no other filter applies).'),
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe('Free-text search over programme titles and descriptions.'),
      organizationId: idInput('Only programmes run by this organisation.').optional(),
      minReward: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only programmes whose reward grid pays at least this much.'),
      maxReward: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only programmes whose reward grid pays at most this much.'),
      ...paginationInput(MAX_LIMIT),
    })
    .refine(
      (v) =>
        !v.invited || [v.query, v.organizationId, v.minReward, v.maxReward].every((f) => f === undefined),
      { message: 'invited: true takes no other filter.' },
    ),
  output: z.object({
    programs: z.array(ProgramSummarySchema),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    if (input.invited) {
      const { myInvitedPrograms } = await graphql.request(
        ListInvitedProgramsDocument,
        { skip: input.offset, take: input.limit },
        { signal },
      );
      return {
        data: { programs: myInvitedPrograms.map(toProgramSummary), ...page(myInvitedPrograms.length, input) },
      };
    }
    const { programs } = await graphql.request(
      SearchProgramsDocument,
      {
        filters: {
          search: input.query ?? null,
          organizationId: input.organizationId ?? null,
          minReward: input.minReward ?? null,
          maxReward: input.maxReward ?? null,
        },
        skip: input.offset,
        take: input.limit,
      },
      { signal },
    );
    return {
      data: {
        programs: programs.map(toProgramSummary),
        ...page(programs.length, input),
      },
    };
  },
});
