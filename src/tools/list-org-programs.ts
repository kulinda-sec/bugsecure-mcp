import * as z from 'zod';

import { ListOrgProgramsDocument } from '../graphql/generated.js';
import { code, page, paginationInput, paginationOutput } from './shared/common.js';
import { ProgramSummarySchema, toProgramSummary } from './shared/program.js';
import { defineTool } from './define-tool.js';

export const listOrgPrograms = defineTool({
  name: 'list_org_programs',
  title: 'List my organizations’ programmes',
  description:
    'Every programme of the organisations the signed-in user belongs to that enabled AI triage access, ' +
    'drafts, paused and closed ones included, with their triage deadline. Use the ids with list_org_reports ' +
    'and get_program_stats. Programmes are created and changed only on the BugSecure website.',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({ ...paginationInput(50) }),
  output: z.object({
    programs: z.array(
      ProgramSummarySchema.extend({
        currency: code('currency'),
        triageDeadlineBusinessDays: z
          .number()
          .int()
          .nullable()
          .describe('Business days to grade a report before BugSecure may take it over.'),
      }),
    ),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    const { myPrograms } = await graphql.request(
      ListOrgProgramsDocument,
      { skip: input.offset, take: input.limit },
      { signal },
    );
    return {
      data: {
        programs: myPrograms.map((p) => ({
          ...toProgramSummary(p),
          currency: p.currency,
          triageDeadlineBusinessDays: p.triageDeadlineBusinessDays,
        })),
        ...page(myPrograms.length, input),
      },
    };
  },
});
