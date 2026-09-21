import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_org_report_stats', () => {
  it('returns trends, severity mix and standing in one request', async () => {
    const graphql = fakeGraphQL({
      GetOrgReportStats: () => ({
        reportTrends: [{ date: '2026-08', status: 'NEW', count: 4 }],
        severityDistribution: [{ severity: 'HIGH', count: 2 }],
        organizationStanding: {
          totalIssued: 3,
          totalSettled: 2,
          currentlyOverdue: 1,
          longestOverdueDays: 12,
          oldestOverdueSince: '2026-09-01T00:00:00.000Z',
          submissionsSuspended: false,
        },
        payoutSummary: [
          { month: '2026-08', count: 2, totalPaid: 900_000, avgBounty: 450_000 },
          { month: 'garbage', count: 1, totalPaid: 1, avgBounty: 1 },
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('get_org_report_stats', { organizationId: 'org1', months: 12 });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      { operation: 'GetOrgReportStats', variables: { orgId: 'org1', months: 12 } },
    ]);
    expect(result.structuredContent).toMatchObject({
      trends: [{ month: '2026-08', status: 'NEW', count: 4 }],
      severityDistribution: [{ severity: 'HIGH', count: 2 }],
      standing: { currentlyOverdue: 1, submissionsSuspended: false },
      payouts: [{ month: '2026-08', count: 2, totalPaid: 900_000, avgBounty: 450_000 }],
    });
    expect((result.structuredContent as { payouts: unknown[] }).payouts).toHaveLength(1);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect((await harness.call('get_org_report_stats', { organizationId: 'org1', months: 25 })).isError).toBe(
      true,
    );
    expect((await harness.call('get_org_report_stats', {})).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('explains an organization that has not opted in to AI triage access', async () => {
    const graphql = fakeGraphQL({
      GetOrgReportStats: () => {
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access for connected apps.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect(textOf(await harness.call('get_org_report_stats', { organizationId: 'org1' }))).toContain(
      'AI triage access',
    );
  });
  it('normalises trend points to their month and drops ones without a readable month', async () => {
    const standing = {
      totalIssued: 0,
      totalSettled: 0,
      currentlyOverdue: 0,
      longestOverdueDays: 0,
      oldestOverdueSince: null,
      submissionsSuspended: false,
    };
    const graphql = fakeGraphQL({
      GetOrgReportStats: () => ({
        reportTrends: [
          { date: '2026-08', status: 'NEW', count: 1 },
          { date: '2026-09-01', status: null, count: 2 },
          { date: '2026-10-01T00:00:00.000Z', status: 'weird status', count: 3 },
          { date: 'last month', status: 'NEW', count: 4 },
          { date: '2026-13', status: 'NEW', count: 5 },
        ],
        severityDistribution: [
          { severity: 'HIGH', count: 1 },
          { severity: '<b>', count: 9 },
        ],
        organizationStanding: standing,
        payoutSummary: [],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });
    const result = await harness.call('get_org_report_stats', { organizationId: 'org1' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      trends: [
        { month: '2026-08', status: 'NEW', count: 1 },
        { month: '2026-09', status: null, count: 2 },
        { month: '2026-10', status: null, count: 3 },
      ],
      severityDistribution: [{ severity: 'HIGH', count: 1 }],
    });
  });
});
