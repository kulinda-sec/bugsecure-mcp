/**
 * Who the signed-in user is, for checks this server makes on top of the API's.
 */
import { BugSecureError } from '../../errors.js';
import type { BountyUserRole } from '../../graphql/generated.js';
import type { ToolContext } from '../define-tool.js';

/**
 * Account roles that are NOT BugSecure staff. Every other role, including any
 * this version does not know yet, is treated as staff: fail closed.
 */
const NON_STAFF_ROLES: ReadonlySet<string> = new Set<BountyUserRole>(['RESEARCHER', 'COMPANY_ADMIN']);

const isNonStaffRole = (role: string): role is BountyUserRole => NON_STAFF_ROLES.has(role);

/** Roles as this server reports them: BugSecure's staff roles are not published, only that one is held. */
export const REPORTED_ROLES = ['RESEARCHER', 'COMPANY_ADMIN', 'PLATFORM_STAFF'] as const;

export const reportedRoles = (roles: readonly string[]): (typeof REPORTED_ROLES)[number][] => [
  ...new Set(roles.map((r) => (isNonStaffRole(r) ? r : 'PLATFORM_STAFF'))),
];

/** Roles do not change mid-conversation; re-read after this long anyway. */
const ROLES_TTL_MS = 5 * 60_000;

/**
 * Refuse organisation-side writes (triage, grading) for a BugSecure staff
 * account. The API grants organisation-side scopes only through an
 * organisation seat and never lets a platform role widen them; this is the
 * second line: a staff member acting as the organisation, through a connected
 * app, would blur the line between the organisation's grade and BugSecure's.
 * `fetchRoles` reads `me.roles` (profile:read) from the calling tool's file.
 */
export const assertNotPlatformStaff = async (
  context: Pick<ToolContext, 'memo'>,
  fetchRoles: () => Promise<readonly string[]>,
): Promise<void> => {
  const roles = await context.memo.get('viewer:roles', ROLES_TTL_MS, fetchRoles);
  if (!roles.every(isNonStaffRole)) {
    throw new BugSecureError(
      'PLATFORM_STAFF',
      'This account has a BugSecure staff role; organisation-side writes through this server are refused for staff accounts.',
    );
  }
};
