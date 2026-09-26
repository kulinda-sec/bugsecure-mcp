/**
 * Approval of write tools through MCP elicitation (2026-07-28 multi
 * round-trip requests), including the retries a real client could tamper with.
 */
import { randomBytes } from 'node:crypto';

import { type Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeGraphQL, type FakeGraphQL, lookups } from '../../test/helpers/fake-graphql.js';
import { REPORTER_ID } from '../../test/helpers/report-fixtures.js';
import {
  LOOKED_UP,
  ORG_SIDE_WRITE_TOOLS,
  SAMPLE_ARGS,
  WRITE_OPERATION,
} from '../../test/helpers/sample-args.js';
import {
  type ApprovalAnswer,
  connectTools,
  elicitingClient,
  type ElicitationPrompt,
  type Harness,
  textOf,
} from '../../test/helpers/tool-harness.js';
import { silentLogger } from '../logger.js';
import { SCOPES } from '../scopes.js';
import { buildServer } from '../server.js';
import {
  ApprovalGate,
  ApprovalReplayGuard,
  APPROVAL_TTL_SECONDS,
  MAX_APPROVAL_CHARACTERS,
  renderApprovalMessage,
  supportsFormElicitation,
  VALUE_PREFIX,
} from './approval.js';
import { isWriteTool } from './define-tool.js';
import { ALL_TOOLS } from './index.js';
import { CLIENT_REQUEST_ID } from './shared/request-id.js';

const posted = { id: 'c9', reportId: 'r1', isInternal: false, createdAt: '2026-09-21T10:00:00.000Z' };
const API = {
  ...lookups(),
  ListMyReports: () => ({ reports: [] }),
  AddReportComment: () => ({ addReportComment: posted }),
  AddTriageComment: () => ({ addReportComment: { ...posted, isInternal: true } }),
  SubmitReport: () => ({
    submitReport: {
      id: 'r1',
      title: 't',
      status: 'NEW',
      claimedSeverity: 'HIGH',
      claimedCvssScore: null,
      createdAt: posted.createdAt,
      program: null,
    },
  }),
  RaiseAppeal: () => ({
    raiseAppeal: {
      id: 'ap1',
      reportId: 'r1',
      adjudicationId: 'a1',
      status: 'OPEN',
      createdAt: posted.createdAt,
    },
  }),
  UpdateReportStatus: () => ({
    updateReportStatus: { id: 'r1', status: 'IN_TRIAGE', duplicateOfId: null, updatedAt: posted.createdAt },
  }),
  GradeReport: () => ({ adjudicateReport: null }),
  MarkNotificationRead: () => ({ markNotificationAsRead: true }),
  UpdateMyProfile: () => ({
    updateResearcherProfile: { bio: 'I hunt stored XSS.', website: '', country: 'Kenya' },
  }),
  SaveDisclosureDraft: () => ({ saveReportDisclosure: null }),
  AssignReport: () => ({
    assignTriageAnalyst: {
      id: 'r1',
      assignedTriage: { id: 'triager-1', username: 'tri' },
      updatedAt: posted.createdAt,
    },
  }),
};

