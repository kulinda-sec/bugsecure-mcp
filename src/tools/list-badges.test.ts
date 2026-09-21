import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const catalog = [
  {
    id: 'b1',
    slug: 'first-blood',
    name: 'First blood',
    description: 'First validated report',
    state: 'EARNED',
    hidden: false,
    awardedAt: '2026-03-01T00:00:00.000Z',
    progress: null,
  },
  {
    id: 'b2',
    slug: 'ten-reports',
    name: 'Ten reports',
    description: 'Ten validated reports',
    state: 'LOCKED',
    hidden: false,
    awardedAt: null,
    progress: { current: 3, threshold: 10 },
  },
];

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_badges', () => {
  it('returns the catalogue with progress, counts and fenced text', async () => {
    const graphql = fakeGraphQL({ ListBadges: () => ({ badgeCatalog: catalog }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('list_badges', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'ListBadges', variables: {} }]);
    const data = result.structuredContent as {
      badges: { id: string; name: string; progress: unknown }[];
      earned: number;
      total: number;
    };
    expect(data).toMatchObject({ earned: 1, total: 2 });
    expect(data.badges[1]?.progress).toEqual({ current: 3, threshold: 10 });
    expect(data.badges[0]?.name).toMatch(/^<untrusted-content-[0-9a-f]{16} source="badge:b1:name">/);
  });

  it('filters by state', async () => {
    const graphql = fakeGraphQL({ ListBadges: () => ({ badgeCatalog: catalog }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('list_badges', { state: 'LOCKED' });
    const data = result.structuredContent as { badges: { id: string }[]; total: number };
    expect(data.badges.map((b) => b.id)).toEqual(['b2']);
    expect(data.total).toBe(2);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect((await harness.call('list_badges', { state: 'SHINY' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays API errors as actionable text', async () => {
    const graphql = fakeGraphQL({
      ListBadges: () => {
        throw new BugSecureError('SESSION_EXPIRED', 'The BugSecure session is no longer valid.');
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect(textOf(await harness.call('list_badges', {}))).toContain('login');
  });
  it('pages the catalogue (the API returns it whole) and keeps the totals', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `b${String(i)}`,
      slug: `badge-${String(i)}`,
      name: `Badge ${String(i)}`,
      description: 'd',
      state: i < 2 ? 'EARNED' : 'LOCKED',
      hidden: false,
      awardedAt: null,
      progress: null,
    }));
    const graphql = fakeGraphQL({ ListBadges: () => ({ badgeCatalog: many }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });
    const page1 = (await harness.call('list_badges', { limit: 3 })).structuredContent as {
      badges: { id: string }[];
      nextOffset: number | null;
      total: number;
      earned: number;
    };
    expect(page1.badges.map((b) => b.id)).toEqual(['b0', 'b1', 'b2']);
    expect(page1).toMatchObject({ nextOffset: 3, total: 7, earned: 2 });
    const last = (await harness.call('list_badges', { limit: 3, offset: 6 })).structuredContent as {
      badges: { id: string }[];
      nextOffset: number | null;
    };
    expect(last.badges.map((b) => b.id)).toEqual(['b6']);
    expect(last.nextOffset).toBeNull();
  });
});
