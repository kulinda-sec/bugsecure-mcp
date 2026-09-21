/**
 * Report output schemas, mappers and renderings shared by the report (researcher
 * side) and triage (organization side) tools.
 *
 * All report text is wrapped with `untrusted()`, whoever wrote it: even a
 * caller's own report routinely quotes content copied from the target, and the
 * same fields are third-party text on the other side.
 */
import * as z from 'zod';

import { BugSecureError } from '../../errors.js';
import type {
  AdjudicationSide,
  FileAccess,
  ReportCommentFieldsFragment,
  ReportCoreFragment,
  ReportDetailFragment,
  ReportStatus,
  ReportSummaryFragment,
  ReportTransitionFieldsFragment,
  ScanStatus,
  SeverityLevel,
} from '../../graphql/generated.js';
import { untrusted, untrustedJson } from '../../untrusted.js';
import { code, id, ifShaped, safeSlug, slug, timestamp, wrapped } from './common.js';

export const REPORT_STATUSES = [
  'NEW',
  'IN_TRIAGE',
  'NEEDS_MORE_INFO',
  'VALIDATED',
  'DUPLICATE',
  'OUT_OF_SCOPE',
  'NOT_APPLICABLE',
  'INFORMATIVE',
  'IN_FIX',
  'FIXED',
  'CLOSED',
] as const satisfies readonly ReportStatus[];

export const SEVERITIES = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFORMATIVE',
] as const satisfies readonly SeverityLevel[];

const SCAN_STATUSES = [
  'PENDING',
  'SCANNING',
  'CLEAN',
  'INFECTED',
  'UNSCANNABLE',
] as const satisfies readonly ScanStatus[];
const FILE_ACCESS = ['VIEW', 'DOWNLOAD', 'PENDING', 'REFUSED'] as const satisfies readonly FileAccess[];
export const SIDES = ['ORGANIZATION', 'PLATFORM'] as const satisfies readonly AdjudicationSide[];

/**
 * An organisation's rulings that take a report out of the triage deadline: it
 * is no longer "awaiting a grade", so BugSecure will not take it over.
 * INFORMATIVE and CLOSED do not: the deadline still runs until it is graded.
 */
export const RULED_OUT_STATUSES: ReadonlySet<ReportStatus> = new Set<ReportStatus>([
  'DUPLICATE',
  'OUT_OF_SCOPE',
  'NOT_APPLICABLE',
]);

export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export const SeveritySchema = z.enum(SEVERITIES);

export const UserRefSchema = z.object({ id: id(), username: wrapped() });

export const SideSchema = z.enum(SIDES).describe('Who graded; PLATFORM: BugSecure, the neutral third party.');

const ReportCoreSchema = z.object({
  id: id(),
  title: wrapped(),
  status: ReportStatusSchema,
  claimedSeverity: SeveritySchema.describe('Not the grade.'),
  createdAt: timestamp(),
  updatedAt: timestamp(),
  program: z.object({ id: id(), slug: slug(), title: wrapped() }).nullable(),
  reporter: UserRefSchema,
  triageDueAt: timestamp().nullable().describe('Grading deadline.'),
  awaitingGrade: z.boolean().describe('Ungraded and not ruled out.'),
  isOverdue: z.boolean().describe('Awaiting a grade past the deadline: BugSecure may grade it.'),
});

export const ReportSummarySchema = ReportCoreSchema.extend({
  grade: z
    .object({
      severity: SeveritySchema,
      side: SideSchema,
      certifiedAmount: z.number().int().nullable().describe('Certificate gross; null if none issued.'),
      currency: code('currency'),
    })
    .nullable()
    .describe('Null while ungraded.'),
});

export const AttachmentSchema = z.object({
  id: id(),
  fileName: wrapped(),
  contentType: code('mime-type').nullable(),
  fileSize: z.number().int().nullable().describe('Bytes; null until BugSecure verified the file.'),
  scanStatus: z.enum(SCAN_STATUSES),
  fileAccess: z.enum(FILE_ACCESS).describe('Opening it on the BugSecure website (never here).'),
});

/** Longest text field returned in full unless the caller asks for everything. */
export const DEFAULT_TEXT_LIMIT = 20_000;

