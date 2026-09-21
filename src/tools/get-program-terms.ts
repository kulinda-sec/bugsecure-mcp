import * as z from 'zod';

import { GetTermsDocumentDocument, ListTermsVersionsDocument } from '../graphql/generated.js';
import { code, id, idInput, timestamp, wrapped } from './shared/common.js';
import { DEFAULT_TEXT_LIMIT, untrustedCapped } from './shared/report.js';
import { defineTool } from './define-tool.js';

const PLATFORM_KINDS = ['PLATFORM_RESEARCHER', 'PLATFORM_ORGANIZATION'] as const;

export const getProgramTerms = defineTool({
  name: 'get_program_terms',
  title: 'Get published terms',
  description:
    'The published terms a report is bound by: a programme’s own terms (programId), or BugSecure’s platform ' +
    'terms for researchers or organisations (kind). Lists every published version, newest first, and returns ' +
    'one in full (the newest unless versionId). Read-only: terms are accepted only on the BugSecure website.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      programId: idInput('A programme’s terms (from search_programs).').optional(),
      kind: z.enum(PLATFORM_KINDS).optional().describe('BugSecure’s platform terms instead.'),
      versionId: idInput('Which version to return in full (default: the newest).').optional(),
      fullText: z
        .boolean()
        .default(false)
        .describe(
          `Return the text whole, not cut at ${DEFAULT_TEXT_LIMIT.toLocaleString('en-US')} characters.`,
        ),
    })
    .refine((v) => (v.programId === undefined) !== (v.kind === undefined), {
      message: 'Provide exactly one of `programId` or `kind`.',
    }),
  output: z.object({
    versions: z.array(z.object({ id: id(), version: z.number().int(), publishedAt: timestamp() })),
    document: z
      .object({
        id: id(),
        kind: code('machine-code'),
        programId: id().nullable(),
        version: z.number().int(),
        publishedAt: timestamp(),
        body: wrapped('The full text; English governs.'),
      })
      .nullable()
      .describe('Null when nothing is published.'),
  }),
  async handler(input, { graphql, signal }) {
    const { termsVersions } = await graphql.request(
      ListTermsVersionsDocument,
      input.programId === undefined
        ? { kind: input.kind ?? 'PLATFORM_RESEARCHER', programId: null }
        : { kind: 'PROGRAMME', programId: input.programId },
      { signal },
    );
    const versionId = input.versionId ?? termsVersions[0]?.id;
    const document =
      versionId === undefined
        ? null
        : (await graphql.request(GetTermsDocumentDocument, { termsVersionId: versionId }, { signal }))
            .termsDocument;
    return {
      data: {
        versions: termsVersions.map((v) => ({ id: v.id, version: v.version, publishedAt: v.publishedAt })),
        document: document && {
          id: document.id,
          kind: document.kind,
          programId: document.programId,
          version: document.version,
          publishedAt: document.publishedAt,
          body: untrustedCapped(
            `terms:${document.id}`,
            document.body,
            input.fullText ? Number.MAX_SAFE_INTEGER : DEFAULT_TEXT_LIMIT,
          ),
        },
      },
    };
  },
});
