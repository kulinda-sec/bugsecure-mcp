import * as z from 'zod';

import type { NotificationType } from '../graphql/generated.js';
import { ListNotificationsDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import {
  code,
  id,
  ifShaped,
  paginationInput,
  paginationOutput,
  page,
  timestamp,
  wrapped,
} from './shared/common.js';
import { defineTool } from './define-tool.js';

const MAX_LIMIT = 50;

/**
 * The kinds BugSecure sends today, for the output description only. BugSecure adds kinds
 * without notice (ORGANIZATION_INVITATION and SETTLEMENT_CONFIRMED arrived after this tool),
 * so the output is not a closed enum: a closed one would fail the whole page, every
 * notification with it, the day a new kind appears. Any machine code passes; a value that
 * is not one comes out as null rather than failing the page.
 */
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
  'ORGANIZATION_INVITATION',
  'PROGRAM_PUBLISHED',
  'REPORT_ADJUDICATED',
  'REPORT_STATUS_CHANGED',
  'SECURITY_ALERT',
  'SETTLEMENT_ATTESTED',
  'SETTLEMENT_CONFIRMED',
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
        type: code('machine-code')
          .nullable()
          .describe(
            `The kind of notification: one of ${NOTIFICATION_TYPES.join(', ')}, or a kind added since ` +
              '(treat an unknown one like a generic notification).',
          ),
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
          type: ifShaped('machine-code', n.type),
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
