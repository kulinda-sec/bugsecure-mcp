import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const stats = {
  totalReports: 5,
  reportsByStatus: { NEW: 3, CLOSED: 2 },
  reportsBySeverity: { HIGH: 1, LOW: 4 },
  averageResolutionTime: 36.5,
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_program_stats', () => {
  it('returns validated counts', async () => {
    const graphql = fakeGraphQL({ GetProgramStats: () => ({ programStats: stats }) });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('get_program_stats', { programId: 'p1' });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'GetProgramStats', variables: { programId: 'p1' } }]);
    expect(result.structuredContent).toEqual({
      totalReports: 5,
      byStatus: { NEW: 3, CLOSED: 2 },
      bySeverity: { HIGH: 1, LOW: 4 },
      averageResolutionHours: 36.5,
    });
  });

  it('fails cleanly when the API returns counts in an unexpected shape', async () => {
    const graphql = fakeGraphQL({
      GetProgramStats: () => ({ programStats: { ...stats, reportsByStatus: { NEW: 'three' } } }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('get_program_stats', { programId: 'p1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unexpected shape/);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect((await harness.call('get_program_stats', { programId: 'x'.repeat(65) })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('explains an organization that has not opted in to AI triage access', async () => {
    const graphql = fakeGraphQL({
      GetProgramStats: () => {
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access for connected apps.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect(textOf(await harness.call('get_program_stats', { programId: 'p1' }))).toContain(
      'AI triage access',
    );
  });
});
