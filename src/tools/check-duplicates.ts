import * as z from 'zod';

import { CheckDuplicatesDocument } from '../graphql/generated.js';
import { idInput } from './shared/common.js';
import { ReportSummarySchema, toReportSummary } from './shared/report.js';
import { defineTool } from './define-tool.js';

export const checkDuplicates = defineTool({
  name: 'check_duplicates',
  title: 'Find possible duplicate reports',
  description:
    'Existing reports on a programme that may duplicate a finding (title and description similarity; up ' +
    'to 10, excluding reports ruled out of scope or not applicable). Organisation side: it reveals other ' +
    'researchers’ reports, so only for programmes of opted-in organisations the user belongs to. ' +
    'Candidates are hints — compare them with get_org_report before marking anything DUPLICATE.',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    programId: idInput('Programme to search.'),
    title: z.string().trim().min(1).max(300).describe('Title of the finding to check.'),
    description: z.string().trim().min(1).max(50_000).describe('Description of the finding to check.'),
  }),
  output: z.object({ candidates: z.array(ReportSummarySchema) }),
  async handler(input, { graphql, signal }) {
    const { checkDuplicates: rows } = await graphql.request(
      CheckDuplicatesDocument,
      { programId: input.programId, title: input.title, description: input.description },
      { signal },
    );
    return { data: { candidates: rows.map(toReportSummary) } };
  },
});
