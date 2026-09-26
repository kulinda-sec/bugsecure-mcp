import { PACKAGE_NAME } from './version.js';
import { formatScopes, ORG_GATED_SCOPES, RESEARCHER_ONLY_SCOPES, type Scope } from './scopes.js';

/**
 * Errors a tool call can end in. Each maps to an *actionable* message for the
 * model and the user; nothing here carries upstream stack traces, tokens or
 * user content (text the API sends back is fenced, see graphql/errors.ts).
 */
export type ErrorCode =
  | 'NOT_LOGGED_IN'
  | 'SESSION_EXPIRED'
  | 'INSUFFICIENT_SCOPE'
  | 'ORG_AI_ACCESS_DISABLED'
  | 'ORG_AI_GRADING_DISABLED'
  | 'OAUTH_FIELD_DENIED'
  | 'PLATFORM_STAFF'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'REQUEST_IN_PROGRESS'
  | 'REQUEST_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'REQUEST_BLOCKED'
  | 'CREDENTIALS_BUSY'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REFUSED'
  | 'UPSTREAM_OUTDATED'
  | 'UPSTREAM_ERROR';

export interface BugSecureErrorOptions {
  readonly requiredScopes?: readonly Scope[];
  /** Whether ALL of `requiredScopes` are needed, or ANY one of them (the API's `scopeMatch`). */
  readonly scopeMatch?: 'all' | 'any';
  /** A specific "what to do now" that replaces the code's generic hint. */
  readonly hint?: string;
  readonly cause?: unknown;
}

export class BugSecureError extends Error {
  override readonly name = 'BugSecureError';
  readonly code: ErrorCode;
  readonly requiredScopes: readonly Scope[];
  readonly scopeMatch: 'all' | 'any';
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: BugSecureErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.requiredScopes = options.requiredScopes ?? [];
    this.scopeMatch = options.scopeMatch ?? 'all';
    this.hint = options.hint;
  }
}

/** Which way this process authenticates; decides how "fix it" hints are phrased. */
export type AuthMode = 'local' | 'hosted';

const cli = `npx -y ${PACKAGE_NAME}`;

/**
 * Who can hold an organisation-side scope at all. The API grants `triage:*`
 * and `grade:write` only to a user with a seat in an organisation whose
 * Administrator enabled the matching opt-in, and never to BugSecure staff:
 * asking for them otherwise changes nothing (the consent screen drops them).
 */
export const ORG_SCOPE_ELIGIBILITY =
  'triage:read and triage:write are only granted to a member of an organisation whose Administrator ' +
  'enabled "AI triage access", and grade:write only where the Administrator also enabled "AI grading"; ' +
  'BugSecure staff accounts are never granted them.';

/** Who can hold a researcher-only scope: the API grants them to researcher accounts only. */
export const RESEARCHER_SCOPE_ELIGIBILITY =
  'profile:write and disclosures:write are only granted to researcher accounts.';

const reauthorize = (mode: AuthMode, scopes: readonly Scope[]): string => {
  const list = formatScopes(scopes);
  return mode === 'local'
    ? `Ask the user to run \`${cli} login --scopes "${list}"\` in a terminal, then restart their MCP client.`
    : `Ask the user to reconnect BugSecure in their MCP client and approve: ${list}.`;
};

/**
 * What to say about scopes the user approved for this connection but BugSecure
 * did not grant (hosted: the token exchange narrowed them). BugSecure's
 * exchange narrows only to what this server's own OAuth client registration
 * allows: whether the account or its organisation may hold a scope is settled
 * at consent, and a staff account is refused per request (PLATFORM_STAFF). So
 * a withheld scope is the operator's to fix, and asking the user to reconnect
 * and approve it again would change nothing.
 */
const withheldHint = (scopes: readonly Scope[]): string => {
  const list = formatScopes(scopes);
  return (
    `BugSecure did not grant ${list} to this connection although it was approved: BugSecure's ` +
    'authorization server left it out of the token it issued to this hosted server, which happens only ' +
    "when the server's OAuth client is not allowed that scope, or the server and the API disagree on it. " +
    'Only the operator of this hosted server can fix that; reconnecting and approving it again changes ' +
    'nothing. Until then, do it on the BugSecure website. Do not retry this call.'
  );
};

