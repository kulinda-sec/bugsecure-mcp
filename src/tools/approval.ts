/**
 * Human approval for write tools, via MCP elicitation (spec 2026-07-28,
 * client/elicitation, form mode). Fail closed: nothing is written unless the
 * user approved exactly this payload in their MCP client.
 *
 * Why the server asks, rather than trusting the model: tool arguments are
 * written by a model that also reads attacker-controlled report and comment
 * text. A `userConfirmed: true` argument would be one more thing the model
 * fills in. An elicitation is answered by the human, in the client's own UI.
 *
 * Mechanism — Multi Round-Trip Requests (spec basic/patterns/mrtr):
 *
 *   1. tools/call arrives without an approval → the tool returns an
 *      `InputRequiredResult` carrying one `elicitation/create` (form mode) that
 *      shows the exact payload, plus a `requestState` (HMAC-sealed by the SDK's
 *      `createRequestStateCodec`) holding the tool name, a SHA-256 digest of
 *      the validated arguments and a single-use nonce, bound to the
 *      authenticated principal and valid for ten minutes.
 *      The prompt is built by the tool's `approval(input, context)`, which may
 *      look up what the ids refer to and may refuse outright (a BugSecureError)
 *      before anything is asked; it is rendered so that nothing in a value can
 *      pass for this server's own text (see `renderApprovalMessage`), and is
 *      refused when too large to review (`MAX_APPROVAL_CHARACTERS`).
 *   2. The client shows the form; the user accepts (ticking "Send exactly
 *      this"), declines or cancels; the client retries tools/call with the
 *      same arguments, the `inputResponses` and the `requestState` echoed.
 *   3. The write runs only if the state verifies (MAC, expiry, principal), its
 *      tool and argument digest match THIS call, the nonce has not been used
 *      in this process, and the response is `accept` with `approve: true`.
 *      Decline/cancel → an error result, nothing sent. Anything that does not
 *      verify → a fresh approval prompt; never a write.
 *
 * This works the same over stateless Streamable HTTP and stdio, because
 * the 2026-07-28 revision carries the request inside the tool result instead
 * of as a server→client JSON-RPC request. For 2025-era clients on stdio the
 * SDK's legacy shim turns step 1 into a real `elicitation/create` request on
 * the connection and re-enters the tool with the answer; over stateless HTTP a
 * 2025-era client cannot receive server→client requests at all, so write tools
 * report that approvals are unavailable.
 *
 * A client that did not declare the `elicitation` capability (form mode) gets
 * an error result saying write tools are unavailable in it — the server MUST
 * NOT send it an elicitation (mrtr § Server Requirements 7).
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
import type { Logger } from '../logger.js';
import { ExpiringLru } from '../lru.js';
import { revealForReview } from '../untrusted.js';

/**
 * What the user is shown before a write. Values are shown verbatim, one
 * prefixed line per line of text, with anything that could hide or fake
 * content made visible (see `renderApprovalMessage`).
 */
export interface ApprovalPrompt {
  /** Completes "bugsecure-mcp wants to …", e.g. "submit a vulnerability report to programme 42". */
  readonly action: string;
  /** Who will see the result; shown prominently, e.g. "VISIBLE TO THE RESEARCHER, who is notified." */
  readonly audience: string;
  /** The change cannot be undone or edited afterwards. */
  readonly irreversible: boolean;
  /**
   * What the ids refer to, looked up read-only for the user's benefit (the
   * programme's name, the report's title…): shown, never sent. Third-party
   * text, escaped like the payload. `null` values are skipped.
   */
  readonly context?: readonly (readonly [label: string, value: string | null | undefined])[];
  /** Short remarks from this server, e.g. that a lookup failed and only an id is shown. */
  readonly notes?: readonly string[];
  /** The exact payload, as label/value pairs in the order they should be read. */
  readonly fields: readonly (readonly [label: string, value: string | null | undefined])[];
}

/**
 * The most payload text one approval may carry, in characters, across all
 * fields. A person cannot meaningfully review more in a dialog; a report that
 * long belongs on the website, where it can be edited and previewed.
 */
export const MAX_APPROVAL_CHARACTERS = 50_000;

/** Key of our single entry in `inputRequests` / `inputResponses`. */
export const APPROVAL_INPUT_KEY = 'approval';
/** How long an approval prompt stays answerable. */
export const APPROVAL_TTL_SECONDS = 600;

interface ApprovalState {
  /** Tool name. */
  readonly t: string;
  /** SHA-256 (base64url) of the canonical JSON of the validated arguments. */
  readonly d: string;
  /** Single-use nonce. */
  readonly n: string;
}

