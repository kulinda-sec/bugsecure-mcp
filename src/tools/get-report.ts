import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { GetReportDisclosureDocument, GetReportDocument } from '../graphql/generated.js';
import { idInput } from './shared/common.js';
import { AdjudicationSchema, AppealSchema, toAdjudication, toAppeals } from './shared/adjudication.js';
import { DisclosureSchema, toDisclosure } from './shared/disclosure.js';
import {
  assertOwnReport,
  CommentSchema,
  DEFAULT_TEXT_LIMIT,
  historyInput,
  historyMeta,
  historyPage,
  HistoryPageSchema,
  ReportDetailSchema,
  requireViewerWhenAmbiguous,
  toComments,
  toReportDetail,
  toTransitions,
  TransitionSchema,
} from './shared/report.js';
import { defineTool, type ToolContext } from './define-tool.js';

/** The disclosure draft, when this connection may read it; a failed read leaves it out (it is optional). */
const readDisclosure = async (
  reportId: string,
  textLimit: number,
  { graphql, signal, granted, logger }: ToolContext,
): Promise<z.input<typeof DisclosureSchema> | null> => {
  if (!granted.has('disclosures:write')) return null;
  try {
    const { reportDisclosureDraft } = await graphql.request(
      GetReportDisclosureDocument,
      { reportId },
      { signal },
    );
    return toDisclosure(reportId, reportDisclosureDraft, textLimit);
  } catch (error) {
    if (signal.aborted) throw error;
    logger.info('disclosure draft not read', {
      errorCode: error instanceof BugSecureError ? error.code : 'unexpected',
    });
    return null;
  }
};

export const getReport = defineTool({
  name: 'get_report',
  title: 'Get one of my reports',
  description:
    'One of the signed-in researcher’s own reports, in full: the report, public comments, status history, ' +
    'the grade in force (severity, CVSS, reward and reasoning, and which side graded it: the organisation, ' +
    'or BugSecure as the neutral third party) and any appeals. raise_appeal needs the grade’s id. Comments ' +
    'and status changes come a page at a time (historyOffset). For reports submitted to your organisation, ' +
    'use get_org_report. With disclosures:write, also its public disclosure draft.',
  requiredScopes: ['reports:read'],
  // Reads the disclosure draft when granted (the API serves it under that scope only).
  optionalScopes: ['disclosures:write'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({ reportId: idInput('Report id (from list_my_reports or search).'), ...historyInput }),
  output: z.object({
    report: ReportDetailSchema,
    comments: z.array(CommentSchema),
    transitions: z.array(TransitionSchema),
    history: HistoryPageSchema,
    adjudication: AdjudicationSchema,
    appeals: z.array(AppealSchema),
    disclosure: DisclosureSchema.nullable().describe(
      'Null without disclosures:write, or if not disclosable.',
    ),
  }),
  async handler(input, context) {
    const { graphql, signal, granted, viewerId } = context;
    requireViewerWhenAmbiguous(viewerId, granted.has('triage:read'));
    const res = await graphql.request(GetReportDocument, { id: input.reportId }, { signal });
    if (!res.report)
      throw new BugSecureError('NOT_FOUND', 'No report with that id is visible to this account.');
    assertOwnReport(res.report.reporter.id, viewerId);
    const textLimit = input.fullText ? Number.MAX_SAFE_INTEGER : DEFAULT_TEXT_LIMIT;
    const report = toReportDetail(res.report, textLimit);
    // Acting as the researcher the API never returns internal notes; toComments drops them regardless.
    const all = toComments(res.reportComments, res.report.reporter.id).comments;
    const allTransitions = toTransitions(res.reportTransitions);
    return {
      data: {
        report,
        comments: historyPage(all, input.historyOffset),
        transitions: historyPage(allTransitions, input.historyOffset),
        history: historyMeta(all.length, allTransitions.length, input.historyOffset),
        adjudication: toAdjudication(res.reportAdjudication),
        appeals: toAppeals(res.reportAppeals),
        disclosure: await readDisclosure(input.reportId, textLimit, context),
      },
    };
  },
});
