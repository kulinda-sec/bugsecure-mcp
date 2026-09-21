import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../logger.js';
import type { HttpApp } from './http-app.js';
import { startHttpServer, type StartedServer } from './http-server.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const send = (
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> => {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
};

let server: StartedServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (app: HttpApp, overrides: { maxBodyBytes?: number; handlerTimeoutMs?: number } = {}) => {
  server = await startHttpServer(
    app,
    { host: '127.0.0.1', port: 0 },
    {
      maxBodyBytes: overrides.maxBodyBytes ?? 1024,
      handlerTimeoutMs: overrides.handlerTimeoutMs ?? 5_000,
      logger: silentLogger,
    },
  );
  return server.url;
};

const echoApp: HttpApp = {
  fetch: async (request) => {
    const body = request.body === null ? '' : await request.text();
    return new Response(
      JSON.stringify({
        method: request.method,
        path: new URL(request.url).pathname,
        host: request.headers.get('host'),
        body,
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-test': 'yes' } },
    );
  },
  close: () => Promise.resolve(),
};

describe('Node HTTP adapter', () => {
  it('binds where asked and forwards method, path, Host and body', async () => {
    const url = await start(echoApp);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await send(`${url}/mcp?x=1`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-test']).toBe('yes');
    expect(JSON.parse(res.body)).toEqual({
      method: 'POST',
      path: '/mcp',
      host: new URL(url).host,
      body: '{"a":1}',
    });
  });

  it('rejects oversized bodies with 413, by Content-Length and while streaming', async () => {
    const url = await start(echoApp, { maxBodyBytes: 16 });
    const declared = await send(`${url}/mcp`, { method: 'POST', body: 'x'.repeat(64) });
    expect(declared.status).toBe(413);
    const chunked = await send(`${url}/mcp`, {
      method: 'POST',
      body: 'x'.repeat(64),
      headers: { 'transfer-encoding': 'chunked' },
    });
    expect(chunked.status).toBe(413);
  });

  it('lets the app answer from the headers alone, never draining the unread body', async () => {
    const authApp: HttpApp = {
      // Like the hosted app for an unauthenticated request: headers only.
      fetch: () => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 })),
      close: () => Promise.resolve(),
    };
    const url = await start(authApp, { maxBodyBytes: 1024 });
    const res = await send(`${url}/mcp`, {
      method: 'POST',
      body: 'x'.repeat(512),
      headers: { 'transfer-encoding': 'chunked' },
    });
    expect(res.status).toBe(401);
    expect(res.body).toBe('{"error":"unauthorized"}');
  });

  it('streams SSE responses', async () => {
    const sseApp: HttpApp = {
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: message\ndata: 1\n\n'));
            controller.enqueue(new TextEncoder().encode('event: message\ndata: 2\n\n'));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
      },
      close: () => Promise.resolve(),
    };
    const url = await start(sseApp);
    const res = await send(`${url}/mcp`, { method: 'POST', body: '{}' });
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toBe('event: message\ndata: 1\n\nevent: message\ndata: 2\n\n');
  });

  it('aborts handlers that exceed the deadline with 504', async () => {
    let aborted = false;
    const slowApp: HttpApp = {
      fetch: (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      close: () => Promise.resolve(),
    };
    const url = await start(slowApp, { handlerTimeoutMs: 50 });
    const res = await send(`${url}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(504);
    expect(aborted).toBe(true);
  });

  it('answers 500 without details when the app throws', async () => {
    const url = await start({
      fetch: () => Promise.reject(new Error('secret detail')),
      close: () => Promise.resolve(),
    });
    const res = await send(`${url}/x`);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret');
  });
});
