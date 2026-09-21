import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf, unfence } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const entry = (rank: number, username: string) => ({
  rank,
  username,
  isAmbassador: rank === 1,
  profile: { userId: `u${String(rank)}`, country: 'Sénégal', level: 7, xp: 1200, reputation: 900 - rank },
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_leaderboard', () => {
  it('maps the period and returns ranked researchers with fenced usernames', async () => {
    const graphql = fakeGraphQL({
      GetLeaderboard: () => ({ leaderboard: [entry(1, 'ada'), entry(2, 'bob')] }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('get_leaderboard', { period: 'monthly', country: 'Sénégal', limit: 2 });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      { operation: 'GetLeaderboard', variables: { limit: 2, timeRange: 'monthly', country: 'Sénégal' } },
    ]);
    const data = result.structuredContent as {
      period: string;
      researchers: { rank: number; userId: string; username: string; isAmbassador: boolean }[];
    };
    expect(data.period).toBe('monthly');
    expect(data.researchers.map((r) => [r.rank, r.userId, r.isAmbassador])).toEqual([
      [1, 'u1', true],
      [2, 'u2', false],
    ]);
    expect(unfence(data.researchers[0]?.username ?? '')).toBe(
      '<untrusted-content source="user:u1:username">\nada\n</untrusted-content>',
    );
  });

  it('sends a null time range for the all-time board and applies defaults', async () => {
    const graphql = fakeGraphQL({ GetLeaderboard: () => ({ leaderboard: [] }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    await harness.call('get_leaderboard', {});

    expect(graphql.calls[0]?.variables).toEqual({ limit: 20, timeRange: null, country: null });
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect((await harness.call('get_leaderboard', { limit: 101 })).isError).toBe(true);
    expect((await harness.call('get_leaderboard', { period: 'weekly' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      GetLeaderboard: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['programs:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('get_leaderboard', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('login --scopes "programs:read"');
  });
});
