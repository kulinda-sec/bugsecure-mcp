import * as z from 'zod';

import { GetOrgReportStatsDocument } from '../graphql/generated.js';
import { code, idInput, ifShaped, timestamp } from './shared/common.js';
import { defineTool } from './define-tool.js';

/**
 * The API labels each point with a date string; the month is its first seven characters
 * (YYYY-MM, YYYY-MM-DD or a full timestamp alike). A point without a readable month is dropped.
 */
const monthOf = (date: string): string | undefined => /^(\d{4}-(?:0[1-9]|1[0-2]))(?:$|-|T)/.exec(date)?.[1];

export const getOrgReportStats = defineTool({
  name: 'get_org_report_stats',
  title: 'Get an organization’s report statistics',
  description:
    'Report statistics for an organisation the signed-in user belongs to (it must have enabled AI triage ' +
    'access): monthly report counts by status, the claimed-severity mix, monthly payouts, and its payment ' +
    'standing (certificates issued, settled and overdue). Organisation ids: list_my_organizations. Needs an ' +
    'Administrator seat in that organisation.',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    organizationId: idInput('Organization id (from list_my_organizations).'),
    months: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(6)
      .describe('How many months of trends and payouts (1–24).'),
  }),
  output: z.object({
    trends: z.array(
      z.object({
        month: code('month'),
        status: code('machine-code').nullable(),
        count: z.number().int(),
      }),
    ),
    severityDistribution: z.array(z.object({ severity: code('machine-code'), count: z.number().int() })),
    payouts: z.array(
      z.object({
        month: code('month'),
        count: z.number().int(),
        totalPaid: z.number().int(),
        avgBounty: z.number(),
      }),
    ),
    standing: z.object({
      // BugSecure withholds both totals from callers who are neither members of the organisation
      // nor staff. A member always gets numbers, but the API types them as nullable, so null is
      // relayed as "not shown" rather than failing the whole answer.
      totalIssued: z.number().int().nullable().describe('Payout certificates issued (null when not shown).'),
      totalSettled: z
        .number()
        .int()
        .nullable()
        .describe('Certificates the researcher confirmed as paid (null when not shown).'),
      currentlyOverdue: z.number().int(),
      longestOverdueDays: z.number().int(),
      oldestOverdueSince: timestamp().nullable(),
      submissionsSuspended: z
        .boolean()
        .describe('True when an unpaid determined certificate has suspended new submissions.'),
    }),
  }),
  async handler(input, { graphql, signal }) {
    const res = await graphql.request(
      GetOrgReportStatsDocument,
      { orgId: input.organizationId, months: input.months },
      { signal },
    );
    const s = res.organizationStanding;
    return {
      data: {
        trends: res.reportTrends.flatMap((t) => {
          const month = monthOf(t.date);
          return month === undefined
            ? []
            : [{ month, status: ifShaped('machine-code', t.status), count: t.count }];
        }),
        payouts: res.payoutSummary.flatMap((p) => {
          const month = monthOf(p.month);
          return month === undefined
            ? []
            : [{ month, count: p.count, totalPaid: p.totalPaid, avgBounty: p.avgBounty }];
        }),
        severityDistribution: res.severityDistribution.flatMap((d) => {
          const severity = ifShaped('machine-code', d.severity);
          return severity === null ? [] : [{ severity, count: d.count }];
        }),
        standing: {
          totalIssued: s.totalIssued,
          totalSettled: s.totalSettled,
          currentlyOverdue: s.currentlyOverdue,
          longestOverdueDays: s.longestOverdueDays,
          oldestOverdueSince: s.oldestOverdueSince,
          submissionsSuspended: s.submissionsSuspended,
        },
      },
    };
  },
});
