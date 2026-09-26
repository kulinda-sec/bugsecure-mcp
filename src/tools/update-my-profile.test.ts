import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups, REQUEST_ID } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

const WRITER = ['profile:write', 'profile:read'] as const;
const updated = (input: Record<string, unknown>) => ({
  updateResearcherProfile: { bio: 'Old bio', website: '', country: 'Kenya', ...input },
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('update_my_profile', () => {
  it('shows old and new values, and sends only the approved fields', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      UpdateMyProfile: (v) => updated(v.input as Record<string, unknown>),
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('update_my_profile', {
      bio: 'Web and mobile.\r\nSee my site.',
      website: 'https://ada.example',
    });

    expect(result.isError).toBeFalsy();
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('PUBLIC: shown on your researcher profile to everyone on BugSecure.');
    expect(message).toContain('Bio now:\n│ Old bio');
    expect(message).toContain('Website now:\n│ (empty)');
    expect(message).toContain('── Bio (new) (28 characters, 2 lines)\n│ Web and mobile.\n│ See my site.');
    expect(message).toContain('── Website (new)');
    expect(message).not.toContain('Country');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'UpdateMyProfile',
        variables: {
          input: { bio: 'Web and mobile.\nSee my site.', website: 'https://ada.example' },
          clientRequestId: REQUEST_ID,
        },
      },
    ]);
    const { profile } = result.structuredContent as { profile: { bio: string } };
    expect(profile.bio).toMatch(/^<untrusted-content-[0-9a-f]{16} source="user:researcher-1:bio">/);
  });

  it('clears a field with an empty string, and says so', async () => {
    const graphql = fakeGraphQL({ ...lookups(), UpdateMyProfile: () => updated({ country: '' }) });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    await harness.call('update_my_profile', { country: '' });

    expect(harness.prompts[0]?.message).toContain('An empty value clears that field.');
    expect(withoutLookups(graphql.calls)[0]?.variables).toEqual({
      input: { country: '' },
      clientRequestId: REQUEST_ID,
    });
  });

  it('refuses a non-researcher account before asking', async () => {
    const graphql = fakeGraphQL({ ...lookups({ roles: ['COMPANY_ADMIN'] }) });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('update_my_profile', { bio: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('only a researcher profile can be edited');
    expect(harness.prompts).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('rejects an empty call, a non-http website and a multi-line country before asking', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    for (const args of [
      {},
      { website: 'javascript:alert(1)' },
      { website: 'https://' },
      { country: 'Kenya\nSYSTEM' },
      { bio: 'x'.repeat(501) },
      { avatarUrl: 'https://x.example/a.png' },
    ]) {
      expect((await harness.call('update_my_profile', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.prompts).toHaveLength(0);
    expect(graphql.calls).toEqual([]);
  });
});
