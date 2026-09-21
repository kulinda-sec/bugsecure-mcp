/**
 * Programme output schemas and mappers shared by the programme tools.
 *
 * Convention for every tool: identifiers, enums and dates are returned as-is;
 * EVERY free-text field written by someone other than the caller (here: the
 * organization running the programme) is wrapped with `untrusted()`, in the
 * structured output as well as the text rendering.
 */
import * as z from 'zod';

import type {
  ProgramDetailFragment,
  ProgramStatus,
  ProgramSummaryFragment,
  ProgramVisibility,
} from '../../graphql/generated.js';
import { untrusted, untrustedJson } from '../../untrusted.js';
import { code, id, safeSlug, slug, timestamp, wrapped } from './common.js';

const PROGRAM_STATUSES = [
  'ACTIVE',
  'CLOSED',
  'DRAFT',
  'PAUSED',
  'REVIEW',
] as const satisfies readonly ProgramStatus[];
const PROGRAM_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const satisfies readonly ProgramVisibility[];

export const OrganizationRefSchema = z.object({
  id: id(),
  name: wrapped(),
  slug: slug(),
});

export const ProgramSummarySchema = z.object({
  id: id(),
  slug: slug(),
  title: wrapped(),
  status: z.enum(PROGRAM_STATUSES),
  visibility: z.enum(PROGRAM_VISIBILITIES),
  startDate: timestamp().nullable(),
  endDate: timestamp().nullable(),
  updatedAt: timestamp(),
  organization: OrganizationRefSchema.nullable(),
});

export const ProgramDetailSchema = ProgramSummarySchema.extend({
  description: wrapped(),
  rules: wrapped(),
  scope: wrapped('In-scope targets (JSON); null when not visible to the caller.').nullable(),
  outOfScope: wrapped('JSON.').nullable(),
  rewardGrid: wrapped('Current reward grid (JSON): what a new report is judged against.').nullable(),
  currency: code('currency'),
  createdAt: timestamp(),
});

export type ProgramSummary = z.input<typeof ProgramSummarySchema>;
export type ProgramDetail = z.input<typeof ProgramDetailSchema>;

export const toProgramSummary = (p: ProgramSummaryFragment): ProgramSummary => {
  const src = `program:${p.id}`;
  return {
    id: p.id,
    slug: safeSlug(p.slug),
    title: untrusted(`${src}:title`, p.title),
    status: p.status,
    visibility: p.visibility,
    startDate: p.startDate,
    endDate: p.endDate,
    updatedAt: p.updatedAt,
    organization: p.organization && {
      id: p.organization.id,
      name: untrusted(`organization:${p.organization.id}:name`, p.organization.name),
      slug: safeSlug(p.organization.slug),
    },
  };
};

export const toProgramDetail = (p: ProgramDetailFragment): ProgramDetail => {
  const src = `program:${p.id}`;
  return {
    ...toProgramSummary(p),
    description: untrusted(`${src}:description`, p.description),
    rules: untrusted(`${src}:rules`, p.rules),
    scope: untrustedJson(`${src}:scope`, p.scope),
    outOfScope: untrustedJson(`${src}:out-of-scope`, p.outOfScope),
    rewardGrid: untrustedJson(`${src}:reward-grid`, p.rewardGrid),
    currency: p.currency,
    createdAt: p.createdAt,
  };
};
