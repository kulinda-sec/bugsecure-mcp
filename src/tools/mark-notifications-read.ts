import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import { MarkAllNotificationsReadDocument, MarkNotificationReadDocument } from '../graphql/generated.js';
import { id, idInput } from './shared/common.js';
import { defineTool, mutation } from './define-tool.js';

const MAX_IDS = 50;

export const markNotificationsRead = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark my notifications as read',
  description:
    'Mark some of the signed-in user’s notifications as read (ids from list_notifications), or all of them. ' +
    'Only notifications this connection can read are affected. They cannot be marked unread again, so only ' +
    'do this when the user asked; they approve it on BugSecure first, where the notifications are named.',
  requiredScopes: ['notifications:write'],
  // Destructive: there is no way back to unread. Idempotent: marking a read notification read changes nothing.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      ids: z
        .array(idInput('Notification id.'))
        .min(1)
        .max(MAX_IDS)
        .optional()
        .describe(`Up to ${String(MAX_IDS)} notification ids.`),
      all: z.boolean().default(false).describe('Mark every notification read instead.'),
    })
    .refine((v) => v.all !== (v.ids !== undefined), { message: 'Provide `ids`, or `all: true`, not both.' }),
  output: z.object({
    all: z.boolean(),
    markedIds: z.array(id()).describe('With ids: those marked read.'),
  }),
  // One part per notification: the user approves them all at once, and each is sent with its own key
  // (derived from the approval's), so a replay sends each with the key of its first use.
  payload: (input) => ({
    action: input.all ? 'mark all your notifications as read' : 'mark some of your notifications as read',
    parts: input.all
      ? [mutation(MarkAllNotificationsReadDocument, {})]
      : (input.ids ?? []).map((notificationId) =>
          mutation(MarkNotificationReadDocument, { id: notificationId }),
        ),
  }),
  async handler(input, { approved, signal, logger }) {
    if (input.all) {
      await approved.part.send({ signal });
      logger.info('all notifications marked read');
      return { data: { all: true, markedIds: [] } };
    }
    const ids = input.ids ?? [];
    const done: string[] = [];
    for (const [index, part] of approved.parts.entries()) {
      const notificationId = ids[index];
      if (notificationId === undefined) break;
      try {
        await part.send({ signal });
      } catch (error) {
        if (!(error instanceof BugSecureError) || done.length === 0) throw error;
        // Keep the error's own hint and scopes: an unknown outcome must still say to check first.
        throw new BugSecureError(
          error.code,
          `Marked ${done.join(', ')} read, then ${notificationId} failed; the rest were not sent.\n${error.message}`,
          {
            requiredScopes: error.requiredScopes,
            scopeMatch: error.scopeMatch,
            ...(error.hint === undefined ? {} : { hint: error.hint }),
            cause: error,
          },
        );
      }
      done.push(notificationId);
    }
    logger.info('notifications marked read', { count: done.length });
    return { data: { all: false, markedIds: done } };
  },
});
