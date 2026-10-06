/**
 * An in-memory GraphQLClient for tool tests: route by operation name, record
 * every call. Handlers return the `data` object or throw (e.g. a BugSecureError).
 */
import { expect } from 'vitest';

import { BugSecureError } from '../../src/errors.js';
import type { GraphQLClient, TypedDocument } from '../../src/graphql/client.js';
import type { AgentApprovalStatus } from '../../src/graphql/generated.js';
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
      options: { signal?: AbortSignal; answerBy?: number } = {},
    ): Promise<TResult> {
      const operation = operationNameOf(document);
      const vars = variables as Record<string, unknown>;
      calls.push({ operation, variables: vars });
      const handler = Object.hasOwn(handlers, operation) ? handlers[operation] : undefined;
      if (!handler) return Promise.reject(new Error(`fakeGraphQL: no handler for ${operation}`));
      let answer: Promise<TResult>;
      try {
        answer = Promise.resolve(handler(vars) as TResult);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // Like the real client: a cancelled request is given up on with the caller's reason, and one
      // not answered by `answerBy` is a timeout (typed UPSTREAM_UNAVAILABLE, so a write is resent).
      const { signal, answerBy } = options;
      if (signal === undefined && answerBy === undefined) return answer;
      return new Promise<TResult>((resolve, reject) => {
        const abort = (): void => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason)));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        const timer =
          answerBy === undefined
            ? undefined
            : setTimeout(
                () => {
                  reject(new BugSecureError('UPSTREAM_UNAVAILABLE', 'The BugSecure API timed out.'));
                },
                Math.max(0, answerBy - Date.now()),
              );
        answer.then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', abort);
          if (timer !== undefined) clearTimeout(timer);
        });
      });
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

/** The framework's approval operations (src/tools/approval.ts), sent by every write tool. */
export const APPROVAL_OPERATIONS: ReadonlySet<string> = new Set([
  'CreateAgentApproval',
  'GetAgentApproval',
  'ListMyAgentApprovals',
]);

/** Operations the write tools send before writing: safety checks and the approval framework's. */
export const LOOKUP_OPERATIONS: ReadonlySet<string> = new Set([
  'GetViewerRoles',
  'GetReportRef',
  'GetAppealTarget',
  'GetReportDisclosure',
  ...APPROVAL_OPERATIONS,
]);

/** The calls that are not lookups (i.e. the write itself, or the tool's own read). */
export const withoutLookups = (calls: readonly RecordedCall[]): RecordedCall[] =>
  calls.filter((c) => !LOOKUP_OPERATIONS.has(c.operation));

/**
 * Default answers to the safety lookups, for a signed-in organisation member
 * (`triager-1`, not staff) looking at report `r1` filed by `researcher-1`.
 * Spread into `fakeGraphQL({...lookups(), ...})` and override what a test needs.
 */
