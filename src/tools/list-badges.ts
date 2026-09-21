import * as z from 'zod';

import type { BadgeState } from '../graphql/generated.js';
import { ListBadgesDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import {
  id,
  pageOf,
  paginationInput,
  paginationOutput,
  safeSlug,
  slug,
  timestamp,
  wrapped,
} from './shared/common.js';
import { defineTool } from './define-tool.js';

const BADGE_STATES = ['EARNED', 'LOCKED'] as const satisfies readonly BadgeState[];

export const listBadges = defineTool({
  name: 'list_badges',
  title: 'List BugSecure badges',
  description:
    'The full BugSecure badge catalogue, with the signed-in user’s progress: which badges are earned, when, ' +
    'and how close they are to each locked one. Hidden badges stay obscured until earned.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    state: z.enum(BADGE_STATES).optional().describe('Only earned or only locked badges.'),
    ...paginationInput(100, 50),
  }),
  output: z.object({
    badges: z.array(
      z.object({
        id: id(),
        slug: slug(),
        name: wrapped(),
        description: wrapped(),
        state: z.enum(BADGE_STATES),
        hidden: z.boolean().describe('Secret: name and progress revealed once earned.'),
        awardedAt: timestamp().nullable(),
        progress: z
          .object({ current: z.number().int(), threshold: z.number().int() })
          .nullable()
          .describe('Toward a locked badge, when measurable.'),
      }),
    ),
    earned: z.number().int(),
    total: z.number().int(),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    // The API returns the whole catalogue at once; page it here so the answer stays bounded.
    const { badgeCatalog } = await graphql.request(ListBadgesDocument, {}, { signal });
    const matching = badgeCatalog.filter((b) => input.state === undefined || b.state === input.state);
    const { items, ...pagination } = pageOf(matching, input);
    return {
      data: {
        badges: items.map((b) => ({
          id: b.id,
          slug: safeSlug(b.slug),
          name: untrusted(`badge:${b.id}:name`, b.name),
          description: untrusted(`badge:${b.id}:description`, b.description),
          state: b.state,
          hidden: b.hidden,
          awardedAt: b.awardedAt,
          progress: b.progress && { current: b.progress.current, threshold: b.progress.threshold },
        })),
        earned: badgeCatalog.filter((b) => b.state === 'EARNED').length,
        total: badgeCatalog.length,
        ...pagination,
      },
    };
  },
});
