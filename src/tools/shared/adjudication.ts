/**
 * The grade in force on a report (its adjudication) and the appeals against
 * it, as both sides read them: the researcher on their own report
 * (get_report), a seat of the organisation on its reports (get_org_report).
 * Who graded, reviewed or appealed is never named (the API refuses those
 * usernames to connected apps); `side` and `raisedBy` say which party.
 */
import * as z from 'zod';

import type {
  AdjudicationFieldsFragment,
  AmountBasis,
  AppealFieldsFragment,
  AppealParty,
  AppealStatus,
  CriticalReviewOutcome,
} from '../../graphql/generated.js';
import { untrusted } from '../../untrusted.js';
import { code, id, ifShaped, timestamp, wrapped } from './common.js';
import { SeveritySchema, SideSchema } from './report.js';

const AMOUNT_BASES = [
  'GRID_FLOOR',
  'GRID_INTERPOLATED',
  'ASSESSOR_OVERRIDE',
] as const satisfies readonly AmountBasis[];
export const REVIEW_OUTCOMES = [
  'CONFIRMED',
  'CHANGED',
  'LAPSED',
] as const satisfies readonly CriticalReviewOutcome[];
const APPEAL_PARTIES = ['RESEARCHER', 'ORGANIZATION'] as const satisfies readonly AppealParty[];
export const APPEAL_STATUSES = [
  'OPEN',
  'UPHELD',
  'OVERTURNED',
  'WITHDRAWN',
] as const satisfies readonly AppealStatus[];

export const AdjudicationSchema = z
  .object({
    id: id(),
    severity: SeveritySchema,
    cvssVersion: code('cvss-version'),
    cvssVector: code('cvss-vector'),
    cvssScore: z.number(),
    cweId: code('cwe-id').nullable(),
    vrtNodeId: code('taxonomy-node-id'),
    amount: z.number().int().nullable().describe('Reward; null if none.'),
    currency: code('currency'),
    amountBasis: z.enum(AMOUNT_BASES),
    amountReason: wrapped().nullable(),
    reasoning: wrapped(),
    deviationReason: wrapped('Why the severity departs from the taxonomy baseline.').nullable(),
    decisionVector: code('decision-vector').nullable().describe('The decision as one replayable line.'),
    supersedesId: id().nullable(),
    side: SideSchema,
    awaitingCriticalReview: z
      .boolean()
      .describe('An organisation’s CRITICAL grade, provisional until BugSecure reviews it.'),
    criticalReviewDueAt: timestamp().nullable().describe('When that review lapses; the grade then stands.'),
    criticalReview: z
      .object({
        outcome: z.enum(REVIEW_OUTCOMES),
        createdAt: timestamp(),
        supersedingAdjudicationId: id().nullable(),
      })
      .nullable(),
    createdAt: timestamp(),
  })
  .nullable()
  .describe('The grade in force; null until graded.');

export const AppealSchema = z.object({
  id: id(),
  adjudicationId: id(),
  raisedBy: z.enum(APPEAL_PARTIES),
  status: z.enum(APPEAL_STATUSES),
  grounds: wrapped(),
  decision: wrapped().nullable(),
  createdAt: timestamp(),
  decidedAt: timestamp().nullable(),
  resultingAdjudicationId: id().nullable(),
});

export const toAdjudication = (a: AdjudicationFieldsFragment | null): z.input<typeof AdjudicationSchema> =>
  a && {
    id: a.id,
    severity: a.severity,
    cvssVersion: a.cvssVersion,
    cvssVector: a.cvssVector,
    cvssScore: a.cvssScore,
    cweId: a.cweId,
    vrtNodeId: a.vrtNodeId,
    amount: a.amount,
    currency: a.currency,
    amountBasis: a.amountBasis,
    amountReason: untrusted(`adjudication:${a.id}:amount-reason`, a.amountReason),
    reasoning: untrusted(`adjudication:${a.id}:reasoning`, a.reasoning),
    deviationReason: untrusted(`adjudication:${a.id}:deviation-reason`, a.deviationReason),
    decisionVector: ifShaped('decision-vector', a.decisionVector),
    supersedesId: a.supersedesId,
    side: a.side,
    awaitingCriticalReview: a.awaitingCriticalReview,
    criticalReviewDueAt: a.criticalReviewDueAt,
    criticalReview: a.criticalReview && {
      outcome: a.criticalReview.outcome,
      createdAt: a.criticalReview.createdAt,
      supersedingAdjudicationId: a.criticalReview.supersedingAdjudicationId,
    },
    createdAt: a.createdAt,
  };

export const toAppeals = (appeals: readonly AppealFieldsFragment[]): z.input<typeof AppealSchema>[] =>
  appeals.map((ap) => ({
    id: ap.id,
    adjudicationId: ap.adjudicationId,
    raisedBy: ap.raisedBy,
    status: ap.status,
    grounds: untrusted(`appeal:${ap.id}:grounds`, ap.grounds),
    decision: untrusted(`appeal:${ap.id}:decision`, ap.decision),
    createdAt: ap.createdAt,
    decidedAt: ap.decidedAt,
    resultingAdjudicationId: ap.resultingAdjudicationId,
  }));