/** The full report; its grade is the tool's `adjudication`. */
export const ReportDetailSchema = ReportCoreSchema.extend({
  claimedCvssVector: wrapped().nullable(),
  claimedCvssScore: z.number().nullable(),
  description: wrapped(),
  stepsToReproduce: wrapped(),
  impact: wrapped(),
  remediation: wrapped().nullable(),
  duplicateOfId: id().nullable(),
  boundRewardGrid: wrapped('Reward grid bound at submission (JSON): what the grade is paid from.').nullable(),
  attachments: z.array(AttachmentSchema),
});

export const COMMENT_AUTHORS = ['researcher', 'organization_or_bugsecure'] as const;

export const CommentSchema = z.object({
  id: id(),
  author: z.enum(COMMENT_AUTHORS),
  authorId: id(),
  content: wrapped(),
  createdAt: timestamp(),
});

export const TransitionSchema = z.object({
  fromStatus: ReportStatusSchema,
  toStatus: ReportStatusSchema,
  reason: wrapped().nullable(),
  createdAt: timestamp(),
});

export type ReportSummary = z.input<typeof ReportSummarySchema>;
export type ReportDetail = z.input<typeof ReportDetailSchema>;
export type Comment = z.input<typeof CommentSchema>;
export type Transition = z.input<typeof TransitionSchema>;

const toReportCore = (r: ReportCoreFragment): z.input<typeof ReportCoreSchema> => {
  const src = `report:${r.id}`;
  return {
    id: r.id,
    title: untrusted(`${src}:title`, r.title),
    status: r.status,
    claimedSeverity: r.claimedSeverity,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    program: r.program && {
      id: r.program.id,
      slug: safeSlug(r.program.slug),
      title: untrusted(`program:${r.program.id}:title`, r.program.title),
    },
    reporter: {
      id: r.reporter.id,
      username: untrusted(`user:${r.reporter.id}:username`, r.reporter.username),
    },
    triageDueAt: r.triageDueAt,
    awaitingGrade: r.awaitingGrade,
    isOverdue: r.isOverdue,
  };
};

export const toReportSummary = (r: ReportSummaryFragment): ReportSummary => {
  return {
    ...toReportCore(r),
    grade: r.grade && {
      severity: r.grade.severity,
      side: r.grade.side,
      certifiedAmount: r.grade.certifiedAmount,
      currency: r.grade.currency,
    },
  };
};

/**
 * Fence `text`, cut to `max` characters with a marker INSIDE the fence saying
 * how much was left out (so a truncated report is never mistaken for a whole one).
 */
export const untrustedCapped = <T extends string | null>(
  source: string,
  text: T,
  max: number,
): T | string => {
  if (text === null || text.length <= max) return text === null ? text : untrusted(source, text);
  const kept = text.slice(0, max);
  const omitted = text.length - kept.length;
  return untrusted(
    source,
    `${kept}\n[… bugsecure-mcp cut this text here: ${omitted.toLocaleString('en-US')} more characters not shown. ` +
      'Call again with fullText: true, or read it on the BugSecure website.]',
  );
};

export const toReportDetail = (r: ReportDetailFragment, textLimit = DEFAULT_TEXT_LIMIT): ReportDetail => {
  const src = `report:${r.id}`;
  return {
    ...toReportCore(r),
    claimedCvssVector: untrusted(`${src}:cvss-vector`, r.claimedCvssVector),
    claimedCvssScore: r.claimedCvssScore,
    description: untrustedCapped(`${src}:description`, r.description, textLimit),
    stepsToReproduce: untrustedCapped(`${src}:steps`, r.stepsToReproduce, textLimit),
    impact: untrustedCapped(`${src}:impact`, r.impact, textLimit),
    remediation: untrustedCapped(`${src}:remediation`, r.remediation, textLimit),
    duplicateOfId: r.duplicateOfId,
    boundRewardGrid: untrustedJson(`${src}:reward-grid`, r.boundRewardGrid),
    attachments: r.attachments.map((a) => ({
      id: a.id,
      fileName: untrusted(`attachment:${a.id}:file-name`, a.fileName),
      contentType: ifShaped('mime-type', a.contentType),
      fileSize: a.fileSize,
      scanStatus: a.scanStatus,
      fileAccess: a.fileAccess,
    })),
  };
};

