/**
 * Human approval for write tools, on the BugSecure website. Fail closed:
 * nothing is written unless BugSecure says the user approved exactly this
 * payload, and the API refuses the write itself without that approval.
 *
 * Why the approval is out of band, rather than a dialog in the MCP client:
 * tool arguments are written by a model that also reads attacker-controlled
 * report and comment text, so the user must read what will be sent. MCP
 * clients fold or truncate long dialogs; the BugSecure review page shows the
 * full payload with server-side context (the report's title, the programme,
 * the payout a grade would issue), signed in, and the API enforces the
 * decision: an OAuth token can register an approval and read its status, but
 * only a first-party session can decide it.
 *
 * Mechanism — Multi Round-Trip Requests (spec basic/patterns/mrtr) with a
 * URL-mode elicitation:
 *
 *   1. tools/call arrives without usable state. The tool's `payload` gives the
 *      exact mutation(s); this gate registers them with the API
 *      (`createAgentApproval`, under the tool's own write scope) and gets back
 *      an approval id and the review page's URL. It answers with an
 *      `InputRequiredResult` carrying one `elicitation/create` in URL mode
 *      (the URL, and a short message naming no argument value) plus a
 *      `requestState` sealed by the SDK's `createRequestStateCodec` (HMAC,
 *      bound to the authenticated principal, 15 minutes) holding the tool
 *      name, a digest of the arguments and payload, the approval id and its
 *      idempotency key.
 *   2. The client shows the URL and its host, asks consent, opens the browser.
 *      The user signs in, reads the payload, approves or declines (a grade
 *      needs a recent authentication). The client retries tools/call with the
 *      same arguments, the elicitation answer and the state echoed.
 *   3. The gate verifies the state (MAC, expiry, principal) and that it names
 *      THIS call (tool and digest), then polls `agentApproval(id)` until the
 *      user decided or the poll budget is spent (under the SDK's 60 s request
 *      timeout and the load balancer's idle timeout). APPROVED → the handler
 *      sends the write(s) with the approval's key; anything else → an error
 *      result saying what happened and what to do, nothing sent.
 *   4. The API runs a write from a connected app only with an APPROVED,
 *      unexpired, unused approval whose stored arguments hash to the actual
 *      ones, and uses it up in the same transaction. A replay (same key)
 *      gets the first result back (./shared/request-id.ts).
 *
 * Without usable state (none, tampered, expired, another principal, or a call
 * whose payload changed), the gate first asks the API for an approval of this
 * exact payload (`myAgentApprovals(clientDigest)`): one the user already
 * approved on the website is used, a pending one is shown again, and only
 * otherwise is a new one created. That is also how a client that cannot open
 * URLs writes: the first call creates the approval and tells the model to send
 * the user to BugSecure → Settings → Agent approvals; a plain second call,
 * once the user approved there, finds it and writes.
 *
 * The review URL is shown only when it is on the configured web origin and
 * is exactly the review page of this approval (./approval-url.ts); no URL is
 * ever relayed to the model, only to the client's URL-mode elicitation.
 */