export const lookups = (
  overrides: { roles?: readonly string[]; reporterId?: string; adjudicationId?: string } = {},
): Record<string, OperationHandler> => ({
  GetViewerRoles: () => ({ me: { id: 'triager-1', roles: overrides.roles ?? ['COMPANY_ADMIN'] } }),
  GetReportRef: (v) => ({
    report: { id: v.id, reporter: { id: overrides.reporterId ?? 'researcher-1' } },
  }),
  GetAppealTarget: (v) => ({
    report: { id: v.reportId, reporter: { id: overrides.reporterId ?? 'researcher-1' } },
    reportAdjudication: { id: overrides.adjudicationId ?? 'a1' },
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
});

/** The web origin the fake API's review URLs are on (the harness configures the gate with it). */
export const FAKE_WEB_URL = 'https://bugsecure.test';

/**
 * How the fake user decides, as seen from the API:
 * - `approve`: approved as soon as it is read back (the first poll, or the next call's lookup);
 * - `decline`, `expire`, `consumed`: that status as soon as it is read back;
 * - `pending`: never decided;
 * - `{ approveAfter: n }`: PENDING for the first `n` polls of `GetAgentApproval`, then APPROVED.
 */
export type ApprovalMode =
  'approve' | 'decline' | 'expire' | 'consumed' | 'pending' | { readonly approveAfter: number };

export interface RegisteredPart {
  readonly operation: string;
  readonly arguments: unknown;
}

export interface RegisteredApproval {
  readonly id: string;
  readonly clientRequestId: string;
  readonly clientDigest: string;
  readonly parts: readonly RegisteredPart[];
  status: AgentApprovalStatus;
  expiresAt: string;
  /** How many times `GetAgentApproval` was asked about it. */
  polls: number;
}

export interface FakeAgentApprovals {
  /** Handlers for the three framework operations; spread them into `fakeGraphQL({...})`. */
  readonly handlers: Record<string, OperationHandler>;
  /** Every approval `CreateAgentApproval` registered, in order. */
  readonly created: RegisteredApproval[];
  /** Change what the API will report for an approval from now on. */
  decide(id: string, status: AgentApprovalStatus): void;
}

export interface FakeAgentApprovalsOptions {
  /** The review URL the API returns for an id (default: the real shape on `FAKE_WEB_URL`). */
  readonly reviewUrl?: (id: string) => string;
  /** The ids to issue (default: `apr-1`, `apr-2`… padded to the real id shape). */
  readonly ids?: () => string;
}

/**
 * The API's agent-approval state machine, as the gate sees it: registration
 * is idempotent on its key, reading an approval back reflects the fake user's
 * decision (`mode`), and the digest lookup finds what was registered.
 */
export const fakeAgentApprovals = (
  mode: ApprovalMode = 'approve',
  options: FakeAgentApprovalsOptions = {},
): FakeAgentApprovals => {
  const created: RegisteredApproval[] = [];
  const byKey = new Map<string, RegisteredApproval>();
  const decided = new Map<string, AgentApprovalStatus>();
  let serial = 0;
  const nextId = options.ids ?? ((): string => `apr-${String((serial += 1)).padStart(16, '0')}`);
  const reviewUrl = options.reviewUrl ?? ((id: string): string => `${FAKE_WEB_URL}/agent-approvals/${id}`);

  const decide = (approval: RegisteredApproval, polled: boolean): void => {
    const forced = decided.get(approval.id);
    if (forced !== undefined) {
      approval.status = forced;
      return;
    }
    if (polled) approval.polls += 1;
    if (mode === 'pending') return;
    if (typeof mode === 'object') {
      if (approval.polls > mode.approveAfter) approval.status = 'APPROVED';
      return;
    }
    approval.status =
      mode === 'approve'
        ? 'APPROVED'
        : mode === 'decline'
          ? 'DECLINED'
          : mode === 'expire'
            ? 'EXPIRED'
            : 'CONSUMED';
  };

  const view = (approval: RegisteredApproval): Record<string, unknown> => ({
    id: approval.id,
    status: approval.status,
    reviewUrl: reviewUrl(approval.id),
    expiresAt: approval.expiresAt,
    clientRequestId: approval.clientRequestId,
  });

  return {
    created,
    decide: (id, status) => {
      decided.set(id, status);
    },
    handlers: {
      CreateAgentApproval: (v) => {
        const key = String(v.clientRequestId);
        const input = v.input as { parts: RegisteredPart[]; clientDigest: string };
        let approval = byKey.get(key);
        if (approval === undefined) {
          approval = {
            id: nextId(),
            clientRequestId: key,
            clientDigest: input.clientDigest,
            parts: input.parts.map((p) => ({ operation: p.operation, arguments: p.arguments })),
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            polls: 0,
          };
          byKey.set(key, approval);
          created.push(approval);
        }
        return { createAgentApproval: view(approval) };
      },
      GetAgentApproval: (v) => {
        const approval = created.find((a) => a.id === v.id);
        if (approval === undefined)
          throw new BugSecureError(
            'NOT_FOUND',
            'BugSecure no longer has the approval this change was waiting for.',
          );
        decide(approval, true);
        return { agentApproval: view(approval) };
      },
      ListMyAgentApprovals: (v) => {
        const statuses = v.statuses as AgentApprovalStatus[];
        const matching = created.filter((a) => a.clientDigest === v.clientDigest);
        for (const approval of matching) decide(approval, false);
        return { myAgentApprovals: matching.filter((a) => statuses.includes(a.status)).map(view) };
      },
    },
  };
};
