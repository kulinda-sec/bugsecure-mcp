import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const me = {
  id: 'u1',
  username: 'ada',
  roles: ['RESEARCHER'],
  status: 'ACTIVE',
  kycStatus: 'PENDING',
  isAmbassador: false,
  approvedAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
};
const myProfile = {
  bio: 'Web hunter',
  country: 'SN',
  website: null,
  level: 3,
  xp: 300,
  reputation: 40,
  streak: 1,
  longestStreak: 4,
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_my_profile', () => {
  it('returns the account and researcher profile, never contact details', async () => {
    const graphql = fakeGraphQL({ GetMyProfile: () => ({ me, myProfile, unreadNotificationCount: 3 }) });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const result = await harness.call('get_my_profile', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'GetMyProfile', variables: {} }]);
    const data = result.structuredContent as {
      account: Record<string, unknown>;
      researcherProfile: Record<string, unknown> | null;
      unreadNotifications: number;
    };
    expect(data.account).toMatchObject({
      id: 'u1',
      approved: false,
      kycStatus: 'PENDING',
      roles: ['RESEARCHER'],
    });
    expect(data.account).not.toHaveProperty('email');
    expect(data.researcherProfile).toMatchObject({ level: 3 });
    expect(data.researcherProfile?.bio).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="user:[^"]+:bio">\nWeb hunter\n/,
    );
    expect(data.unreadNotifications).toBe(3);
  });

  it('handles accounts without a researcher profile', async () => {
    const graphql = fakeGraphQL({
      GetMyProfile: () => ({
        me: { ...me, roles: ['COMPANY_ADMIN'], approvedAt: '2025-01-02T00:00:00.000Z' },
        myProfile: null,
        unreadNotificationCount: 0,
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const data = (await harness.call('get_my_profile', {})).structuredContent as {
      account: { approved: boolean };
      researcherProfile: unknown;
    };
    expect(data.account.approved).toBe(true);
    expect(data.researcherProfile).toBeNull();
  });

  it('reports any staff role as PLATFORM_STAFF, once', async () => {
    const graphql = fakeGraphQL({
      GetMyProfile: () => ({
        me: { ...me, roles: ['RESEARCHER', 'PLATFORM_ROLE_A', 'PLATFORM_ROLE_B'] },
        myProfile,
        unreadNotificationCount: 0,
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const result = await harness.call('get_my_profile', {});
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { account: { roles: string[] } };
    expect(data.account.roles).toEqual(['RESEARCHER', 'PLATFORM_STAFF']);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      GetMyProfile: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['profile:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    expect(textOf(await harness.call('get_my_profile', {}))).toContain('login --scopes "profile:read"');
  });
  it('adds report statistics and monthly activity only when asked', async () => {
    const graphql = fakeGraphQL({
      GetMyProfile: () => ({ me, myProfile, unreadNotificationCount: 0 }),
      GetMyStats: () => ({
        researcherStats: {
          totalReports: 7,
          validatedReports: 3,
          validationRate: 0.43,
          totalEarned: 900_000,
          reportsBySeverity: { HIGH: 2, LOW: 5, '<b>': 1, MEDIUM: 'x' },
        },
        researcherActivity: [
          { date: '2026-08', submissions: 2, validated: 1 },
          { date: 'August', submissions: 1, validated: 0 },
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    expect((await harness.call('get_my_profile', {})).structuredContent).toMatchObject({ stats: null });
    expect(graphql.calls.map((c) => c.operation)).toEqual(['GetMyProfile']);

    const result = await harness.call('get_my_profile', { stats: true });

    expect(graphql.calls[2]).toEqual({ operation: 'GetMyStats', variables: { userId: 'u1', months: 12 } });
    expect(result.structuredContent).toMatchObject({
      stats: {
        totalReports: 7,
        validationRate: 0.43,
        reportsBySeverity: [
          { severity: 'HIGH', count: 2 },
          { severity: 'LOW', count: 5 },
        ],
        activity: [{ month: '2026-08', submissions: 2, validated: 1 }],
      },
    });
  });
});
