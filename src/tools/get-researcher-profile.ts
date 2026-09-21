import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { GetResearcherProfileDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, timestamp, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

export const getResearcherProfile = defineTool({
  name: 'get_researcher_profile',
  title: 'Get a researcher’s public profile',
  description:
    'The public BugSecure profile of a researcher, by username: level, reputation, streaks, report counts ' +
    'and badges, plus the bio, country and website they chose to publish.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .describe('BugSecure username (3–30 characters), e.g. from get_leaderboard.'),
  }),
  output: z.object({
    profile: z.object({
      userId: id(),
      username: wrapped(),
      memberSince: timestamp(),
      isAmbassador: z.boolean(),
      bio: wrapped().nullable(),
      country: wrapped().nullable(),
      website: wrapped().nullable(),
      level: z.number().int(),
      xp: z.number().int(),
      reputation: z.number().int(),
      streak: z.number().int(),
      longestStreak: z.number().int(),
      reportsSubmitted: z.number().int(),
      reportsAccepted: z.number().int(),
      badges: z.array(z.object({ id: id(), name: wrapped(), awardedAt: timestamp() })),
    }),
  }),
  async handler(input, { graphql, signal }) {
    const { researcherPublicProfile: p } = await graphql.request(
      GetResearcherProfileDocument,
      { username: input.username },
      { signal },
    );
    if (!p) throw new BugSecureError('NOT_FOUND', 'No researcher profile with that username.');
    const src = `user:${p.userId}`;
    return {
      data: {
        profile: {
          userId: p.userId,
          username: untrusted(`${src}:username`, p.username),
          memberSince: p.memberSince,
          isAmbassador: p.isAmbassador,
          bio: untrusted(`${src}:bio`, p.bio),
          country: untrusted(`${src}:country`, p.country),
          website: untrusted(`${src}:website`, p.website),
          level: p.level,
          xp: p.xp,
          reputation: p.reputation,
          streak: p.streak,
          longestStreak: p.longestStreak,
          reportsSubmitted: p.reportsSubmitted,
          reportsAccepted: p.reportsAccepted,
          badges: p.badges.map((b) => ({
            id: b.id,
            name: untrusted(`badge:${b.id}:name`, b.name),
            awardedAt: b.awardedAt,
          })),
        },
      },
    };
  },
});
