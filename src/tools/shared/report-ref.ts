/**
 * What a report id refers to, looked up before a write: shown in the approval
 * prompt next to the id (so the user approves "comment on 'Stored XSS in …'",
 * not on an opaque id), and used to check which side of the report the
 * caller acts on.
 */
import { BugSecureError } from '../../errors.js';
import type { GetReportRefQuery } from '../../graphql/generated.js';
import type { ApprovalPrompt } from '../approval.js';
import type { ToolContext } from '../define-tool.js';

export type ReportRef = NonNullable<GetReportRefQuery['report']>;

export interface ReportLookup {
  /** The report, or undefined when it could not be looked up (see `notes`). */
  readonly report: ReportRef | undefined;
  readonly notes: string[];
}

/**
 * Look the report up if this connection can read it (reports:read or
 * triage:read). Never throws for a failed lookup: the prompt then shows the
 * id only and says why. `fetch` sends GetReportRef from the calling tool's file.
 */
export const lookupReport = async (
  context: Pick<ToolContext, 'granted' | 'signal'>,
  fetch: () => Promise<GetReportRefQuery>,
): Promise<ReportLookup> => {
  if (!context.granted.has('reports:read') && !context.granted.has('triage:read')) {
    return {
      report: undefined,
      notes: ['The report’s title is not shown: this connection lacks reports:read and triage:read.'],
    };
  }
  try {
    const { report } = await fetch();
    if (report === null) {
      return { report: undefined, notes: ['This report is not visible to your account; check the id.'] };
    }
    return { report, notes: [] };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { report: undefined, notes: ['Could not look up the report; only its id is shown.'] };
  }
};

/** Approval-prompt context lines for a looked-up report. */
export const reportContext = (
  report: ReportRef | undefined,
  options: { readonly researcher?: boolean } = {},
): NonNullable<ApprovalPrompt['context']> => {
  if (report === undefined) return [];
  return [
    ['Report', report.title],
    ['Programme', report.program?.title],
    ['Status now', report.status],
    ...(options.researcher === true ? ([['Researcher', report.reporter.username]] as const) : []),
  ];
};

/**
 * A comment tool must know which side it posts on when the token could post
 * on either (both reports:write and triage:write): the API decides by whose
 * report it is, so posting "as the researcher" on an organisation's report
 * would land as an organisation comment, and vice versa.
 */
export const requireSideKnown = (report: ReportRef | undefined, bothSides: boolean, what: string): void => {
  if (report === undefined && bothSides) {
    throw new BugSecureError(
      'FORBIDDEN',
      `Nothing was sent: this connection can comment as a researcher and as an organisation, and the report could not be read to check which side ${what} is on.`,
      {
        hint: 'Grant reports:read (your own reports) or triage:read (your organisations’ reports) so the report can be checked, or use the BugSecure website.',
      },
    );
  }
};
