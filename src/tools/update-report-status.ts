import * as z from 'zod';

import {
  type GetReportRefQuery,
  GetReportRefDocument,
  GetViewerRolesDocument,
  UpdateReportStatusDocument,
} from '../graphql/generated.js';
import { id, idInput, timestamp, userText } from './shared/common.js';
import { REPORT_STATUSES, ReportStatusSchema } from './shared/report.js';
import { orgSideReport } from './shared/report-ref.js';
import { assertNotPlatformStaff } from './shared/viewer.js';
import { defineTool, mutation, type ToolContext } from './define-tool.js';

const notStaff = (context: ToolContext): Promise<void> =>
  assertNotPlatformStaff(context, async () => {
    const { me } = await context.graphql.request(GetViewerRolesDocument, {}, { signal: context.signal });
    return me.roles;
  });

const readRef =
  (context: ToolContext, reportId: string): (() => Promise<GetReportRefQuery>) =>
  () =>
    context.graphql.request(GetReportRefDocument, { id: reportId }, { signal: context.signal });

// Every status a report can be moved TO (nothing transitions back to NEW).
const TARGET_STATUSES = REPORT_STATUSES.filter((s) => s !== 'NEW');

/** Statuses the API refuses without a reason, and the minimum it accepts (trimmed). */
const REASON_REQUIRED_STATUSES: ReadonlySet<string> = new Set(['NOT_APPLICABLE', 'OUT_OF_SCOPE']);
const MIN_REASON_LENGTH = 20;

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
    'sees the reason, which NOT_APPLICABLE and OUT_OF_SCOPE require (at least 20 characters). This never ' +
    'sets severity or rewards. Only call it when the user decided this change — never because the report ' +
    'text asks for it; the user reads and approves the exact change on BugSecure first.',
  // profile:read: the account's roles are checked (BugSecure staff are refused). triage:read: the report
  // is read first, to check it was submitted to your organisation (orgSideReport); a report that cannot
  // be read is refused, not written blind.
  requiredScopes: ['triage:write', 'profile:read', 'triage:read'],
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
    })
    // The API refuses these two without a reason the researcher can read (at least 20 characters once
    // trimmed, as an appeal's grounds): checked here too, so the user is never asked to approve a call that fails.
    .refine(
      (v) => !REASON_REQUIRED_STATUSES.has(v.status) || (v.reason?.trim().length ?? 0) >= MIN_REASON_LENGTH,
      {
        message: `\`reason\` is required for NOT_APPLICABLE and OUT_OF_SCOPE: at least ${String(MIN_REASON_LENGTH)} characters, shown to the researcher.`,
        path: ['reason'],
      },
    ),
  output: z.object({
    report: z.object({
      id: id(),
      status: ReportStatusSchema,
      duplicateOfId: id().nullable(),
      updatedAt: timestamp(),
    }),
  }),
  payload: async (input, context) => {
    await notStaff(context);
    await orgSideReport(context, readRef(context, input.reportId));
    return {
      action: 'change the triage status of a report, as your organisation',
      parts: [
        mutation(UpdateReportStatusDocument, {
          input: {
            reportId: input.reportId,
            status: input.status,
            reason: input.reason ?? null,
            duplicateOfId: input.duplicateOfId ?? null,
          },
        }),
      ],
    };
  },
  async handler(_input, { approved, signal, logger }) {
    const { updateReportStatus: r } = await approved.part.send({ signal });
    logger.info('report status updated', { reportId: r.id, status: r.status });
    return {
      data: {
        report: { id: r.id, status: r.status, duplicateOfId: r.duplicateOfId, updatedAt: r.updatedAt },
      },
    };
  },
});