const hint = (
  error: BugSecureError,
  mode: AuthMode,
  granted: ReadonlySet<Scope>,
  withheld: ReadonlySet<Scope>,
): string | undefined => {
  if (error.hint !== undefined) return error.hint;
  switch (error.code) {
    case 'NOT_LOGGED_IN':
    case 'SESSION_EXPIRED':
      return mode === 'local'
        ? `Ask the user to run \`${cli} login\` in a terminal, then restart their MCP client.`
        : 'Ask the user to reconnect BugSecure in their MCP client to sign in again.';
    case 'INSUFFICIENT_SCOPE': {
      if (error.requiredScopes.length === 0)
        return 'This operation is not available to connected apps; the user can do it on the BugSecure website.';
      // Ask for what is granted PLUS what is missing, so re-authorizing never drops a
      // permission. When ANY one of several scopes would do, ask for the first only (the
      // first BugSecure has not withheld, when there is one).
      const any = error.scopeMatch === 'any' && error.requiredScopes.length > 1;
      const askable = error.requiredScopes.filter((s) => !withheld.has(s));
      const missing = any
        ? askable.length > 0
          ? askable.slice(0, 1)
          : error.requiredScopes
        : error.requiredScopes;
      const options = any ? `Any one of ${error.requiredScopes.join(', ')} is enough. ` : '';
      // Approved, then left out by BugSecure: approving them again would not help.
      const notGranted = missing.filter((s) => withheld.has(s));
      const toAsk = missing.filter((s) => !withheld.has(s));
      if (toAsk.length === 0) return `${options}${withheldHint(notGranted)}`;
      const gated = toAsk.some((s) => ORG_GATED_SCOPES.has(s)) ? ` ${ORG_SCOPE_ELIGIBILITY}` : '';
      const researcher = toAsk.some((s) => RESEARCHER_ONLY_SCOPES.has(s))
        ? ` ${RESEARCHER_SCOPE_ELIGIBILITY}`
        : '';
      const also = notGranted.length > 0 ? ` ${withheldHint(notGranted)}` : '';
      return `${options}${reauthorize(mode, [...granted, ...toAsk])}${gated}${researcher}${also}`;
    }
    case 'ORG_AI_ACCESS_DISABLED':
      return 'An Administrator of that organisation must enable "AI triage access" in the organisation settings on the BugSecure website.';
    case 'ORG_AI_GRADING_DISABLED':
      return (
        'Grading through a connected app needs the organisation\'s separate "AI grading" consent (AI triage access alone is not enough). ' +
        'Only an Administrator of that organisation can enable it, on the BugSecure website. Until then, grade the report on the BugSecure website. ' +
        'Do not retry this call.'
      );
    case 'PLATFORM_STAFF':
      return 'BugSecure staff use the admin tools, not this server. Do not retry this call.';
    case 'RATE_LIMITED':
      return 'Wait before retrying, and do not retry in a loop.';
    case 'REQUEST_BLOCKED':
      return (
        'The firewall in front of BugSecure refused this text; nothing was sent. Do not retry it unchanged. ' +
        'Rephrase it (for example put payloads in a fenced code block, or describe an exploit string instead ' +
        'of quoting it), or submit it on the BugSecure website.'
      );
    case 'CREDENTIALS_BUSY':
      return 'Retry in a few seconds.';
    case 'REQUEST_IN_PROGRESS':
      return (
        'Do not retry. Wait a few seconds, then check whether the change was made ' +
        '(for example with get_report or list_notifications) before telling the user.'
      );
    case 'REQUEST_KEY_REUSED':
      return 'Do not retry this call. If the user still wants the change, they approve it again.';
    case 'UPSTREAM_OUTDATED':
      return (
        'Nothing was written. Read tools still work; for changes, ask the user to use the BugSecure ' +
        'website until the API is updated, and do not retry.'
      );
    case 'UPSTREAM_UNAVAILABLE':
      return 'The BugSecure API could not be reached; retry shortly.';
    case 'OAUTH_FIELD_DENIED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'INVALID_INPUT':
    case 'CONFLICT':
    case 'UPSTREAM_REFUSED':
    case 'UPSTREAM_ERROR':
      return undefined;
  }
};

/**
 * The text a failed tool call returns to the model. `grantedScopes` (when
 * known) is folded into re-authorization hints; `withheldScopes` are scopes the
 * user approved but BugSecure did not grant (hosted: narrowed by the token
 * exchange), which a re-authorization would not obtain either.
 */
export const describeError = (
  error: BugSecureError,
  mode: AuthMode,
  grantedScopes: ReadonlySet<Scope> = new Set(),
  withheldScopes: ReadonlySet<Scope> = new Set(),
): string => {
  const h = hint(error, mode, grantedScopes, withheldScopes);
  return h === undefined ? error.message : `${error.message}\n\n${h}`;
};
