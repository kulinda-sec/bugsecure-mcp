import * as z from 'zod';

import { GetViewerRolesDocument, ListOrgCertificatesDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { CERTIFICATE_STATUSES, CertificateSchema, toCertificate } from './shared/certificate.js';
import { id, idInput, page, paginationInput, paginationOutput, wrapped } from './shared/common.js';
import { assertNotPlatformStaff } from './shared/viewer.js';
import { defineTool } from './define-tool.js';

export const listOrgCertificates = defineTool({
  name: 'list_org_certificates',
  title: 'List an organization’s payout certificates',
  description:
    'Payout certificates an organisation the signed-in user belongs to owes researchers (it must have enabled ' +
    'AI triage access), newest first: amounts, who graded, appeal window, due date, overdue. What is owed, ' +
    'never how it is paid: settlement claims and payment details stay on the BugSecure website.',
  // profile:read: the account's roles are checked (BugSecure staff are refused).
  requiredScopes: ['triage:read', 'profile:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    organizationId: idInput('Organization id (from list_my_organizations).'),
    status: z.enum(CERTIFICATE_STATUSES).optional().describe('Only certificates in this status.'),
    reportId: idInput('Only the certificates of this report.').optional(),
    ...paginationInput(100, 50),
  }),
  output: z.object({
    certificates: z.array(CertificateSchema.extend({ researcherId: id(), researcherUsername: wrapped() })),
    ...paginationOutput,
  }),
  async handler(input, context) {
    const { graphql, signal } = context;
    await assertNotPlatformStaff(context, async () => {
      const { me } = await graphql.request(GetViewerRolesDocument, {}, { signal });
      return me.roles;
    });
    const { organizationCertificates } = await graphql.request(
      ListOrgCertificatesDocument,
      {
        orgId: input.organizationId,
        status: input.status ?? null,
        reportId: input.reportId ?? null,
        skip: input.offset,
        take: input.limit,
      },
      { signal },
    );
    return {
      data: {
        certificates: organizationCertificates.map((c) => ({
          ...toCertificate(c),
          researcherId: c.researcherId,
          researcherUsername: untrusted(`user:${c.researcherId}:username`, c.researcherUsername),
        })),
        ...page(organizationCertificates.length, input),
      },
    };
  },
});