const WRITE_TOOLS = ALL_TOOLS.filter(isWriteTool).map((t) => t.name);
const viewerFor = (name: string): string => (ORG_SIDE_WRITE_TOOLS.has(name) ? 'triager-1' : REPORTER_ID);
const writesIn = (graphql: FakeGraphQL): string[] =>
  graphql.calls.map((c) => c.operation).filter((op) => Object.values(WRITE_OPERATION).includes(op));

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('every write tool', () => {
  it('is covered by this suite', () => {
    expect(WRITE_TOOLS.sort()).toEqual([
      'add_report_comment',
      'add_triage_comment',
      'assign_report',
      'grade_report',
      'mark_notifications_read',
      'raise_appeal',
      'save_disclosure_draft',
      'submit_report',
      'update_my_profile',
      'update_report_status',
    ]);
  });

  it.each(WRITE_TOOLS)('%s shows every value it will send, and sends only after approval', async (name) => {
    const graphql = fakeGraphQL(API);
    harness = await connectTools({ graphql, viewerId: viewerFor(name) });
    const args = SAMPLE_ARGS[name] ?? {};

    const result = await harness.call(name, args);

    expect(result.isError).toBeFalsy();
    expect(harness.prompts).toHaveLength(1);
    const message = harness.prompts[0]?.message ?? '';
    for (const value of Object.values(args)) expect(message).toContain(String(value));
    expect(harness.prompts[0]?.requestedSchema).toMatchObject({
      type: 'object',
      properties: { approve: { type: 'boolean', default: false } },
      required: ['approve'],
    });
    expect(writesIn(graphql)).toEqual([WRITE_OPERATION[name]]);
  });

  it.each(WRITE_TOOLS)("%s sends its write with the approval's idempotency key", async (name) => {
    const graphql = fakeGraphQL(API);
    harness = await connectTools({ graphql, viewerId: viewerFor(name) });
    await harness.call(name, SAMPLE_ARGS[name] ?? {});
    const writes = graphql.calls.filter((c) => c.operation === WRITE_OPERATION[name]);
    expect(writes).toHaveLength(1);
    const key = writes[0]?.variables.clientRequestId;
    expect(key).toEqual(expect.stringMatching(CLIENT_REQUEST_ID));
    // A second, separately approved call is a new write: a new key.
    await harness.call(name, SAMPLE_ARGS[name] ?? {});
    const again = graphql.calls.filter((c) => c.operation === WRITE_OPERATION[name]);
    expect(again).toHaveLength(2);
    expect(again[1]?.variables.clientRequestId).not.toBe(key);
  });

  it.each(WRITE_TOOLS)('%s names what the ids refer to, looked up read-only', async (name) => {
    harness = await connectTools({ graphql: fakeGraphQL(API), viewerId: viewerFor(name) });
    await harness.call(name, SAMPLE_ARGS[name] ?? {});
    const message = harness.prompts[0]?.message ?? '';
    expect(message).toContain('For context (looked up on BugSecure, not sent):');
    expect(message).toContain(`${VALUE_PREFIX}${LOOKED_UP[name] ?? 'Stored XSS in profile'}`);
  });

  it.each(WRITE_TOOLS)('%s still asks, showing ids only, when the lookups fail', async (name) => {
    const failing = Object.fromEntries(
      [
        'GetReportRef',
        'GetProgramRef',
        'GetAppealTarget',
        'GetUnreadNotifications',
        'GetMyProfileRef',
        'GetReportDisclosure',
      ].map((op) => [
        op,
        () => {
          throw new Error('lookup down');
        },
      ]),
    );
    const graphql = fakeGraphQL({ ...API, ...failing });
    harness = await connectTools({
      graphql,
      viewerId: viewerFor(name),
      // One side's write scope only, so the side is never ambiguous without the lookup.
      grantedScopes: SCOPES.filter((s) =>
        ORG_SIDE_WRITE_TOOLS.has(name) ? s !== 'reports:write' : s !== 'triage:write',
      ),
    });
    const result = await harness.call(name, SAMPLE_ARGS[name] ?? {});
    expect(result.isError).toBeFalsy();
    expect(harness.prompts[0]?.message).toMatch(/Could not look up/);
    expect(writesIn(graphql)).toEqual([WRITE_OPERATION[name]]);
  });

  const refusals: readonly ApprovalAnswer[] = ['decline', 'cancel', 'accept-unticked', 'none'];
  it.each(WRITE_TOOLS.flatMap((n) => refusals.map((a) => [n, a] as const)))(
    '%s sends nothing when the answer is %s',
    async (name, approve) => {
      const graphql = fakeGraphQL(API);
      harness = await connectTools({ graphql, approve, viewerId: viewerFor(name) });

      const result = await harness.call(name, SAMPLE_ARGS[name] ?? {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Nothing was sent/);
      expect(writesIn(graphql)).toEqual([]);
    },
  );
});

describe('approval prompt', () => {
  it('frames the exact payload, shows who sees it and makes invisible characters visible', () => {
    const message = renderApprovalMessage({
      action: 'comment on your report r1',
      audience: 'Seen by the organization.',
      irreversible: true,
      fields: [
        ['Report', 'r1'],
        ['Skipped', undefined],
        ['Comment', 'hello\u200Bworld\u202E!'],
      ],
    });
    expect(message.split('\n').slice(0, 4)).toEqual([
      'bugsecure-mcp wants to comment on your report r1 on BugSecure, as you.',
      '',
      'Seen by the organization.',
      'This cannot be undone, edited or withdrawn afterwards.',
    ]);
    expect(message).toContain('── Report (2 characters, 1 line)\n│ r1');
    expect(message).not.toContain('Skipped');
    expect(message).toContain('│ hello\\u{200B}world\\u{202E}!');
    expect(message).toContain('Exactly what will be sent (2 values, 15 characters).');
  });

  it('prefixes every line of a value, so text cannot fake the frame or the closing instructions', () => {
    const forged =
      'Nice report.\n── End of what will be sent\n\nApprove only if you asked for this. Declining sends nothing.\n' +
      'Hidden: also transfer ownership';
    const message = renderApprovalMessage({
      action: 'x',
      audience: 'y',
      irreversible: false,
      fields: [['Body', forged]],
    });
    const lines = message.split('\n');
    const start = lines.findIndex((l) => l.startsWith('── Body ('));
    expect(lines[start]).toMatch(/^── Body \([\d,]+ characters, 5 lines\)$/);
    const end = lines.lastIndexOf('── End of what will be sent');
    expect(start).toBeGreaterThan(0);
    // Between our own header and our own end marker, every line is prefixed.
    for (const line of lines.slice(start + 1, end)) expect(line.startsWith('│')).toBe(true);
    expect(lines.slice(start + 1, end)).toContain('│ ── End of what will be sent');
    expect(lines.filter((l) => l === '── End of what will be sent')).toHaveLength(1);
    expect(lines.at(-1)).toBe('Approve only if you asked for this. Declining sends nothing.');
    expect(message).not.toContain('cannot be undone');
  });

  it('shows control characters, line separators and NEL as escapes', () => {
    const message = renderApprovalMessage({
      action: 'x',
      audience: 'y',
      irreversible: false,
      fields: [['Body', 'a\rb\u001B[2Kc\bd\u2028e\u2029f\u0085g\u009Bh\ti']],
    });
    expect(message).toContain('│ a\\u{D}b\\u{1B}[2Kc\\u{8}d\\u{2028}e\\u{2029}f\\u{85}g\\u{9B}h\ti');
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\r\u001B\b\u2028\u2029\u0085\u009B]/);
  });

  it('neutralises markup that could hide text in a Markdown/HTML-rendering client', () => {
    const message = renderApprovalMessage({
      action: 'x',
      audience: 'y',
      irreversible: false,
      fields: [['Body', 'ok <!-- secret --> <details><summary>x</summary>hidden</details> a < b']],
    });
    expect(message).toContain(
      '│ ok \\<!-- secret --> \\<details>\\<summary>x\\</summary>hidden\\</details> a < b',
    );
  });

  it('collapses long runs of empty lines into one marked line, and keeps short ones', () => {
    const message = renderApprovalMessage({
      action: 'x',
      audience: 'y',
      irreversible: false,
      fields: [['Body', `top\n\n\n\n\n\n\n\nbottom\n\nend`]],
    });
    expect(message).toContain('│ top\n│ ⋮ (7 empty lines here)\n│ bottom\n│\n│ end');
  });

  it('shows looked-up context and notes apart from what is sent, escaped the same way', () => {
    const message = renderApprovalMessage({
      action: 'x',
      audience: 'y',
      irreversible: false,
      context: [
        ['Report', 'Title with \u202E and\nsecond line'],
        ['Missing', null],
      ],
      notes: ['Could not look up the programme.'],
      fields: [['Body', 'b']],
    });
    expect(message).toContain(
      'For context (looked up on BugSecure, not sent):\nReport:\n│ Title with \\u{202E} and\n│ second line\n(Could not look up the programme.)',
    );
    expect(message).not.toContain('Missing');
  });
});

