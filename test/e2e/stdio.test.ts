/**
 * End to end over the BUILT binary (dist/cli.js), spawned exactly as an MCP
 * client spawns it, over stdio, against a fake BugSecure API on loopback:
 *
 * - stdout carries only protocol traffic (the SDK client would choke otherwise);
 * - a signed-out server still starts, lists tools and explains how to sign in;
 * - protocol 2026-07-28: a write tool asks for approval through elicitation
 *   and writes only when the user accepts (declined → nothing sent; a client
 *   without the capability → refused);
 * - a 2025-era client gets the same approval as a real elicitation/create.
 *
 * `pnpm run check` and CI build before testing. Without a build this suite
 * FAILS (it never silently skips): run `pnpm build` first.
 */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApprovalAnswer, type ElicitationPrompt, elicitingClient } from '../helpers/tool-harness.js';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const TOKEN = 'e2e-access-token';

interface ApiCall {
  readonly operation: string;
  readonly authorization: string | undefined;
}

let api: Server;
let apiUrl: string;
const apiCalls: ApiCall[] = [];

/** A fake BugSecure API: answers the operations these tests use, records every call. */
const fakeApi = (): Server => {
  return createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { query: string };
      const operation = /\b(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? '?';
      apiCalls.push({ operation, authorization: req.headers.authorization });
      const data =
        operation === 'AddReportComment'
          ? {
              addReportComment: {
                id: 'c1',
                reportId: 'r1',
                isInternal: false,
                createdAt: '2026-09-21T10:00:00.000Z',
              },
            }
          : operation === 'SearchPrograms'
            ? { programs: [] }
            : null;
      res.writeHead(data ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data ? { data } : { errors: [{ message: `unexpected ${operation}` }] }));
    });
  });
};

/** A config dir holding a valid stored login for the fake API (file store, 0600). */
const signedInConfigDir = (scope: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bsmcp-e2e-'));
  const now = Math.floor(Date.now() / 1000);
  const credentials = {
    version: 1,
    issuer: apiUrl,
    clientId: 'bugsecure-mcp-cli',
    resource: apiUrl,
    tokenEndpoint: `${apiUrl}/oauth/token`,
    accessToken: TOKEN,
    accessTokenExpiresAt: now + 3_600,
    scope,
    obtainedAt: now,
  };
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify({ version: 1, entries: { [apiUrl]: credentials } }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return dir;
};

const spawnClient = async (
  configDir: string,
  options: { approve?: ApprovalAnswer; era?: 'modern' | 'legacy'; prompts?: ElicitationPrompt[] } = {},
): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--api-url', apiUrl],
    env: {
      PATH: process.env.PATH ?? '',
      BUGSECURE_CREDENTIAL_STORE: 'file',
      BUGSECURE_CONFIG_DIR: configDir,
      BUGSECURE_LOG_LEVEL: 'silent',
    },
    stderr: 'pipe',
  });
  const client = elicitingClient(
    options.approve ?? 'accept',
    options.prompts ?? [],
    options.era === 'legacy' ? {} : { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  return client;
};

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} does not exist: run \`pnpm build\` before the end-to-end tests.`);
  }
  api = fakeApi();
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    api.close(() => {
      resolve();
    });
  });
});

describe('bugsecure-mcp over stdio (built binary)', () => {
  it('serves a signed-out session on the 2026-07-28 protocol, explaining how to sign in', async () => {
    const client = await spawnClient(mkdtempSync(join(tmpdir(), 'bsmcp-e2e-')));
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerVersion()?.name).toBe('bugsecure-mcp');
      expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['get_program', 'search_programs', 'submit_report']));

      const result = await client.callTool({ name: 'search_programs', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('login');
    } finally {
      await client.close();
    }
  });

  it('calls the API with the stored token and returns structured output', async () => {
    const client = await spawnClient(signedInConfigDir('programs:read'));
    apiCalls.length = 0;
    try {
      const result = await client.callTool({ name: 'search_programs', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ programs: [], nextOffset: null });
      expect(apiCalls).toEqual([{ operation: 'SearchPrograms', authorization: `Bearer ${TOKEN}` }]);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['modern', 'accept', 1],
    ['modern', 'decline', 0],
    ['modern', 'cancel', 0],
    ['modern', 'none', 0],
    ['legacy', 'accept', 1],
    ['legacy', 'decline', 0],
  ] as const)('%s client, approval answered with %s → %i write(s)', async (era, approve, writes) => {
    const prompts: ElicitationPrompt[] = [];
    const client = await spawnClient(signedInConfigDir('reports:read reports:write'), {
      approve,
      era,
      prompts,
    });
    apiCalls.length = 0;
    try {
      expect(client.getProtocolEra()).toBe(era);
      const result = await client.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'Here is the test account: e2e@example.test' },
      });

      expect(apiCalls.filter((c) => c.operation === 'AddReportComment')).toHaveLength(writes);
      if (approve === 'none') {
        expect(prompts).toHaveLength(0);
        expect(JSON.stringify(result.content)).toContain('does not support approval prompts');
      } else {
        expect(prompts).toHaveLength(1);
        expect(prompts[0]?.message).toContain('Here is the test account: e2e@example.test');
      }
      if (writes === 1) {
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ comment: { id: 'c1', reportId: 'r1' } });
      } else {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Nothing was sent');
      }
    } finally {
      await client.close();
    }
  });

  it('refuses a tool whose scope the stored login lacks, with the exact login command', async () => {
    const client = await spawnClient(signedInConfigDir('programs:read'));
    apiCalls.length = 0;
    try {
      const result = await client.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'hi' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        String.raw`login --scopes \"programs:read reports:write\"`,
      );
      expect(apiCalls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
