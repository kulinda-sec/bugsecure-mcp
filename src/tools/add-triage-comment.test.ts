import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL, lookups, withoutLookups, REQUEST_ID } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

/** triage:write, plus profile:read for the staff check. */
const TRIAGER = ['triage:write', 'profile:read'] as const;

const posted = (isInternal: boolean) => ({
  addReportComment: { id: 'c9', reportId: 'r1', isInternal, createdAt: '2026-09-21T10:00:00.000Z' },
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('add_triage_comment', () => {
  it('posts an organization-only (internal) note by default, and says so in the approval', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AddTriageComment: () => posted(true) });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    const result = await harness.call('add_triage_comment', {
      reportId: 'r1',
      content: 'Likely dupe.',
    });

    expect(result.isError).toBeFalsy();
    expect(withoutLookups(graphql.calls)).toEqual([
      {
        operation: 'AddTriageComment',
        variables: {
          input: { reportId: 'r1', content: 'Likely dupe.', isInternal: true },
          clientRequestId: REQUEST_ID,
        },
      },
    ]);
    expect(result.structuredContent).toMatchObject({ comment: { id: 'c9', internal: true } });
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('internal note');
    expect(message).toContain('The researcher does NOT see it.');
    expect(message).toContain('Likely dupe.');
  });

  it('posts to the researcher only with visibleToResearcher: true, shown prominently', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AddTriageComment: () => posted(false) });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    const result = await harness.call('add_triage_comment', {
      reportId: 'r1',
      content: 'Thanks, reproducing.',
      visibleToResearcher: true,
    });

    expect(withoutLookups(graphql.calls)[0]?.variables).toMatchObject({ input: { isInternal: false } });
    expect(result.structuredContent).toMatchObject({ comment: { internal: false } });
    const message = harness.prompts[0]?.message ?? '';
    // The audience line comes right after the headline, before the payload.
    expect(message.split('\n')[2]).toBe(
      'VISIBLE TO THE RESEARCHER, who is notified. Also seen by your organisation.',
    );
  });

  it('sends nothing when the user declines', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AddTriageComment: () => posted(true) });
    harness = await connectTools({
      graphql,
      grantedScopes: [...TRIAGER],
      viewerId: 'triager-1',
      approve: 'decline',
    });

    const result = await harness.call('add_triage_comment', { reportId: 'r1', content: 'x' });
    expect(result.isError).toBe(true);
    expect(withoutLookups(graphql.calls)).toHaveLength(0);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect((await harness.call('add_triage_comment', { reportId: 'r1', content: '' })).isError).toBe(true);
    expect(
      (await harness.call('add_triage_comment', { reportId: 'r1', content: 'x', visibleToResearcher: 'yes' }))
        .isError,
    ).toBe(true);
    expect(withoutLookups(graphql.calls)).toHaveLength(0);
  });

  it('explains an organization that has not opted in to AI triage access', async () => {
    const graphql = fakeGraphQL({
      ...lookups(),
      AddTriageComment: () => {
        throw new BugSecureError(
          'ORG_AI_ACCESS_DISABLED',
          'This organization has not enabled AI triage access.',
        );
      },
    });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });

    expect(textOf(await harness.call('add_triage_comment', { reportId: 'r1', content: 'hi' }))).toContain(
      'AI triage access',
    );
  });
  it('refuses a BugSecure staff account', async () => {
    const graphql = fakeGraphQL({
      ...lookups({ roles: ['PLATFORM_ROLE_A'] }),
      AddTriageComment: () => posted(true),
    });
    harness = await connectTools({ graphql, grantedScopes: [...TRIAGER], viewerId: 'triager-1' });
    const result = await harness.call('add_triage_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('BugSecure staff role;');
    expect(harness.prompts).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('refuses the user’s own report (it would post as the researcher), pointing at add_report_comment', async () => {
    const graphql = fakeGraphQL({
      ...lookups({ reporterId: 'triager-1' }),
      AddTriageComment: () => posted(true),
    });
    harness = await connectTools({
      graphql,
      grantedScopes: [...TRIAGER, 'triage:read'],
      viewerId: 'triager-1',
    });
    const result = await harness.call('add_triage_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('add_report_comment');
  });

  it('refuses when it could post on either side and cannot read the report to tell which', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AddTriageComment: () => posted(true) });
    harness = await connectTools({
      graphql,
      grantedScopes: [...TRIAGER, 'reports:write'],
      viewerId: 'triager-1',
    });
    const result = await harness.call('add_triage_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^Nothing was sent: this connection can comment as a researcher and as an organisation/,
    );
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });
});
