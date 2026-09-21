import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups } from '../../test/helpers/fake-graphql.js';
import { certificate } from '../../test/helpers/report-fixtures.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

const ORG_READER = ['triage:read', 'profile:read'] as const;

const owed = (id: string) => ({
  ...certificate(id, 'ISSUED', false),
  researcherId: 'u1',
  researcherUsername: 'ada',
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_org_certificates', () => {
  it('pages what the organisation owes through the API, fencing the researcher’s name', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      ListOrgCertificates: () => ({ organizationCertificates: [owed('0001'), owed('0002')] }),
    });
    harness = await connectTools({ graphql, grantedScopes: [...ORG_READER], viewerId: 'triager-1' });

    const result = await harness.call('list_org_certificates', {
      organizationId: 'o1',
      status: 'ISSUED',
      limit: 2,
      offset: 4,
    });

    expect(result.isError).toBeFalsy();
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'ListOrgCertificates',
        variables: { orgId: 'o1', status: 'ISSUED', reportId: null, skip: 4, take: 2 },
      },
    ]);
    const data = result.structuredContent as {
      certificates: Record<string, unknown>[];
      nextOffset: number | null;
    };
    expect(data.nextOffset).toBe(6);
    expect(data.certificates[0]).toMatchObject({ reference: 'BSC-2026-0001', graderSide: 'ORGANIZATION' });
    expect(data.certificates[0]?.researcherUsername).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="user:u1:username">\nada\n/,
    );
    expect(data.certificates[0]).not.toHaveProperty('settlement');
    expect(data.certificates[0]).not.toHaveProperty('reportTitle');
  });

  it('refuses a BugSecure staff account before reading anything', async () => {
    const graphql = fakeGraphQL({ ...lookups({ roles: ['PLATFORM_ROLE_A'] }) });
    harness = await connectTools({ graphql, grantedScopes: [...ORG_READER], viewerId: 'triager-1' });

    const result = await harness.call('list_org_certificates', { organizationId: 'o1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('BugSecure staff');
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('needs profile:read for the staff check', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });
    const result = await harness.call('list_org_certificates', { organizationId: 'o1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('needs the profile:read triage:read permission');
    expect(graphql.calls).toEqual([]);
  });
});
