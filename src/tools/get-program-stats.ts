import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { GetProgramStatsDocument } from '../graphql/generated.js';
import { code, idInput } from './shared/common.js';
import { defineTool } from './define-tool.js';

const Counts = z.record(code('machine-code'), z.number().int().nonnegative());

export const getProgramStats = defineTool({
  name: 'get_program_stats',
  title: 'Get a programme’s report statistics',
  description:
    'Report statistics for one programme of an organization the signed-in user belongs to (organization ' +
    'must have enabled AI triage access): total reports, counts by status and by claimed severity, and the ' +
    'average time to resolution (FIXED or CLOSED).',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ programId: idInput('Programme id.') }),
  output: z.object({
    totalReports: z.number().int(),
    byStatus: Counts,
    bySeverity: Counts.describe('By claimed severity.'),
    averageResolutionHours: z.number().describe('Mean hours from submission to FIXED/CLOSED; 0 when none.'),
  }),
  async handler(input, { graphql, signal }) {
    const { programStats: s } = await graphql.request(
      GetProgramStatsDocument,
      { programId: input.programId },
      { signal },
    );
    const byStatus = Counts.safeParse(s.reportsByStatus);
    const bySeverity = Counts.safeParse(s.reportsBySeverity);
    if (!byStatus.success || !bySeverity.success) {
      throw new BugSecureError(
        'UPSTREAM_ERROR',
        'BugSecure returned programme statistics in an unexpected shape.',
      );
    }
    return {
      data: {
        totalReports: s.totalReports,
        byStatus: byStatus.data,
        bySeverity: bySeverity.data,
        averageResolutionHours: s.averageResolutionTime,
      },
    };
  },
});
