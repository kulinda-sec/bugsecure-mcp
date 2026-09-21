import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { cleanMessage } from '../http.js';
import { isScope, type Scope } from '../scopes.js';
import { untrusted } from '../untrusted.js';

export const GraphQLErrorSchema = z.object({
  message: z.string().catch('Unknown error'),
  extensions: z
    .looseObject({
      code: z.string().optional().catch(undefined),
      requiredScopes: z.array(z.string()).optional().catch(undefined),
      scopeMatch: z.enum(['all', 'any']).optional().catch(undefined),
      termsKind: z.enum(['PLATFORM_RESEARCHER', 'PLATFORM_ORGANIZATION']).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type GraphQLErrorShape = z.infer<typeof GraphQLErrorSchema>;

/**
 * Error codes that say something specific about *authorization* (or about the
 * firewall refusing the request outright); if a response carries several
 * errors, these win over generic ones so the user gets the actionable message.
 */
const PRIORITY = [
  'REQUEST_BLOCKED',
  'UNAUTHENTICATED',
  'INSUFFICIENT_SCOPE',
  'ORG_AI_ACCESS_DISABLED',
  'ORG_AI_GRADING_DISABLED',
  'OAUTH_FIELD_DENIED',
  'PLATFORM_STAFF_SCOPE_REFUSED',
  'PLATFORM_TERMS_NOT_ACCEPTED',
  'PROGRAMME_TERMS_NOT_ACCEPTED',
  'ORGANIZATION_TERMS_NOT_ACCEPTED',
];

const pick = (errors: readonly GraphQLErrorShape[]): GraphQLErrorShape | undefined => {
  for (const code of PRIORITY) {
    const hit = errors.find((e) => e.extensions?.code === code);
    if (hit) return hit;
  }
  return errors[0];
};

const TERMS_HINT =
  'Ask the user to accept the current terms on the BugSecure website, then retry; a connected app cannot accept terms.';
const ORGANIZATION_TERMS_HINT =
  'Only an Administrator of that organisation can accept them, on the BugSecure website; a connected app cannot. Do not retry until then.';

/** Machine codes are shown as-is only when they look like one. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Map GraphQL `errors[]` from the BugSecure API to one actionable BugSecureError.
 *
 * Any text the API sends back (the message of a refusal) can quote what a user
 * or organisation wrote — a report title, a programme name — so it is relayed
 * only inside an untrusted-content fence, never as plain text.
 */
export const mapGraphQLErrors = (errors: readonly GraphQLErrorShape[]): BugSecureError => {
  const error = pick(errors);
  if (!error) return new BugSecureError('UPSTREAM_ERROR', 'The BugSecure API returned an empty error.');
  const code = error.extensions?.code;
  const relayed = (): string => untrusted('bugsecure-api:error', cleanMessage(error.message));

  switch (code) {
    case 'UNAUTHENTICATED':
      return new BugSecureError('SESSION_EXPIRED', 'The BugSecure session is no longer valid.');
    case 'REQUEST_BLOCKED':
      return new BugSecureError(
        'REQUEST_BLOCKED',
        'The firewall in front of the BugSecure API refused this request before it reached BugSecure.',
      );
    case 'INSUFFICIENT_SCOPE': {
      const requiredScopes: Scope[] = (error.extensions?.requiredScopes ?? []).filter(isScope);
      const scopeMatch = error.extensions?.scopeMatch ?? 'all';
      const any = scopeMatch === 'any' && requiredScopes.length > 1;
      return new BugSecureError(
        'INSUFFICIENT_SCOPE',
        requiredScopes.length > 0
          ? `This BugSecure connection was not granted the permission this needs (${
              any ? `one of ${requiredScopes.join(', ')}` : requiredScopes.join(', ')
            }).`
          : 'This operation is not available to apps connected to BugSecure.',
        { requiredScopes, scopeMatch },
      );
    }
    case 'ORG_AI_ACCESS_DISABLED':
      return new BugSecureError(
        'ORG_AI_ACCESS_DISABLED',
        'This organisation has not enabled AI triage access for connected apps.',
      );
    case 'ORG_AI_GRADING_DISABLED':
      return new BugSecureError(
        'ORG_AI_GRADING_DISABLED',
        'This organisation has not enabled AI grading for connected apps.',
      );
    case 'OAUTH_FIELD_DENIED':
      return new BugSecureError(
        'OAUTH_FIELD_DENIED',
        'Part of this data is not available to apps connected to BugSecure.',
      );
    case 'PLATFORM_STAFF_SCOPE_REFUSED':
      return new BugSecureError(
        'PLATFORM_STAFF',
        'BugSecure refuses organisation-side access to accounts with a BugSecure staff role.',
      );
    case 'PLATFORM_TERMS_NOT_ACCEPTED':
      // termsKind says whose acceptance is missing: the user's own (as a researcher), or the organisation's.
      return error.extensions?.termsKind === 'PLATFORM_ORGANIZATION'
        ? new BugSecureError(
            'FORBIDDEN',
            'The organisation has not accepted the current BugSecure terms for organisations.',
            { hint: ORGANIZATION_TERMS_HINT },
          )
        : new BugSecureError(
            'FORBIDDEN',
            'The user has not accepted the current BugSecure platform terms for researchers.',
            { hint: TERMS_HINT },
          );
    case 'PROGRAMME_TERMS_NOT_ACCEPTED':
      return new BugSecureError('FORBIDDEN', 'The user has not accepted this programme’s current terms.', {
        hint: TERMS_HINT,
      });
    case 'ORGANIZATION_TERMS_NOT_ACCEPTED':
      return new BugSecureError(
        'FORBIDDEN',
        'The organisation has not accepted the current BugSecure terms for organisations.',
        { hint: ORGANIZATION_TERMS_HINT },
      );
    case 'FORBIDDEN':
      return new BugSecureError('FORBIDDEN', `BugSecure denied access:\n${relayed()}`);
    case 'NOT_FOUND':
      return new BugSecureError('NOT_FOUND', `BugSecure found nothing:\n${relayed()}`);
    case 'BAD_REQUEST':
    case 'BAD_USER_INPUT':
    case 'UNPROCESSABLE_ENTITY':
      return new BugSecureError('INVALID_INPUT', `BugSecure refused the input:\n${relayed()}`);
    case 'FILE_REFUSED':
      return new BugSecureError('INVALID_INPUT', `BugSecure refused a file:\n${relayed()}`);
    case 'CONFLICT':
      return new BugSecureError('CONFLICT', `BugSecure refused this in the current state:\n${relayed()}`);
    case 'FILE_PENDING':
      return new BugSecureError(
        'CONFLICT',
        'A file is still being checked by BugSecure; retry in a minute or two.',
      );
    case 'TOO_MANY_REQUESTS':
      return new BugSecureError('RATE_LIMITED', 'The BugSecure API is rate limiting these requests.');
    case 'GRAPHQL_VALIDATION_FAILED':
    case 'GRAPHQL_PARSE_FAILED':
      return new BugSecureError(
        'UPSTREAM_ERROR',
        'The BugSecure API rejected a query from this version of bugsecure-mcp; updating the package should fix it.',
      );
    case 'INTERNAL_SERVER_ERROR':
      // Internal errors: never relay the upstream message.
      return new BugSecureError('UPSTREAM_ERROR', 'The BugSecure API reported an internal error.');
    default: {
      // A refusal this version does not know yet (or none at all): relay it, fenced.
      const label = code !== undefined && SAFE_CODE.test(code) ? ` (${code})` : '';
      return new BugSecureError('UPSTREAM_REFUSED', `BugSecure refused this request${label}:\n${relayed()}`);
    }
  }
};
