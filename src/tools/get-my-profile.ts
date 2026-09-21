import * as z from 'zod';

import type { UserStatus } from '../graphql/generated.js';
import { GetMyProfileDocument, GetMyStatsDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { KYC_STATUSES } from './shared/account.js';
import { code, id, ifShaped, timestamp, wrapped } from './shared/common.js';
import { REPORTED_ROLES, reportedRoles } from './shared/viewer.js';
import { defineTool } from './define-tool.js';

const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DELETED'] as const satisfies readonly UserStatus[];

/** `{ "HIGH": 3, … }` (JSON from the API) as counts; anything not shaped like that is dropped. */
const severityCounts = (value: unknown): { severity: string; count: number }[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, count]) => {
    const severity = ifShaped('machine-code', key);
    return severity !== null && typeof count === 'number' && Number.isSafeInteger(count)
      ? [{ severity, count }]
      : [];
  });
};

export const getMyProfile = defineTool({
  name: 'get_my_profile',
  title: 'Get my BugSecure profile',
  description:
    'The signed-in user’s BugSecure account and researcher profile: username, roles, whether the account ' +
    'is approved to submit reports, KYC status, level, reputation, streaks and unread notification count. ' +
    'With stats: true, also report counts by outcome and severity, earnings and monthly activity. ' +
    'Contact details are never returned. Badges: list_badges.',
  requiredScopes: ['profile:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    stats: z
      .boolean()
      .default(false)
      .describe('Also return report statistics and the last 12 months of activity.'),
  }),
  output: z.object({
    account: z.object({
      id: id(),
      username: wrapped(),
      roles: z.array(z.enum(REPORTED_ROLES)),
      status: z.enum(USER_STATUSES),
      approved: z.boolean().describe('False until BugSecure approves the account; no reports before that.'),
      approvedAt: timestamp().nullable(),
      kycStatus: z.enum(KYC_STATUSES),
      isAmbassador: z.boolean(),
      createdAt: timestamp(),
    }),
    researcherProfile: z
      .object({
        bio: wrapped().nullable(),
        country: wrapped().nullable(),
        website: wrapped().nullable(),
        level: z.number().int(),
        xp: z.number().int(),
        reputation: z.number().int(),
        streak: z.number().int(),
        longestStreak: z.number().int(),
      })
      .nullable()
      .describe('Null for accounts without a researcher profile.'),
    unreadNotifications: z.number().int(),
    stats: z
      .object({
        totalReports: z.number().int(),
        validatedReports: z.number().int(),
        validationRate: z.number(),
        totalEarned: z.number().int(),
        reportsBySeverity: z.array(z.object({ severity: code('machine-code'), count: z.number().int() })),
        activity: z.array(
          z.object({ month: code('month'), submissions: z.number().int(), validated: z.number().int() }),
        ),
      })
      .nullable()
      .describe('Only with stats: true.'),
  }),
  async handler(input, { graphql, signal }) {
    const { me, myProfile, unreadNotificationCount } = await graphql.request(
      GetMyProfileDocument,
      {},
      { signal },
    );
    const stats = input.stats
      ? await graphql.request(GetMyStatsDocument, { userId: me.id, months: 12 }, { signal })
      : undefined;
    // Written by the caller, but still free text: fenced like everything else, so the rule
    // "every output string is fenced or strictly shaped" has no exceptions.
    return {
      data: {
        account: {
          id: me.id,
          username: untrusted(`user:${me.id}:username`, me.username),
          roles: reportedRoles(me.roles),
          status: me.status,
          approved: me.approvedAt !== null,
          approvedAt: me.approvedAt,
          kycStatus: me.kycStatus,
          isAmbassador: me.isAmbassador,
          createdAt: me.createdAt,
        },
        researcherProfile: myProfile && {
          bio: untrusted(`user:${me.id}:bio`, myProfile.bio),
          country: untrusted(`user:${me.id}:country`, myProfile.country),
          website: untrusted(`user:${me.id}:website`, myProfile.website),
          level: myProfile.level,
          xp: myProfile.xp,
          reputation: myProfile.reputation,
          streak: myProfile.streak,
          longestStreak: myProfile.longestStreak,
        },
        unreadNotifications: unreadNotificationCount,
        stats:
          stats === undefined
            ? null
            : {
                totalReports: stats.researcherStats.totalReports,
                validatedReports: stats.researcherStats.validatedReports,
                validationRate: stats.researcherStats.validationRate,
                totalEarned: stats.researcherStats.totalEarned,
                reportsBySeverity: severityCounts(stats.researcherStats.reportsBySeverity),
                activity: stats.researcherActivity.flatMap((a) => {
                  const month = ifShaped('month', a.date);
                  return month === null
                    ? []
                    : [{ month, submissions: a.submissions, validated: a.validated }];
                }),
              },
      },
    };
  },
});
