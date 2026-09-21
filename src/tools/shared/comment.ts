import * as z from 'zod';

import type { AddReportCommentMutation } from '../../graphql/generated.js';
import { id, timestamp, userText } from './common.js';

/** Comment text as the API accepts it. */
export const commentContent = userText(1, 10_000, 'Comment text (1–10,000 characters, Markdown).');

export const PostedCommentSchema = z.object({
  id: id(),
  reportId: id(),
  internal: z.boolean().describe('An organisation-only note the researcher cannot see.'),
  createdAt: timestamp(),
});

export const toPostedComment = (
  c: AddReportCommentMutation['addReportComment'],
): z.input<typeof PostedCommentSchema> => {
  return { id: c.id, reportId: c.reportId, internal: c.isInternal, createdAt: c.createdAt };
};
