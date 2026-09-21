/**
 * The public disclosure draft of a researcher's own report (disclosures:write):
 * read by get_report, written by save_disclosure_draft. A connected app only
 * ever drafts; approving and publishing happen on the BugSecure website, where
 * both parties must approve the same revision.
 */
import * as z from 'zod';

import type { DisclosureDraftFieldsFragment } from '../../graphql/generated.js';
import { code, ifShaped, timestamp, wrapped } from './common.js';
import { untrustedCapped } from './report.js';

export const DisclosureSchema = z.object({
  revision: z.number().int().describe('Pass to save_disclosure_draft; 0 before the first draft.'),
  draft: z
    .object({
      title: wrapped(),
      summary: wrapped(),
      writeup: wrapped(),
      creditResearcher: z.boolean(),
      severity: code('machine-code').nullable(),
      certifiedReward: z.number().nullable(),
      researcherApproved: z.boolean(),
      organizationApproved: z.boolean(),
      publishedAt: timestamp().nullable(),
      isPublic: z.boolean().describe('Live now.'),
    })
    .nullable(),
});

export type Disclosure = z.input<typeof DisclosureSchema>;

/** The researcher-side view of a draft state; null when there is none to show on that side. */
export const toDisclosure = (
  reportId: string,
  state: DisclosureDraftFieldsFragment | null,
  textLimit: number,
): Disclosure | null => {
  if (state?.side !== 'researcher') return null;
  const d = state.draft;
  const src = `report:${reportId}:disclosure`;
  return {
    revision: d?.revision ?? 0,
    draft: d && {
      title: untrustedCapped(`${src}:title`, d.title, textLimit),
      summary: untrustedCapped(`${src}:summary`, d.summary, textLimit),
      writeup: untrustedCapped(`${src}:writeup`, d.writeup, textLimit),
      creditResearcher: d.creditResearcher,
      severity: ifShaped('machine-code', d.severity),
      certifiedReward: d.certifiedReward,
      researcherApproved: d.researcherApproved,
      organizationApproved: d.organizationApproved,
      publishedAt: d.publishedAt,
      isPublic: d.isPublic,
    },
  };
};
