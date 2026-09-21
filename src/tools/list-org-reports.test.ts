import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { reportSummary } from '../../test/helpers/report-fixtures.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_org_reports', () => {
  it('maps filters and returns summaries with the assigned triager', async () => {
    const graphql = fakeGraphQL({
      ListOrgReports: () => ({
        reports: [
          { ...reportSummary('r1'), assignedTriage: { id: 't1', username: 'triager' } },
          { ...reportSummary('r2'), assignedTriage: null },
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'], viewerId: 'triager-1' });

    const result = await harness.call('list_org_reports', {
      programId: 'p1',
      status: 'NEW',
      assignedTriageId: 't1',
      limit: 10,
      offset: 10,
    });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      {
        operation: 'ListOrgReports',
        variables: {
          filters: { programId: 'p1', status: 'NEW', severity: null, assignedTriageId: 't1', search: null },
          skip: 10,
          take: 10,
        },
      },
    ]);
    const data = result.structuredContent as {
      reports: { reporter: { username: string }; assignedTriage: { username: string } | null }[];
      nextOffset: number | null;
    };
    expect(data.reports[0]?.assignedTriage?.username).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="user:t1:username">/,
    );
    expect(data.reports[0]?.reporter.username).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="user:researcher-1:username">/,
    );
    expect(data.reports[1]?.assignedTriage).toBeNull();
    expect(data.nextOffset).toBeNull();
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'], viewerId: 'triager-1' });

    expect((await harness.call('list_org_reports', { status: 'OPEN' })).isError).toBe(true);
    expect((await harness.call('list_org_reports', { query: '' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('explains an organization that has not opted in to AI triage access', async () => {
    const graphql = fakeGraphQL({
      ListOrgReports: () => {
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access for connected apps.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'], viewerId: 'triager-1' });

    expect(textOf(await harness.call('list_org_reports', { programId: 'p1' }))).toContain('AI triage access');
  });
  it('never lists the user’s own reports as a researcher (a reports:read token reaches them too)', async () => {
    const graphql = fakeGraphQL({
      ListOrgReports: () => ({
        reports: [
          { ...reportSummary('r1'), assignedTriage: null },
          { ...reportSummary('r2', { reporter: { id: 'triager-1', username: 'me' } }), assignedTriage: null },
        ],
      }),
    });
    harness = await connectTools({
      graphql,
      grantedScopes: ['triage:read', 'reports:read'],
      viewerId: 'triager-1',
    });
    const result = await harness.call('list_org_reports', { limit: 2 });
    const data = result.structuredContent as { reports: { id: string }[]; nextOffset: number | null };
    expect(data.reports.map((r) => r.id)).toEqual(['r1']);
    expect(data.nextOffset).toBe(2);
  });
});
