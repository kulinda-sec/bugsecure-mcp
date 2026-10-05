import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import {
  AssignReportDocument,
  type GetReportRefQuery,
  GetReportRefDocument,
  GetViewerRolesDocument,
} from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, idInput, timestamp } from './shared/common.js';
import { UserRefSchema } from './shared/report.js';
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

/**
 * Only to the signed-in user: a connected app cannot list an organisation's
 * members (refused to OAuth clients), so it could not name another one.
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
    'BugSecure website. The researcher is not notified. The user approves it on BugSecure first.',
  // profile:read: the account's roles are checked (BugSecure staff are refused). triage:read: the report
  // is read first, to check it was submitted to your organisation (orgSideReport); a report that cannot
  // be read is refused, not written blind.
  requiredScopes: ['triage:write', 'profile:read', 'triage:read'],
  // Destructive: replaces the current assignee. Idempotent: assigning yourself again changes nothing.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ reportId: idInput('Report id (from list_org_reports).') }),
  output: z.object({
    report: z.object({ id: id(), assignedTriage: UserRefSchema.nullable(), updatedAt: timestamp() }),
  }),
  payload: async (input, context) => {
    const me = self(context.viewerId);
    await notStaff(context);
    await orgSideReport(context, readRef(context, input.reportId));
    return {
      action: 'assign a report to you, as your organisation’s triager',
      parts: [mutation(AssignReportDocument, { reportId: input.reportId, triageUserId: me })],
    };
  },
  async handler(_input, { approved, signal, logger }) {
    const { assignTriageAnalyst: r } = await approved.part.send({ signal });
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
