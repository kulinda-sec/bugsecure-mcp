import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import type { AppealStatus } from '../graphql/generated.js';
import { GetAppealTargetDocument, RaiseAppealDocument } from '../graphql/generated.js';
import { id, idInput, timestamp, userText } from './shared/common.js';
import { assertOwnReport } from './shared/report.js';
import { defineTool, mutation } from './define-tool.js';

const APPEAL_STATUSES = [
  'OPEN',
  'UPHELD',
  'OVERTURNED',
  'WITHDRAWN',
] as const satisfies readonly AppealStatus[];

export const raiseAppeal = defineTool({
  name: 'raise_appeal',
  title: 'Appeal the grade of my report',
  description:
    'Appeal the grade (assessed severity and reward) of one of the signed-in researcher’s own reports. ' +
    'BugSecure, as the appointed neutral third party, re-examines the grade (an assessor other than the ' +
    'grader); the organisation sees the grounds. An appeal cannot be withdrawn from here, and the number ' +
    'of appeals per report is limited, so only call this when the user explicitly asked to appeal; they ' +
    'read and approve the exact grounds on BugSecure first, next to the grade contested. Get the grade’s ' +
    'id from get_report (adjudication.id). Appeals must be raised before the appeal window closes.',
  requiredScopes: ['reports:write'],
  // Safety lookup: the report must be the caller's own and the grade the one in force on it.
  optionalScopes: ['reports:read'],
  // Destructive: irreversible (cannot be withdrawn here, and uses one of the report's limited appeals).
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    reportId: idInput('The report whose grade is contested (get_report).'),
    adjudicationId: idInput('The grade being contested (get_report → adjudication.id).'),
    grounds: userText(20, 10_000, 'Why the grade is wrong, with evidence (20–10,000 characters).'),
  }),
  output: z.object({
    appeal: z.object({
      id: id(),
      reportId: id(),
      adjudicationId: id(),
      status: z.enum(APPEAL_STATUSES),
      createdAt: timestamp(),
    }),
  }),
  // `reportId` names the report for the model and the check below; the API needs only the grade,
  // and enforces the same rules itself (the review page shows the report and the grade contested).
  payload: async (input, context) => {
    if (context.granted.has('reports:read')) {
      let target;
      try {
        target = await context.graphql.request(
          GetAppealTargetDocument,
          { reportId: input.reportId },
          { signal: context.signal },
        );
      } catch (error) {
        // A typed refusal (session expired, scope missing, API refusal) keeps its own guidance.
        if (context.signal.aborted || error instanceof BugSecureError) throw error;
        // Fail closed: an appeal is irreversible and counted, so it is not asked for unverified.
        throw new BugSecureError(
          'UPSTREAM_UNAVAILABLE',
          'Nothing was sent: the report and its grade could not be checked on BugSecure. Try again.',
        );
      }
      if (target.report === null)
        throw new BugSecureError('NOT_FOUND', 'No report with that id is visible to this account.');
      assertOwnReport(target.report.reporter.id, context.viewerId);
      if (target.reportAdjudication?.id !== input.adjudicationId) {
        throw new BugSecureError(
          'INVALID_INPUT',
          'Nothing was sent: that grade is not the one in force on this report. Read the report again with get_report and use its adjudication.id.',
        );
      }
    }
    return {
      action: 'appeal the grade of one of your reports',
      parts: [
        mutation(RaiseAppealDocument, {
          input: { adjudicationId: input.adjudicationId, grounds: input.grounds },
        }),
      ],
    };
  },
  async handler(_input, { approved, signal }) {
    const { raiseAppeal: a } = await approved.part.send({ signal });
    return {
      data: {
        appeal: {
          id: a.id,
          reportId: a.reportId,
          adjudicationId: a.adjudicationId,
          status: a.status,
          createdAt: a.createdAt,
        },
      },
    };
  },
});
