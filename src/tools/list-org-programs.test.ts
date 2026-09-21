import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness } from '../../test/helpers/tool-harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_org_programs', () => {
  it('lists every programme of the organisations, drafts included, with the triage deadline', async () => {
    const graphql = fakeGraphQL({
      ListOrgPrograms: () => ({
        myPrograms: [
          {
            id: 'p1',
            slug: 'acme-web',
            title: 'Acme web',
            status: 'DRAFT',
            visibility: 'PRIVATE',
            startDate: null,
            endDate: null,
            updatedAt: '2026-09-01T00:00:00.000Z',
            organization: { id: 'o1', name: 'Acme', slug: 'acme' },
            currency: 'KES',
            triageDeadlineBusinessDays: 10,
          },
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('list_org_programs', { limit: 1 });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'ListOrgPrograms', variables: { skip: 0, take: 1 } }]);
    expect(result.structuredContent).toMatchObject({
      programs: [{ id: 'p1', status: 'DRAFT', currency: 'KES', triageDeadlineBusinessDays: 10 }],
      nextOffset: 1,
    });
    const [program] = (result.structuredContent as { programs: { title: string }[] }).programs;
    expect(program?.title).toMatch(/^<untrusted-content-[0-9a-f]{16} source="program:p1:title">/);
  });
});
