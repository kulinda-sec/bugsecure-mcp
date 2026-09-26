import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { AssignReportDocument, GetReportRefDocument, GetViewerRolesDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, idInput, timestamp } from './shared/common.js';
import { assertNotOwnReport, UserRefSchema } from './shared/report.js';
import { lookupReport, reportContext } from './shared/report-ref.js';
import { assertNotPlatformStaff } from './shared/viewer.js';
import { defineTool, type ToolContext } from './define-tool.js';

const notStaff = (context: ToolContext): Promise<void> =>
  assertNotPlatformStaff(context, async () => {
    const { me } = await context.graphql.request(GetViewerRolesDocument, {}, { signal: context.signal });
    return me.roles;
  });

/**
 * Only to the signed-in user: a connected app cannot list an organisation's
 * members (refused to OAuth clients), so it could not show who another id is.
 */
const self = (viewerId: string | undefined): string => {
  if (viewerId === undefined)
    throw new BugSecureError(
      'UPSTREAM_ERROR',
      'Cannot tell who you are: the access token does not name its user. Sign in again.',
    );
  return viewerId;
};

export const assignReport = defineTool({
  name: 'assign_report',
  title: 'Assign a report to myself',
  description:
    'Assign a report of an opted-in organisation the user belongs to to the signed-in user, as the ' +
    'organisation’s triager for it, replacing any current assignee. Assigning to someone else is done on the ' +
    'BugSecure website. The researcher is not notified. The user approves it first.',
  // profile:read: the account's roles are checked (BugSecure staff are refused).
  requiredScopes: ['triage:write', 'profile:read'],
  // Reading the report shows its title and current assignee in the approval.
  optionalScopes: ['triage:read'],
  // Destructive: replaces the current assignee. Idempotent: assigning yourself again changes nothing.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ reportId: idInput('Report id (from list_org_reports).') }),
  output: z.object({
    report: z.object({ id: id(), assignedTriage: UserRefSchema.nullable(), updatedAt: timestamp() }),
  }),
  approval: async (input, context) => {
    const me = self(context.viewerId);
    await notStaff(context);
    const { report, notes } = await lookupReport(context, () =>
      context.graphql.request(GetReportRefDocument, { id: input.reportId }, { signal: context.signal }),
    );
    if (report !== undefined) assertNotOwnReport(report.reporter.id, context.viewerId);
    return {
      action: `assign report ${input.reportId} to yourself, as your organisation`,
      audience: 'Seen by your organisation. The researcher is not notified.',
      irreversible: false,
      context: [
        ...reportContext(report, { researcher: true }),
        ['Assigned now', report === undefined ? undefined : (report.assignedTriage?.username ?? '(nobody)')],
      ],
      notes,
      fields: [
        ['Report', input.reportId],
        ['Assignee', `you (${me})`],
      ],
    };
  },
  async handler(input, context) {
    const { graphql, signal, logger, clientRequestId } = context;
    const me = self(context.viewerId);
    await notStaff(context);
    const { assignTriageAnalyst: r } = await graphql.request(
      AssignReportDocument,
      { reportId: input.reportId, triageUserId: me, clientRequestId },
      { signal },
    );
    logger.info('report assigned', { reportId: r.id });
    return {
      data: {
        report: {
          id: r.id,
          assignedTriage: r.assignedTriage && {
            id: r.assignedTriage.id,
            username: untrusted(`user:${r.assignedTriage.id}:username`, r.assignedTriage.username),
          },
          updatedAt: r.updatedAt,
        },
      },
    };
  },
});
