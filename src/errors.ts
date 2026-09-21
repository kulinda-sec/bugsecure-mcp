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
  | 'RATE_LIMITED'
  | 'REQUEST_BLOCKED'
  | 'CREDENTIALS_BUSY'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REFUSED'
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

const hint = (error: BugSecureError, mode: AuthMode, granted: ReadonlySet<Scope>): string | undefined => {
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
      // permission. When ANY one of several scopes would do, ask for the first only.
      const any = error.scopeMatch === 'any' && error.requiredScopes.length > 1;
      const missing = any ? error.requiredScopes.slice(0, 1) : error.requiredScopes;
      const options = any ? `Any one of ${error.requiredScopes.join(', ')} is enough. ` : '';
      const gated = missing.some((s) => ORG_GATED_SCOPES.has(s)) ? ` ${ORG_SCOPE_ELIGIBILITY}` : '';
      const researcher = missing.some((s) => RESEARCHER_ONLY_SCOPES.has(s))
        ? ` ${RESEARCHER_SCOPE_ELIGIBILITY}`
        : '';
      return `${options}${reauthorize(mode, [...granted, ...missing])}${gated}${researcher}`;
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
 * known) is folded into re-authorization hints.
 */
export const describeError = (
  error: BugSecureError,
  mode: AuthMode,
  grantedScopes: ReadonlySet<Scope> = new Set(),
): string => {
  const h = hint(error, mode, grantedScopes);
  return h === undefined ? error.message : `${error.message}\n\n${h}`;
};
