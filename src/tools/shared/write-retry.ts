/**
 * One resend for a write whose answer was lost.
 *
 * A write can reach the API, commit, and still end here as a failure: the
 * request timed out while the API worked, the connection dropped before the
 * response arrived, a proxy in front of the API answered 5xx after the API had
 * answered, or the API committed and then failed while answering (an internal
 * error). Reported as a plain failure, the model asks the user to approve the
 * same change again, and the new approval carries a NEW idempotency key: the
 * API would then write a second time.
 *
 * So the handler's client resends a mutation ONCE when it fails with
 * UPSTREAM_UNAVAILABLE (timeout, network error, unreadable or failed 5xx, or an
 * internal error the API reported), with the same variables, therefore the
 * same `clientRequestId`. The API reserves the key as the first statement of
 * the write's own transaction, so either it committed and answers the resend
 * with what it wrote (./request-id.ts), or it rolled back with the key and the
 * resend is the first attempt that counts. A key whose first request is still
 * running answers IDEMPOTENCY_KEY_IN_PROGRESS, which means "not done yet, ask
 * again shortly": that one resend waits and asks again (`IN_PROGRESS_DELAYS_MS`),
 * sending nothing new, since the API did not run it.
 *
 * Only a mutation carrying a `clientRequestId` is resent (every mutation this
 * server sends does, see ./define-tool.ts); a query is never resent here. When
 * the resend fails the same way, or the API rate limits it (its limiter runs
 * before it looks the key up, so the first request may well have committed),
 * the outcome is unknown, and the error says so: the change may have been
 * made, and must be checked with a read tool before the user is asked to
 * approve it again (a new approval is a new key). Any other definite answer
 * to the resend (a refusal) stands.
 */
import { BugSecureError } from '../../errors.js';
import type { GraphQLClient, RequestOptions, TypedDocument } from '../../graphql/client.js';
import type { Logger } from '../../logger.js';
import { CHECK_BEFORE_REAPPROVING } from './request-id.js';

/** How long the resend waits before asking again, each time the API says the first request still runs. */
export const IN_PROGRESS_DELAYS_MS: readonly number[] = [500, 1_500];

/** What to do when a write's outcome is unknown. */
export const OUTCOME_UNKNOWN_HINT =
  'The change may already have been made. Do not retry it, and do not ask the user to approve it again ' +
  `yet: ${CHECK_BEFORE_REAPPROVING}`;

export interface WriteRetryOptions {
  readonly logger: Logger;
  /** Waits between IN_PROGRESS answers (default `IN_PROGRESS_DELAYS_MS`); tests shorten them. */
  readonly inProgressDelaysMs?: readonly number[];
}

const isMutation = (query: string): boolean => /^\s*mutation\b/.test(query);

const hasRequestId = (variables: unknown): boolean => {
  return (
    typeof variables === 'object' &&
    variables !== null &&
    typeof (variables as { clientRequestId?: unknown }).clientRequestId === 'string'
  );
};

const isLost = (error: unknown): error is BugSecureError => {
  return error instanceof BugSecureError && error.code === 'UPSTREAM_UNAVAILABLE';
};

const wait = (ms: number, signal: AbortSignal | undefined): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/** The failure a write ends in when neither its request nor the resend confirmed it. */
const outcomeUnknown = (cause: unknown): BugSecureError => {
  return new BugSecureError(
    'UPSTREAM_UNAVAILABLE',
    'BugSecure did not confirm this change (the request was sent, then its answer was lost or was an ' +
      'error on BugSecure’s side, and one resend with the same idempotency key got no confirmation either).',
    { hint: OUTCOME_UNKNOWN_HINT, cause },
  );
};

/** `graphql`, with each write resent once, under the same key, when its answer was lost. */
export const resendingLostWrites = (graphql: GraphQLClient, options: WriteRetryOptions): GraphQLClient => {
  const delays = options.inProgressDelaysMs ?? IN_PROGRESS_DELAYS_MS;
  return {
    async request<TResult, TVariables>(
      document: TypedDocument<TResult, TVariables>,
      variables: TVariables,
      requestOptions: RequestOptions = {},
    ): Promise<TResult> {
      if (!isMutation(document.toString()) || !hasRequestId(variables)) {
        return graphql.request(document, variables, requestOptions);
      }
      const { signal } = requestOptions;
      try {
        return await graphql.request(document, variables, requestOptions);
      } catch (error) {
        if (!isLost(error) || signal?.aborted) throw error;
        options.logger.info('write answer lost; resending once with the same idempotency key');
      }
      // The one resend. IN_PROGRESS means the API holds the key for a request still
      // running and ran nothing for this one, so asking again after a pause stays
      // within that single resend.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await graphql.request(document, variables, requestOptions);
        } catch (error) {
          if (signal?.aborted) throw error;
          const code = error instanceof BugSecureError ? error.code : undefined;
          const inProgress = code === 'REQUEST_IN_PROGRESS';
          const delay = delays[attempt];
          if (inProgress && delay !== undefined) {
            await wait(delay, signal);
            continue;
          }
          // Still no answer, still running when we stopped asking, or rate limited before the
          // API looked the key up: unknown.
          if (isLost(error) || inProgress || code === 'RATE_LIMITED') throw outcomeUnknown(error);
          // A definite answer (a refusal) stands: the API decided this key's request.
          throw error;
        }
      }
    },
  };
};
