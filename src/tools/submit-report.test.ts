import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  REQUEST_ID,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const args = {
  programId: 'p1',
  title: 'Stored XSS in profile bio',
  severity: 'HIGH',
  description: 'The profile bio is rendered without escaping on /u/<name>.',
  stepsToReproduce: '1. Set bio to <script>alert(1)</script>\n2. Open the profile.',
  impact: 'Session theft for any visitor.',
  cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N',
};

const created = {
  id: 'r1',
  title: args.title,
  status: 'NEW',
  claimedSeverity: 'HIGH',
  claimedCvssScore: 7.6,
  createdAt: '2026-09-21T10:00:00.000Z',
  program: { id: 'p1', title: 'Acme web', slug: 'acme-web' },
};

const api = (submit: () => unknown = () => ({ submitReport: created })) => {
  const approvals = fakeAgentApprovals('approve');
  return { approvals, graphql: fakeGraphQL({ ...approvals.handlers, SubmitReport: submit }) };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('submit_report', () => {
  it('registers the exact report for review, sends the user to its page, then submits exactly one and returns its id', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('submit_report', args);

    expect(result.isError).toBeFalsy();
    const expected = {
      programId: 'p1',
      title: args.title,
      severity: 'HIGH',
      description: args.description,
      stepsToReproduce: args.stepsToReproduce,
      impact: args.impact,
      remediation: null,
      cvssVector: args.cvssVector,
    };
    // What the user reviews on BugSecure is exactly what is then sent.
    expect(approvals.created).toHaveLength(1);
    expect(approvals.created[0]?.parts).toEqual([
      { operation: 'submitReport', arguments: { input: expected } },
    ]);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]?.mode).toBe('url');
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain('wants to submit a vulnerability report to a programme');
    expect(harness.prompts[0]?.message).not.toContain(args.title);
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'SubmitReport',
        variables: { clientRequestId: approvals.created[0]?.clientRequestId, input: expected },
      },
    ]);
    const { report } = result.structuredContent as { report: { id: string; title: string } };
    expect(report.id).toBe('r1');
    expect(report.title).toMatch(/^<untrusted-content-[0-9a-f]{16} source="report:r1:title">/);
  });

  it('sends optional fields as null and tolerates a hidden programme', async () => {
    const { graphql } = api(() => ({ submitReport: { ...created, program: null } }));
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const { cvssVector: _omit, ...rest } = args;
    const result = await harness.call('submit_report', { ...rest, remediation: 'Escape output.' });

    expect(withoutLookups(graphql.calls)[0]?.variables).toMatchObject({
      input: { remediation: 'Escape output.', cvssVector: null },
    });
    expect((result.structuredContent as { report: { program: unknown } }).report.program).toBeNull();
  });

  it.each(['decline', 'cancel'] as const)(
    'sends nothing when the user does not open the review page (%s)',
    async (open) => {
      const { graphql, approvals } = api();
      harness = await connectTools({ graphql, grantedScopes: ['reports:write'], open });

      const result = await harness.call('submit_report', args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Nothing was sent/);
      expect(approvals.created).toHaveLength(1);
      expect(withoutLookups(graphql.calls)).toHaveLength(0);
    },
  );

  it('sends nothing when the user declines on BugSecure', async () => {
    const approvals = fakeAgentApprovals('decline');
    const graphql = fakeGraphQL({ ...approvals.handlers, SubmitReport: () => ({ submitReport: created }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });
    const result = await harness.call('submit_report', args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Nothing was sent: the user declined/);
    expect(withoutLookups(graphql.calls)).toHaveLength(0);
  });

  it('in a client that cannot open URLs, registers the report and names the menu path; nothing is sent', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'], open: 'none' });

    const result = await harness.call('submit_report', args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Settings → Agent approvals');
    expect(approvals.created).toHaveLength(1);
    expect(withoutLookups(graphql.calls)).toHaveLength(0);
  });

  it('no longer accepts a model-supplied confirmation flag', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}), grantedScopes: ['reports:write'] });
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'submit_report');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('userConfirmed');
  });

  it.each([
    ['with a too-short title', { title: 'XSS' }],
    ['with an unknown severity', { severity: 'SEVERE' }],
    ['with a thin description', { description: 'xss' }],
    ['without steps', { stepsToReproduce: undefined }],
    ['with an invalid CVSS vector', { cvssVector: 'CVSS:4.0/AV:N' }],
    ['with a bad programme id', { programId: 'p1; drop' }],
    ['with a huge impact', { impact: 'x'.repeat(10_001) }],
    ['with an escape sequence in the title', { title: 'Stored XSS \u001B[2K in bio' }],
  ])('rejects a report %s before registering anything', async (_label, patch) => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('submit_report', { ...args, ...patch });

    expect(result.isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays the API refusing a submission (e.g. terms not accepted)', async () => {
    const { graphql } = api(() => {
      throw new BugSecureError(
        'FORBIDDEN',
        'BugSecure denied access: You must accept the current programme terms before submitting',
      );
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(textOf(await harness.call('submit_report', args))).toMatch(/accept the current programme terms/);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const { graphql } = api(() => {
      throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
        requiredScopes: ['reports:write'],
      });
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(textOf(await harness.call('submit_report', args))).toContain('login --scopes "reports:write"');
  });

  it('is a non-idempotent, destructive (irreversible) write tool', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}), grantedScopes: ['reports:write'] });
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'submit_report');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
    });
    expect(tool?.description).toContain('No attachments');
    expect(tool?.description).toContain('platform and programme terms');
    expect(tool?.description).toContain('approves the exact report on BugSecure');
  });

  it('sends one write with the approval’s key, and no lookup, whatever it may read', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({
      graphql,
      grantedScopes: ['reports:write', 'reports:read', 'programs:read'],
    });
    expect((await harness.call('submit_report', args)).isError).toBeFalsy();
    expect(withoutLookups(graphql.calls).map((c) => c.operation)).toEqual(['SubmitReport']);
    expect(graphql.calls.map((c) => c.operation)).not.toContain('GetProgramRef');
    expect(withoutLookups(graphql.calls)[0]?.variables.clientRequestId).toEqual(REQUEST_ID);
    expect(withoutLookups(graphql.calls)[0]?.variables.clientRequestId).toBe(
      approvals.created[0]?.clientRequestId,
    );
  });

  it('normalises Windows line endings and refuses control characters', async () => {
    const { graphql } = api();
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });
    await harness.call('submit_report', { ...args, stepsToReproduce: '1. Open it.\r\n2. Look at it.' });
    expect(withoutLookups(graphql.calls)[0]?.variables).toMatchObject({
      input: { stepsToReproduce: '1. Open it.\n2. Look at it.' },
    });
    for (const bad of ['\u001B[31mred', 'a\u0008b', 'x y', 'nel\u0085']) {
      const result = await harness.call('submit_report', { ...args, impact: `Session theft ${bad}` });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(withoutLookups(graphql.calls)).toHaveLength(1);
  });
});
