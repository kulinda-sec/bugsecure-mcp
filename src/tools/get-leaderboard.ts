import * as z from 'zod';

import { GetLeaderboardDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 100;

export const getLeaderboard = defineTool({
  name: 'get_leaderboard',
  title: 'Get the researcher leaderboard',
  description:
    'Top researchers on BugSecure. All-time ranks by reputation; `monthly`/`quarterly` rank by reports ' +
    'validated in that period. Optionally filtered by country. Use get_researcher_profile with a username ' +
    'for more about one researcher.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    period: z
      .enum(['all_time', 'monthly', 'quarterly'])
      .default('all_time')
      .describe('Ranking period: all_time (reputation), monthly or quarterly (validated reports).'),
    country: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Only researchers whose profile lists this country, exactly as written on their profile.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(20)
      .describe(`How many researchers (1–${MAX_LIMIT}).`),
  }),
  output: z.object({
    period: z.enum(['all_time', 'monthly', 'quarterly']),
    researchers: z.array(
      z.object({
        rank: z.number().int(),
        userId: id(),
        username: wrapped(),
        country: wrapped().nullable(),
        isAmbassador: z.boolean(),
        reputation: z.number().int(),
        level: z.number().int(),
        xp: z.number().int(),
      }),
    ),
  }),
  async handler(input, { graphql, signal }) {
    const { leaderboard } = await graphql.request(
      GetLeaderboardDocument,
      {
        limit: input.limit,
        timeRange: input.period === 'all_time' ? null : input.period,
        country: input.country ?? null,
      },
      { signal },
    );
    return {
      data: {
        period: input.period,
        researchers: leaderboard.map((e) => {
          const src = `user:${e.profile.userId}`;
          return {
            rank: e.rank,
            userId: e.profile.userId,
            username: untrusted(`${src}:username`, e.username),
            country: untrusted(`${src}:country`, e.profile.country),
            isAmbassador: e.isAmbassador,
            reputation: e.profile.reputation,
            level: e.profile.level,
            xp: e.profile.xp,
          };
        }),
      },
    };
  },
});
