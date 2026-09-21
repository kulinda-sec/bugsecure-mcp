import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf, unfence } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('list_my_organizations', () => {
  it('lists the opted-in organizations with fenced names', async () => {
    const graphql = fakeGraphQL({
      ListMyOrganizations: () => ({
        myOrganizations: [
          {
            id: 'org1',
            name: 'Acme Bank',
            slug: 'acme',
            aiTriageAccessEnabled: true,
            aiGradingEnabled: false,
          },
        ],
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    const result = await harness.call('list_my_organizations', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'ListMyOrganizations', variables: {} }]);
    expect(JSON.parse(unfence(JSON.stringify(result.structuredContent)))).toEqual({
      organizations: [
        {
          id: 'org1',
          slug: 'acme',
          name: '<untrusted-content source="organization:org1:name">\nAcme Bank\n</untrusted-content>',
          aiTriageAccessEnabled: true,
          aiGradingEnabled: false,
        },
      ],
    });
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      ListMyOrganizations: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['triage:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['triage:read'] });

    expect(textOf(await harness.call('list_my_organizations', {}))).toContain('login --scopes "triage:read"');
  });
});
