import * as z from 'zod';

import { ListMyCertificatesDocument } from '../graphql/generated.js';
import { CERTIFICATE_STATUSES, CertificateSchema, toCertificate } from './shared/certificate.js';
import { pageOf, paginationInput, paginationOutput } from './shared/common.js';
import { defineTool } from './define-tool.js';

export const listMyCertificates = defineTool({
  name: 'list_my_certificates',
  title: 'List my payout certificates',
  description:
    'The signed-in researcher’s payout certificates: what each adjudicated report is owed (gross, withheld ' +
    'at source, net), who graded it, when the appeal window closes, when payment is due, and whether it is overdue. ' +
    'Settlement claims and payment details are never returned; use the BugSecure website for those.',
  requiredScopes: ['profile:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    status: z.enum(CERTIFICATE_STATUSES).optional().describe('Only certificates in this status.'),
    overdueOnly: z.boolean().default(false).describe('Only certificates past their due date.'),
    ...paginationInput(100, 50),
  }),
  output: z.object({
    certificates: z.array(CertificateSchema),
    total: z.number().int(),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    // The API returns every certificate at once; page it here so a long history stays bounded.
    const { myCertificates } = await graphql.request(ListMyCertificatesDocument, {}, { signal });
    const matching = myCertificates.filter(
      (c) => (input.status === undefined || c.status === input.status) && (!input.overdueOnly || c.isOverdue),
    );
    const { items, ...pagination } = pageOf(matching, input);
    return {
      data: {
        certificates: items.map(toCertificate),
        total: matching.length,
        ...pagination,
      },
    };
  },
});
