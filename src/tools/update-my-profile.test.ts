import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

const WRITER = ['profile:write'] as const;
const updated = (input: Record<string, unknown>) => ({
  updateResearcherProfile: { bio: 'Old bio', website: '', country: 'KE', ...input },
});

const api = () => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({
      ...approvals.handlers,
      UpdateMyProfile: (v) => updated(v.input as Record<string, unknown>),
    }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('update_my_profile', () => {
  it('registers only the given fields for review, then sends exactly those', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('update_my_profile', {
      bio: 'Web and mobile.\r\nSee my site.',
      website: 'https://ada.example',
    });

    expect(result.isError).toBeFalsy();
    const input = { bio: 'Web and mobile.\nSee my site.', website: 'https://ada.example' };
    expect(approvals.created[0]?.parts).toEqual([
      { operation: 'updateResearcherProfile', arguments: { input } },
    ]);
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approvals.created[0]?.id ?? ''}`);
    expect(harness.prompts[0]?.message).toContain(
      'change the bio, website on your public researcher profile',
    );
    expect(harness.prompts[0]?.message).not.toContain('ada.example');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'UpdateMyProfile',
        variables: { input, clientRequestId: approvals.created[0]?.clientRequestId },
      },
    ]);
    const { profile } = result.structuredContent as { profile: { bio: string } };
    expect(profile.bio).toMatch(/^<untrusted-content-[0-9a-f]{16} source="user:researcher-1:bio">/);
  });

  it('clears a field with an empty string', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    await harness.call('update_my_profile', { country: '' });

    expect(approvals.created[0]?.parts[0]?.arguments).toEqual({ input: { country: '' } });
    expect(withoutLookups(graphql.calls)[0]?.variables).toEqual({
      input: { country: '' },
      clientRequestId: approvals.created[0]?.clientRequestId,
    });
  });

  it('looks nothing up for display: the review page shows the current profile', async () => {
    const { graphql } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER, 'profile:read'] });
    expect((await harness.call('update_my_profile', { bio: 'x' })).isError).toBeFalsy();
    expect(graphql.calls.map((c) => c.operation)).not.toContain('GetMyProfileRef');
  });

  it('sends the country as an upper-case ISO code', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('update_my_profile', { country: 'sn' });

    expect(result.isError).toBeFalsy();
    expect(approvals.created[0]?.parts[0]?.arguments).toEqual({ input: { country: 'SN' } });
    expect(withoutLookups(graphql.calls)[0]?.variables).toEqual({
      input: { country: 'SN' },
      clientRequestId: approvals.created[0]?.clientRequestId,
    });
  });

  it('sends nothing when the user declines on BugSecure', async () => {
    const approvals = fakeAgentApprovals('decline');
    const graphql = fakeGraphQL({ ...approvals.handlers, UpdateMyProfile: () => updated({}) });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    const result = await harness.call('update_my_profile', { bio: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Nothing was sent: the user declined/);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('rejects an empty call, a non-http website and a country that is not a two-letter code before registering anything', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    for (const args of [
      {},
      { website: 'javascript:alert(1)' },
      { website: 'https://' },
      { country: 'Kenya' },
      { country: 'SEN' },
      { country: 'S1' },
      { bio: 'x'.repeat(501) },
      { avatarUrl: 'https://x.example/a.png' },
    ]) {
      expect((await harness.call('update_my_profile', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.prompts).toHaveLength(0);
    expect(graphql.calls).toEqual([]);
  });
});
