import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateCallback,
  LoginError,
  type LoopbackOptions,
  type LoopbackReceiver,
  startLoopbackReceiver,
} from './loopback.js';

const ISSUER = 'https://as.test';
const options: LoopbackOptions = {
  expectedState: 'state-123',
  expectedIssuer: ISSUER,
  issParameterSupported: true,
  timeoutMs: 5_000,
};

const cb = (query: Record<string, string>): URL => {
  const url = new URL('http://127.0.0.1:1/callback');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
};

describe('evaluateCallback (state and RFC 9207 iss checks)', () => {
  it('accepts a matching state and issuer', () => {
    expect(evaluateCallback(cb({ state: 'state-123', iss: ISSUER, code: 'c' }), options)).toEqual({
      ok: true,
      code: 'c',
    });
  });

  it('ignores a wrong or missing state (keeps waiting)', () => {
    expect(evaluateCallback(cb({ state: 'nope', iss: ISSUER, code: 'c' }), options)).toEqual({
      ok: 'ignore',
    });
    expect(evaluateCallback(cb({ iss: ISSUER, code: 'c' }), options)).toEqual({ ok: 'ignore' });
  });

  it('aborts on an issuer mismatch, compared as exact strings', () => {
    for (const iss of ['https://evil.test', 'https://AS.test', 'https://as.test/', 'https://as.test:443']) {
      const outcome = evaluateCallback(cb({ state: 'state-123', iss, code: 'c' }), options);
      expect(outcome).toMatchObject({ ok: false, error: { code: 'issuer_mismatch' } });
    }
  });

  it('does not act on an error response whose issuer mismatches', () => {
    const outcome = evaluateCallback(
      cb({
        state: 'state-123',
        iss: 'https://evil.test',
        error: 'access_denied',
        error_description: 'phish',
      }),
      options,
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'issuer_mismatch' } });
    expect(JSON.stringify(outcome)).not.toContain('phish');
  });

  it('requires iss when the AS advertises support, tolerates absence otherwise', () => {
    expect(evaluateCallback(cb({ state: 'state-123', code: 'c' }), options)).toMatchObject({
      ok: false,
      error: { code: 'issuer_missing' },
    });
    expect(
      evaluateCallback(cb({ state: 'state-123', code: 'c' }), { ...options, issParameterSupported: false }),
    ).toEqual({
      ok: true,
      code: 'c',
    });
  });

  it('reports authorization errors', () => {
    expect(
      evaluateCallback(cb({ state: 'state-123', iss: ISSUER, error: 'access_denied' }), options),
    ).toMatchObject({
      ok: false,
      error: { code: 'access_denied' },
    });
    expect(
      evaluateCallback(
        cb({ state: 'state-123', iss: ISSUER, error: 'server_error', error_description: 'x' }),
        options,
      ),
    ).toMatchObject({ ok: false, error: { code: 'authorization_error' } });
    expect(evaluateCallback(cb({ state: 'state-123', iss: ISSUER }), options)).toMatchObject({
      ok: false,
      error: { code: 'authorization_error' },
    });
  });

  it('explains invalid_scope: none of the requested permissions is available to the account', () => {
    const outcome = evaluateCallback(
      cb({ state: 'state-123', iss: ISSUER, error: 'invalid_scope' }),
      options,
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_scope' } });
    const message = (outcome as { error: Error }).error.message;
    expect(message).toContain('None of the requested permissions is available to this account');
    expect(message).toContain('AI triage access');
    expect(message).toContain('BugSecure staff accounts never receive organisation-side permissions');
  });
});

const get = (
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> => {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
};

let receiver: LoopbackReceiver | undefined;
afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
});

describe('startLoopbackReceiver', () => {
  it('binds an ephemeral port on 127.0.0.1 and resolves the code once', async () => {
    receiver = await startLoopbackReceiver(options);
    expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const wrong = await get(`${receiver.redirectUri}?state=wrong&code=x&iss=${encodeURIComponent(ISSUER)}`);
    expect(wrong.status).toBe(400);

    const ok = await get(
      `${receiver.redirectUri}?state=state-123&code=the-code&iss=${encodeURIComponent(ISSUER)}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
    expect(ok.body).not.toContain('the-code'); // nothing reflected
    await expect(receiver.code).resolves.toBe('the-code');
  });

  it('is not reachable on non-loopback interfaces', async () => {
    receiver = await startLoopbackReceiver(options);
    const port = new URL(receiver.redirectUri).port;
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i?.family === 'IPv4' && !i.internal);
    const targets = ['http://[::1]', ...(external ? [`http://${external.address}`] : [])];
    for (const target of targets) {
      await expect(get(`${target}:${port}/callback`)).rejects.toThrow();
    }
  });

  it('rejects requests whose Host is not the loopback address (DNS rebinding)', async () => {
    receiver = await startLoopbackReceiver(options);
    const res = await get(
      `${receiver.redirectUri}?state=state-123&code=c&iss=${encodeURIComponent(ISSUER)}`,
      {
        host: 'attacker.example',
      },
    );
    expect(res.status).toBe(400);
  });

  it('404s other paths', async () => {
    receiver = await startLoopbackReceiver(options);
    const res = await get(receiver.redirectUri.replace('/callback', '/other'));
    expect(res.status).toBe(404);
  });

  it('times out', async () => {
    receiver = await startLoopbackReceiver({ ...options, timeoutMs: 50 });
    await expect(receiver.code).rejects.toMatchObject({ code: 'timeout' });
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    receiver = await startLoopbackReceiver({ ...options, signal: controller.signal });
    controller.abort();
    const error = await receiver.code.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect(error).toMatchObject({ code: 'cancelled' });
  });

  it('fails the login on an issuer mismatch', async () => {
    receiver = await startLoopbackReceiver(options);
    const res = await get(
      `${receiver.redirectUri}?state=state-123&code=c&iss=${encodeURIComponent('https://evil.test')}`,
    );
    expect(res.status).toBe(400);
    await expect(receiver.code).rejects.toMatchObject({ code: 'issuer_mismatch' });
  });
});
