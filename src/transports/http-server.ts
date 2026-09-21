/**
 * Node `http` adapter for the hosted app, with the transport-level limits:
 *
 * - request bodies are streamed to the app lazily: the app checks Host,
 *   Origin and the bearer token from the headers first and reads the body
 *   only for authenticated requests. Bodies are capped (Content-Length up
 *   front, then while streaming → 413), and an unread body is never drained:
 *   the connection is closed instead;
 * - header/request/keep-alive timeouts on the socket, and a per-request
 *   deadline that aborts the handler (and so the tool call) if exceeded;
 * - client disconnects abort in-flight work (Streamable HTTP cancellation);
 * - responses, including SSE, are streamed with backpressure.
 *
 * Why hand-rolled rather than `@modelcontextprotocol/node`'s `toNodeHandler`:
 * that adapter wraps one MCP handler, while this server routes three things
 * (the MCP endpoint, RFC 9728 metadata, a health check) through one web-standard
 * `fetch` function, and needs the ordering above (headers → auth → body), the
 * size cap and the deadline wired into the request's AbortSignal. It is ~150
 * lines of `node:http` and `stream` with no further dependency; the app itself
 * stays runtime-agnostic (it is also what the tests drive, without sockets).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Logger } from '../logger.js';
import type { HttpApp } from './http-app.js';

export interface NodeAdapterOptions {
  readonly maxBodyBytes: number;
  /** Upper bound on one request's handling, including the tool call. */
  readonly handlerTimeoutMs: number;
  readonly logger: Logger;
}

const sendPlain = (res: ServerResponse, status: number, body: object): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(JSON.stringify(body));
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** The request body as a web stream that errors once more than `maxBytes` arrive. */
const cappedBody = (
  req: IncomingMessage,
  maxBytes: number,
  onTooLarge: () => void,
): ReadableStream<Uint8Array> => {
  let total = 0;
  return (Readable.toWeb(req) as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          onTooLarge();
          controller.error(new BodyTooLargeError(`request body exceeds ${String(maxBytes)} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

export const toNodeListener = (app: HttpApp, options: NodeAdapterOptions) => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    const started = performance.now();
    // Access log: method, path (never the query string), status, duration.
    res.on('finish', () => {
      options.logger.info('http', {
        method: req.method,
        path: (req.url ?? '/').split('?')[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      });
      // The app answered without reading the whole body (401, 403, 413…):
      // close the connection rather than drain an unbounded upload.
      if (!req.complete) req.destroy();
    });
    const deadline = setTimeout(() => {
      controller.abort(new DOMException('request deadline exceeded', 'TimeoutError'));
    }, options.handlerTimeoutMs);
    deadline.unref();
    // Client went away before we finished: cancel the work.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new DOMException('client disconnected', 'AbortError'));
      clearTimeout(deadline);
    });

    const body = { tooLarge: false };
    try {
      const method = req.method ?? 'GET';
      const hasBody = BODY_METHODS.has(method);
      const declared = Number(req.headers['content-length'] ?? Number.NaN);
      if (hasBody && Number.isFinite(declared) && declared > options.maxBodyBytes) {
        sendPlain(res, 413, { error: 'payload_too_large' });
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headersDistinct)) {
        for (const v of value ?? []) headers.append(name, v);
      }
      // The URL's authority is only used for routing; Host is validated by the app.
      const url = new URL(req.url ?? '/', 'http://localhost');
      const request = new Request(url, {
        method,
        headers,
        // Streamed on demand: nothing is read unless the app asks for the body.
        ...(hasBody
          ? {
              body: cappedBody(req, options.maxBodyBytes, () => {
                body.tooLarge = true;
              }),
              duplex: 'half',
            }
          : {}),
        signal: controller.signal,
      });

      const response = await app.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        res.appendHeader(name, value);
      });
      if (response.body === null) {
        res.end();
        return;
      }
      res.flushHeaders();
      await pipeline(Readable.fromWeb(response.body), res, {
        signal: controller.signal,
      });
    } catch (error) {
      if (body.tooLarge) {
        sendPlain(res, 413, { error: 'payload_too_large' });
        return;
      }
      if (controller.signal.aborted) {
        options.logger.info('request aborted', { why: String(controller.signal.reason) });
        if (!res.headersSent) sendPlain(res, 504, { error: 'timeout' });
        else res.destroy();
        return;
      }
      options.logger.error('unhandled error serving request', { error });
      sendPlain(res, 500, { error: 'server_error' });
    } finally {
      clearTimeout(deadline);
    }
  };
};

export interface StartedServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export const startHttpServer = async (
  app: HttpApp,
  listen: { readonly host: string; readonly port: number },
  options: NodeAdapterOptions,
): Promise<StartedServer> => {
  const listener = toNodeListener(app, options);
  const server = createServer(
    { requestTimeout: 60_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      void listener(req, res);
    },
  );
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  return {
    server,
    url: `http://${host}:${address.port}`,
    async close() {
      await app.close();
      server.closeIdleConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
