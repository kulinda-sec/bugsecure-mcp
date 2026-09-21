import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { reportSummary } from '../../test/helpers/report-fixtures.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('check_duplicates', () => {
  it('returns candidate reports', async () => {
    const graphql = fakeGraphQL({ CheckDuplicates: () => ({ checkDuplicates: [reportSummary('r0')] }) });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('check_duplicates', {
      programId: 'p1',
      title: 'Stored XSS in profile',
      description: 'bio field unescaped',
    });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      {
        operation: 'CheckDuplicates',
        variables: { programId: 'p1', title: 'Stored XSS in profile', description: 'bio field unescaped' },
      },
    ]);
    expect(
      (result.structuredContent as { candidates: { id: string }[] }).candidates.map((c) => c.id),
    ).toEqual(['r0']);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect(
      (await harness.call('check_duplicates', { programId: 'p1', title: '', description: 'x' })).isError,
    ).toBe(true);
    expect((await harness.call('check_duplicates', { title: 't', description: 'd' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('explains an organization that has not opted in to AI triage access', async () => {
    const graphql = fakeGraphQL({
      CheckDuplicates: () => {
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access for connected apps.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('check_duplicates', { programId: 'p1', title: 't', description: 'd' });
    expect(textOf(result)).toContain('AI triage access');
  });

  it('is triage-side: refused with reports:read alone', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:read'] });
    const result = await harness.call('check_duplicates', { programId: 'p1', title: 't', description: 'd' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('triage:read');
    expect(graphql.calls).toHaveLength(0);
  });
});
