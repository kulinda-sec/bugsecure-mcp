import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeAuthorizationServer } from '../../test/helpers/fake-authorization-server.js';
import { loadHostedConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { runHosted } from './hosted.js';
import type { StartedServer } from './http-server.js';

const ISSUER = 'https://as.test';

let started: StartedServer | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
});

const config = (env: Record<string, string> = {}) =>
  loadHostedConfig({
    BUGSECURE_API_URL: ISSUER,
    BUGSECURE_MCP_RESOURCE: 'http://localhost:8944/mcp',
    BUGSECURE_CLIENT_SECRET: 'x',
    PORT: '0',
    ...env,
  });

describe('runHosted', () => {
  it('discovers the authorization server, then serves metadata and a 401 challenge', async () => {
    const as = fakeAuthorizationServer(ISSUER);
    vi.stubGlobal('fetch', as.fetch);
    started = await runHosted(config(), silentLogger);
    vi.unstubAllGlobals();

    const prm = await fetch(`${started.url}/.well-known/oauth-protected-resource/mcp`);
    expect(await prm.json()).toMatchObject({
      resource: 'http://localhost:8944/mcp',
      authorization_servers: [ISSUER],
    });

    const unauthenticated = await fetch(`${started.url}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost:8944/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('warns when the AS does not advertise token exchange', async () => {
    const as = fakeAuthorizationServer(ISSUER);
    as.metadata = { ...as.metadata, grant_types_supported: ['authorization_code'] };
    vi.stubGlobal('fetch', as.fetch);
    const warn = vi.fn();
    started = await runHosted(config(), { ...silentLogger, warn, child: () => silentLogger });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('token-exchange'));
  });

  it('fails fast when the authorization server is unusable', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    await expect(runHosted(config(), silentLogger)).rejects.toMatchObject({ error: 'metadata_not_found' });
  });
});
