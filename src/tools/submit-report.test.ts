import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups } from '../../test/helpers/fake-graphql.js';
import { reportSummary } from '../../test/helpers/report-fixtures.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';
import { revealForReview } from '../untrusted.js';

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

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('submit_report', () => {
  it('shows the user the exact report, then submits exactly one and returns its id', async () => {
    const graphql = fakeGraphQL({ SubmitReport: () => ({ submitReport: created }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('submit_report', args);

    expect(result.isError).toBeFalsy();
    expect(harness.prompts).toHaveLength(1);
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('submit a vulnerability report to programme p1');
    for (const value of [args.title, args.description, args.stepsToReproduce, args.impact, args.cvssVector]) {
      // Shown line by line, each line prefixed, markup openers escaped (`<script>` → `\<script>`).
      for (const line of revealForReview(value).split('\n')) expect(message).toContain(`│ ${line}`);
    }
    expect(message).toContain('│ 1. Set bio to \\<script>alert(1)\\</script>');
    expect(message).toContain('It carries no attachments.');
    expect(message).toContain('this connection lacks programs:read');
    expect(message).toContain('cannot be undone');
    expect(graphql.calls).toEqual([
      {
        operation: 'SubmitReport',
        variables: {
          input: {
            programId: 'p1',
            title: args.title,
            severity: 'HIGH',
            description: args.description,
            stepsToReproduce: args.stepsToReproduce,
            impact: args.impact,
            remediation: null,
            cvssVector: args.cvssVector,
          },
        },
      },
    ]);
    const { report } = result.structuredContent as { report: { id: string; title: string } };
    expect(report.id).toBe('r1');
    expect(report.title).toMatch(/^<untrusted-content-[0-9a-f]{16} source="report:r1:title">/);
  });

  it('sends optional fields as null and tolerates a hidden programme', async () => {
    const graphql = fakeGraphQL({ SubmitReport: () => ({ submitReport: { ...created, program: null } }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const { cvssVector: _omit, ...rest } = args;
    const result = await harness.call('submit_report', { ...rest, remediation: 'Escape output.' });

    expect(graphql.calls[0]?.variables).toMatchObject({
      input: { remediation: 'Escape output.', cvssVector: null },
    });
    expect((result.structuredContent as { report: { program: unknown } }).report.program).toBeNull();
  });

  it.each(['decline', 'cancel', 'accept-unticked'] as const)(
    'sends nothing when the user answers the approval with %s',
    async (approve) => {
      const graphql = fakeGraphQL({ SubmitReport: () => ({ submitReport: created }) });
      harness = await connectTools({ graphql, grantedScopes: ['reports:write'], approve });

      const result = await harness.call('submit_report', args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Nothing was sent/);
      expect(graphql.calls).toHaveLength(0);
    },
  );

  it('is unavailable in a client that cannot ask the user (no elicitation capability)', async () => {
    const graphql = fakeGraphQL({ SubmitReport: () => ({ submitReport: created }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'], approve: 'none' });

    const result = await harness.call('submit_report', args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not support approval prompts');
    expect(graphql.calls).toHaveLength(0);
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
  ])('rejects a report %s before calling the API', async (_label, patch) => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('submit_report', { ...args, ...patch });

    expect(result.isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays the API refusing a submission (e.g. terms not accepted)', async () => {
    const graphql = fakeGraphQL({
      SubmitReport: () => {
        throw new BugSecureError(
          'FORBIDDEN',
          'BugSecure denied access: You must accept the current programme terms before submitting',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(textOf(await harness.call('submit_report', args))).toMatch(/accept the current programme terms/);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      SubmitReport: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['reports:write'],
        });
      },
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
  });

  it('names the programme in the approval when programs:read is granted', async () => {
    const graphql = fakeGraphQL({ ...lookups(), SubmitReport: () => ({ submitReport: created }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'programs:read'] });
    await harness.call('submit_report', args);
    expect(harness.prompts[0]?.message).toContain('Programme:\n│ Acme web (run by Acme)');
  });

  it('refuses what looks like a replayed approval: the same title on the same programme minutes ago', async () => {
    const recent = reportSummary('r9', {
      title: args.title,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const graphql = fakeGraphQL({
      ListMyReports: () => ({ reports: [recent] }),
      SubmitReport: () => ({ submitReport: created }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });

    const result = await harness.call('submit_report', args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'Nothing was sent: you filed a report with this exact title on this programme',
    );
    expect(textOf(result)).toContain('report r9');
    expect(graphql.calls.map((c) => c.operation)).toEqual(['ListMyReports']);
    expect(graphql.calls[0]?.variables).toMatchObject({
      filters: { programId: 'p1', search: args.title, reporterId: 'researcher-1' },
    });
  });

  it('submits when the similar report is older than an approval can live, or the check fails', async () => {
    const old = reportSummary('r9', { title: args.title, createdAt: '2026-01-01T00:00:00.000Z' });
    const graphql = fakeGraphQL({
      ListMyReports: () => ({ reports: [old] }),
      SubmitReport: () => ({ submitReport: created }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    expect((await harness.call('submit_report', args)).isError).toBeFalsy();
    await harness.close();

    const down = fakeGraphQL({
      ListMyReports: () => {
        throw new Error('down');
      },
      SubmitReport: () => ({ submitReport: created }),
    });
    harness = await connectTools({ graphql: down, grantedScopes: ['reports:write', 'reports:read'] });
    expect((await harness.call('submit_report', args)).isError).toBeFalsy();
    expect(down.calls.map((c) => c.operation)).toEqual(['ListMyReports', 'SubmitReport']);
  });

  it('normalises Windows line endings and refuses control characters', async () => {
    const graphql = fakeGraphQL({ SubmitReport: () => ({ submitReport: created }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });
    await harness.call('submit_report', { ...args, stepsToReproduce: '1. Open it.\r\n2. Look at it.' });
    expect(graphql.calls[0]?.variables).toMatchObject({
      input: { stepsToReproduce: '1. Open it.\n2. Look at it.' },
    });
    for (const bad of ['\u001B[31mred', 'a\u0008b', 'x\u2028y', 'nel\u0085']) {
      const result = await harness.call('submit_report', { ...args, impact: `Session theft ${bad}` });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(graphql.calls).toHaveLength(1);
  });
});
