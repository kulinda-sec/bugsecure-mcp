/**
 * Where the user is sent to review a write: only a BugSecure review page.
 *
 * The API returns the review page's URL with each approval, and the MCP
 * client opens that URL in the user's browser (URL-mode elicitation). The API
 * is trusted for the approval itself, but a URL is where a mistake or a
 * compromise on the way (a wrong deployment, a tampered response) would send
 * the user, signed in, to another host. So the URL is accepted only when it
 * is exactly the review page of THE approval, on the web origin this server
 * was configured with (`BUGSECURE_WEB_URL`), and otherwise the user is told to
 * open the page from BugSecure's own menu instead. Fail closed: a URL that
 * does not pass is never shown.
 */
import { LOOPBACK_HOSTS } from '../http.js';

/** The shape of an approval id (128 random bits, base64url) as the API issues it. */
export const APPROVAL_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** The review page of approval `id`, relative to the web origin (no locale prefix). */
export const REVIEW_PATH_PREFIX = '/agent-approvals/';

/** Longer than any review URL can be; refused before parsing. */
export const MAX_REVIEW_URL_LENGTH = 2048;

/** `true` for a syntactically plausible approval id. */
export const isApprovalId = (value: unknown): value is string => {
  return typeof value === 'string' && APPROVAL_ID.test(value);
};

/**
 * The web origin a configured `BUGSECURE_WEB_URL` denotes: https, or http on
 * a loopback host only (a development web app), with no path, userinfo, query
 * or fragment. Returns `undefined` for anything else.
 */
export const webOrigin = (webUrl: string): URL | undefined => {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return undefined;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== '/') return undefined;
  return url;
};

/**
 * Validate the review URL the API returned for approval `approvalId`: it must
 * be `<web origin>/agent-approvals/<approvalId>` exactly, with nothing else
 * (no userinfo, query or fragment, and no other id). Returns the URL to show,
 * or `undefined` when it must not be shown.
 */
export const validateReviewUrl = (
  raw: unknown,
  approvalId: string,
  webUrl: string | undefined,
): string | undefined => {
  if (webUrl === undefined || typeof raw !== 'string' || raw.length > MAX_REVIEW_URL_LENGTH) return undefined;
  if (!isApprovalId(approvalId)) return undefined;
  const origin = webOrigin(webUrl);
  if (origin === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.origin !== origin.origin || url.protocol !== origin.protocol) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== `${REVIEW_PATH_PREFIX}${approvalId}`) return undefined;
  // Re-serialised, so what is shown is exactly what was checked (no odd encodings survive).
  return `${origin.origin}${REVIEW_PATH_PREFIX}${approvalId}`;
};
