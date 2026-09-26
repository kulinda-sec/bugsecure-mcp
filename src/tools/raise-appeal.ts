import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import type { AppealStatus } from '../graphql/generated.js';
import { GetAppealTargetDocument, RaiseAppealDocument } from '../graphql/generated.js';
import { id, idInput, timestamp, userText } from './shared/common.js';
import { assertOwnReport } from './shared/report.js';
import { defineTool } from './define-tool.js';

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
    'are shown the exact grounds and must approve them. Get the grade’s id from get_report. Appeals must ' +
    'be raised before the appeal window closes.',
  requiredScopes: ['reports:write'],
  // Reading the report shows its title and the grade contested in the approval, and checks it is the user's.
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
  approval: async (input, context) => {
    const notes: string[] = [];
    const shown: [string, string | undefined][] = [];
    if (context.granted.has('reports:read')) {
      let target;
      try {
        target = await context.graphql.request(
          GetAppealTargetDocument,
          { reportId: input.reportId },
          { signal: context.signal },
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        notes.push('Could not look up the report and its grade; only ids are shown.');
      }
      if (target !== undefined) {
        if (target.report === null)
          throw new BugSecureError('NOT_FOUND', 'No report with that id is visible to this account.');
        assertOwnReport(target.report.reporter.id, context.viewerId);
        const grade = target.reportAdjudication;
        if (grade?.id !== input.adjudicationId) {
          throw new BugSecureError(
            'INVALID_INPUT',
            'Nothing was sent: that grade is not the one in force on this report. Read the report again with get_report and use its adjudication.id.',
          );
        }
        shown.push(
          ['Report', target.report.title],
          [
            'Grade contested',
            `${grade.severity}, ${grade.amount === null ? 'no reward' : `${grade.amount.toLocaleString('en-US')} ${grade.currency}`}, graded by ${grade.side === 'ORGANIZATION' ? 'the organisation' : 'BugSecure'}`,
          ],
        );
      }
    } else {
      notes.push('The report and the grade are not shown: this connection lacks reports:read.');
    }
    return {
      action: `appeal the grade ${input.adjudicationId} of your report ${input.reportId}`,
      audience:
        'BugSecure, as the neutral third party, re-examines the grade; the organisation sees the grounds. Appeals per report are limited.',
      irreversible: true,
      context: shown,
      notes,
      fields: [
        ['Report', input.reportId],
        ['Grade', input.adjudicationId],
        ['Grounds', input.grounds],
      ],
    };
  },
  // `reportId` is for the approval and the checks above; the API needs only the grade.
  async handler(input, { graphql, signal, clientRequestId }) {
    const { raiseAppeal: a } = await graphql.request(
      RaiseAppealDocument,
      { input: { adjudicationId: input.adjudicationId, grounds: input.grounds }, clientRequestId },
      { signal },
    );
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