/**
 * Public (non-internal) comments, labelled by side. Internal organization notes
 * are never returned by this server, on either side: they are dropped here and
 * only counted. Anyone but the reporter is labelled "organisation or
 * BugSecure": a connected app cannot read who else wrote (names are refused to
 * OAuth tokens), and BugSecure's staff comment on reports too.
 */
export const toComments = (
  comments: readonly ReportCommentFieldsFragment[],
  reporterId: string,
): { comments: Comment[]; internalHidden: number } => {
  const visible = comments.filter((c) => !c.isInternal);
  return {
    comments: visible.map((c) => ({
      id: c.id,
      author: c.authorId === reporterId ? 'researcher' : 'organization_or_bugsecure',
      authorId: c.authorId,
      content: untrusted(`comment:${c.id}`, c.content),
      createdAt: c.createdAt,
    })),
    internalHidden: comments.length - visible.length,
  };
};

export const toTransitions = (transitions: readonly ReportTransitionFieldsFragment[]): Transition[] => {
  return transitions.map((t) => ({
    fromStatus: t.fromStatus,
    toStatus: t.toStatus,
    reason: untrusted(`transition:${t.id}:reason`, t.reason),
    createdAt: t.createdAt,
  }));
};

/**
 * Comments and status changes are returned a page at a time, newest first
 * (`historyOffset` skips the newest ones), each page in chronological order.
 * The API returns them all at once; the page bounds what reaches the model.
 */
export const HISTORY_LIMIT = 20;

export const historyInput = {
  historyOffset: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe('Skip this many of the newest comments and status changes, to page back through older ones.'),
  fullText: z
    .boolean()
    .default(false)
    .describe(
      `Return long text fields whole, not cut at ${DEFAULT_TEXT_LIMIT.toLocaleString('en-US')} characters.`,
    ),
};

export const HistoryPageSchema = z
  .object({
    commentsTotal: z.number().int(),
    transitionsTotal: z.number().int(),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe('`historyOffset` for older entries; null when none are left.'),
  })
  .describe(`Up to ${String(HISTORY_LIMIT)} of each, newest first, shown oldest first.`);

/** The newest `HISTORY_LIMIT` entries after skipping `offset` newest, in chronological order. */
export const historyPage = <T>(chronological: readonly T[], offset: number): T[] => {
  const end = Math.max(0, chronological.length - offset);
  return chronological.slice(Math.max(0, end - HISTORY_LIMIT), end);
};

export const historyMeta = (
  comments: number,
  transitions: number,
  offset: number,
): z.input<typeof HistoryPageSchema> => ({
  commentsTotal: comments,
  transitionsTotal: transitions,
  nextOffset: Math.max(comments, transitions) > offset + HISTORY_LIMIT ? offset + HISTORY_LIMIT : null,
});

/**
 * Researcher-side tools act on the caller's OWN reports. A token that also
 * holds triage:read reaches the caller's organisations' reports through the
 * same API fields, so the reporter is checked against the signed-in user.
 */
export const assertOwnReport = (reporterId: string, viewerId: string | undefined): void => {
  if (viewerId !== undefined && reporterId !== viewerId) {
    throw new BugSecureError(
      'NOT_FOUND',
      'That is not one of your own reports. For a report submitted to your organisation, use the organisation tools (get_org_report, add_triage_comment…).',
    );
  }
};

/**
 * Organisation-side tools act on reports submitted to the caller's
 * organisations. A token that also holds reports:read reaches the caller's own
 * reports through the same fields; members cannot report to their own
 * organisation's programmes, so "not filed by the caller" is exactly
 * "reached through the organisation".
 */
export const assertNotOwnReport = (reporterId: string, viewerId: string | undefined): void => {
  if (viewerId !== undefined && reporterId === viewerId) {
    throw new BugSecureError(
      'NOT_FOUND',
      'That is one of your own reports as a researcher, not a report submitted to your organisation. Use get_report, add_report_comment or raise_appeal for it.',
    );
  }
};

/**
 * Refuse when the token reaches both sides and the signed-in user is unknown
 * (so the two cannot be told apart). Never happens with a normal login, whose
 * token names its user.
 */
export const requireViewerWhenAmbiguous = (viewerId: string | undefined, otherSide: boolean): void => {
  if (viewerId === undefined && otherSide) {
    throw new BugSecureError(
      'UPSTREAM_ERROR',
      'Cannot tell which reports are your own: the access token does not name its user. Sign in again.',
    );
  }
};