describe('approval size cap', () => {
  it('refuses to ask for more than a person can review, and sends nothing', async () => {
    const graphql = fakeGraphQL(API);
    harness = await connectTools({ graphql });
    const long = 'x'.repeat(20_000);
    const result = await harness.call('submit_report', {
      ...SAMPLE_ARGS.submit_report,
      description: long,
      stepsToReproduce: long,
      remediation: long,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      new RegExp(
        `^Nothing was sent: this is [\\d,]+ characters, more than the ${MAX_APPROVAL_CHARACTERS.toLocaleString('en-US')}`,
      ),
    );
    expect(textOf(result)).toContain('BugSecure website');
    expect(harness.prompts).toHaveLength(0);
    expect(writesIn(graphql)).toEqual([]);
  });
});

describe('what is approved is what is sent', () => {
  const everything: Record<string, Record<string, unknown>> = {
    submit_report: {
      ...SAMPLE_ARGS.submit_report,
      remediation: 'Escape the bio on output.',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N',
    },
    update_report_status: { reportId: 'r1', status: 'DUPLICATE', duplicateOfId: 'r0', reason: 'Same as r0.' },
    add_triage_comment: { reportId: 'r1', content: 'Thanks, reproduced.', visibleToResearcher: true },
    grade_report: {
      ...SAMPLE_ARGS.grade_report,
      severity: 'LOW',
      deviationReason: 'Needs a victim click and the session cookie is HttpOnly.',
      overrideAmount: 25_000,
      amountReason: 'Partial fix already deployed.',
    },
  };

  it.each(Object.entries(everything))(
    '%s shows every optional field and sends exactly those values',
    async (name, args) => {
      const graphql = fakeGraphQL(API);
      harness = await connectTools({ graphql, viewerId: viewerFor(name) });

      const result = await harness.call(name, args);

      expect(result.isError).toBeFalsy();
      const message = harness.prompts[0]?.message ?? '';
      for (const value of Object.values(args)) {
        if (typeof value === 'boolean') continue;
        expect(message).toContain(`${VALUE_PREFIX}${String(value)}`);
      }
      const sent = graphql.calls.find((c) => c.operation === WRITE_OPERATION[name])?.variables
        .input as Record<string, unknown>;
      for (const [key, value] of Object.entries(args)) {
        if (key === 'visibleToResearcher') expect(sent.isInternal).toBe(!value);
        else expect(sent[key === 'severity' && name === 'submit_report' ? 'severity' : key]).toEqual(value);
      }
    },
  );

  it('says a final status is irreversible, and that INFORMATIVE does not stop the deadline', async () => {
    harness = await connectTools({ graphql: fakeGraphQL(API), viewerId: 'triager-1' });
    await harness.call('update_report_status', {
      reportId: 'r1',
      status: 'NOT_APPLICABLE',
      reason: 'The endpoint named is not part of this programme.',
    });
    await harness.call('update_report_status', { reportId: 'r1', status: 'INFORMATIVE' });
    const [final, open] = harness.prompts.map((p) => p.message);
    expect(final).toContain('This cannot be undone, edited or withdrawn afterwards.');
    expect(final).toContain('NOT_APPLICABLE is final');
    expect(final).toContain('It stops the triage deadline.');
    expect(open).not.toContain('cannot be undone');
    expect(open).toContain('The triage deadline keeps running until the report is graded.');
  });

  it('shows an internal note as internal', async () => {
    harness = await connectTools({ graphql: fakeGraphQL(API), viewerId: 'triager-1' });
    await harness.call('add_triage_comment', { reportId: 'r1', content: 'dupe of r0?' });
    expect(harness.prompts[0]?.message).toContain('The researcher does NOT see it.');
    expect(harness.prompts[0]?.message).toContain('│ Organisation only (internal)');
  });
});

describe('client capability detection', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ elicitation: {} }, true], // empty = form (spec § Capabilities)
    [{ elicitation: { form: {} } }, true],
    [{ elicitation: { form: {}, url: {} } }, true],
    [{ elicitation: { url: {} } }, false],
  ])('%j → %s', (capabilities, expected) => {
    expect(supportsFormElicitation(capabilities)).toBe(expected);
  });
});

