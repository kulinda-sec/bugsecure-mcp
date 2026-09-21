/**
 * The loopback redirect receiver for `bugsecure-mcp login` (RFC 8252 §7.3).
 *
 * - Listens on 127.0.0.1 only (never 0.0.0.0, never `localhost`, which may
 *   resolve to a non-loopback address), on an ephemeral port chosen by the OS.
 * - Accepts exactly one valid callback: GET /callback whose `state` matches
 *   (constant-time comparison), whose `Host` is our own loopback address (a
 *   DNS-rebinding page cannot deliver a code), and whose `iss` passes the
 *   RFC 9207 checks the MCP spec requires. Anything else is answered and
 *   ignored; the flow keeps waiting until the timeout.
 * - The browser page is static: nothing from the request is reflected into it,
 *   and it is served with a CSP that forbids everything.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { constantTimeEqual } from '../../crypto.js';
import { cleanMessage } from '../../http.js';

export const CALLBACK_PATH = '/callback';
const LOOPBACK_ADDRESS = '127.0.0.1';

export class LoginError extends Error {
  override readonly name = 'LoginError';
  readonly code:
    | 'timeout'
    | 'access_denied'
    | 'invalid_scope'
    | 'authorization_error'
    | 'issuer_mismatch'
    | 'issuer_missing'
    | 'cancelled';

  constructor(code: LoginError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface LoopbackOptions {
  readonly expectedState: string;
  /** Issuer recorded from validated AS metadata before redirecting (RFC 9207). */
  readonly expectedIssuer: string;
  /** `authorization_response_iss_parameter_supported` from the AS metadata. */
  readonly issParameterSupported: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface LoopbackReceiver {
  /** e.g. http://127.0.0.1:53124/callback */
  readonly redirectUri: string;
  /** Resolves with the authorization code, or rejects with a LoginError. */
  readonly code: Promise<string>;
  close(): Promise<void>;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const page = (title: string, message: string): string => {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`;
};

const respond = (res: ServerResponse, status: number, title: string, message: string): void => {
  res.writeHead(status, PAGE_HEADERS);
  res.end(page(title, message));
};

type Outcome = { ok: true; code: string } | { ok: false; error: LoginError } | { ok: 'ignore' };

/** Validate one callback request. Exported for unit tests. */
export const evaluateCallback = (url: URL, options: LoopbackOptions): Outcome => {
  const params = url.searchParams;
  const state = params.get('state');
  if (state === null || !constantTimeEqual(state, options.expectedState)) return { ok: 'ignore' };

  // RFC 9207 §2.4 as tabulated in the MCP authorization spec: a present `iss`
  // must equal the recorded issuer by simple string comparison; an absent one
  // is fatal only when the AS advertised support. On mismatch nothing else in
  // the response (error, error_description) may be acted on or displayed.
  const iss = params.get('iss');
  if (iss !== null && iss !== options.expectedIssuer) {
    return {
      ok: false,
      error: new LoginError(
        'issuer_mismatch',
        'The authorization response came from an unexpected issuer; login aborted.',
      ),
    };
  }
  if (iss === null && options.issParameterSupported) {
    return {
      ok: false,
      error: new LoginError(
        'issuer_missing',
        'The authorization response did not identify its issuer; login aborted.',
      ),
    };
  }

  const error = params.get('error');
  if (error !== null) {
    if (error === 'access_denied')
      return { ok: false, error: new LoginError('access_denied', 'Authorization was denied.') };
    if (error === 'invalid_scope')
      return {
        ok: false,
        error: new LoginError(
          'invalid_scope',
          'None of the requested permissions is available to this account, so nothing was granted. ' +
            'Sign in again asking for user-side permissions (programs:read, profile:read, reports:read, ' +
            'reports:write), or ask an Administrator of your organisation to enable "AI triage access" ' +
            '(triage:read, triage:write) or "AI grading" (grade:write). BugSecure staff accounts never ' +
            'receive organisation-side permissions.',
        ),
      };
    const description = params.get('error_description');
    const detail = cleanMessage(description === null ? error : `${error}: ${description}`, 200);
    return {
      ok: false,
      error: new LoginError('authorization_error', `The authorization server returned an error (${detail}).`),
    };
  }

  const code = params.get('code');
  if (code === null || code === '') {
    return {
      ok: false,
      error: new LoginError('authorization_error', 'The authorization response carried no code.'),
    };
  }
  return { ok: true, code };
};

export const startLoopbackReceiver = async (options: LoopbackOptions): Promise<LoopbackReceiver> => {
  let settle: ((outcome: { code: string } | { error: LoginError }) => void) | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = (outcome) => {
      if ('code' in outcome) resolve(outcome.code);
      else reject(outcome.error);
    };
  });
  // Callers may never await `code` if they abort early; avoid an unhandled rejection.
  code.catch(() => undefined);

  let expectedHost = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' || req.headers.host !== expectedHost) {
      respond(res, 400, 'Bad request', 'This address only accepts the BugSecure login redirect.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname !== CALLBACK_PATH) {
      respond(res, 404, 'Not found', 'This address only accepts the BugSecure login redirect.');
      return;
    }
    const outcome = evaluateCallback(url, options);
    if (outcome.ok === 'ignore') {
      respond(
        res,
        400,
        'Login link expired',
        'This login link is not the one bugsecure-mcp is waiting for. Start again from your terminal.',
      );
      return;
    }
    if (outcome.ok) {
      respond(
        res,
        200,
        'Signed in',
        'bugsecure-mcp is now connected to BugSecure. You can close this tab and return to your terminal.',
      );
      settle?.({ code: outcome.code });
    } else {
      respond(
        res,
        400,
        'Sign-in failed',
        'bugsecure-mcp could not complete sign-in. See your terminal for details.',
      );
      settle?.({ error: outcome.error });
    }
    settle = undefined; // one terminal outcome only
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 50;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_ADDRESS, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  expectedHost = `${LOOPBACK_ADDRESS}:${port}`;

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  const fail = (error: LoginError): void => {
    settle?.({ error });
    settle = undefined;
  };
  const timer = setTimeout(() => {
    fail(
      new LoginError(
        'timeout',
        `Timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for the browser sign-in.`,
      ),
    );
  }, options.timeoutMs);
  timer.unref();
  const onAbort = (): void => {
    fail(new LoginError('cancelled', 'Login cancelled.'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  return { redirectUri: `http://${expectedHost}${CALLBACK_PATH}`, code, close };
};
