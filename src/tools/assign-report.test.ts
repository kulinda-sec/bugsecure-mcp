import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups, REQUEST_ID } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

const TRIAGER = ['triage:write', 'profile:read', 'triage:read'] as const;
const assigned = {
  assignTriageAnalyst: {
    id: 'r1',
    assignedTriage: { id: 'triager-1', username: 'tri' },
    updatedAt: '2026-09-21T10:00:00.000Z',
  },
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('assign_report', () => {
  it('assigns the report to the signed-in user only, after showing who holds it now', async () => {
    const base = lookups();
    const graphql = fakeGraphQL({
      ...base,
      GetReportRef: (v) => ({
        report: {
          ...(base.GetReportRef?.(v) as { report: object }).report,
          assignedTriage: { id: 't0', username: 'previous-triager' },
        },
      }),
      AssignReport: () => assigned,
    });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    const result = await harness.call('assign_report', { reportId: 'r1' });

    expect(result.isError).toBeFalsy();
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('Assigned now:\n│ previous-triager');
    expect(message).toContain('── Assignee (15 characters, 1 line)\n│ you (triager-1)');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'AssignReport',
        variables: { reportId: 'r1', triageUserId: 'triager-1', clientRequestId: REQUEST_ID },
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      report: { id: 'r1', assignedTriage: { id: 'triager-1' } },
    });
  });

  it('takes no assignee argument: another member cannot be named from here', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AssignReport: () => assigned });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    await harness.call('assign_report', { reportId: 'r1', triageUserId: 'someone-else' });

    expect(withoutLookups(graphql.calls)[0]?.variables).toEqual({
      reportId: 'r1',
      triageUserId: 'triager-1',
      clientRequestId: REQUEST_ID,
    });
  });

  it.each([
    ['a BugSecure staff account', { roles: ['PLATFORM_ROLE_B'] }, 'triager-1', /BugSecure staff/],
    ['the user’s own report', {}, 'researcher-1', /one of your own reports/],
    ['an unknown signed-in user', {}, null, /does not name its user/],
  ])('refuses %s before asking', async (_what, overrides, viewerId, why) => {
    const graphql = fakeGraphQL({ ...lookups(overrides) });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId });

    const result = await harness.call('assign_report', { reportId: 'r1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(why);
    expect(harness.prompts).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });
});
