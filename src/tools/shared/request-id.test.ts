import { describe, expect, it } from 'vitest';

import { CLIENT_REQUEST_ID, newClientRequestId, partRequestId } from './request-id.js';

describe('idempotency keys', () => {
  it('are fresh, and fit the API’s key format', () => {
    const a = newClientRequestId();
    expect(a).toMatch(CLIENT_REQUEST_ID);
    expect(newClientRequestId()).not.toBe(a);
  });

  it('derive one deterministic key per part of a call', () => {
    const base = newClientRequestId();
    expect(partRequestId(base, 0)).toBe(`${base}-0`);
    expect(partRequestId(base, 49)).toMatch(CLIENT_REQUEST_ID);
    expect(() => partRequestId(base, -1)).toThrow(RangeError);
    expect(() => partRequestId(base, 1.5)).toThrow(RangeError);
    expect(() => partRequestId('x'.repeat(127), 10)).toThrow(RangeError);
  });
});
