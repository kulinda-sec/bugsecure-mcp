import * as z from 'zod';

import { ListMyOrganizationsDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, safeSlug, slug, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

export const listMyOrganizations = defineTool({
  name: 'list_my_organizations',
  title: 'List organizations I can triage',
  description:
    'Organisations the signed-in user belongs to that have enabled AI triage access — the only ones the ' +
    'triage tools can reach — and whether each also enabled AI grading. Use the ids with get_org_report_stats, ' +
    'list_org_certificates. If an expected organisation is ' +
    'missing, an Administrator of that organisation must enable "AI triage access" in its settings on BugSecure.',
  requiredScopes: ['triage:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({}),
  output: z.object({
    organizations: z.array(
      z.object({
        id: id(),
        slug: slug(),
        name: wrapped(),
        aiTriageAccessEnabled: z.boolean(),
        aiGradingEnabled: z.boolean().describe('Whether grade_report may grade its reports.'),
      }),
    ),
  }),
  async handler(_input, { graphql, signal }) {
    const { myOrganizations } = await graphql.request(ListMyOrganizationsDocument, {}, { signal });
    return {
      data: {
        organizations: myOrganizations.map((o) => ({
          id: o.id,
          slug: safeSlug(o.slug),
          name: untrusted(`organization:${o.id}:name`, o.name),
          aiTriageAccessEnabled: o.aiTriageAccessEnabled,
          aiGradingEnabled: o.aiGradingEnabled,
        })),
      },
    };
  },
});
