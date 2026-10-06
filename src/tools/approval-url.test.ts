import { describe, expect, it } from 'vitest';

import { isApprovalId, MAX_REVIEW_URL_LENGTH, validateReviewUrl, webOrigin } from './approval-url.js';

const ID = 'Zm9vYmFyYmF6cXV4MTIzNDU2';
const WEB = 'https://bugsecure.example';

describe('validateReviewUrl', () => {
  it('accepts exactly the review page of this approval on the configured web origin', () => {
    expect(validateReviewUrl(`${WEB}/agent-approvals/${ID}`, ID, WEB)).toBe(`${WEB}/agent-approvals/${ID}`);
    // A loopback development web app may be plain http.
    expect(
      validateReviewUrl(`http://localhost:3000/agent-approvals/${ID}`, ID, 'http://localhost:3000'),
    ).toBe(`http://localhost:3000/agent-approvals/${ID}`);
  });

  it.each([
    ['another host', `https://evil.example/agent-approvals/${ID}`, WEB],
    ['a subdomain of the host', `https://bugsecure.example.evil.example/agent-approvals/${ID}`, WEB],
    ['http on a public host', `http://bugsecure.example/agent-approvals/${ID}`, WEB],
    ['another port', `${WEB}:8443/agent-approvals/${ID}`, WEB],
    ['userinfo', `https://user@bugsecure.example/agent-approvals/${ID}`, WEB],
    ['a query', `${WEB}/agent-approvals/${ID}?next=https://evil.example`, WEB],
    ['a fragment', `${WEB}/agent-approvals/${ID}#x`, WEB],
    ['another approval', `${WEB}/agent-approvals/${ID.replace('Z', 'Y')}`, WEB],
    ['a locale prefix', `${WEB}/en/agent-approvals/${ID}`, WEB],
    ['another path', `${WEB}/settings/agent-approvals/${ID}`, WEB],
    ['a trailing slash', `${WEB}/agent-approvals/${ID}/`, WEB],
    ['a traversal', `${WEB}/agent-approvals/../login`, WEB],
    ['an encoded path', `${WEB}/agent-approvals%2F${ID}`, WEB],
    ['not a URL', 'agent-approvals', WEB],
    ['a javascript: URL', `javascript:alert(1)//agent-approvals/${ID}`, WEB],
    ['an over-long URL', `${WEB}/agent-approvals/${ID}${'/'.repeat(MAX_REVIEW_URL_LENGTH)}`, WEB],
    ['a web origin with a path', `${WEB}/app/agent-approvals/${ID}`, `${WEB}/app`],
    [
      'an http web origin on a public host',
      `http://bugsecure.example/agent-approvals/${ID}`,
      'http://bugsecure.example',
    ],
  ])('refuses %s', (_what, url, web) => {
    expect(validateReviewUrl(url, ID, web)).toBeUndefined();
  });

  it('refuses everything when no web origin is configured, or the id is not an id', () => {
    expect(validateReviewUrl(`${WEB}/agent-approvals/${ID}`, ID, undefined)).toBeUndefined();
    expect(validateReviewUrl(`${WEB}/agent-approvals/x`, 'x', WEB)).toBeUndefined();
    expect(validateReviewUrl(42, ID, WEB)).toBeUndefined();
  });
});

describe('webOrigin', () => {
  it('accepts an https origin, or http on loopback, with nothing else', () => {
    expect(webOrigin(WEB)?.origin).toBe(WEB);
    expect(webOrigin(`${WEB}/`)?.origin).toBe(WEB);
    expect(webOrigin('http://127.0.0.1:3000')?.host).toBe('127.0.0.1:3000');
    for (const bad of [
      `${WEB}/app`,
      'http://bugsecure.example',
      `${WEB}?x=1`,
      `${WEB}#f`,
      'https://u@h.example',
      'nope',
    ]) {
      expect(webOrigin(bad), bad).toBeUndefined();
    }
  });
});

describe('isApprovalId', () => {
  it('accepts base64url ids of a plausible length only', () => {
    expect(isApprovalId(ID)).toBe(true);
    expect(isApprovalId('short')).toBe(false);
    expect(isApprovalId(`${ID}/..`)).toBe(false);
    expect(isApprovalId('x'.repeat(129))).toBe(false);
    expect(isApprovalId(42)).toBe(false);
  });
});
