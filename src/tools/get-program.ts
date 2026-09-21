import * as z from 'zod';

import {
  GetProgramActivityDocument,
  GetProgramBySlugDocument,
  GetProgramDocument,
  type GetProgramActivityQuery,
} from '../graphql/generated.js';
import { BugSecureError } from '../errors.js';
import { untrusted } from '../untrusted.js';
import { defineTool, type ToolContext } from './define-tool.js';
import { code, id, idInput, ifShaped, SLUG_PATTERN, timestamp, wrapped } from './shared/common.js';
import { ProgramDetailSchema, toProgramDetail } from './shared/program.js';

const ActivitySchema = z
  .object({
    overview: z
      .object({
        total: z.number().int().describe('Published disclosures.'),
        lastWeek: z.number().int(),
        averageCertifiedReward: z.number().nullable(),
        rewardSampleSize: z.number().int(),
        confirmedSettlements: z.number().int().describe('Rewards the researcher confirmed as paid.'),
        hallOfFame: z.array(
          z.object({ username: wrapped(), isAmbassador: z.boolean(), contributions: z.number().int() }),
        ),
      })
      .nullable(),
    disclosures: z.array(
      z.object({
        id: id(),
        title: wrapped(),
        summary: wrapped(),
        severity: code('machine-code').nullable(),
        certifiedReward: z.number().nullable(),
        settlement: code('machine-code').nullable(),
        researcher: wrapped().nullable().describe('Null when not credited.'),
        publishedAt: timestamp(),
      }),
    ),
    moreDisclosures: z.boolean().describe('Older disclosures exist (read them on the website).'),
  })
  .nullable()
  .describe('Only with activity: true; null unless the programme is public and active.');

const toActivity = (a: GetProgramActivityQuery['publicProgramActivity']): z.input<typeof ActivitySchema> => ({
  overview: a.overview && {
    total: a.overview.total,
    lastWeek: a.overview.lastWeek,
    averageCertifiedReward: a.overview.averageCertifiedReward,
    rewardSampleSize: a.overview.rewardSampleSize,
    confirmedSettlements: a.overview.confirmedSettlements,
    hallOfFame: a.overview.hallOfFame.map((h, i) => ({
      username: untrusted(`hall-of-fame:${String(i)}:username`, h.username),
      isAmbassador: h.isAmbassador,
      contributions: h.contributions,
    })),
  },
  disclosures: a.disclosures.map((d) => ({
    id: d.id,
    title: untrusted(`disclosure:${d.id}:title`, d.title),
    summary: untrusted(`disclosure:${d.id}:summary`, d.summary),
    severity: ifShaped('machine-code', d.severity),
    certifiedReward: d.certifiedReward,
    settlement: ifShaped('machine-code', d.settlement),
    researcher: untrusted(`disclosure:${d.id}:researcher`, d.username),
    publishedAt: d.publishedAt,
  })),
  moreDisclosures: a.nextCursor !== null,
});

/** Public activity; null when there is none to show (the API answers NOT_FOUND unless public and active). */
const readActivity = async (
  slug: string | null,
  { graphql, signal }: ToolContext,
): Promise<z.input<typeof ActivitySchema>> => {
  if (slug === null) return null;
  try {
    const { publicProgramActivity } = await graphql.request(GetProgramActivityDocument, { slug }, { signal });
    return toActivity(publicProgramActivity);
  } catch (error) {
    if (error instanceof BugSecureError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
};

export const getProgram = defineTool({
  name: 'get_program',
  title: 'Get a bug bounty programme',
  description:
    'Get one BugSecure programme by id or slug: description, rules, in-scope and out-of-scope targets, ' +
    'and the reward grid currently in force. Read the scope and rules before testing or reporting anything. ' +
    'activity: true adds its latest published disclosures, hall of fame and reward statistics. Its terms: ' +
    'get_program_terms.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      id: idInput('Programme id (from search_programs).').optional(),
      slug: z
        .string()
        .regex(SLUG_PATTERN, 'not a programme slug')
        .optional()
        .describe('Programme slug, as in its URL.'),
      activity: z
        .boolean()
        .default(false)
        .describe('Also return its public disclosures and reward statistics.'),
    })
    .refine((v) => (v.id === undefined) !== (v.slug === undefined), {
      message: 'Provide exactly one of `id` or `slug`.',
    }),
  output: z.object({ program: ProgramDetailSchema, activity: ActivitySchema }),
  async handler(input, context) {
    const { graphql, signal } = context;
    let program;
    if (input.id !== undefined) {
      ({ program } = await graphql.request(GetProgramDocument, { id: input.id }, { signal }));
    } else if (input.slug !== undefined) {
      ({ programBySlug: program } = await graphql.request(
        GetProgramBySlugDocument,
        { slug: input.slug },
        { signal },
      ));
    }
    if (!program) {
      throw new BugSecureError('NOT_FOUND', 'No programme with that id or slug is visible to this account.');
    }
    const detail = toProgramDetail(program);
    return {
      data: {
        program: detail,
        activity: input.activity ? await readActivity(detail.slug ?? null, context) : null,
      },
    };
  },
});
