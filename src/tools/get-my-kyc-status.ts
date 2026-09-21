import * as z from 'zod';

import { GetMyKycStatusDocument } from '../graphql/generated.js';
import { defineTool } from './define-tool.js';
import { KYC_STATUSES } from './shared/account.js';

export const getMyKycStatus = defineTool({
  name: 'get_my_kyc_status',
  title: 'Get my KYC verification status',
  description:
    'Whether the signed-in user’s identity verification (KYC) is complete: overall status and which ' +
    'required documents are on file. Status only — documents themselves are never available here; they ' +
    'are uploaded and managed on the BugSecure website.',
  requiredScopes: ['profile:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({}),
  output: z.object({
    status: z.enum(KYC_STATUSES),
    isComplete: z.boolean(),
    hasIdDocument: z.boolean(),
    hasProofOfAddress: z.boolean(),
  }),
  async handler(_input, { graphql, signal }) {
    const { me, myKycStatus } = await graphql.request(GetMyKycStatusDocument, {}, { signal });
    return {
      data: {
        status: me.kycStatus,
        isComplete: myKycStatus.isComplete,
        hasIdDocument: myKycStatus.hasIdDocument,
        hasProofOfAddress: myKycStatus.hasProofOfAddress,
      },
    };
  },
});