export const APPROVAL_SCHEMA: {
  type: 'object';
  properties: { approve: { type: 'boolean'; title: string; description: string; default: boolean } };
  required: string[];
} = {
  type: 'object',
  properties: {
    approve: {
      type: 'boolean',
      title: 'Send exactly this',
      description:
        'Tick to send the content shown above to BugSecure, as you. Leave unticked or decline to send nothing.',
      default: false,
    },
  },
  required: ['approve'],
};

/**
 * Single-use memory for approval nonces, per process. Bounded: under a flood
 * of more than `max` approvals within the TTL the oldest are forgotten, which
 * only reopens replay of an already-approved, identical payload by the same
 * principal. Hosted deployments with several instances do not share it; the
 * principal binding and the ten-minute TTL still apply everywhere.
 *
 * Residual risk (SECURITY.md § Known limitations): an approved retry replayed
 * to ANOTHER instance within the TTL would run there. The API offers no
 * idempotency key; submit_report refuses an apparent repeat (same title,
 * programme and user within the TTL), and grades and status moves cannot
 * repeat at the API.
 */
export class ApprovalReplayGuard {
  readonly #used: ExpiringLru<string, true>;
  readonly #now: () => number;

  constructor(max = 10_000, now: () => number = Date.now) {
    this.#used = new ExpiringLru(max, now);
    this.#now = now;
  }

