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
import { BugSecureError } from '../errors.js';

/** triage:write, plus profile:read for the staff check and triage:read for the report check. */
const TRIAGER = ['triage:write', 'profile:read', 'triage:read'] as const;

const updated = (status: string, duplicateOfId: string | null = null) => ({
  updateReportStatus: { id: 'r1', status, duplicateOfId, updatedAt: '2026-09-21T10:00:00.000Z' },
});

const api = (update: OperationHandler, overrides: Record<string, OperationHandler> = {}) => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({ ...lookups(), ...approvals.handlers, UpdateReportStatus: update, ...overrides }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('update_report_status', () => {
  it('registers the exact move for review, then moves the report with a reason', async () => {
    const { graphql, approvals } = api(() => updated('NEEDS_MORE_INFO'));
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    const result = await harness.call('update_report_status', {
      reportId: 'r1',
      status: 'NEEDS_MORE_INFO',
      reason: 'Which account did you use?',
    });

    expect(result.isError).toBeFalsy();
    const input = {
      reportId: 'r1',
      status: 'NEEDS_MORE_INFO',
      reason: 'Which account did you use?',
      duplicateOfId: null,
    };
    expect(approvals.created[0]?.parts).toEqual([{ operation: 'updateReportStatus', arguments: { input } }]);
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain(
      'change the triage status of a report, as your organisation',
    );
    expect(harness.prompts[0]?.message).not.toContain('NEEDS_MORE_INFO');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'UpdateReportStatus',
        variables: { clientRequestId: approvals.created[0]?.clientRequestId, input },
      },
    ]);
    expect(result.structuredContent).toMatchObject({ report: { id: 'r1', status: 'NEEDS_MORE_INFO' } });
  });

  it('requires a reason of at least 20 characters for NOT_APPLICABLE and OUT_OF_SCOPE', async () => {
    const { graphql, approvals } = api(() => updated('NOT_APPLICABLE'));
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    for (const status of ['NOT_APPLICABLE', 'OUT_OF_SCOPE']) {
      expect((await harness.call('update_report_status', { reportId: 'r1', status })).isError).toBe(true);
      expect(
        (await harness.call('update_report_status', { reportId: 'r1', status, reason: '   too short   ' }))
          .isError,
      ).toBe(true);
    }
    expect(approvals.created).toEqual([]);
    expect(withoutLookups(graphql.calls)).toEqual([]);

    const result = await harness.call('update_report_status', {
      reportId: 'r1',
      status: 'NOT_APPLICABLE',
      reason: 'The endpoint named is not part of this programme.',
    });
    expect(result.isError).toBeFalsy();
  });

  it('requires duplicateOfId exactly when marking DUPLICATE', async () => {
    const { graphql } = api(() => updated('DUPLICATE', 'r0'));
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect(
      (await harness.call('update_report_status', { reportId: 'r1', status: 'DUPLICATE' })).isError,
    ).toBe(true);
    expect(
      (
        await harness.call('update_report_status', {
          reportId: 'r1',
          status: 'VALIDATED',
          duplicateOfId: 'r0',
        })
      ).isError,
    ).toBe(true);
    expect(withoutLookups(graphql.calls)).toHaveLength(0);

    const ok = await harness.call('update_report_status', {
      reportId: 'r1',
      status: 'DUPLICATE',
      duplicateOfId: 'r0',
    });
    expect(ok.isError).toBeFalsy();
    expect(withoutLookups(graphql.calls)[0]?.variables).toMatchObject({
      input: { duplicateOfId: 'r0', reason: null },
    });
  });

  it('rejects invalid arguments before registering anything', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect((await harness.call('update_report_status', { reportId: 'r1', status: 'NEW' })).isError).toBe(
      true,
    );
    expect((await harness.call('update_report_status', { reportId: 'r1', status: 'PAID' })).isError).toBe(
      true,
    );
    expect(
      (
        await harness.call('update_report_status', {
          reportId: 'r1',
          status: 'IN_TRIAGE',
          reason: 'x'.repeat(5001),
        })
      ).isError,
    ).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays an invalid transition', async () => {
    const { graphql } = api(() => {
      throw new BugSecureError('INVALID_INPUT', 'Cannot transition from NEW to FIXED');
    });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect(textOf(await harness.call('update_report_status', { reportId: 'r1', status: 'FIXED' }))).toBe(
      'Cannot transition from NEW to FIXED',
    );
  });

  it('explains an organization that has not opted in, and a missing scope', async () => {
    const { graphql } = api((vars) => {
      const input = vars.input as { reportId: string };
      if (input.reportId === 'r1')
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access.',
        );
      throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing', { requiredScopes: ['triage:write'] });
    });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect(
      textOf(await harness.call('update_report_status', { reportId: 'r1', status: 'IN_TRIAGE' })),
    ).toContain('AI triage access');
    expect(
      textOf(await harness.call('update_report_status', { reportId: 'r2', status: 'IN_TRIAGE' })),
    ).toContain('login --scopes "profile:read triage:read triage:write"');
  });

  it('refuses a BugSecure staff account and the user’s own report before registering anything', async () => {
    for (const [overrides, why] of [
      [{ roles: ['PLATFORM_ROLE_A'] }, /BugSecure staff/],
      [{ reporterId: 'triager-1' }, /one of your own reports/],
    ] as const) {
      const { graphql, approvals } = api(() => updated('IN_TRIAGE'), lookups(overrides));
      harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });
      const result = await harness.call('update_report_status', { reportId: 'r1', status: 'IN_TRIAGE' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(why);
      expect(harness.prompts).toHaveLength(0);
      expect(approvals.created).toEqual([]);
      expect(withoutLookups(graphql.calls)).toEqual([]);
      await harness.close();
      harness = undefined;
    }
  });

  it('is announced as destructive', async () => {
    harness = await connectTools({
      graphql: fakeGraphQL({}),
      grantedScopes: [...TRIAGER],
      viewerId: 'triager-1',
    });
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'update_report_status');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
