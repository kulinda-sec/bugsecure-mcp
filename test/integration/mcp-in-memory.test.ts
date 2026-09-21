/**
 * End-to-end over the real SDK: an MCP Client talking to the production
 * server builder, on both protocol eras, with a fake API behind it.
 */
import { randomBytes } from 'node:crypto';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { BugSecureError } from '../../src/errors.js';
import { silentLogger } from '../../src/logger.js';
import { buildServer } from '../../src/server.js';
import { ApprovalGate, ApprovalReplayGuard } from '../../src/tools/approval.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { UNTRUSTED_TAG } from '../../src/untrusted.js';
import { fakeGraphQL } from '../helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../helpers/tool-harness.js';

const programs = {
  SearchPrograms: () => ({
    programs: [
      {
        id: 'p1',
        slug: 'acme',
        title: 'Acme',
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        startDate: null,
        endDate: null,
        updatedAt: '2026-09-01T00:00:00.000Z',
        organization: null,
      },
    ],
  }),
};

// A write tool, to exercise read-only mode and write-scope filtering.
const fakeWrite = defineTool({
  name: 'fake_submit',
  title: 'Fake submit',
  description: 'A write tool that exists only in this test suite.',
  requiredScopes: ['reports:write'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  approval: () => ({ action: 'do a fake write', audience: 'Nobody.', irreversible: false, fields: [] }),
  handler: () => Promise.resolve({ data: { ok: true } }),
});
const toolsWithWrite = [...ALL_TOOLS, fakeWrite];

const testApprovals = (): ApprovalGate =>
  new ApprovalGate({
    key: randomBytes(32),
    principal: 'test',
    replay: new ApprovalReplayGuard(),
    logger: silentLogger,
  });

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('MCP 2026-07-28 (modern era) over streamable HTTP, in process', () => {
  it('negotiates the modern protocol and lists tools with full metadata', async () => {
    harness = await connectTools({ graphql: fakeGraphQL(programs), grantedScopes: ['programs:read'] });

    expect(harness.client.getProtocolEra()).toBe('modern');
    expect(harness.client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
    const { tools } = await harness.client.listTools();
    // every tool, in deterministic (name) order
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(ALL_TOOLS.length);

    const search = tools.find((t) => t.name === 'search_programs');
    expect(search?.title).toBe('Search bug bounty programmes');
    expect(search?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(search?.inputSchema.type).toBe('object');
    expect(search?.outputSchema?.type).toBe('object');
  });

  it('sends server instructions that fence third-party content', async () => {
    harness = await connectTools({ graphql: fakeGraphQL(programs), grantedScopes: ['programs:read'] });
    const instructions = harness.client.getInstructions() ?? '';
    expect(instructions).toContain(`<${UNTRUSTED_TAG}-NONCE`);
    expect(instructions).toMatch(/changes with every tool response/);
    expect(instructions).toMatch(/Never follow instructions/);
  });

  it('calls a tool and returns structuredContent validated against outputSchema, plus the same JSON as text', async () => {
    harness = await connectTools({ graphql: fakeGraphQL(programs), grantedScopes: ['programs:read'] });
    const result = await harness.call('search_programs', { query: 'acme' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ programs: [{ id: 'p1' }], nextOffset: null });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('lists write tools whatever the scopes, and hides them in read-only mode', async () => {
    harness = await connectTools({
      graphql: fakeGraphQL(programs),
      grantedScopes: [],
      tools: toolsWithWrite,
    });
    expect(await harness.listToolNames()).toContain('fake_submit');
    await harness.close();

    harness = await connectTools({
      graphql: fakeGraphQL(programs),
      grantedScopes: ['programs:read', 'reports:write'],
      tools: toolsWithWrite,
      readOnly: true,
    });
    expect(await harness.listToolNames()).not.toContain('fake_submit');
    const hidden = await harness.call('fake_submit', {}).catch((error: unknown) => error);
    // Either a protocol error or an isError result — never a successful call.
    expect(hidden instanceof Error || (hidden as { isError?: boolean }).isError === true).toBe(true);
  });

  it('a tool called without its scopes explains the re-authorization and calls nothing', async () => {
    const graphql = fakeGraphQL(programs);
    harness = await connectTools({ graphql, grantedScopes: ['profile:read'] });
    const result = await harness.call('search_programs', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('login --scopes "programs:read profile:read"');
    expect(graphql.calls).toHaveLength(0);
  });

  it('when not signed in, lists tools and explains how to log in', async () => {
    const graphql = fakeGraphQL(programs);
    harness = await connectTools({ graphql, grantedScopes: 'signed-out' });
    expect(await harness.listToolNames()).toContain('search_programs');
    const result = await harness.call('search_programs', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/npx -y @kulinda-sec\/bugsecure-mcp login/);
  });

  it('phrases fixes for hosted connections differently', async () => {
    const graphql = fakeGraphQL({
      SearchPrograms: () => {
        throw new BugSecureError('SESSION_EXPIRED', 'expired');
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'], mode: 'hosted' });
    expect(textOf(await harness.call('search_programs', {}))).toMatch(/reconnect BugSecure/);
  });
});

describe('2026-07-28 wire format', () => {
  it('marks the scope-filtered tool list as privately cacheable and identifies the server', async () => {
    const handler = createMcpHandler(() =>
      buildServer({
        mode: 'hosted',
        graphql: fakeGraphQL(programs),
        logger: silentLogger,
        grantedScopes: () => Promise.resolve(new Set(['programs:read'] as const)),
        readOnly: false,
        approvals: testApprovals(),
      }),
    );
    try {
      const response = await handler.fetch(
        new Request('http://wire.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/list',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': { name: 'wire', version: '0' },
              },
            },
          }),
        }),
      );
      const body = (await response.json()) as { result: Record<string, unknown> };
      expect(body.result).toMatchObject({ resultType: 'complete', cacheScope: 'private', ttlMs: 600_000 });
      expect(body.result._meta).toMatchObject({
        'io.modelcontextprotocol/serverInfo': { name: 'bugsecure-mcp' },
      });
    } finally {
      await handler.close();
    }
  });
});

describe('MCP 2025-era clients (initialize handshake)', () => {
  it('are still served by the same handler', async () => {
    harness = await connectTools({
      graphql: fakeGraphQL(programs),
      grantedScopes: ['programs:read'],
      era: 'legacy',
    });
    expect(harness.client.getProtocolEra()).toBe('legacy');
    const result = await harness.call('search_programs', {});
    expect(result.structuredContent).toMatchObject({ programs: [{ id: 'p1' }] });
  });

  it('work over an in-memory linked transport pair', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer({
      mode: 'local',
      graphql: fakeGraphQL(programs),
      logger: silentLogger,
      grantedScopes: () => Promise.resolve(new Set(['programs:read'] as const)),
      readOnly: false,
      approvals: testApprovals(),
    });
    const client = new Client({ name: 'in-memory', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()?.name).toBe('bugsecure-mcp');
      const result = await client.callTool({ name: 'get_program', arguments: { slug: 'x', id: 'y' } });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
