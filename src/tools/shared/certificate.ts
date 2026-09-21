/** Payout certificate shapes shared by the tools that return one. */
import * as z from 'zod';

import type { CertificateFieldsFragment, CertificateStatus } from '../../graphql/generated.js';
import { untrusted } from '../../untrusted.js';
import { REVIEW_OUTCOMES } from './adjudication.js';
import { code, id, PATTERNS, timestamp, wrapped } from './common.js';
import { SideSchema } from './report.js';

/** Printed, human-facing reference, e.g. "BSC-2026-0001". */
export const CERTIFICATE_REFERENCE = PATTERNS['certificate-reference'];

export const CERTIFICATE_STATUSES = [
  'ISSUED',
  'UNDER_APPEAL',
  'ATTESTED',
  'DISPUTED',
  'SETTLED',
  'SUPERSEDED',
  'VOID',
] as const satisfies readonly CertificateStatus[];

/** What a certificate owes and when; never how it is paid (settlement details are refused to connected apps). */
export const CertificateSchema = z.object({
  id: id(),
  reference: code('certificate-reference'),
  reportId: id(),
  adjudicationId: id(),
  status: z.enum(CERTIFICATE_STATUSES),
  graderSide: SideSchema,
  criticalReviewOutcome: z
    .enum(REVIEW_OUTCOMES)
    .nullable()
    .describe('An organisation’s Critical: how BugSecure’s review ended. Null when none applied.'),
  currency: code('currency'),
  grossAmount: z.number().int(),
  withheldAmount: z.number().int().describe('Withheld at source by the payer.'),
  netAmount: z.number().int().describe('What the researcher should receive.'),
  issuedAt: timestamp(),
  appealClosesAt: timestamp(),
  dueAt: timestamp(),
  disputeClosesAt: timestamp()
    .nullable()
    .describe('Payment claimed: until when the researcher may dispute it.'),
  isOverdue: z.boolean(),
  voidReason: wrapped().nullable(),
});

export type Certificate = z.input<typeof CertificateSchema>;

export const toCertificate = (c: CertificateFieldsFragment): Certificate => ({
  id: c.id,
  reference: c.reference,
  reportId: c.reportId,
  adjudicationId: c.adjudicationId,
  status: c.status,
  graderSide: c.graderSide,
  criticalReviewOutcome: c.criticalReviewOutcome,
  currency: c.currency,
  grossAmount: c.grossAmount,
  withheldAmount: c.withheldAmount,
  netAmount: c.netAmount,
  issuedAt: c.issuedAt,
  appealClosesAt: c.appealClosesAt,
  dueAt: c.dueAt,
  disputeClosesAt: c.disputeClosesAt,
  isOverdue: c.isOverdue,
  voidReason: untrusted(`certificate:${c.id}:void-reason`, c.voidReason),
});
