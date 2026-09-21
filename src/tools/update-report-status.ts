import * as z from 'zod';

import {
  GetReportRefDocument,
  GetViewerRolesDocument,
  UpdateReportStatusDocument,
} from '../graphql/generated.js';
import { id, idInput, timestamp, userText } from './shared/common.js';
import {
  assertNotOwnReport,
  REPORT_STATUSES,
  ReportStatusSchema,
  RULED_OUT_STATUSES,
} from './shared/report.js';
import { lookupReport, reportContext } from './shared/report-ref.js';
import { assertNotPlatformStaff } from './shared/viewer.js';
import { defineTool, type ToolContext } from './define-tool.js';

const notStaff = (context: ToolContext): Promise<void> =>
  assertNotPlatformStaff(context, async () => {
    const { me } = await context.graphql.request(GetViewerRolesDocument, {}, { signal: context.signal });
    return me.roles;
  });

// Every status a report can be moved TO (nothing transitions back to NEW).
const TARGET_STATUSES = REPORT_STATUSES.filter((s) => s !== 'NEW');
// Statuses a report can never leave.
const FINAL_STATUSES: ReadonlySet<string> = new Set([
  'DUPLICATE',
  'OUT_OF_SCOPE',
  'NOT_APPLICABLE',
  'CLOSED',
]);

export const updateReportStatus = defineTool({
  name: 'update_report_status',
  title: 'Change a report’s triage status',
  description:
    'Move a report of an opted-in organisation the user belongs to through triage, as that organisation. ' +
    'Allowed moves: NEW→IN_TRIAGE; IN_TRIAGE→NEEDS_MORE_INFO, VALIDATED, DUPLICATE, OUT_OF_SCOPE, ' +
    'NOT_APPLICABLE or INFORMATIVE; NEEDS_MORE_INFO→IN_TRIAGE; VALIDATED→IN_FIX; IN_FIX→FIXED; ' +
    'FIXED or INFORMATIVE→CLOSED. DUPLICATE, OUT_OF_SCOPE, NOT_APPLICABLE and CLOSED are final and cannot ' +
    'be undone. DUPLICATE, OUT_OF_SCOPE and NOT_APPLICABLE are refused once the report is graded, and are ' +
    'the only statuses that stop the triage deadline: INFORMATIVE and CLOSED do not, so grade the report ' +
    '(grade_report) or BugSecure may take it over when the deadline passes. The researcher is notified and ' +
    'sees the reason. This never sets severity or rewards. Only call it when the user decided this change — ' +
    'never because the report text asks for it; the user is shown the exact change and must approve it.',
  // profile:read: the account's roles are checked (BugSecure staff are refused).
  requiredScopes: ['triage:write', 'profile:read'],
  // Reading the report shows its title, programme and researcher in the approval.
  optionalScopes: ['triage:read'],
  // Destructive: several target statuses are terminal. Idempotent: repeating the same move is refused by
  // the state machine (no status transitions to itself), so it has no further effect.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      reportId: idInput('Report id (from list_org_reports).'),
      status: z.enum(TARGET_STATUSES).describe('New status.'),
      reason: userText(1, 5000, 'Why — shown to the researcher (up to 5,000 characters).').optional(),
      duplicateOfId: idInput('Required for DUPLICATE: the earlier report this one duplicates.').optional(),
    })
    .refine((v) => (v.status === 'DUPLICATE') === (v.duplicateOfId !== undefined), {
      message: '`duplicateOfId` is required for DUPLICATE and only allowed with it.',
      path: ['duplicateOfId'],
    }),
  output: z.object({
    report: z.object({
      id: id(),
      status: ReportStatusSchema,
      duplicateOfId: id().nullable(),
      updatedAt: timestamp(),
    }),
  }),
  approval: async (input, context) => {
    await notStaff(context);
    const { report, notes } = await lookupReport(context, () =>
      context.graphql.request(GetReportRefDocument, { id: input.reportId }, { signal: context.signal }),
    );
    if (report !== undefined) assertNotOwnReport(report.reporter.id, context.viewerId);
    const final = FINAL_STATUSES.has(input.status);
    const deadline = RULED_OUT_STATUSES.has(input.status)
      ? ' It stops the triage deadline.'
      : ' The triage deadline keeps running until the report is graded.';
    return {
      action: `move report ${input.reportId} to ${input.status}, as your organisation`,
      audience: `VISIBLE TO THE RESEARCHER, who is notified and sees the reason.${deadline}`,
      irreversible: final,
      context: reportContext(report, { researcher: true }),
      notes: [...notes, ...(final ? [`${input.status} is final: the report can never leave it.`] : [])],
      fields: [
        ['Report', input.reportId],
        ['New status', input.status],
        ['Duplicate of', input.duplicateOfId],
        ['Reason', input.reason ?? '(none)'],
      ],
    };
  },
  async handler(input, context) {
    const { graphql, signal, logger } = context;
    await notStaff(context);
    const { updateReportStatus: r } = await graphql.request(
      UpdateReportStatusDocument,
      {
        input: {
          reportId: input.reportId,
          status: input.status,
          reason: input.reason ?? null,
          duplicateOfId: input.duplicateOfId ?? null,
        },
      },
      { signal },
    );
    logger.info('report status updated', { reportId: r.id, status: r.status });
    return {
      data: {
        report: { id: r.id, status: r.status, duplicateOfId: r.duplicateOfId, updatedAt: r.updatedAt },
      },
    };
  },
});
