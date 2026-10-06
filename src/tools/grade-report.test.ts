import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  lookups,
  type OperationHandler,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { SAMPLE_ARGS } from '../../test/helpers/sample-args.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';
import { mapGraphQLErrors } from '../graphql/errors.js';

const ARGS = SAMPLE_ARGS.grade_report ?? {};
/** grade:write, plus profile:read for the staff check and triage:read for the report lookup. */
const GRADER = ['grade:write', 'profile:read', 'triage:read'] as const;

const certificate = {
  id: 'cert1',
  reference: 'BSC-2026-0042',
  reportId: 'r1',
  adjudicationId: 'adj1',
  status: 'ISSUED',
  graderSide: 'ORGANIZATION',
  currency: 'XOF',
  grossAmount: 500_000,
  withheldAmount: 25_000,
  netAmount: 475_000,
  issuedAt: '2026-09-23T10:00:00.000Z',
  appealClosesAt: '2026-10-07T10:00:00.000Z',
  dueAt: '2026-10-21T10:00:00.000Z',
};

const api = (grade: OperationHandler, overrides: Record<string, OperationHandler> = {}) => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({ ...lookups(), ...approvals.handlers, GradeReport: grade, ...overrides }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('grade_report', () => {
  it('registers the exact grade for review, then grades and returns the certificate the organization now owes', async () => {
    const { graphql, approvals } = api(() => ({ adjudicateReport: certificate }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const result = await harness.call('grade_report', ARGS);

    expect(result.isError).toBeFalsy();
    const input = { ...ARGS, deviationReason: null, overrideAmount: null, amountReason: null };
    expect(approvals.created[0]?.parts).toEqual([{ operation: 'adjudicateReport', arguments: { input } }]);
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'GradeReport',
        variables: { clientRequestId: approvals.created[0]?.clientRequestId, input },
      },
    ]);
    expect(result.structuredContent).toEqual({ outcome: 'CERTIFICATE_ISSUED', certificate });
    // The message says what it is; the review page shows the grade, the report and the payout.
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain(
      'grade a report as your organisation (binding; it may issue a payout certificate)',
    );
    expect(harness.prompts[0]?.message).not.toContain('CVSS:3.1');
  });

  it('sends a deviation and an amount override with its reason', async () => {
    const { graphql, approvals } = api(() => ({ adjudicateReport: certificate }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const result = await harness.call('grade_report', {
      ...ARGS,
      severity: 'MEDIUM',
      deviationReason: 'Only reachable by authenticated members.',
      overrideAmount: 200_000,
      amountReason: 'Test environment only.',
    });

    expect(result.isError).toBeFalsy();
    const expected = {
      input: {
        severity: 'MEDIUM',
        deviationReason: 'Only reachable by authenticated members.',
        overrideAmount: 200_000,
        amountReason: 'Test environment only.',
      },
    };
    expect(approvals.created[0]?.parts[0]?.arguments).toMatchObject(expected);
    expect(withoutLookups(graphql.calls)[0]?.variables).toMatchObject(expected);
  });

  it('reports an organization’s CRITICAL grade as provisional', async () => {
    const { graphql } = api(() => ({ adjudicateReport: null }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const result = await harness.call('grade_report', {
      ...ARGS,
      severity: 'CRITICAL',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H',
      cvssScore: 10,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ outcome: 'AWAITING_CRITICAL_REVIEW', certificate: null });
  });

  it('reports a grade the grid does not pay', async () => {
    const { graphql } = api(() => ({ adjudicateReport: null }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const result = await harness.call('grade_report', { ...ARGS, severity: 'INFORMATIVE' });

    expect(result.structuredContent).toEqual({ outcome: 'NO_REWARD_PAYABLE', certificate: null });
  });

  it('rejects invalid arguments before registering anything or calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const invalid: Record<string, unknown>[] = [
      { ...ARGS, reasoning: 'Too short.' },
      { ...ARGS, reasoning: 'x'.repeat(10_001) },
      { ...ARGS, severity: 'SEVERE' },
      { ...ARGS, cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N' },
      { ...ARGS, cvssVector: 'CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P' },
      { ...ARGS, cvssScore: 10.5 },
      { ...ARGS, vrtNodeId: 'Stored XSS' },
      { ...ARGS, reportId: '../r1' },
      { ...ARGS, overrideAmount: 100 }, // without amountReason
      { ...ARGS, amountReason: 'Because.' }, // without overrideAmount
      { ...ARGS, overrideAmount: -1, amountReason: 'Negative.' },
    ];
    for (const args of invalid) {
      expect((await harness.call('grade_report', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(graphql.calls).toHaveLength(0);
    expect(harness.prompts).toHaveLength(0);
  });

  it('explains how to enable AI grading when the organization has not opted in', async () => {
    const { graphql } = api(() => {
      throw mapGraphQLErrors([
        {
          message: 'This organization has not enabled AI grading for connected apps',
          extensions: { code: 'ORG_AI_GRADING_DISABLED' },
        },
      ]);
    });
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    const result = await harness.call('grade_report', ARGS);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('has not enabled AI grading');
    expect(text).toContain('"AI grading" consent');
    expect(text).toContain('Only an Administrator of that organisation can enable it');
    expect(text).toContain('Do not retry');
  });

  it('relays a refusal of an already-graded report, and a missing scope', async () => {
    const { graphql } = api((vars) => {
      const input = vars.input as { reportId: string };
      if (input.reportId === 'r1')
        throw new BugSecureError(
          'FORBIDDEN',
          'BugSecure denied access: This report has already been adjudicated; raise an appeal to revisit it',
        );
      throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing', { requiredScopes: ['grade:write'] });
    });
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });

    expect(textOf(await harness.call('grade_report', ARGS))).toContain('already been adjudicated');
    expect(textOf(await harness.call('grade_report', { ...ARGS, reportId: 'r2' }))).toContain(
      'login --scopes "profile:read triage:read grade:write"',
    );
  });

  it('is not usable with triage scopes alone', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read', 'triage:write'] });

    const result = await harness.call('grade_report', ARGS);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('login --scopes "profile:read triage:read triage:write grade:write"');
    expect(textOf(result)).toContain('grade:write only where the Administrator also enabled "AI grading"');
    expect(graphql.calls).toHaveLength(0);
  });

  it('is announced as a destructive write, and hidden in read-only mode', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}), grantedScopes: [...GRADER] });
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'grade_report');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tool?.description).toContain('recent sign-in');
    await harness.close();

    harness = await connectTools({
      graphql: fakeGraphQL({}),
      grantedScopes: [...GRADER],
      readOnly: true,
    });
    expect(await harness.listToolNames()).not.toContain('grade_report');
  });

  it('refuses a BugSecure staff account before registering anything, and before writing', async () => {
    for (const roles of [['PLATFORM_ROLE_A'], ['PLATFORM_ROLE_B', 'COMPANY_ADMIN'], ['SOME_FUTURE_ROLE']]) {
      const { graphql, approvals } = api(() => ({ adjudicateReport: certificate }), lookups({ roles }));
      harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
      const result = await harness.call('grade_report', ARGS);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('BugSecure staff use the admin tools, not this server');
      expect(harness.prompts).toHaveLength(0);
      expect(approvals.created).toEqual([]);
      expect(withoutLookups(graphql.calls)).toEqual([]);
      await harness.close();
      harness = undefined;
    }
  });

  it('checks the roles once per session', async () => {
    const { graphql } = api(() => ({ adjudicateReport: certificate }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
    expect((await harness.call('grade_report', ARGS)).isError).toBeFalsy();
    // The asking round and the approved retry are separate requests on the harness (one server per
    // request), so this counts per request; within one server the memo answers the second check.
    expect(graphql.calls.filter((c) => c.operation === 'GetViewerRoles').length).toBeLessThanOrEqual(2);
  });

  it('treats a grade recorded as BugSecure’s (PLATFORM) as an error, saying it WAS recorded', async () => {
    const { graphql } = api(() => ({ adjudicateReport: { ...certificate, graderSide: 'PLATFORM' } }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
    const result = await harness.call('grade_report', ARGS);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('as BugSecure’s own (grader side PLATFORM)');
    expect(text).toContain('BSC-2026-0042');
    expect(text).toContain('The grade WAS recorded: do not retry.');
  });

  it('refuses to grade the user’s own report', async () => {
    const { graphql, approvals } = api(
      () => ({ adjudicateReport: null }),
      lookups({ reporterId: 'triager-1' }),
    );
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
    const result = await harness.call('grade_report', ARGS);
    expect(result.isError).toBe(true);
    expect(approvals.created).toEqual([]);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  // Report e6629484: a grade is never registered, asked for, or sent, when the report cannot be read to check whose it is.
  it('refuses, registering nothing, when the report is not visible to the account', async () => {
    const { graphql, approvals } = api(() => ({ adjudicateReport: certificate }), {
      GetReportRef: () => ({ report: null }),
    });
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
    const result = await harness.call('grade_report', ARGS);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing was sent: the report could not be read');
    expect(harness.prompts).toHaveLength(0);
    expect(approvals.created).toEqual([]);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('checks the report again when the approved grade is sent', async () => {
    const { graphql } = api(() => ({ adjudicateReport: certificate }));
    harness = await connectTools({ graphql, grantedScopes: [...GRADER], viewerId: 'triager-1' });
    await harness.call('grade_report', ARGS);
    const ops = graphql.calls.map((c) => c.operation);
    expect(ops.lastIndexOf('GetReportRef')).toBeLessThan(ops.indexOf('GradeReport'));
    expect(ops.filter((o) => o === 'GetReportRef').length).toBeGreaterThanOrEqual(2);
  });
});
