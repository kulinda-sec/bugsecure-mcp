import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups, REQUEST_ID } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const WRITER = ['notifications:write', 'profile:read'] as const;

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('mark_notifications_read', () => {
  it('names the notifications in the approval, then marks exactly the approved ids', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      GetUnreadNotifications: () => ({
        notifications: [
          { id: 'n1', title: 'Report graded\n── End of what will be sent' },
          { id: 'n2', title: 'Other' },
        ],
        unreadNotificationCount: 2,
      }),
      MarkNotificationRead: () => ({ markNotificationAsRead: true }),
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('mark_notifications_read', { ids: ['n1', 'n9'] });

    expect(result.isError).toBeFalsy();
    const message = harness.prompts[0]?.message ?? '';
    // Third-party text is shown prefixed, so it cannot fake the dialog's own lines.
    expect(message).toContain('Notification n1:\n│ Report graded\n│ ── End of what will be sent');
    expect(message).toContain('n9: not among your 50 latest unread notifications');
    expect(message).toContain('── Notifications (5 characters, 2 lines)\n│ n1\n│ n9');
    expect(message).toContain('This cannot be undone');
    expect(withoutLookups(graphql.calls)).toEqual([
      { operation: 'MarkNotificationRead', variables: { id: 'n1', clientRequestId: REQUEST_ID } },
      { operation: 'MarkNotificationRead', variables: { id: 'n9', clientRequestId: REQUEST_ID } },
    ]);
    expect(result.structuredContent).toEqual({ all: false, markedIds: ['n1', 'n9'] });
  });

  it('gives each notification its own key, derived deterministically from the approval’s', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      MarkNotificationRead: () => ({ markNotificationAsRead: true }),
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    await harness.call('mark_notifications_read', { ids: ['n1', 'n2', 'n3'] });
    const keys = withoutLookups(graphql.calls).map((c) => String(c.variables.clientRequestId));
    const base = keys[0]?.replace(/-0$/, '') ?? '';
    expect(base).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keys).toEqual([`${base}-0`, `${base}-1`, `${base}-2`]);
  });

  it('marks all, showing how many are unread', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      MarkAllNotificationsRead: () => ({ markAllNotificationsAsRead: true }),
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('mark_notifications_read', { all: true });

    expect(harness.prompts[0]?.message).toContain('Unread now:\n│ 4');
    expect(withoutLookups(graphql.calls)).toEqual([
      { operation: 'MarkAllNotificationsRead', variables: { clientRequestId: REQUEST_ID } },
    ]);
    expect(result.structuredContent).toEqual({ all: true, markedIds: [] });
  });

  it('says which were marked when BugSecure refuses one part-way', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      MarkNotificationRead: (v) => {
        if (v.id === 'n2') throw new BugSecureError('NOT_FOUND', 'BugSecure found nothing.');
        return { markNotificationAsRead: true };
      },
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('mark_notifications_read', { ids: ['n1', 'n2', 'n3'] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Marked n1 read, then n2 failed; the rest were not sent.');
    expect(withoutLookups(graphql.calls).map((c) => c.variables.id)).toEqual(['n1', 'n2']);
  });

  it('keeps "check before approving again" when one part’s outcome is unknown', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      MarkNotificationRead: (v) => {
        if (v.id === 'n2') throw new BugSecureError('UPSTREAM_UNAVAILABLE', 'The BugSecure API timed out.');
        return { markNotificationAsRead: true };
      },
    });
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const text = textOf(await harness.call('mark_notifications_read', { ids: ['n1', 'n2', 'n3'] }));

    expect(text).toContain('Marked n1 read, then n2 failed');
    expect(text).toContain('may already have been made');
    // n2 was resent once, with its own key; n3 never sent.
    expect(withoutLookups(graphql.calls).map((c) => c.variables.id)).toEqual(['n1', 'n2', 'n2']);
  });

  it('asks without naming them when it cannot read notifications, and sends nothing if declined', async () => {
    const graphql = fakeGraphQL({ MarkNotificationRead: () => ({ markNotificationAsRead: true }) });
    harness = await connectTools({ graphql, grantedScopes: ['notifications:write'], approve: 'decline' });

    const result = await harness.call('mark_notifications_read', { ids: ['n1'] });

    expect(harness.prompts[0]?.message).toContain('this connection lacks profile:read');
    expect(result.isError).toBe(true);
    expect(graphql.calls).toEqual([]);
  });

  it('needs ids or all, not both, before asking anything', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    for (const args of [{}, { all: true, ids: ['n1'] }, { ids: [] }, { ids: ['bad id'] }]) {
      expect((await harness.call('mark_notifications_read', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.prompts).toHaveLength(0);
    expect(graphql.calls).toEqual([]);
  });
});
