import { describe, expect, it } from 'vitest';

import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
} from './resource-metadata.js';

describe('RFC 9728 metadata location', () => {
  it('inserts the well-known segment before the resource path', () => {
    expect(protectedResourceMetadataUrl('https://mcp.example/mcp')).toBe(
      'https://mcp.example/.well-known/oauth-protected-resource/mcp',
    );
    expect(protectedResourceMetadataUrl('https://mcp.example')).toBe(
      'https://mcp.example/.well-known/oauth-protected-resource',
    );
    expect(protectedResourceMetadataUrl('http://localhost:8944/mcp')).toBe(
      'http://localhost:8944/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('builds the document with scopes in canonical order', () => {
    expect(
      buildProtectedResourceMetadata({
        resource: 'https://h/mcp',
        issuer: 'https://as',
        scopes: ['reports:read', 'programs:read'],
      }),
    ).toMatchObject({
      resource: 'https://h/mcp',
      authorization_servers: ['https://as'],
      scopes_supported: ['programs:read', 'reports:read'],
      bearer_methods_supported: ['header'],
    });
  });
});

describe('WWW-Authenticate', () => {
  it('formats the 401 challenge', () => {
    expect(
      wwwAuthenticate({ resourceMetadataUrl: 'https://h/.well-known/oauth-protected-resource/mcp' }),
    ).toBe('Bearer resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"');
  });

  it('formats the step-up challenge with every parameter', () => {
    expect(
      wwwAuthenticate({
        resourceMetadataUrl: 'https://h/prm',
        scopes: ['reports:write', 'programs:read'],
        error: 'insufficient_scope',
        errorDescription: 'needs "more"\\ scope\r\n',
      }),
    ).toBe(
      'Bearer error="insufficient_scope", error_description="needs \\"more\\"\\\\ scope", scope="programs:read reports:write", resource_metadata="https://h/prm"',
    );
  });
});
