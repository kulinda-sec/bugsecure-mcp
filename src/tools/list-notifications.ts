import * as z from 'zod';

import type { NotificationType } from '../graphql/generated.js';
import { ListNotificationsDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, paginationInput, paginationOutput, page, timestamp, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 50;
const NOTIFICATION_TYPES = [
  'APPEAL_DECIDED',
  'APPEAL_RAISED',
  'BADGE_EARNED',
  'CERTIFICATE_ISSUED',
  'CERTIFICATE_OVERDUE',
  'INBOUND_EMAIL_RECEIVED',
  'KYC_STATUS_CHANGED',
  'LEVEL_UP',
  'NEW_REPORT_RECEIVED',
  'PROGRAM_PUBLISHED',
  'REPORT_ADJUDICATED',
  'REPORT_STATUS_CHANGED',
  'SECURITY_ALERT',
  'SETTLEMENT_ATTESTED',
  'SETTLEMENT_DISPUTED',
  'SUBSCRIPTION_ACTIVATED',
  'USER_PENDING_APPROVAL',
] as const satisfies readonly NotificationType[];

export const listNotifications = defineTool({
  name: 'list_notifications',
  title: 'List my notifications',
  description:
    'The signed-in user’s BugSecure notifications, newest first (report status changes, adjudications, ' +
    'appeals, certificates, badges…). Read-only: this does not mark them as read.',
  requiredScopes: ['profile:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    unreadOnly: z.boolean().default(false).describe('Only notifications not yet read.'),
    ...paginationInput(MAX_LIMIT),
  }),
  output: z.object({
    notifications: z.array(
      z.object({
        id: id(),
        type: z.enum(NOTIFICATION_TYPES),
        title: wrapped(),
        body: wrapped(),
        createdAt: timestamp(),
        readAt: timestamp().nullable(),
      }),
    ),
    ...paginationOutput,
  }),
  async handler(input, { graphql, signal }) {
    const { notifications } = await graphql.request(
      ListNotificationsDocument,
      { skip: input.offset, take: input.limit, unreadOnly: input.unreadOnly },
      { signal },
    );
    return {
      data: {
        notifications: notifications.map((n) => ({
          id: n.id,
          type: n.type,
          title: untrusted(`notification:${n.id}:title`, n.title),
          body: untrusted(`notification:${n.id}:body`, n.body),
          createdAt: n.createdAt,
          readAt: n.readAt,
        })),
        ...page(notifications.length, input),
      },
    };
  },
});
