/**
 * An in-memory GraphQLClient for tool tests: route by operation name, record
 * every call. Handlers return the `data` object or throw (e.g. a BugSecureError).
 */
import { expect } from 'vitest';

import { BugSecureError } from '../../src/errors.js';
import type { GraphQLClient, TypedDocument } from '../../src/graphql/client.js';
import { CLIENT_REQUEST_ID } from '../../src/tools/shared/request-id.js';

/** Matches the idempotency key every write sends (`clientRequestId`). */
export const REQUEST_ID: unknown = expect.stringMatching(CLIENT_REQUEST_ID);

export type OperationHandler = (variables: Record<string, unknown>) => unknown;

export interface RecordedCall {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
}

export interface FakeGraphQL extends GraphQLClient {
  readonly calls: RecordedCall[];
}

export const operationNameOf = (document: { toString(): string }): string => {
  const name = /\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(document.toString())?.[1];
  if (name === undefined) throw new Error('document has no operation name');
  return name;
};

export const fakeGraphQL = (handlers: Record<string, OperationHandler>): FakeGraphQL => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    request<TResult, TVariables>(
      document: TypedDocument<TResult, TVariables>,
      variables: TVariables,
    ): Promise<TResult> {
      const operation = operationNameOf(document);
      const vars = variables as Record<string, unknown>;
      calls.push({ operation, variables: vars });
      const handler = handlers[operation];
      if (!handler) return Promise.reject(new Error(`fakeGraphQL: no handler for ${operation}`));
      try {
        return Promise.resolve(handler(vars) as TResult);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};

export interface IdempotentWrite extends OperationHandler {
  /** How many times the write itself ran (a replayed key does not run it). */
  readonly writes: () => number;
}

/** How a lost answer fails by default: as a timeout or a dropped connection does. */
const timedOut = (): never => {
  throw new BugSecureError('UPSTREAM_UNAVAILABLE', 'The BugSecure API timed out.');
};

/**
 * A mutation handler that behaves like the API's key store: the first request
 * with a `clientRequestId` runs `write` and commits, a repeat of that key gets
 * the recorded result. The first `drop` answers are lost AFTER the commit,
 * thrown by `lose` (default: UPSTREAM_UNAVAILABLE as a timeout is; pass the
 * mapped INTERNAL_SERVER_ERROR for "committed, then failed while answering").
 */
export const idempotentWrite = (
  write: (variables: Record<string, unknown>) => unknown,
  { drop = 0, lose = timedOut }: { drop?: number; lose?: () => never } = {},
): IdempotentWrite => {
  const recorded = new Map<string, unknown>();
  let runs = 0;
  let dropped = 0;
  const handler = (variables: Record<string, unknown>): unknown => {
    const key = String(variables.clientRequestId);
    if (!recorded.has(key)) {
      runs += 1;
      recorded.set(key, write(variables));
    }
    if (dropped < drop) {
      dropped += 1;
      lose();
    }
    return recorded.get(key);
  };
  return Object.assign(handler, { writes: () => runs });
};

/** Operations the write tools send before writing: safety checks and approval-prompt lookups. */
export const LOOKUP_OPERATIONS: ReadonlySet<string> = new Set([
  'GetViewerRoles',
  'GetReportRef',
  'GetProgramRef',
  'GetAppealTarget',
  'GetUnreadNotifications',
  'GetMyProfileRef',
  'GetReportDisclosure',
]);

/** The calls that are not lookups (i.e. the write itself, or the tool's own read). */
export const withoutLookups = (calls: readonly RecordedCall[]): RecordedCall[] =>
  calls.filter((c) => !LOOKUP_OPERATIONS.has(c.operation));

/**
 * Default answers to the lookups, for a signed-in organisation member
 * (`triager-1`, not staff) looking at report `r1` filed by `researcher-1`.
 * Spread into `fakeGraphQL({...lookups(), ...})` and override what a test needs.
 */
export const lookups = (
  overrides: { roles?: readonly string[]; reporterId?: string } = {},
): Record<string, OperationHandler> => ({
  GetViewerRoles: () => ({ me: { id: 'triager-1', roles: overrides.roles ?? ['COMPANY_ADMIN'] } }),
  GetReportRef: (v) => ({
    report: {
      id: v.id,
      title: 'Stored XSS in profile',
      status: 'IN_TRIAGE',
      program: { id: 'p1', title: 'Acme web' },
      reporter: { id: overrides.reporterId ?? 'researcher-1', username: 'ada' },
      assignedTriage: null,
    },
  }),
  GetUnreadNotifications: () => ({
    notifications: [{ id: 'n1', title: 'Your report was graded' }],
    unreadNotificationCount: 4,
  }),
  GetMyProfileRef: () => ({
    me: { id: overrides.reporterId ?? 'researcher-1', roles: overrides.roles ?? ['RESEARCHER'] },
    myProfile: { bio: 'Old bio', website: '', country: 'Kenya' },
  }),
  GetReportDisclosure: () => ({
    reportDisclosureDraft: {
      side: 'researcher',
      draft: {
        revision: 3,
        title: 'Old public title',
        summary: 'Old summary.',
        writeup: 'Old write-up.',
        creditResearcher: false,
        severity: 'HIGH',
        certifiedReward: 500_000,
        researcherApproved: false,
        organizationApproved: true,
        publishedAt: null,
        isPublic: false,
      },
    },
  }),
  GetProgramRef: (v) => ({ program: { id: v.id, title: 'Acme web', organization: { name: 'Acme' } } }),
  GetAppealTarget: (v) => ({
    report: {
      id: v.reportId,
      title: 'Stored XSS in profile',
      reporter: { id: overrides.reporterId ?? 'researcher-1' },
    },
    reportAdjudication: {
      id: 'a1',
      severity: 'MEDIUM',
      amount: 150_000,
      currency: 'KES',
      side: 'ORGANIZATION',
    },
  }),
});
