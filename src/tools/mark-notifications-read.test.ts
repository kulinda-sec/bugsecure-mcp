import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_WEB_URL,
  fakeAgentApprovals,
  fakeGraphQL,
  type OperationHandler,
  withoutLookups,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';
import { partRequestId } from './shared/request-id.js';

const WRITER = ['notifications:write'] as const;

const api = (handlers: Record<string, OperationHandler> = {}) => {
  const approvals = fakeAgentApprovals('approve');
  return {
    approvals,
    graphql: fakeGraphQL({
      ...approvals.handlers,
      MarkNotificationRead: () => ({ markNotificationAsRead: true }),
      MarkAllNotificationsRead: () => ({ markAllNotificationsAsRead: true }),
      ...handlers,
    }),
  };
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('mark_notifications_read', () => {
  it('registers one part per notification for review, then marks exactly those ids, one key each', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('mark_notifications_read', { ids: ['n1', 'n9'] });

    expect(result.isError).toBeFalsy();
    const approval = approvals.created[0]!;
    expect(approval.parts).toEqual([
      { operation: 'markNotificationAsRead', arguments: { id: 'n1' } },
      { operation: 'markNotificationAsRead', arguments: { id: 'n9' } },
    ]);
    expect(harness.prompts[0]?.url).toBe(`${FAKE_WEB_URL}/agent-approvals/${approval.id}`);
    expect(harness.prompts[0]?.message).toContain('mark some of your notifications as read');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'MarkNotificationRead',
        variables: { id: 'n1', clientRequestId: partRequestId(approval.clientRequestId, 0) },
      },
      {
        operation: 'MarkNotificationRead',
        variables: { id: 'n9', clientRequestId: partRequestId(approval.clientRequestId, 1) },
      },
    ]);
    expect(result.structuredContent).toEqual({ all: false, markedIds: ['n1', 'n9'] });
  });

  it('sends a single notification with the approval’s own key', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    await harness.call('mark_notifications_read', { ids: ['n1'] });
    expect(withoutLookups(graphql.calls).map((c) => c.variables.clientRequestId)).toEqual([
      approvals.created[0]?.clientRequestId,
    ]);
  });

  it('marks all, as one part', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });

    const result = await harness.call('mark_notifications_read', { all: true });

    expect(approvals.created[0]?.parts).toEqual([{ operation: 'markAllNotificationsAsRead', arguments: {} }]);
    expect(harness.prompts[0]?.message).toContain('mark all your notifications as read');
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'MarkAllNotificationsRead',
        variables: { clientRequestId: approvals.created[0]?.clientRequestId },
      },
    ]);
    expect(result.structuredContent).toEqual({ all: true, markedIds: [] });
  });

  it('says which were marked when BugSecure refuses one part-way', async () => {
    const { graphql } = api({
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
    const { graphql } = api({
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

  it('looks nothing up for display, and sends nothing if the user does not open the page', async () => {
    const { graphql, approvals } = api();
    harness = await connectTools({ graphql, grantedScopes: [...WRITER], open: 'decline' });

    const result = await harness.call('mark_notifications_read', { ids: ['n1'] });

    expect(result.isError).toBe(true);
    expect(approvals.created).toHaveLength(1);
    expect(graphql.calls.map((c) => c.operation)).not.toContain('GetUnreadNotifications');
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('needs ids or all, not both, before registering anything', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...WRITER] });
    for (const args of [{}, { all: true, ids: ['n1'] }, { ids: [] }, { ids: ['bad id'] }]) {
      expect((await harness.call('mark_notifications_read', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.prompts).toHaveLength(0);
    expect(graphql.calls).toEqual([]);
  });
});

describe('mark_notifications_read — the call’s deadline', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('stops before a part whose write could not answer in time, and says which were marked', async () => {
    const { graphql, approvals } = api({
      MarkNotificationRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { markNotificationAsRead: true };
      },
    });
    // Room for one write attempt (the API timeout, 1 s, which is also the least an attempt is given), the
    // answer, and 150 ms of slack for the status read: the first part goes (and takes 250 ms), so the second
    // can no longer be given a full attempt before the answer is due and is not started.
    harness = await connectTools({
      graphql,
      grantedScopes: [...WRITER],
      timing: { deadlineAt: () => Date.now() + 1_000 + 2_000 + 150, writeTimeoutMs: 1_000 },
    });
    const result = await harness.call('mark_notifications_read', { ids: ['n1', 'n2', 'n3'] });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Marked n1 read, then n2 failed; the rest were not sent.');
    expect(text).toContain('Part 2 of 3 was not sent');
    expect(text).toContain('Call the tool again for what remains');
    expect(graphql.calls.filter((c) => c.operation === 'MarkNotificationRead')).toHaveLength(1);
    expect(approvals.created).toHaveLength(1);
  });

  it('reports a part whose answer did not arrive in time as an unknown outcome, after the parts it confirmed', async () => {
    let sent = 0;
    const { graphql } = api({
      MarkNotificationRead: () => {
        sent += 1;
        // n1 answers; n2 is committed but its answer never comes before the call's deadline.
        return sent === 1 ? { markNotificationAsRead: true } : new Promise(() => undefined);
      },
    });
    harness = await connectTools({
      graphql,
      grantedScopes: [...WRITER],
      timing: { deadlineAt: () => Date.now() + 1_000 + 2_000 + 150, writeTimeoutMs: 1_000 },
    });
    const result = await harness.call('mark_notifications_read', { ids: ['n1', 'n2', 'n3'] });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Marked n1 read, then n2 failed; the rest were not sent.');
    expect(text).toContain('no time left to resend it');
    expect(text).toContain('may already have been made');
    expect(text).not.toContain('unexpected error');
    expect(graphql.calls.filter((c) => c.operation === 'MarkNotificationRead')).toHaveLength(2);
  });
});
