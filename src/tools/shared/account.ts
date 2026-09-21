import type { KycStatus } from '../../graphql/generated.js';

export const KYC_STATUSES = [
  'NOT_SUBMITTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const satisfies readonly KycStatus[];
