import * as z from 'zod';

import { UpdateMyProfileDocument } from '../graphql/generated.js';
import { hasControlCharacters, untrusted } from '../untrusted.js';
import { userText, wrapped } from './shared/common.js';
import { defineTool, mutation } from './define-tool.js';

type Field = 'bio' | 'website' | 'country';
const LABELS: Readonly<Record<Field, string>> = { bio: 'bio', website: 'website', country: 'country' };

const WEBSITE = /^https?:\/\/[^\s/?#]+[^\s]*$/;
/** The API takes the country as an ISO 3166-1 alpha-2 code and refuses a name. */
const COUNTRY_CODE = /^[A-Za-z]{2}$/;

export const updateMyProfile = defineTool({
  name: 'update_my_profile',
  title: 'Edit my public researcher profile',
  description:
    'Change the bio, website or country on the signed-in researcher’s public BugSecure profile (only the ' +
    'fields given; an empty string clears one; the country is an ISO 3166-1 alpha-2 code such as SN). ' +
    'Everyone on BugSecure sees them. Nothing else about the ' +
    'account can be changed here: the avatar, email, sign-in and payout details stay on the website. Only ' +
    'call this when the user asked; they approve the new values on BugSecure first, next to the current ones. ' +
    'Researcher accounts only.',
  requiredScopes: ['profile:write'],
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
      country: z
        .string()
        .trim()
        .refine(
          (v) => v === '' || COUNTRY_CODE.test(v),
          'an ISO 3166-1 alpha-2 code (two letters), or an empty string',
        )
        .transform((v) => v.toUpperCase())
        .optional()
        .describe('Country as an ISO 3166-1 alpha-2 code (SN, CI, FR…), or an empty string to clear it.'),
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
  payload: (input) => {
    const changed = (['bio', 'website', 'country'] as const).filter((f) => input[f] !== undefined);
    return {
      action: `change the ${changed.map((f) => LABELS[f]).join(', ')} on your public researcher profile`,
      parts: [
        mutation(UpdateMyProfileDocument, {
          input: {
            ...(input.bio === undefined ? {} : { bio: input.bio }),
            ...(input.website === undefined ? {} : { website: input.website }),
            ...(input.country === undefined ? {} : { country: input.country }),
          },
        }),
      ],
    };
  },
  async handler(_input, { approved, signal, viewerId, logger }) {
    const { updateResearcherProfile: p } = await approved.part.send({ signal });
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
