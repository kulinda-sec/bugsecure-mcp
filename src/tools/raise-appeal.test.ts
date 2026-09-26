import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups, REQUEST_ID } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const grounds = 'The assessor ignored that the admin panel renders the payload.';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('raise_appeal', () => {
  it('raises an appeal against an adjudication', async () => {
    const graphql = fakeGraphQL({
      RaiseAppeal: () => ({
        raiseAppeal: {
          id: 'ap1',
          reportId: 'r1',
          adjudicationId: 'adj1',
          status: 'OPEN',
          createdAt: '2026-09-21T10:00:00.000Z',
        },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      {
        operation: 'RaiseAppeal',
        variables: { input: { adjudicationId: 'adj1', grounds }, clientRequestId: REQUEST_ID },
      },
    ]);
    expect(result.structuredContent).toMatchObject({ appeal: { id: 'ap1', status: 'OPEN', reportId: 'r1' } });
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(
      (await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds: 'too short' }))
        .isError,
    ).toBe(true);
    expect((await harness.call('raise_appeal', { reportId: 'r1', grounds })).isError).toBe(true);
    expect((await harness.call('raise_appeal', { adjudicationId: 'adj1', grounds })).isError).toBe(true);
    expect(
      (
        await harness.call('raise_appeal', {
          reportId: 'r1',
          adjudicationId: 'adj1',
          grounds: `${grounds}\u001B[2K`,
        })
      ).isError,
    ).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays the API refusing a late or repeated appeal', async () => {
    const graphql = fakeGraphQL({
      RaiseAppeal: () => {
        throw new BugSecureError('INVALID_INPUT', 'The appeal window has closed');
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(
      textOf(await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds })),
    ).toBe('The appeal window has closed');
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      RaiseAppeal: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['reports:write'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(
      textOf(await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds })),
    ).toContain('login --scopes "reports:write"');
  });
  const raised = {
    raiseAppeal: {
      id: 'ap1',
      reportId: 'r1',
      adjudicationId: 'a1',
      status: 'OPEN',
      createdAt: '2026-09-21T10:00:00.000Z',
    },
  };

  it('shows the report’s title and the grade contested, from reports:read', async () => {
    const graphql = fakeGraphQL({ ...lookups(), RaiseAppeal: () => raised });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBeFalsy();
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('Report:\n│ Stored XSS in profile');
    expect(message).toContain('Grade contested:\n│ MEDIUM, 150,000 KES, graded by the organisation');
    expect(message).toContain('BugSecure, as the neutral third party, re-examines the grade');
  });

  it('refuses a grade that is not the one in force on the report, before asking', async () => {
    const graphql = fakeGraphQL({ ...lookups(), RaiseAppeal: () => raised });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'old', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not the one in force');
    expect(harness.prompts).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('refuses a report that is not the user’s own', async () => {
    const graphql = fakeGraphQL({ ...lookups({ reporterId: 'someone-else' }), RaiseAppeal: () => raised });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBe(true);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('refuses a report that is not visible', async () => {
    const graphql = fakeGraphQL({
      GetAppealTarget: () => ({ report: null, reportAdjudication: null }),
      RaiseAppeal: () => raised,
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No report with that id');
  });
});