  /** `true` the first time `nonce` is seen within the TTL. */
  consume(nonce: string): boolean {
    if (this.#used.get(nonce) !== undefined) return false;
    this.#used.set(nonce, true, this.#now() + APPROVAL_TTL_SECONDS * 1000);
    return true;
  }
}

export interface ApprovalGateOptions {
  /** HMAC key for `requestState`, ≥ 32 bytes. Must be shared by every instance serving a principal. */
  readonly key: Uint8Array;
  /** The authenticated user and client; approvals never transfer between principals. */
  readonly principal: string;
  readonly replay: ApprovalReplayGuard;
  readonly logger: Logger;
}

/** What the framework knows about the current tools/call round. */
export interface ApprovalCall {
  readonly toolName: string;
  /** Arguments after input validation (defaults applied). */
  readonly args: Record<string, unknown>;
  readonly ctx: ServerContext;
  readonly clientCapabilities: ClientCapabilities | undefined;
}

export type ApprovalOutcome =
  | { readonly kind: 'approved' }
  | { readonly kind: 'respond'; readonly result: CallToolResult | InputRequiredResult };

/** Whether the client declared form-mode elicitation (an empty object means form, spec § Capabilities). */
export const supportsFormElicitation = (capabilities: ClientCapabilities | undefined): boolean => {
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) return false;
  const modes = elicitation as { form?: unknown; url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
};

/** Every line of a shown value starts with this, so text inside a value cannot pass for our own lines. */
export const VALUE_PREFIX = '│ ';
/** Empty lines in a row, beyond which a run is shown as one marker line. */
const MAX_BLANK_RUN = 2;

const characters = (value: string): number => Array.from(value).length;
const count = (n: number, what: string): string =>
  `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

/** A value as prefixed, escaped lines; long runs of empty lines collapse into one marked line. */
const valueLines = (value: string): string[] => {
  const out: string[] = [];
  let blanks = 0;
  const flush = (): void => {
    if (blanks > MAX_BLANK_RUN) out.push(`${VALUE_PREFIX}⋮ (${count(blanks, 'empty line')} here)`);
    else for (let i = 0; i < blanks; i += 1) out.push(VALUE_PREFIX.trimEnd());
    blanks = 0;
  };
  for (const line of revealForReview(value).split('\n')) {
    if (line.trim() === '') {
      blanks += 1;
      continue;
    }
    flush();
    out.push(`${VALUE_PREFIX}${line}`);
  }
  flush();
  return out;
};

/** Total payload characters of `prompt` (what the size cap is checked against). */
export const approvalSize = (prompt: ApprovalPrompt): number =>
  prompt.fields.reduce((n, [, v]) => n + (v === null || v === undefined ? 0 : characters(v)), 0);

/**
 * The elicitation `message`: the exact payload, framed so that nothing a
 * model wrote can pass for this server's own text. Every line of every value
 * (and of every looked-up name) starts with "│ "; control, invisible and
 * direction-changing characters are shown as escapes; markup openers are
 * neutralised; each value states its size.
 */
export const renderApprovalMessage = (prompt: ApprovalPrompt): string => {
  const lines = [
    `bugsecure-mcp wants to ${prompt.action} on BugSecure, as you.`,
    '',
    prompt.audience,
    ...(prompt.irreversible ? ['This cannot be undone, edited or withdrawn afterwards.'] : []),
  ];
  const context = (prompt.context ?? []).filter(
    (entry): entry is readonly [string, string] => entry[1] !== null && entry[1] !== undefined,
  );
  if (context.length > 0 || (prompt.notes ?? []).length > 0) {
    lines.push('', 'For context (looked up on BugSecure, not sent):');
    for (const [label, value] of context) lines.push(`${label}:`, ...valueLines(value));
    for (const note of prompt.notes ?? []) lines.push(`(${note})`);
  }
  const fields = prompt.fields.filter(
    (entry): entry is readonly [string, string] => entry[1] !== null && entry[1] !== undefined,
  );
  lines.push(
    '',
    `Exactly what will be sent (${count(fields.length, 'value')}, ${count(approvalSize(prompt), 'character')}). ` +
      `Every line of a value starts with "${VALUE_PREFIX.trimEnd()}"; a line without it is not part of what is sent.`,
  );
  for (const [label, value] of fields) {
    lines.push(
      `── ${label} (${count(characters(value), 'character')}, ${count(value.split('\n').length, 'line')})`,
      ...valueLines(value),
    );
  }
  lines.push(
    '── End of what will be sent',
    '',
    'Approve only if you asked for this. Declining sends nothing.',
  );
  return lines.join('\n');
};

const refusal = (text: string): ApprovalOutcome => {
  return { kind: 'respond', result: { content: [{ type: 'text', text }], isError: true } };
};

export const NO_ELICITATION_MESSAGE =
  'Nothing was sent. BugSecure write tools need your explicit approval for every change, and this MCP ' +
  'client does not support approval prompts (MCP elicitation) on this connection, so write tools are ' +
  'unavailable here. Do this on the BugSecure website instead, or use an MCP client that supports ' +
  'elicitation (see https://github.com/kulinda-sec/bugsecure-mcp#write-tools-and-approvals). ' +
  'Do not retry this call.';

export class ApprovalGate {
  readonly #options: ApprovalGateOptions;
  readonly #codec: RequestStateCodec<ApprovalState>;

  constructor(options: ApprovalGateOptions) {
    this.#options = options;
    this.#codec = createRequestStateCodec<ApprovalState>({
      key: options.key,
      ttlSeconds: APPROVAL_TTL_SECONDS,
      // Bound to the authenticated principal (spec: elicitation § Security 1,
      // mrtr § Server Requirements 5). The codec stores only an HMAC tag of it.
      bind: () => options.principal,
    });
  }

  async check(
    call: ApprovalCall,
    prompt: () => ApprovalPrompt | Promise<ApprovalPrompt>,
  ): Promise<ApprovalOutcome> {
    const logger = this.#options.logger;
    if (!supportsFormElicitation(call.clientCapabilities)) {
      logger.info('write refused: client cannot show approval prompts');
      return refusal(NO_ELICITATION_MESSAGE);
    }

    const digest = sha256Base64Url(canonicalJson({ tool: call.toolName, args: call.args }));
    const state = await this.#verify(call.ctx);
    const answer = inputResponse(call.ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);

    if (state !== undefined && answer.kind === 'elicit') {
      if (state.t !== call.toolName || state.d !== digest) {
        // The retry does not carry the call that was approved: ask again for this one.
        logger.warn('approval does not match the retried call; asking again');
      } else if (answer.action === 'accept' && answer.content?.approve === true) {
        if (!this.#options.replay.consume(state.n)) {
          logger.warn('approval replayed; refused');
          return refusal(
            'Nothing was sent: this approval was already used. Ask the user before trying again.',
          );
        }
        logger.info('write approved by the user');
        return { kind: 'approved' };
      } else {
        logger.info('write not approved by the user', { action: answer.action });
        return refusal(
          answer.action === 'cancel'
            ? 'Nothing was sent: the user dismissed the approval prompt. Do not retry unless the user asks you to.'
            : 'Nothing was sent: the user did not approve this. Do not retry unless the user asks you to.',
        );
      }
    }

    // Built only when asking: it may look things up, and may refuse (a BugSecureError) before asking.
    const shown = await prompt();
    const size = approvalSize(shown);
    if (size > MAX_APPROVAL_CHARACTERS) {
      logger.info('write refused: too large to review', { size });
      return refusal(
        `Nothing was sent: this is ${size.toLocaleString('en-US')} characters, more than the ` +
          `${MAX_APPROVAL_CHARACTERS.toLocaleString('en-US')} an approval prompt can show for a person to review. ` +
          'Shorten it, or ask the user to submit it on the BugSecure website, where long reports can be edited and previewed.',
      );
    }
    const requestState = await this.#codec.mint(
      { t: call.toolName, d: digest, n: randomToken(16) },
      call.ctx,
    );
    return {
      kind: 'respond',
      result: inputRequired({
        inputRequests: {
          [APPROVAL_INPUT_KEY]: inputRequired.elicit({
            mode: 'form',
            message: renderApprovalMessage(shown),
            requestedSchema: APPROVAL_SCHEMA,
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
      this.#options.logger.info('approval state did not verify; asking again');
      return undefined;
    }
  }
}
