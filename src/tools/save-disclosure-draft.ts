import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { GetReportDisclosureDocument, SaveDisclosureDraftDocument } from '../graphql/generated.js';
import { idInput, userText } from './shared/common.js';
import { DisclosureSchema, toDisclosure } from './shared/disclosure.js';
import { DEFAULT_TEXT_LIMIT } from './shared/report.js';
import { defineTool, mutation, type ToolContext } from './define-tool.js';

interface Input {
  readonly reportId: string;
  readonly revision: number;
}

/**
 * Refuses before asking, and again before sending, when the draft cannot be
 * saved from here: not the user's side, not disclosable, already published,
 * or changed since the model read it (the revision check). The review page
 * shows the current draft next to the new text.
 */
const checkDraft = async (input: Input, { graphql, signal }: ToolContext): Promise<void> => {
  const { reportDisclosureDraft: state } = await graphql.request(
    GetReportDisclosureDocument,
    { reportId: input.reportId },
    { signal },
  );
  if (state === null)
    throw new BugSecureError(
      'CONFLICT',
      'Nothing was sent: this report cannot have a public disclosure (it must be fixed or closed, on a public programme, and graded), or it is not yours.',
    );
  if (state.side !== 'researcher')
    throw new BugSecureError(
      'NOT_FOUND',
      'Nothing was sent: that is not one of your own reports. Only the researcher’s draft can be edited here.',
    );
  const d = state.draft;
  if (d?.publishedAt !== null && d?.publishedAt !== undefined)
    throw new BugSecureError(
      'FORBIDDEN',
      'Nothing was sent: this disclosure is published. Changing it would take it down; do that on the BugSecure website.',
    );
  const revision = d?.revision ?? 0;
  if (revision !== input.revision)
    throw new BugSecureError(
      'CONFLICT',
      `Nothing was sent: the draft is now at revision ${String(revision)}, not ${String(input.revision)}. Read it again with get_report and redo the edit on top of it.`,
    );
};

export const saveDisclosureDraft = defineTool({
  name: 'save_disclosure_draft',
  title: 'Save the public disclosure draft of my report',
  description:
    'Write the public disclosure draft of one of the signed-in researcher’s own reports (fixed or closed, ' +
    'on a public programme, graded): title, summary and write-up, replacing the current draft. Saving NEVER ' +
    'publishes: it clears any approval, and the disclosure goes public only when the researcher and the ' +
    'organisation both approve it on the BugSecure website. A published disclosure is refused. Read the ' +
    'draft and its revision with get_report first; the user approves the new text on BugSecure, next to the old.',
  requiredScopes: ['disclosures:write'],
  // Destructive: replaces the previous draft and clears approvals. Not idempotent: each save bumps the revision.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    reportId: idInput('Your report (get_report).'),
    revision: z
      .number()
      .int()
      .min(0)
      .max(2_147_483_646)
      .describe('get_report → disclosure.revision (0 when there is no draft yet).'),
    title: userText(3, 160, 'Public title (3–160 characters).'),
    summary: userText(10, 500, 'Public summary (10–500 characters).'),
    writeup: userText(20, 20_000, 'Public write-up (20–20,000 characters).'),
    creditResearcher: z.boolean().describe('Show your username on the published disclosure.'),
  }),
  output: z.object({ disclosure: DisclosureSchema.nullable() }),
  payload: async (input, context) => {
    await checkDraft(input, context);
    return {
      action: 'save the public disclosure draft of one of your reports (not publish it)',
      parts: [
        mutation(SaveDisclosureDraftDocument, {
          input: {
            reportId: input.reportId,
            revision: input.revision,
            title: input.title,
            summary: input.summary,
            writeup: input.writeup,
            creditResearcher: input.creditResearcher,
          },
        }),
      ],
    };
  },
  async handler(input, { approved, signal, logger }) {
    const { saveReportDisclosure } = await approved.part.send({ signal });
    logger.info('disclosure draft saved', { reportId: input.reportId });
    return { data: { disclosure: toDisclosure(input.reportId, saveReportDisclosure, DEFAULT_TEXT_LIMIT) } };
  },
});
