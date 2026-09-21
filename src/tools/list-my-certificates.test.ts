import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { certificate } from '../../test/helpers/report-fixtures.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const all = [
  certificate('0001', 'ISSUED', true),
  certificate('0002', 'SETTLED', false),
  certificate('0003', 'VOID', false, 'Issued in error'),
];

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_my_certificates', () => {
  it('returns certificates with amounts, fencing void reasons', async () => {
    const graphql = fakeGraphQL({ ListMyCertificates: () => ({ myCertificates: all }) });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const result = await harness.call('list_my_certificates', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'ListMyCertificates', variables: {} }]);
    const data = result.structuredContent as { certificates: Record<string, unknown>[] };
    expect(data.certificates).toHaveLength(3);
    expect(data.certificates[0]).toMatchObject({
      reference: 'BSC-2026-0001',
      netAmount: 475_000,
      graderSide: 'ORGANIZATION',
      criticalReviewOutcome: null,
      disputeClosesAt: null,
    });
    expect(data.certificates[0]).not.toHaveProperty('settlement');
    expect(data.certificates[2]?.voidReason).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="certificate:0003:void-reason">/,
    );
  });

  it('filters by status and overdue', async () => {
    const graphql = fakeGraphQL({ ListMyCertificates: () => ({ myCertificates: all }) });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const overdue = (await harness.call('list_my_certificates', { overdueOnly: true })).structuredContent as {
      certificates: { id: string }[];
    };
    expect(overdue.certificates.map((c) => c.id)).toEqual(['0001']);
    const settled = (await harness.call('list_my_certificates', { status: 'SETTLED' })).structuredContent as {
      certificates: { id: string }[];
    };
    expect(settled.certificates.map((c) => c.id)).toEqual(['0002']);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    expect((await harness.call('list_my_certificates', { status: 'PAID' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('explains a field refused to connected apps', async () => {
    const graphql = fakeGraphQL({
      ListMyCertificates: () => {
        throw new BugSecureError(
          'OAUTH_FIELD_DENIED',
          'Part of this data is not available to apps connected to BugSecure.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    expect(textOf(await harness.call('list_my_certificates', {}))).toMatch(/not available to apps/);
  });
  it('pages the certificates (the API returns them all) and counts the matches', async () => {
    const graphql = fakeGraphQL({
      ListMyCertificates: () => ({
        myCertificates: all,
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });
    const data = (await harness.call('list_my_certificates', { limit: 2 })).structuredContent as {
      certificates: { id: string }[];
      total: number;
      nextOffset: number | null;
    };
    expect(data.certificates.map((c) => c.id)).toEqual(['0001', '0002']);
    expect(data).toMatchObject({ total: 3, nextOffset: 2 });
  });
});
