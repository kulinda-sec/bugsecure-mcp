import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  lookups,
  type OperationHandler,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

const TRIAGER = ['triage:write', 'profile:read', 'triage:read'] as const;
const assigned = {
  assignTriageAnalyst: {
    id: 'r1',
    assignedTriage: { id: 'triager-1', username: 'tri' },
    updatedAt: '2026-09-21T10:00:00.000Z',
  },
};

const api = (overrides: Record<string, OperationHandler> = {}) => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({ ...lookups(), ...approvals.handlers, AssignReport: () => assigned, ...overrides }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('assign_report', () => {
  it('registers the assignment to the signed-in user for review, then assigns', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    const result = await harness.call('assign_report', { reportId: 'r1' });

    expect(result.isError).toBeFalsy();
    expect(approvals.created[0]?.parts).toEqual([
      { operation: 'assignTriageAnalyst', arguments: { reportId: 'r1', triageUserId: 'triager-1' } },
    ]);
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain('assign a report to you, as your organisation’s triager');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'AssignReport',
        variables: {
          reportId: 'r1',
          triageUserId: 'triager-1',
          clientRequestId: approvals.created[0]?.clientRequestId,
        },
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      report: { id: 'r1', assignedTriage: { id: 'triager-1' } },
    });
  });

  it('takes no assignee argument: another member cannot be named from here', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    await harness.call('assign_report', { reportId: 'r1', triageUserId: 'someone-else' });

    expect(approvals.created[0]?.parts[0]?.arguments).toEqual({ reportId: 'r1', triageUserId: 'triager-1' });
    expect(withoutLookups(graphql.calls)[0]?.variables).toEqual({
      reportId: 'r1',
      triageUserId: 'triager-1',
      clientRequestId: approvals.created[0]?.clientRequestId,
    });
  });

  it.each([
    ['a BugSecure staff account', { roles: ['PLATFORM_ROLE_B'] }, 'triager-1', /BugSecure staff/],
    ['the user’s own report', {}, 'researcher-1', /one of your own reports/],
    ['an unknown signed-in user', {}, null, /does not name its user/],
  ])('refuses %s before registering anything', async (_what, overrides, viewerId, why) => {
    const { graphql, approvals } = api(lookups(overrides));
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId });

    const result = await harness.call('assign_report', { reportId: 'r1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(why);
    expect(harness.prompts).toHaveLength(0);
    expect(approvals.created).toEqual([]);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });
});
