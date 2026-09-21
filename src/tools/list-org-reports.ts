import * as z from 'zod';

import { ListOrgReportsDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { idInput, paginationInput, paginationOutput, page } from './shared/common.js';
import {
  ReportStatusSchema,
  ReportSummarySchema,
  requireViewerWhenAmbiguous,
  SeveritySchema,
  toReportSummary,
  UserRefSchema,
} from './shared/report.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 50;

export const listOrgReports = defineTool({
  name: 'list_org_reports',
  title: 'List reports to triage',
  description:
    'Reports submitted to the programmes of organisations the signed-in user belongs to — only ' +
    'organisations that enabled AI triage access — newest first. Filter by programme, status, severity, ' +
    'assigned triager or text; e.g. status NEW for the untriaged queue. Never includes the user’s own ' +
    'reports as a researcher (a page can hold fewer than `limit`). Call get_org_report for one report.',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    programId: idInput('Only reports on this programme.').optional(),
    status: ReportStatusSchema.optional().describe('Only reports in this status.'),
    severity: SeveritySchema.optional().describe('Only reports with this claimed severity.'),
    assignedTriageId: idInput('Only reports assigned to this triager (user id).').optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Text to look for in titles and descriptions.'),
    ...paginationInput(MAX_LIMIT),
  }),
  output: z.object({
    reports: z.array(
      ReportSummarySchema.extend({
        assignedTriage: UserRefSchema.nullable(),
      }),
    ),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal, granted, viewerId }) {
    // With reports:read too, the same API list also holds the user's own reports as a researcher.
    requireViewerWhenAmbiguous(viewerId, granted.has('reports:read'));
    const { reports } = await graphql.request(
      ListOrgReportsDocument,
      {
        filters: {
          programId: input.programId ?? null,
          status: input.status ?? null,
          severity: input.severity ?? null,
          assignedTriageId: input.assignedTriageId ?? null,
          search: input.query ?? null,
        },
        skip: input.offset,
        take: input.limit,
      },
      { signal },
    );
    return {
      data: {
        reports: reports
          .filter((r) => r.reporter.id !== viewerId)
          .map((r) => ({
            ...toReportSummary(r),
            assignedTriage: r.assignedTriage && {
              id: r.assignedTriage.id,
              username: untrusted(`user:${r.assignedTriage.id}:username`, r.assignedTriage.username),
            },
          })),
        ...page(reports.length, input),
      },
    };
  },
});
