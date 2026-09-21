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

describe('list_my_reports', () => {
  it('maps filters and pagination, and returns fenced summaries', async () => {
    const graphql = fakeGraphQL({
      ListMyReports: () => ({ reports: [reportSummary('r1'), reportSummary('r2')] }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });

    const result = await harness.call('list_my_reports', {
      programId: 'p1',
      status: 'NEW',
      severity: 'HIGH',
      query: 'xss',
      limit: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      {
        operation: 'ListMyReports',
        variables: {
          filters: {
            programId: 'p1',
            status: 'NEW',
            severity: 'HIGH',
            search: 'xss',
            reporterId: 'researcher-1',
          },
          skip: 0,
          take: 2,
        },
      },
    ]);
    const data = result.structuredContent as {
      reports: { id: string; title: string; program: { title: string } }[];
      nextOffset: number | null;
    };
    expect(data.reports.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(data.reports[0]?.title).toMatch(/^<untrusted-content-[0-9a-f]{16} source="report:r1:title">/);
    expect(data.reports[0]?.program.title).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="program:p1:title">/,
    );
    expect(data.nextOffset).toBe(2);
  });

  it('sends null filters by default and handles reports whose programme is hidden', async () => {
    const graphql = fakeGraphQL({
      ListMyReports: () => ({ reports: [reportSummary('r1', { program: null })] }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });

    const result = await harness.call('list_my_reports', {});

    expect(graphql.calls[0]?.variables).toEqual({
      filters: { programId: null, status: null, severity: null, search: null, reporterId: 'researcher-1' },
      skip: 0,
      take: 20,
    });
    expect((result.structuredContent as { reports: { program: unknown }[] }).reports[0]?.program).toBeNull();
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });

    expect((await harness.call('list_my_reports', { status: 'PAID' })).isError).toBe(true);
    expect((await harness.call('list_my_reports', { severity: 'SEVERE' })).isError).toBe(true);
    expect((await harness.call('list_my_reports', { programId: 'a b' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      ListMyReports: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['reports:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });

    expect(textOf(await harness.call('list_my_reports', {}))).toContain('login --scopes "reports:read"');
  });
  it('with triage:read too, asks for the user’s own reports and drops anything else', async () => {
    const graphql = fakeGraphQL({
      ListMyReports: () => ({
        reports: [
          reportSummary('r1'),
          reportSummary('r2', { reporter: { id: 'someone-else', username: 'eve' } }),
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read', 'triage:read'] });
    const result = await harness.call('list_my_reports', { limit: 2 });
    expect((graphql.calls[0]?.variables.filters as { reporterId: string }).reporterId).toBe('researcher-1');
    const data = result.structuredContent as { reports: { id: string }[]; nextOffset: number | null };
    expect(data.reports.map((r) => r.id)).toEqual(['r1']);
    expect(data.nextOffset).toBe(2); // paging follows what the API returned
  });

  it('refuses when both sides are reachable and the user is unknown', async () => {
    const graphql = fakeGraphQL({ ListMyReports: () => ({ reports: [] }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read', 'triage:read'], viewerId: null });
    expect((await harness.call('list_my_reports', {})).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });
  it('returns the deadline state and the grade in brief', async () => {
    const grade = { severity: 'HIGH', side: 'PLATFORM', certifiedAmount: null, currency: 'KES' } as const;
    const graphql = fakeGraphQL({
      ListMyReports: () => ({
        reports: [reportSummary('r1', { awaitingGrade: false, isOverdue: false, grade })],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });

    const result = await harness.call('list_my_reports', {});

    expect(result.structuredContent).toMatchObject({
      reports: [
        { id: 'r1', awaitingGrade: false, isOverdue: false, triageDueAt: '2026-09-08T10:00:00.000Z', grade },
      ],
    });
  });
});