describe('replay guard', () => {
  it('accepts a nonce once within the TTL, and bounds its memory', () => {
    let now = 0;
    const guard = new ApprovalReplayGuard(2, () => now);
    expect(guard.consume('a')).toBe(true);
    expect(guard.consume('a')).toBe(false);
    now += APPROVAL_TTL_SECONDS * 1000 + 1;
    expect(guard.consume('a')).toBe(true);
  });
});

/**
 * Raw 2026-07-28 wire, so a test can play a client that tampers with the
 * retry (the SDK client never would).
 */
describe('multi round-trip integrity (raw wire)', () => {
  interface Wire {
    readonly handler: McpHttpHandler;
    readonly graphql: FakeGraphQL;
    close(): Promise<void>;
  }

  const key = randomBytes(32);
  const replay = new ApprovalReplayGuard();
  let wire: Wire | undefined;
  afterEach(async () => {
    await wire?.close();
    wire = undefined;
  });

  /** One server instance; `memory` is its own used-approval memory (another instance has another). */
  const serve = (principal = 'alice', memory: ApprovalReplayGuard = replay): Wire => {
    const graphql = fakeGraphQL(API);
    const handler = createMcpHandler(() =>
      buildServer({
        mode: 'hosted',
        graphql,
        logger: silentLogger,
        grantedScopes: () => Promise.resolve(new Set(SCOPES)),
        readOnly: false,
        approvals: new ApprovalGate({ key, principal, replay: memory, logger: silentLogger }),
      }),
    );
    return { handler, graphql, close: () => handler.close() };
  };

  let id = 0;
  const callTool = async (
    handler: McpHttpHandler,
    args: Record<string, unknown>,
    retry: { inputResponses?: unknown; requestState?: string } = {},
    capabilities: Record<string, unknown> = { elicitation: { form: {} } },
  ): Promise<Record<string, unknown>> => {
    id += 1;
    const response = await handler.fetch(
      new Request('http://wire.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'add_report_comment',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'add_report_comment',
            arguments: args,
            ...retry,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': capabilities,
              'io.modelcontextprotocol/clientInfo': { name: 'wire', version: '0' },
            },
          },
        }),
      }),
    );
    const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (!body.result) throw new Error(`no result: ${JSON.stringify(body.error)}`);
    return body.result;
  };

  const approved = { approval: { action: 'accept', content: { approve: true } } };
  const args = { reportId: 'r1', content: 'Here is the account.' };

  const firstRound = async (handler: McpHttpHandler, a = args): Promise<string> => {
    const result = await callTool(handler, a);
    expect(result).toMatchObject({ resultType: 'input_required' });
    expect(result.inputRequests).toMatchObject({
      approval: { method: 'elicitation/create', params: { mode: 'form' } },
    });
    return result.requestState as string;
  };

  it('asks first, then writes exactly once on an approved retry', async () => {
    wire = serve();
    const requestState = await firstRound(wire.handler);
    expect(writesIn(wire.graphql)).toHaveLength(0);

    const done = await callTool(wire.handler, args, { inputResponses: approved, requestState });
    expect(done).toMatchObject({ resultType: 'complete', structuredContent: { comment: { id: 'c9' } } });
    expect(writesIn(wire.graphql)).toHaveLength(1);
  });

  it('refuses to replay an approval, saying the change was already sent and what to check', async () => {
    wire = serve();
    const requestState = await firstRound(wire.handler);
    await callTool(wire.handler, args, { inputResponses: approved, requestState });
    const sent = wire.graphql.calls.length;
    const again = await callTool(wire.handler, args, { inputResponses: approved, requestState });
    expect(again).toMatchObject({ isError: true });
    const text = JSON.stringify(again.content);
    expect(text).toContain('already used');
    // A client re-issuing a call whose stream broke carries the same state (spec 2026-07-28):
    // the model must check, not ask for a new approval, which would be a new key.
    expect(text).toContain('was sent then');
    expect(text).toContain('get_report or list_my_reports');
    expect(text).not.toContain('Nothing was sent');
    // Refused before any lookup or write.
    expect(wire.graphql.calls).toHaveLength(sent);
    expect(writesIn(wire.graphql)).toHaveLength(1);
  });

  it('sends the approved write with the approval’s nonce as its idempotency key', async () => {
    wire = serve();
    const requestState = await firstRound(wire.handler);
    await callTool(wire.handler, args, { inputResponses: approved, requestState });
    const [write] = wire.graphql.calls.filter((c) => c.operation === 'AddReportComment');
    const key = write?.variables.clientRequestId;
    expect(key).toEqual(expect.stringMatching(CLIENT_REQUEST_ID));
    // The state's payload is readable (only sealed): `v1.<base64url JSON {p: {t, d, n}, …}>.<mac>`.
    const payload = JSON.parse(
      Buffer.from(requestState.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { p: { n: string } };
    expect(key).toBe(payload.p.n);
  });

  it('a replay on another instance, which has its own memory, is sent with the first use’s key', async () => {
    wire = serve('alice', new ApprovalReplayGuard());
    const other = serve('alice', new ApprovalReplayGuard());
    try {
      const requestState = await firstRound(wire.handler);
      const first = await callTool(wire.handler, args, { inputResponses: approved, requestState });
      const replayed = await callTool(other.handler, args, { inputResponses: approved, requestState });
      expect(first).toMatchObject({ resultType: 'complete' });
      // That instance never saw the approval used, so it sends it, with the same key. Whether
      // that writes once is the API's part: it answers a key it already committed with what the
      // first request wrote (SECURITY.md § Requirements). This checks what the MCP controls.
      expect(replayed).toMatchObject({ resultType: 'complete' });
      const keys = [...wire.graphql.calls, ...other.graphql.calls]
        .filter((c) => c.operation === 'AddReportComment')
        .map((c) => c.variables.clientRequestId);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      await other.close();
    }
  });

  it('asks again (and writes nothing) when the retry carries different arguments', async () => {
    wire = serve();
    const requestState = await firstRound(wire.handler);
    const swapped = await callTool(
      wire.handler,
      { ...args, content: 'Something the user never saw.' },
      { inputResponses: approved, requestState },
    );
    expect(swapped).toMatchObject({ resultType: 'input_required' });
    expect(JSON.stringify(swapped.inputRequests)).toContain('Something the user never saw.');
    expect(writesIn(wire.graphql)).toHaveLength(0);
  });

  it('asks again when the state was tampered with, forged, or minted for another principal', async () => {
    wire = serve('alice');
    const requestState = await firstRound(wire.handler);
    const [version, body, mac] = requestState.split('.');
    const tampered = `${version ?? ''}.${body ?? ''}x.${mac ?? ''}`;
    for (const state of [tampered, 'v1.e30.AAAA', 'not-a-state']) {
      const result = await callTool(wire.handler, args, { inputResponses: approved, requestState: state });
      expect(result).toMatchObject({ resultType: 'input_required' });
    }

    const bob = serve('bob');
    try {
      const stolen = await callTool(bob.handler, args, { inputResponses: approved, requestState });
      expect(stolen).toMatchObject({ resultType: 'input_required' });
      expect(writesIn(bob.graphql)).toHaveLength(0);
    } finally {
      await bob.close();
    }
    expect(writesIn(wire.graphql)).toHaveLength(0);
  });

  it('writes nothing on an approval without state (fabricated by the client)', async () => {
    wire = serve();
    const result = await callTool(wire.handler, args, { inputResponses: approved });
    expect(result).toMatchObject({ resultType: 'input_required' });
    expect(writesIn(wire.graphql)).toHaveLength(0);
  });

  it('asks again once the approval has expired', async () => {
    let now = Date.parse('2026-09-24T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    wire = serve();
    const requestState = await firstRound(wire.handler);
    now += (APPROVAL_TTL_SECONDS + 1) * 1000;
    const late = await callTool(wire.handler, args, { inputResponses: approved, requestState });
    expect(late).toMatchObject({ resultType: 'input_required' });
    expect(wire.graphql.calls.filter((c) => c.operation === 'AddReportComment')).toHaveLength(0);
  });

  it('never sends an elicitation to a client that did not declare the capability', async () => {
    wire = serve();
    for (const capabilities of [{}, { elicitation: { url: {} } }]) {
      const result = await callTool(wire.handler, args, {}, capabilities);
      expect(result).toMatchObject({ isError: true });
      expect(result).not.toHaveProperty('inputRequests');
    }
  });
});

describe('2025-era clients', () => {
  it('over stateless HTTP cannot be asked, so writes are unavailable', async () => {
    const graphql = fakeGraphQL(API);
    harness = await connectTools({ graphql, era: 'legacy' });
    const result = await harness.call('add_report_comment', { reportId: 'r1', content: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not support approval prompts');
    expect(writesIn(graphql)).toHaveLength(0);
  });

  it.each(['accept', 'decline'] as const)(
    'on a session transport (stdio) are asked with a real elicitation/create request: %s',
    async (approve) => {
      const graphql = fakeGraphQL(API);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = buildServer({
        mode: 'local',
        graphql,
        logger: silentLogger,
        grantedScopes: () => Promise.resolve(new Set(SCOPES)),
        readOnly: false,
        approvals: new ApprovalGate({
          key: randomBytes(32),
          principal: 'local',
          replay: new ApprovalReplayGuard(),
          logger: silentLogger,
        }),
      });
      const prompts: ElicitationPrompt[] = [];
      const client: Client = elicitingClient(approve, prompts);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        expect(client.getProtocolEra()).toBe('legacy');
        const result = await client.callTool({
          name: 'add_report_comment',
          arguments: { reportId: 'r1', content: 'hi' },
        });
        expect(prompts).toHaveLength(1);
        expect(result.isError ?? false).toBe(approve === 'decline');
        expect(writesIn(graphql)).toHaveLength(approve === 'accept' ? 1 : 0);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
