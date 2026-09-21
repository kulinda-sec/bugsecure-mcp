import * as z from 'zod';

import { ListMyReportsDocument } from '../graphql/generated.js';
import { idInput, paginationInput, paginationOutput, page } from './shared/common.js';
import {
  ReportStatusSchema,
  ReportSummarySchema,
  requireViewerWhenAmbiguous,
  SeveritySchema,
  toReportSummary,
} from './shared/report.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 50;

export const listMyReports = defineTool({
  name: 'list_my_reports',
  title: 'List my vulnerability reports',
  description:
    'Vulnerability reports the signed-in researcher submitted, newest first, with status and claimed ' +
    'severity. Filter by programme, status, severity or text. Call get_report with an id for the full ' +
    'report, its comments, status history, adjudication and appeals.',
  requiredScopes: ['reports:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    programId: idInput('Only reports on this programme.').optional(),
    status: ReportStatusSchema.optional().describe('Only reports in this status.'),
    severity: SeveritySchema.optional().describe('Only reports with this claimed severity.'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Text to look for in titles and descriptions.'),
    ...paginationInput(MAX_LIMIT),
  }),
  output: z.object({ reports: z.array(ReportSummarySchema), ...paginationOutput }),
  async handler(input, { graphql, signal, granted, viewerId }) {
    // With triage:read too, the same API list also holds the user's organisations' reports:
    // ask for the user's own (and drop anything else that comes back regardless).
    requireViewerWhenAmbiguous(viewerId, granted.has('triage:read'));
    const { reports } = await graphql.request(
      ListMyReportsDocument,
      {
        filters: {
          programId: input.programId ?? null,
          status: input.status ?? null,
          severity: input.severity ?? null,
          search: input.query ?? null,
          reporterId: viewerId ?? null,
        },
        skip: input.offset,
        take: input.limit,
      },
      { signal },
    );
    const own = reports.filter((r) => viewerId === undefined || r.reporter.id === viewerId);
    return { data: { reports: own.map(toReportSummary), ...page(reports.length, input) } };
  },
});
