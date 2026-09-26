import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { GetMyProfileRefDocument, UpdateMyProfileDocument } from '../graphql/generated.js';
import { hasControlCharacters, untrusted } from '../untrusted.js';
import type { ApprovalPrompt } from './approval.js';
import { userText, wrapped } from './shared/common.js';
import { defineTool, type ToolContext } from './define-tool.js';

type Field = 'bio' | 'website' | 'country';
const LABELS: Readonly<Record<Field, string>> = { bio: 'Bio', website: 'Website', country: 'Country' };

const WEBSITE = /^https?:\/\/[^\s/?#]+[^\s]*$/;

/** The profile as it is now, shown next to the new values; refuses a non-researcher before asking. */
const currentProfile = async (
  changed: readonly Field[],
  { graphql, signal, granted }: ToolContext,
): Promise<Pick<ApprovalPrompt, 'context' | 'notes'>> => {
  if (!granted.has('profile:read'))
    return { notes: ['Your current profile is not shown: this connection lacks profile:read.'] };
  let current;
  try {
    current = await graphql.request(GetMyProfileRefDocument, {}, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { notes: ['Could not look up your current profile; only the new values are shown.'] };
  }
  if (!current.me.roles.includes('RESEARCHER')) {
    throw new BugSecureError(
      'FORBIDDEN',
      'Nothing was sent: only a researcher profile can be edited through a connected app, and this account is not a researcher.',
    );
  }
  return {
    context: changed.map((f) => {
      const now = current.myProfile?.[f] ?? '';
      return [`${LABELS[f]} now`, now === '' ? '(empty)' : now];
    }),
  };
};

export const updateMyProfile = defineTool({
  name: 'update_my_profile',
  title: 'Edit my public researcher profile',
  description:
    'Change the bio, website or country on the signed-in researcher’s public BugSecure profile (only the ' +
    'fields given; an empty string clears one). Everyone on BugSecure sees them. Nothing else about the ' +
    'account can be changed here: the avatar, email, sign-in and payout details stay on the website. Only ' +
    'call this when the user asked; they approve the old and new values first.',
  requiredScopes: ['profile:write'],
  // Reading the profile shows the current values in the approval, and refuses non-researchers early.
  optionalScopes: ['profile:read'],
  // Destructive: overwrites the previous values. Idempotent: the same values again change nothing.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      bio: userText(0, 500, 'Public bio (up to 500 characters).').optional(),
      website: z
        .string()
        .trim()
        .max(255)
        .refine((v) => v === '' || (WEBSITE.test(v) && !hasControlCharacters(v)), 'not an http(s) URL')
        .optional()
        .describe('Public website, http(s) URL.'),
      country: userText(0, 100, 'Country, as shown on the profile.')
        .refine((v) => !v.includes('\n'), 'must be one line')
        .optional(),
    })
    .refine((v) => v.bio !== undefined || v.website !== undefined || v.country !== undefined, {
      message: 'Give at least one of `bio`, `website` or `country`.',
    }),
  output: z.object({
    profile: z.object({
      bio: wrapped().nullable(),
      website: wrapped().nullable(),
      country: wrapped().nullable(),
    }),
  }),
  approval: async (input, context) => {
    const changed = (['bio', 'website', 'country'] as const).filter((f) => input[f] !== undefined);
    const shown = await currentProfile(changed, context);
    return {
      action: `change ${changed.map((f) => LABELS[f].toLowerCase()).join(', ')} on your public researcher profile`,
      audience: 'PUBLIC: shown on your researcher profile to everyone on BugSecure.',
      irreversible: false,
      context: shown.context ?? [],
      notes: [
        ...(shown.notes ?? []),
        ...(changed.some((f) => input[f] === '') ? ['An empty value clears that field.'] : []),
      ],
      fields: changed.map((f) => [`${LABELS[f]} (new)`, input[f]]),
    };
  },
  async handler(input, { graphql, signal, viewerId, logger, clientRequestId }) {
    const { updateResearcherProfile: p } = await graphql.request(
      UpdateMyProfileDocument,
      {
        input: {
          ...(input.bio === undefined ? {} : { bio: input.bio }),
          ...(input.website === undefined ? {} : { website: input.website }),
          ...(input.country === undefined ? {} : { country: input.country }),
        },
        clientRequestId,
      },
      { signal },
    );
    logger.info('researcher profile updated');
    const src = `user:${viewerId ?? 'me'}`;
    return {
      data: {
        profile: {
          bio: untrusted(`${src}:bio`, p.bio),
          website: untrusted(`${src}:website`, p.website),
          country: untrusted(`${src}:country`, p.country),
        },
      },
    };
  },
});
