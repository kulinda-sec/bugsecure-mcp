import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const taxonomyProfile = {
  taxonomyId: 'bugcrowd-vrt',
  taxonomyVersion: 'v1.19.1',
  nodes: [
    {
      id: 'cross_site_scripting_xss.stored.non_privileged_user_to_anyone',
      name: 'Non-Privileged User to Anyone',
      priority: 2,
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N',
      cweId: 'CWE-79',
    },
    {
      id: 'cross_site_scripting_xss.reflected.non_self',
      name: 'Non-Self',
      priority: 3,
      cvssVector: null,
      cweId: null,
    },
    {
      id: 'server_security_misconfiguration.clickjacking.sensitive_click_based_action',
      name: 'Sensitive Click-Based Action',
      priority: null,
      cvssVector: 'not a vector',
      cweId: 'CWE-1021',
    },
    { id: 'Not A Node Id', name: 'dropped', priority: 1, cvssVector: null, cweId: null },
  ],
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_taxonomy', () => {
  it('lists the nodes graders pick from, names fenced', async () => {
    const graphql = fakeGraphQL({ GetTaxonomy: () => ({ taxonomyProfile }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('get_taxonomy', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'GetTaxonomy', variables: {} }]);
    const data = result.structuredContent as {
      nodes: { id: string; name: string; cvssVector: string | null; priority: number | null }[];
      total: number;
      nextOffset: number | null;
    };
    expect(data).toMatchObject({ taxonomyId: 'bugcrowd-vrt', taxonomyVersion: 'v1.19.1', total: 3 });
    expect(data.nextOffset).toBeNull();
    expect(data.nodes.map((n) => n.id)).toEqual([
      'cross_site_scripting_xss.stored.non_privileged_user_to_anyone',
      'cross_site_scripting_xss.reflected.non_self',
      'server_security_misconfiguration.clickjacking.sensitive_click_based_action',
    ]);
    expect(data.nodes[0]?.name).toMatch(/^<untrusted-content-[0-9a-f]{16} source="taxonomy:/);
    // A value that does not have the expected shape is dropped, never passed through.
    expect(data.nodes[2]).toMatchObject({ priority: null, cvssVector: null });
  });

  it('filters by words in the id or name, and pages', async () => {
    const graphql = fakeGraphQL({ GetTaxonomy: () => ({ taxonomyProfile }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const stored = await harness.call('get_taxonomy', { query: 'Stored XSS' });
    expect(stored.structuredContent).toMatchObject({
      total: 1,
      nodes: [{ id: 'cross_site_scripting_xss.stored.non_privileged_user_to_anyone' }],
    });

    const first = await harness.call('get_taxonomy', { query: 'scripting', limit: 1 });
    expect(first.structuredContent).toMatchObject({ total: 2, nextOffset: 1, nodes: [{}] });
    const second = await harness.call('get_taxonomy', { query: 'scripting', limit: 1, offset: 1 });
    expect(second.structuredContent).toMatchObject({
      nextOffset: null,
      nodes: [{ id: 'cross_site_scripting_xss.reflected.non_self' }],
    });
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect((await harness.call('get_taxonomy', { query: 'x' })).isError).toBe(true);
    expect((await harness.call('get_taxonomy', { limit: 201 })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays an API failure', async () => {
    const graphql = fakeGraphQL({
      GetTaxonomy: () => {
        throw new BugSecureError('UPSTREAM_UNAVAILABLE', 'BugSecure is unreachable.');
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect(textOf(await harness.call('get_taxonomy', {}))).toContain('BugSecure is unreachable.');
  });
});
