import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  type OperationHandler,
  lookups,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const grounds = 'The assessor ignored that the admin panel renders the payload.';
const raised = {
  raiseAppeal: {
    id: 'ap1',
    reportId: 'r1',
    adjudicationId: 'adj1',
    status: 'OPEN',
    createdAt: '2026-09-21T10:00:00.000Z',
  },
};

const api = (appeal: OperationHandler = () => raised, overrides: Parameters<typeof lookups>[0] = {}) => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({ ...lookups(overrides), ...approvals.handlers, RaiseAppeal: appeal }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('raise_appeal', () => {
  it('registers the exact grounds for review, then raises the appeal against the grade', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds });

    expect(result.isError).toBeFalsy();
    // Only the grade and the grounds go to the API; the review page shows the report and the grade contested.
    expect(approvals.created[0]?.parts).toEqual([
      { operation: 'raiseAppeal', arguments: { input: { adjudicationId: 'adj1', grounds } } },
    ]);
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain('wants to appeal the grade of one of your reports');
    expect(harness.prompts[0]?.message).not.toContain(grounds);
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'RaiseAppeal',
        variables: {
          input: { adjudicationId: 'adj1', grounds },
          clientRequestId: approvals.created[0]?.clientRequestId,
        },
      },
    ]);
    expect(result.structuredContent).toMatchObject({ appeal: { id: 'ap1', status: 'OPEN', reportId: 'r1' } });
  });

  it('rejects invalid arguments before registering anything', async () => {
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

  it('relays the API refusing a late or repeated appeal, or a grade no longer in force', async () => {
    const { graphql } = api(() => {
      throw new BugSecureError('INVALID_INPUT', 'The appeal window has closed');
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(
      textOf(await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds })),
    ).toBe('The appeal window has closed');
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const { graphql } = api(() => {
      throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
        requiredScopes: ['reports:write'],
      });
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(
      textOf(await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'adj1', grounds })),
    ).toContain('login --scopes "reports:write"');
  });

  it('checks the report is the user’s own and the grade in force, from reports:read, before asking', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBeFalsy();
    // Looked up on both rounds (before asking, before sending); nothing of it is sent or shown.
    expect(graphql.calls.filter((c) => c.operation === 'GetAppealTarget')).toHaveLength(2);
    expect(approvals.created).toHaveLength(1);
    expect(harness.prompts[0]?.message).not.toContain('r1');
  });

  it('refuses a grade that is not the one in force on the report, before asking', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'old', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not the one in force');
    expect(harness.prompts).toHaveLength(0);
    expect(approvals.created).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('refuses a report that is not the user’s own, before asking', async () => {
    const { graphql, approvals } = api(() => raised, { reporterId: 'someone-else' });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not one of your own reports');
    expect(approvals.created).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('refuses a report that is not visible, and one it cannot check', async () => {
    const approvals = fakeAgentApprovals('approve');
    const graphql = fakeGraphQL({
      ...approvals.handlers,
      GetAppealTarget: () => ({ report: null, reportAdjudication: null }),
      RaiseAppeal: () => raised,
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const notVisible = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(notVisible.isError).toBe(true);
    expect(textOf(notVisible)).toContain('No report with that id');
    await harness.close();

    const failing = fakeGraphQL({
      ...approvals.handlers,
      GetAppealTarget: () => {
        throw new Error('boom');
      },
      RaiseAppeal: () => raised,
    });
    harness = await connectTools({ graphql: failing, grantedScopes: ['reports:write', 'reports:read'] });
    const unchecked = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(unchecked.isError).toBe(true);
    expect(textOf(unchecked)).toContain('could not be checked');
    expect(approvals.created).toHaveLength(0);
    expect(withoutLookups(failing.calls)).toEqual([]);
  });

  it('relays a typed refusal of the safety lookup with its own guidance, and still sends nothing', async () => {
    const approvals = fakeAgentApprovals('approve');
    const graphql = fakeGraphQL({
      ...approvals.handlers,
      GetAppealTarget: () => {
        throw new BugSecureError('SESSION_EXPIRED', 'The BugSecure session is no longer valid.');
      },
      RaiseAppeal: () => raised,
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The BugSecure session is no longer valid.');
    expect(textOf(result)).not.toContain('could not be checked');
    expect(approvals.created).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('asks without the check when reports:read is not granted (the API enforces it)', async () => {
    const { graphql } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBeFalsy();
    expect(graphql.calls.map((c) => c.operation)).not.toContain('GetAppealTarget');
  });

  it('sends nothing when the user declines on BugSecure', async () => {
    const approvals = fakeAgentApprovals('decline');
    const graphql = fakeGraphQL({ ...approvals.handlers, RaiseAppeal: () => raised });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });
    const result = await harness.call('raise_appeal', { reportId: 'r1', adjudicationId: 'a1', grounds });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Nothing was sent: the user declined/);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });
});
