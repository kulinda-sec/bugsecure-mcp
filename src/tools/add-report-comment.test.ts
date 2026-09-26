import { afterEach, describe, expect, it } from 'vitest';

import {
  fakeGraphQL,
  idempotentWrite,
  lookups,
  withoutLookups,
  REQUEST_ID,
} from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { BugSecureError } from '../errors.js';

const posted = { id: 'c9', reportId: 'r1', isInternal: false, createdAt: '2026-09-21T10:00:00.000Z' };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('add_report_comment', () => {
  it('posts a public comment as the researcher', async () => {
    const graphql = fakeGraphQL({ AddReportComment: () => ({ addReportComment: posted }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('add_report_comment', {
      reportId: 'r1',
      content: ' Here is the account. ',
    });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([
      {
        operation: 'AddReportComment',
        variables: {
          input: { reportId: 'r1', content: 'Here is the account.', isInternal: false },
          clientRequestId: REQUEST_ID,
        },
      },
    ]);
    expect(result.structuredContent).toEqual({
      comment: { id: 'c9', reportId: 'r1', internal: false, createdAt: posted.createdAt },
    });
  });

  it('never accepts an internal flag from the researcher side', async () => {
    const graphql = fakeGraphQL({ AddReportComment: () => ({ addReportComment: posted }) });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    await harness.call('add_report_comment', {
      reportId: 'r1',
      content: 'hi',
      internal: true,
      isInternal: true,
    });
    expect(graphql.calls[0]?.variables).toMatchObject({ input: { isInternal: false } });
  });

  it('rejects invalid arguments before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect((await harness.call('add_report_comment', { reportId: 'r1', content: '   ' })).isError).toBe(true);
    expect(
      (await harness.call('add_report_comment', { reportId: 'r1', content: 'x'.repeat(10_001) })).isError,
    ).toBe(true);
    expect((await harness.call('add_report_comment', { content: 'hi' })).isError).toBe(true);
    expect(graphql.calls).toHaveLength(0);
  });

  it('turns an insufficient-scope API error into actionable guidance', async () => {
    const graphql = fakeGraphQL({
      AddReportComment: () => {
        throw new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', {
          requiredScopes: ['reports:write', 'triage:write'],
        });
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    expect(textOf(await harness.call('add_report_comment', { reportId: 'r1', content: 'hi' }))).toContain(
      'login --scopes "reports:write triage:write"',
    );
  });
  const done = () => ({
    addReportComment: { id: 'c9', reportId: 'r1', isInternal: false, createdAt: '2026-09-21T10:00:00.000Z' },
  });

  it('posts only on the user’s own report, checked before asking', async () => {
    const graphql = fakeGraphQL({ ...lookups({ reporterId: 'someone-else' }), AddReportComment: done });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    const result = await harness.call('add_report_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not one of your own reports');
    expect(harness.prompts).toHaveLength(0);
    expect(withoutLookups(graphql.calls)).toEqual([]);
  });

  it('shows the report’s title, and posts on the user’s own report', async () => {
    const graphql = fakeGraphQL({ ...lookups(), AddReportComment: done });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'reports:read'] });
    expect((await harness.call('add_report_comment', { reportId: 'r1', content: 'hi' })).isError).toBeFalsy();
    expect(harness.prompts[0]?.message).toContain('Report:\n│ Stored XSS in profile');
  });

  it('refuses when it could post on either side and cannot read the report to tell which', async () => {
    const graphql = fakeGraphQL({ AddReportComment: done });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write', 'triage:write'] });
    const result = await harness.call('add_report_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(graphql.calls).toEqual([]);
  });

  it('resends a comment whose answer was lost after BugSecure posted it, with the same key: one comment', async () => {
    const write = idempotentWrite(() => ({ addReportComment: posted }), { drop: 1 });
    const graphql = fakeGraphQL({ AddReportComment: write });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('add_report_comment', { reportId: 'r1', content: 'Hello' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ comment: { id: 'c9' } });
    expect(harness.prompts).toHaveLength(1);
    const keys = graphql.calls.map((c) => c.variables.clientRequestId);
    expect(keys).toEqual([REQUEST_ID, keys[0]]);
    expect(write.writes()).toBe(1);
  });

  it('says the comment may have been posted when the resend gets no answer either', async () => {
    const write = idempotentWrite(() => ({ addReportComment: posted }), { drop: 2 });
    const graphql = fakeGraphQL({ AddReportComment: write });
    harness = await connectTools({ graphql, grantedScopes: ['reports:write'] });

    const result = await harness.call('add_report_comment', { reportId: 'r1', content: 'Hello' });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('may already have been made');
    expect(text).toContain('do not ask the user to approve it again');
    expect(text).toContain('get_report');
    expect(text).not.toContain('retry shortly');
    expect(graphql.calls).toHaveLength(2);
    expect(write.writes()).toBe(1);
  });
});
