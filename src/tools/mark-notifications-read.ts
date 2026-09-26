import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import {
  GetUnreadNotificationsDocument,
  MarkAllNotificationsReadDocument,
  MarkNotificationReadDocument,
} from '../graphql/generated.js';
import type { ApprovalPrompt } from './approval.js';
import { id, idInput } from './shared/common.js';
import { partRequestId } from './shared/request-id.js';
import { defineTool, type ToolContext } from './define-tool.js';

const MAX_IDS = 50;

/** Titles of the notifications about to be marked read, when this connection can read them. */
const describeTargets = async (
  input: { ids?: string[] | undefined; all: boolean },
  { graphql, signal, granted }: ToolContext,
): Promise<Pick<ApprovalPrompt, 'context' | 'notes'>> => {
  if (!granted.has('profile:read'))
    return { notes: ['The notifications are not named: this connection lacks profile:read.'] };
  let unread;
  try {
    unread = await graphql.request(GetUnreadNotificationsDocument, {}, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { notes: ['Could not look up your notifications; only ids are shown.'] };
  }
  if (input.all) return { context: [['Unread now', String(unread.unreadNotificationCount)]] };
  const titles = new Map(unread.notifications.map((n) => [n.id, n.title]));
  const unknown = (input.ids ?? []).filter((i) => !titles.has(i));
  return {
    context: (input.ids ?? []).map((i) => [`Notification ${i}`, titles.get(i)]),
    notes:
      unknown.length > 0
        ? [
            `${unknown.join(', ')}: not among your 50 latest unread notifications (already read, or not visible here).`,
          ]
        : [],
  };
};

export const markNotificationsRead = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark my notifications as read',
  description:
    'Mark some of the signed-in user’s notifications as read (ids from list_notifications), or all of them. ' +
    'Only notifications this connection can read are affected. They cannot be marked unread again, so only ' +
    'do this when the user asked; they approve it first.',
  requiredScopes: ['notifications:write'],
  // Reading them names them in the approval.
  optionalScopes: ['profile:read'],
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
  approval: async (input, context) => ({
    action: input.all
      ? 'mark all your notifications as read'
      : `mark ${String(input.ids?.length ?? 0)} of your notifications as read`,
    audience: 'Only you see notifications; BugSecure stops showing these as unread.',
    irreversible: true,
    ...(await describeTargets(input, context)),
    fields: [['Notifications', input.all ? 'all' : (input.ids ?? []).join('\n')]],
  }),
  async handler(input, { graphql, signal, logger, clientRequestId }) {
    if (input.all) {
      await graphql.request(MarkAllNotificationsReadDocument, { clientRequestId }, { signal });
      logger.info('all notifications marked read');
      return { data: { all: true, markedIds: [] } };
    }
    const done: string[] = [];
    for (const [index, notificationId] of (input.ids ?? []).entries()) {
      try {
        // One key per notification, derived from the approval's, so a replay sends each with the
        // key of its first use (which the API answers from its record).
        await graphql.request(
          MarkNotificationReadDocument,
          { id: notificationId, clientRequestId: partRequestId(clientRequestId, index) },
          { signal },
        );
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
