import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const row = (type: string, id: string) => ({
  type,
  id,
  slug: type === 'program' ? `slug-${id}` : null,
  title: `Title ${id}`,
  status: 'ACTIVE',
  highlight: 'a <mark>match</mark>',
  rank: 0.5,
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('search', () => {
  it('searches both types by default and fences titles and excerpts', async () => {
    const graphql = fakeGraphQL({ Search: () => ({ search: [row('program', 'p1'), row('report', 'r1')] }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('search', { query: ' xss ', limit: 2 });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      { operation: 'Search', variables: { query: 'xss', types: ['program', 'report'], limit: 2, offset: 0 } },
    ]);
    const data = result.structuredContent as {
      results: { type: string; title: string; highlight: string }[];
      nextOffset: number | null;
    };
    expect(data.results.map((r) => r.type)).toEqual(['program', 'report']);
    expect(data.results[1]?.highlight).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="report:r1:excerpt">/,
    );
    expect(data.nextOffset).toBe(2);
  });

  it('passes deduplicated types and drops result types it does not know', async () => {
    const graphql = fakeGraphQL({
      Search: () => ({ search: [row('program', 'p1'), row('hacker', 'u1')] }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('search', { query: 'acme', types: ['program', 'program'] });

    expect(graphql.calls[0]?.variables).toMatchObject({ types: ['program'] });
    const data = result.structuredContent as { results: { id: string }[]; nextOffset: number | null };
    expect(data.results.map((r) => r.id)).toEqual(['p1']);
    expect(data.nextOffset).toBeNull();
  });

  it('searches researchers on request and wraps the username as untrusted', async () => {
    const graphql = fakeGraphQL({
      Search: () => ({ search: [row('researcher', 'u1')] }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('search', { query: 'amadou', types: ['researcher'] });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls[0]?.variables).toMatchObject({ types: ['researcher'] });
    const data = result.structuredContent as { results: { type: string; id: string; title: string }[] };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ type: 'researcher', id: 'u1' });
    expect(data.results[0]?.title).toMatch(/^<untrusted-content-[0-9a-f]{16} source="researcher:u1:title">/);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect((await harness.call('search', { query: 'x' })).isError).toBe(true);
    expect((await harness.call('search', { query: 'xss', types: ['hacker'] })).isError).toBe(true);
    expect((await harness.call('search', { query: 'xss', limit: 51 })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      Search: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['programs:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'], mode: 'hosted' });

    expect(textOf(await harness.call('search', { query: 'xss' }))).toContain('approve: programs:read');
  });
});
