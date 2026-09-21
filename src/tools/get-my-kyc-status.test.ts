import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('get_my_kyc_status', () => {
  it('returns the status only', async () => {
    const graphql = fakeGraphQL({
      GetMyKycStatus: () => ({
        me: { kycStatus: 'PENDING' },
        myKycStatus: { isComplete: false, hasIdDocument: true, hasProofOfAddress: false },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const result = await harness.call('get_my_kyc_status', {});

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'GetMyKycStatus', variables: {} }]);
    expect(result.structuredContent).toEqual({
      status: 'PENDING',
      isComplete: false,
      hasIdDocument: true,
      hasProofOfAddress: false,
    });
  });

  it('fails closed on a status this version does not know', async () => {
    const graphql = fakeGraphQL({
      GetMyKycStatus: () => ({
        me: { kycStatus: 'SOMETHING_NEW' },
        myKycStatus: { isComplete: false, hasIdDocument: false, hasProofOfAddress: false },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    const result = await harness.call('get_my_kyc_status', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not understand/);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      GetMyKycStatus: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['profile:read'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });

    expect(textOf(await harness.call('get_my_kyc_status', {}))).toContain('login --scopes "profile:read"');
  });
});