import {
  type CallToolResult,
  type ClientCapabilities,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';

import { canonicalJson, randomToken, sha256Base64Url } from '../crypto.js';
import type { GraphQLClient } from '../graphql/client.js';
import {
  type AgentApprovalRefFragment,
  type AgentApprovalStatus,
  CreateAgentApprovalDocument,
  GetAgentApprovalDocument,
  ListMyAgentApprovalsDocument,
} from '../graphql/generated.js';
import type { Logger } from '../logger.js';
import { validateReviewUrl, webOrigin } from './approval-url.js';
import type { Parts, WritePayload } from './define-tool.js';
import { CHECK_BEFORE_REAPPROVING } from './shared/request-id.js';
import { resendingLostWrites } from './shared/write-retry.js';

/** Key of our single entry in `inputRequests` / `inputResponses`. */
export const APPROVAL_INPUT_KEY = 'approval';
/** How long an approval, and the state that names it, stay usable (the API's own window). */
export const APPROVAL_TTL_SECONDS = 900;
/** How often the user's decision is asked for while a call waits. */
export const POLL_INTERVAL_MS = 2_000;
/**
 * How long one call waits for the decision: under the SDK client's 60 s
 * request timeout and a load balancer's idle timeout, with room for the
 * write itself.
 */
export const POLL_BUDGET_MS = 45_000;

interface ApprovalState {
  /** Tool name. */
  readonly t: string;
  /** Digest of the tool and arguments alone (see `argsDigest`): names the call before its payload is built. */
  readonly a: string;
  /** Digest of the arguments and the payload (see `payloadDigest`). */
  readonly d: string;
  /** The approval's id. */
  readonly i: string;
  /** The approval's idempotency key: the key of the write(s) it approves. */
  readonly c: string;
}

export interface ApprovalGateOptions {
  /** HMAC key for `requestState`, ≥ 32 bytes. Must be shared by every instance serving a principal. */
  readonly key: Uint8Array;
  /** The authenticated user and client; approvals never transfer between principals. */
  readonly principal: string;
  readonly logger: Logger;
  /** The BugSecure web origin review URLs must be on; `undefined` → the menu-path fallback. */
  readonly webUrl: string | undefined;
  readonly pollIntervalMs?: number;
  readonly pollBudgetMs?: number;
  /** The API client's timeout: what one write attempt may take after polling stops. */
  readonly writeTimeoutMs?: number;
  /** Time kept after a write attempt for the answer (default `POLL_ANSWER_MARGIN_MS`); tests shorten it. */
  readonly answerMarginMs?: number;
}

/** What the framework knows about the current tools/call round. */
export interface ApprovalCall {
  readonly toolName: string;
  /** Arguments after input validation (defaults applied). */
  readonly args: Record<string, unknown>;
  readonly ctx: ServerContext;
  readonly clientCapabilities: ClientCapabilities | undefined;
  /** The session's client, for the approval operations (sent under the tool's write scope). */
  readonly graphql: GraphQLClient;
  readonly signal: AbortSignal;
  /**
   * When the MCP client gives up on THIS call (absolute, ms): the request's
   * start plus the shortest deadline it runs under, so time already spent
   * (authentication, a cold token exchange) counts. Polling stops early enough
   * for one write and the answer to fit before it.
   */
  readonly deadlineAt: number;
}

export type ApprovalOutcome =
  /** `clientRequestId`: the approval's key, the idempotency key of the write(s) it approved; `payload`: what it approved. */
  | { readonly kind: 'approved'; readonly clientRequestId: string; readonly payload: WritePayload }
  | { readonly kind: 'respond'; readonly result: CallToolResult | InputRequiredResult };

/** Time kept, after the write's own timeout, for the answer to be built and sent. */
export const POLL_ANSWER_MARGIN_MS = 2_000;
/** The MCP SDK client's default request timeout: what a stdio server must assume its client allows a call. */
export const CLIENT_REQUEST_DEADLINE_MS = 60_000;

/**
 * The poll budget a transport can afford under a request deadline: the
 * configured budget, capped so that one write attempt (`writeTimeoutMs`, the
 * API client's timeout) and the answer still fit before the deadline, and
 * never under a second. The one resend of a write whose answer was lost is
 * not reserved for: it is the exception, and the key makes it safe to be
 * answered late, as for any write.
 */
export const pollBudgetWithin = (deadlineMs: number, budgetMs: number, writeTimeoutMs: number): number =>
  Math.max(1_000, Math.min(budgetMs, deadlineMs - writeReserve(writeTimeoutMs) - POLL_ANSWER_MARGIN_MS));

/**
 * The most of a call that is kept for the write attempt after polling: an
 * API timeout configured for slow reads (up to 120 s) must not eat the whole
 * 60 s call, which would leave no time to wait for the user's decision. A
 * write that does start is bounded to what is left of the call anyway
 * (`writeAttempt`), so a longer timeout never outlives the call.
 */
export const MAX_WRITE_RESERVE_MS = 20_000;

/** The time kept for one write attempt under a deadline: the API timeout, capped. */
export const writeReserve = (writeTimeoutMs: number): number =>
  Math.min(writeTimeoutMs, MAX_WRITE_RESERVE_MS);

/**
 * The poll budget a transport can afford under EVERY deadline a call must
 * respect: the MCP client's (`CLIENT_REQUEST_DEADLINE_MS`, always, since the
 * client gives up on the call whatever the server allows itself) and, hosted,
 * the Node adapter's own. The shortest one bounds the wait.
 */
export const pollBudgetFor = (
  budgetMs: number,
  writeTimeoutMs: number,
  ...serverDeadlinesMs: number[]
): number =>
  pollBudgetWithin(Math.min(CLIENT_REQUEST_DEADLINE_MS, ...serverDeadlinesMs), budgetMs, writeTimeoutMs);

/** The API client's default timeout (src/config.ts), when a gate is built without one. */
export const DEFAULT_WRITE_TIMEOUT_MS = 20_000;

/**
 * When polling must stop in this call: the configured budget from now, or
 * earlier when the call's own deadline leaves less than one write attempt
 * and the answer after it (`writeTimeoutMs` + `POLL_ANSWER_MARGIN_MS`).
 */
export const pollDeadline = (
  now: number,
  budgetMs: number,
  callDeadlineAt: number,
  writeTimeoutMs: number,
  answerMarginMs: number = POLL_ANSWER_MARGIN_MS,
): number => Math.min(now + budgetMs, callDeadlineAt - writeReserve(writeTimeoutMs) - answerMarginMs);

/** The least a write attempt is given when the call's deadline is near; under this it is not started. */
export const MIN_WRITE_ATTEMPT_MS = 1_000;

/**
 * How long a write attempt started `now` may take and still answer before the
 * call's deadline: the API client's timeout, capped to what is left; `null`
 * when less than `minAttemptMs` is left, so the write is not started.
 */
export const writeAttempt = (
  now: number,
  callDeadlineAt: number,
  writeTimeoutMs: number,
  answerMarginMs: number = POLL_ANSWER_MARGIN_MS,
  minAttemptMs: number = MIN_WRITE_ATTEMPT_MS,
): number | null => {
  const window = Math.min(writeTimeoutMs, callDeadlineAt - answerMarginMs - now);
  return window >= minAttemptMs ? window : null;
};

/** Thrown inside the gate when a status read outlives the poll budget: the call answers "awaiting". */
class PollBudgetSpent extends Error {
  constructor() {
    super('the poll budget is spent');
  }
}

/** Whether the client declared URL-mode elicitation (a bare `{}` means form mode only, spec § Capabilities). */
export const supportsUrlElicitation = (capabilities: ClientCapabilities | undefined): boolean => {
  const elicitation: unknown = capabilities?.elicitation;
  if (typeof elicitation !== 'object' || elicitation === null) return false;
  return (elicitation as { url?: unknown }).url !== undefined;
};

/** The tool and its validated arguments: what names a call before its payload exists. */
export const argsDigest = (toolName: string, args: Record<string, unknown>): string => {
  return sha256Base64Url(canonicalJson({ t: toolName, a: args }));
};

/**
 * What binds the approval to this call: the tool, its validated arguments and
 * the exact payload (operations and variables). Sent to the API as the
 * approval's `clientDigest` (opaque to it: found again by equality only) and
 * sealed in the request state, so a retry with other arguments, or a payload
 * that changed between rounds, starts over instead of writing.
 */
export const payloadDigest = (toolName: string, args: Record<string, unknown>, parts: Parts): string => {
  return sha256Base64Url(
    canonicalJson({
      t: toolName,
      a: args,
      p: parts.map((part) => ({ operation: part.operation, variables: part.variables })),
    }),
  );
};

/** The message shown next to the review URL: what, where, and that nothing is sent until approved. */
export const approvalMessage = (action: string, webHost: string): string => {
  return (
    `bugsecure-mcp wants to ${action} on BugSecure, as you. Review and approve it on ${webHost}, the page ` +
    'this opens. Nothing is sent until you approve it there; the request expires in 15 minutes.'
  );
};

/** The menu path a user takes when the client cannot open the review page. Never a URL. */
export const SETTINGS_PATH = 'BugSecure → Settings → Agent approvals';

export const FALLBACK_MESSAGE =
  'Nothing was sent yet. This change needs the user’s approval on BugSecure, and this MCP client cannot ' +
  `open the review page. Ask the user to open ${SETTINGS_PATH}, read the change and approve or decline it ` +
  'there; it expires 15 minutes after it was requested. Call this tool again, with the same arguments, only ' +
  'when the user says they decided; never retry on your own.';

export const AWAITING_MESSAGE =
  'Nothing was sent yet: BugSecure is still awaiting the user’s decision on the review page. Ask the user ' +
  'whether they approved it, and call this tool again, with the same arguments, only when they say they ' +
  'did; never retry on your own.';

export const NOT_OPENED_MESSAGE =
  'Nothing was sent: the user did not open the BugSecure review page (they declined or dismissed it). ' +
  'Do not retry unless the user asks you to.';

export const DECLINED_MESSAGE =
  'Nothing was sent: the user declined this change on BugSecure. Do not retry unless the user asks you to.';

export const EXPIRED_MESSAGE =
  'Nothing was sent: the request to approve this change expired on BugSecure (15 minutes) before the user ' +
  'decided. If the user still wants it, call this tool again to create a new one.';

export const CONSUMED_MESSAGE =
  'This approval was already used: the change it approved was sent then, and this call sent nothing. ' +
  `Do not retry it, and do not ask the user to approve it again yet: ${CHECK_BEFORE_REAPPROVING}`;

export const MISMATCH_MESSAGE =
  'Nothing was sent: the approval BugSecure holds does not match this request. If the user still wants ' +
  'the change, call this tool again.';

export const UNKNOWN_STATUS_MESSAGE =
  'Nothing was sent: BugSecure reported a decision state this version of bugsecure-mcp does not know. ' +
  'Ask the user to check the approval under BugSecure → Settings → Agent approvals, and to update bugsecure-mcp.';

const refusal = (text: string): ApprovalOutcome => {
  return { kind: 'respond', result: { content: [{ type: 'text', text }], isError: true } };
};

const wait = (ms: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const STATUSES_TO_REUSE: readonly AgentApprovalStatus[] = ['PENDING', 'APPROVED'];

/** The status to act on: what the API says, except that a lapsed `expiresAt` is EXPIRED whatever it says. */
const effectiveStatus = (approval: AgentApprovalRefFragment, now: number): AgentApprovalStatus => {
  const expiresAt = Date.parse(approval.expiresAt);
  if (approval.status === 'PENDING' || approval.status === 'APPROVED') {
    if (Number.isNaN(expiresAt) || expiresAt <= now) return 'EXPIRED';
  }
  return approval.status;
};

export class ApprovalGate {
  readonly #options: ApprovalGateOptions;
  readonly #codec: RequestStateCodec<ApprovalState>;
  readonly #pollIntervalMs: number;
  readonly #pollBudgetMs: number;
  readonly #writeTimeoutMs: number;
  readonly #answerMarginMs: number;

  constructor(options: ApprovalGateOptions) {
    this.#options = options;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#pollBudgetMs = options.pollBudgetMs ?? POLL_BUDGET_MS;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#answerMarginMs = options.answerMarginMs ?? POLL_ANSWER_MARGIN_MS;
    this.#codec = createRequestStateCodec<ApprovalState>({
      key: options.key,
      ttlSeconds: APPROVAL_TTL_SECONDS,
      // Bound to the authenticated principal (spec: elicitation § Security 1,
      // mrtr § Server Requirements 5). The codec stores only an HMAC tag of it.
      bind: () => options.principal,
    });
  }

  /**
   * `buildPayload` is called at most once, and only when the payload is
   * needed: a retry whose approval was already used, declined or expired is
   * answered from the approval's status alone, before the tool's own checks
   * run, because the write that approval covered may since have moved what
   * those checks read (a draft revision the write itself bumped).
   */
  async check(call: ApprovalCall, buildPayload: () => Promise<WritePayload>): Promise<ApprovalOutcome> {
    const logger = this.#options.logger;
    const state = await this.#verify(call.ctx);
    const named = state?.t === call.toolName && state.a === argsDigest(call.toolName, call.args);
    if (state !== undefined && !named) {
      // The retry does not carry the call that was approved: start over for this one.
      logger.warn('approval state does not match the retried call; starting over');
    }

    if (state !== undefined && named) {
      const answer = inputResponse(call.ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);
      if (answer.kind === 'elicit' && answer.action !== 'accept') {
        logger.info('review page not opened by the user', { approvalId: state.i, action: answer.action });
        return refusal(NOT_OPENED_MESSAGE);
      }
      const deadline = pollDeadline(
        Date.now(),
        this.#pollBudgetMs,
        call.deadlineAt,
        this.#writeTimeoutMs,
        this.#answerMarginMs,
      );
      let first: AgentApprovalRefFragment;
      try {
        first = await this.#read(call, state.i, deadline);
      } catch (error) {
        if (error instanceof PollBudgetSpent) return refusal(AWAITING_MESSAGE);
        throw error;
      }
      const status = effectiveStatus(first, Date.now());
      if (status !== 'PENDING' && status !== 'APPROVED') return this.#settled(state, first, status);
      const payload = await buildPayload();
      const digest = payloadDigest(call.toolName, call.args, payload.parts);
      if (state.d === digest) return this.#awaitDecision(call, state, payload, first, deadline);
      logger.warn('the payload changed since the user was asked; starting over');
      return this.#fresh(call, payload, digest);
    }

    const payload = await buildPayload();
    return this.#fresh(call, payload, payloadDigest(call.toolName, call.args, payload.parts));
  }

  /** No usable state: an approval of this exact payload may still exist (approved on the website by a client that cannot open the page, or pending), else create one. */
  async #fresh(call: ApprovalCall, payload: WritePayload, digest: string): Promise<ApprovalOutcome> {
    const existing = await this.#find(call, digest);
    if (existing.kind === 'approved')
      return { kind: 'approved', clientRequestId: existing.clientRequestId, payload };
    const approval =
      existing.kind === 'pending' ? existing.approval : await this.#create(call, payload, digest);
    return this.#ask(call, payload, digest, approval);
  }

  /** One status read, bounded by the caller's signal and by what is left of the poll budget. */
  async #read(call: ApprovalCall, approvalId: string, deadline: number): Promise<AgentApprovalRefFragment> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PollBudgetSpent();
    const budget = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([call.signal, budget]);
    try {
      const { agentApproval } = await call.graphql.request(
        GetAgentApprovalDocument,
        { id: approvalId },
        { signal },
      );
      return agentApproval;
    } catch (error) {
      if (!call.signal.aborted && budget.aborted) throw new PollBudgetSpent();
      throw error;
    }
  }

  /** The answer for a decision other than "still pending", once the approval is known to name this call. */
  #settled(
    state: ApprovalState,
    approval: AgentApprovalRefFragment,
    status: Exclude<AgentApprovalStatus, 'PENDING'>,
    payload?: WritePayload,
  ): ApprovalOutcome {
    const logger = this.#options.logger;
    logger.info('approval decided', { approvalId: state.i, status });
    switch (status) {
      case 'APPROVED':
        if (approval.clientRequestId !== state.c) {
          logger.warn('approved approval carries another key than the state; refused', {
            approvalId: state.i,
          });
          return refusal(MISMATCH_MESSAGE);
        }
        if (payload === undefined) throw new Error('an approved write needs its payload');
        return { kind: 'approved', clientRequestId: state.c, payload };
      case 'CONSUMED':
        return refusal(CONSUMED_MESSAGE);
      case 'DECLINED':
        return refusal(DECLINED_MESSAGE);
      case 'EXPIRED':
        return refusal(EXPIRED_MESSAGE);
      default: {
        // A status a later API may add: nothing is sent, and the model is told so, rather than
        // the generic failure a fall-through would end in.
        logger.warn('approval has a status this version does not know; nothing sent', {
          approvalId: state.i,
        });
        return refusal(UNKNOWN_STATUS_MESSAGE);
      }
    }
  }

  /**
   * Poll the approval the verified state names until the user decided, or the
   * budget is spent. Every read is bounded by what is left of the budget, and
   * an approval that arrives after it is not acted on: the client has given
   * up on this call by then, and a write it never hears about is worse than
   * asking it to call again.
   */
  async #awaitDecision(
    call: ApprovalCall,
    state: ApprovalState,
    payload: WritePayload,
    first: AgentApprovalRefFragment,
    deadline: number,
  ): Promise<ApprovalOutcome> {
    const logger = this.#options.logger;
    let approval = first;
    let polls = 1;
    for (;;) {
      const status = effectiveStatus(approval, Date.now());
      if (status === 'PENDING') {
        if (Date.now() + this.#pollIntervalMs > deadline) {
          logger.info('approval still pending; budget spent', { approvalId: state.i, polls });
          return refusal(AWAITING_MESSAGE);
        }
        await wait(this.#pollIntervalMs, call.signal);
        try {
          approval = await this.#read(call, state.i, deadline);
        } catch (error) {
          if (error instanceof PollBudgetSpent) {
            logger.info('approval still pending; budget spent', { approvalId: state.i, polls });
            return refusal(AWAITING_MESSAGE);
          }
          throw error;
        }
        polls += 1;
        continue;
      }
      if (status === 'APPROVED' && Date.now() > deadline) {
        logger.info('approval arrived after the budget; not acted on', { approvalId: state.i, polls });
        return refusal(AWAITING_MESSAGE);
      }
      return this.#settled(state, approval, status, payload);
    }
  }

  /** An approval of this exact payload the API already holds: approved (use it), pending (show it again), or none. */
  async #find(
    call: ApprovalCall,
    digest: string,
  ): Promise<
    | { readonly kind: 'approved'; readonly clientRequestId: string }
    | { readonly kind: 'pending'; readonly approval: AgentApprovalRefFragment }
    | { readonly kind: 'none' }
  > {
    const { myAgentApprovals } = await call.graphql.request(
      ListMyAgentApprovalsDocument,
      { clientDigest: digest, statuses: [...STATUSES_TO_REUSE] },
      { signal: call.signal },
    );
    const now = Date.now();
    const live = myAgentApprovals.filter((a) => effectiveStatus(a, now) === a.status);
    const approved = live.find((a) => a.status === 'APPROVED');
    if (approved !== undefined) {
      this.#options.logger.info('write approved on BugSecure beforehand', { approvalId: approved.id });
      return { kind: 'approved', clientRequestId: approved.clientRequestId };
    }
    const pending = live.find((a) => a.status === 'PENDING');
    if (pending !== undefined) {
      this.#options.logger.info('approval still pending; asking again', { approvalId: pending.id });
      return { kind: 'pending', approval: pending };
    }
    return { kind: 'none' };
  }

  /** Register the payload with the API. Its key becomes the key of the write(s) it approves. */
  async #create(
    call: ApprovalCall,
    payload: WritePayload,
    digest: string,
  ): Promise<AgentApprovalRefFragment> {
    const logger = this.#options.logger;
    // A registration whose answer was lost is resent once under the same key: the API answers
    // a duplicate key with the same approval (./shared/write-retry.ts).
    const { createAgentApproval } = await resendingLostWrites(call.graphql, { logger }).request(
      CreateAgentApprovalDocument,
      {
        input: {
          parts: payload.parts.map((part) => ({ operation: part.operation, arguments: part.variables })),
          clientDigest: digest,
        },
        clientRequestId: randomToken(16),
      },
      { signal: call.signal },
    );
    logger.info('approval created', { approvalId: createAgentApproval.id, parts: payload.parts.length });
    return createAgentApproval;
  }

  /** Send the user to the review page (URL-mode elicitation), or to the menu when that is not possible. */
  async #ask(
    call: ApprovalCall,
    payload: WritePayload,
    digest: string,
    approval: AgentApprovalRefFragment,
  ): Promise<ApprovalOutcome> {
    const logger = this.#options.logger;
    const { webUrl } = this.#options;
    if (!supportsUrlElicitation(call.clientCapabilities)) {
      logger.info('client cannot open the review page; sending the user to the menu', {
        approvalId: approval.id,
      });
      return refusal(FALLBACK_MESSAGE);
    }
    const origin = webUrl === undefined ? undefined : webOrigin(webUrl);
    const url = validateReviewUrl(approval.reviewUrl, approval.id, webUrl);
    if (origin === undefined || url === undefined) {
      logger.warn(
        webUrl === undefined
          ? 'no web origin configured (BUGSECURE_WEB_URL); sending the user to the menu'
          : 'review URL is not this approval’s page on the configured web origin; sending the user to the menu',
        { approvalId: approval.id },
      );
      return refusal(FALLBACK_MESSAGE);
    }
    const requestState = await this.#codec.mint(
      {
        t: call.toolName,
        a: argsDigest(call.toolName, call.args),
        d: digest,
        i: approval.id,
        c: approval.clientRequestId,
      },
      call.ctx,
    );
    logger.info('asking the user to review on BugSecure', { approvalId: approval.id });
    return {
      kind: 'respond',
      result: inputRequired({
        inputRequests: {
          [APPROVAL_INPUT_KEY]: inputRequired.elicitUrl({
            url,
            message: approvalMessage(payload.action, origin.host),
          }),
        },
        requestState,
      }),
    };
  }

  /** The verified state of this round, or undefined (absent, tampered, expired, other principal). */
  async #verify(ctx: ServerContext): Promise<ApprovalState | undefined> {
    const raw = ctx.mcpReq.requestState();
    if (typeof raw !== 'string') return undefined;
    try {
      return await this.#codec.verify(raw, ctx);
    } catch {
      this.#options.logger.info('approval state did not verify; starting over');
      return undefined;
    }
  }
}
