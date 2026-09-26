/**
 * OAuth scopes understood by the BugSecure API.
 *
 * Scopes only ever *narrow* what a connected app can do on the user's behalf;
 * the API still applies the user's own roles, organization membership and
 * per-object ownership checks on top. There is no scope hierarchy: a write
 * scope does not imply the matching read scope.
 */
export const SCOPES = [
  'programs:read',
  'profile:read',
  'reports:read',
  'reports:write',
  'triage:read',
  'triage:write',
  'grade:write',
  'notifications:write',
  'profile:write',
  'disclosures:write',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes that let a client change state. Tools needing one are "write tools". */
export const WRITE_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'reports:write',
  'triage:write',
  'grade:write',
  'notifications:write',
  'profile:write',
  'disclosures:write',
]);

/**
 * Write scopes that also grant a read the API serves under no read scope:
 * `disclosures:write` reads the draft it edits (`reportDisclosureDraft`). A
 * read tool may list one in `optionalScopes`, for that read only.
 */
export const WRITE_SCOPES_WITH_READS: ReadonlySet<Scope> = new Set<Scope>(['disclosures:write']);

/**
 * Scopes the API grants only to an account with the RESEARCHER role (its
 * public profile, its side of a disclosure). Asking for one otherwise changes
 * nothing: the consent screen lists it as unavailable.
 */
export const RESEARCHER_ONLY_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'profile:write',
  'disclosures:write',
]);

/**
 * Scopes that act on an organisation's side. The API only grants them to a
 * user with a seat in an organisation that opted in (AI triage access, or AI
 * grading for `grade:write`), never to BugSecure staff, and silently drops
 * them from a consent otherwise: re-asking for them cannot help an ineligible
 * account, so hosted step-up never requests them.
 */
export const ORG_GATED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'triage:read',
  'triage:write',
  'grade:write',
]);

/** Every read-only scope. */
export const READ_SCOPES: readonly Scope[] = SCOPES.filter((s) => !WRITE_SCOPES.has(s));

/**
 * What `login` requests when `--scopes` is not given, and what the hosted
 * server advertises (`scopes_supported`, the 401 challenge): the read scopes
 * and `reports:write` (every write still needs the user's approval, one by
 * one). The other write scopes are requested on demand: `login --scopes`
 * locally, a step-up challenge when hosted.
 */
export const DEFAULT_LOGIN_SCOPES: readonly Scope[] = [...READ_SCOPES, 'reports:write'];

/**
 * What the hosted server asks for on first connection (`scopes_supported`, and
 * the 401 challenge): the login defaults plus every scope only some accounts
 * can hold, the researcher-only writes and the organisation-side writes. The
 * consent screen lists a scope the account cannot hold as unavailable without
 * failing, and grants the rest, so asking costs an ineligible account nothing,
 * and an eligible one gets its scopes without a second trip to the consent
 * screen. These are the scopes that are never stepped up (`NO_STEP_UP_SCOPES`),
 * so the first connection is the only time to ask for them: left out here, the
 * organisation-side write tools would be unreachable over the hosted transport.
 */
export const HOSTED_INITIAL_SCOPES: readonly Scope[] = [
  ...DEFAULT_LOGIN_SCOPES,
  ...RESEARCHER_ONLY_SCOPES,
  'triage:write',
  'grade:write',
];

/**
 * Scopes the hosted server never asks for by step-up: consent grants them only
 * to eligible accounts and silently drops them otherwise, so asking again
 * would send an ineligible user round the consent screen for ever. They are
 * requested on first connection instead (`HOSTED_INITIAL_SCOPES`). A call
 * missing one reaches the tool, whose error says who is eligible and how to
 * approve it on a fresh connection.
 */
export const NO_STEP_UP_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  ...ORG_GATED_SCOPES,
  ...RESEARCHER_ONLY_SCOPES,
]);

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export const isScope = (value: unknown): value is Scope => {
  return typeof value === 'string' && SCOPE_SET.has(value);
};

export const isWriteScope = (scope: Scope): boolean => {
  return WRITE_SCOPES.has(scope);
};

/**
 * Parse an RFC 6749 §3.3 space-delimited scope string. Unknown values are
 * dropped: this server can only ever act on scopes it knows how to honour.
 */
export const parseScopeString = (value: string | undefined | null): ReadonlySet<Scope> => {
  if (typeof value !== 'string') return new Set();
  return new Set(value.split(/\s+/).filter(isScope));
};

/** Serialise scopes canonically (declaration order), for requests and display. */
export const formatScopes = (scopes: Iterable<Scope>): string => {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s)).join(' ');
};

/** `true` when `granted` contains every scope in `required`. */
export const hasAllScopes = (granted: ReadonlySet<Scope>, required: readonly Scope[]): boolean => {
  return required.every((s) => granted.has(s));
};
