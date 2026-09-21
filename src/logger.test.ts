import { describe, expect, it } from 'vitest';

import { createLogger, redact } from './logger.js';

const capture = (level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'debug') => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { logger, lines };
};

describe('logger', () => {
  it('writes one JSON object per line with level and message', () => {
    const { logger, lines } = capture();
    logger.info('hello', { count: 3 });
    expect(lines).toEqual([{ time: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'hello', count: 3 }]);
  });

  it('filters below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((l) => l.msg)).toEqual(['c', 'd']);
  });

  it.each([
    'token',
    'access_token',
    'refreshToken',
    'Authorization',
    'client_secret',
    'code',
    'code_verifier',
    'state',
    'body',
    'description',
    'password',
    'subject-token',
  ])('redacts sensitive field %s', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: '[redacted]' });
  });

  it('keeps useful metadata', () => {
    expect(redact({ statusCode: 401, op: 'SearchPrograms', scopes: ['programs:read'] })).toEqual({
      statusCode: 401,
      op: 'SearchPrograms',
      scopes: ['programs:read'],
    });
  });

  it('redacts nested objects, truncates long strings and strips URL queries', () => {
    const out = redact({
      nested: { accessToken: 'x', ok: 1 },
      long: 'a'.repeat(500),
      url: new URL('https://h/p?code=secret'),
      error: new Error('boom'),
    });
    expect(out.nested).toEqual({ accessToken: '[redacted]', ok: 1 });
    expect(String(out.long)).toHaveLength(201);
    expect(out.url).toBe('https://h/p');
    expect(out.error).toEqual({ name: 'Error' }); // never the message
  });

  it('keeps error codes (errorCode) while still redacting OAuth authorization codes (code)', () => {
    const { logger, lines } = capture();
    logger.info('tool error', { errorCode: 'ORG_AI_ACCESS_DISABLED', code: 'auth-code-abc123' });
    expect(lines[0]).toMatchObject({ errorCode: 'ORG_AI_ACCESS_DISABLED', code: '[redacted]' });
    expect(JSON.stringify(lines)).not.toContain('auth-code-abc123');
  });

  it('child loggers carry bound fields', () => {
    const { logger, lines } = capture();
    logger.child({ tool: 'x' }).info('y');
    expect(lines[0]).toMatchObject({ tool: 'x', msg: 'y' });
  });
  it('redacts the fields that carry what people wrote in reports, appeals and grades', () => {
    const out = redact({
      title: 't',
      impact: 'i',
      grounds: 'g',
      reasoning: 'r',
      reason: 'why',
      deviationReason: 'd',
      amountReason: 'a',
      message: 'm',
      reportId: 'r1',
    });
    for (const key of [
      'title',
      'impact',
      'grounds',
      'reasoning',
      'reason',
      'deviationReason',
      'amountReason',
      'message',
    ])
      expect(out[key], key).toBe('[redacted]');
    expect(out.reportId).toBe('r1');
  });

  it('logs an error’s machine code, never its message', () => {
    const coded = Object.assign(new Error('token=abc in https://x/?code=1'), { code: 'SESSION_EXPIRED' });
    const oauth = Object.assign(new Error('bad'), { error: 'invalid_grant' });
    const junk = Object.assign(new Error('x'), { code: 'not a code!' });
    expect(redact({ e: coded, o: oauth, j: junk })).toEqual({
      e: { name: 'Error', code: 'SESSION_EXPIRED' },
      o: { name: 'Error', code: 'invalid_grant' },
      j: { name: 'Error' },
    });
  });
});
