/**
 * Small helpers shared by every outbound HTTP call (GraphQL, OAuth endpoints).
 * Everything uses the platform `fetch`; there is no HTTP client dependency.
 */
import { BugSecureError } from './errors.js';
import { USER_AGENT } from './version.js';

export type FetchFn = typeof globalThis.fetch;

/** Hostnames (as `URL#hostname` spells them) that are this machine: plain http is allowed only for these. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Default cap on any response body we buffer (GraphQL results, OAuth JSON). */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError';
}

/**
 * Read a request or response body as text, refusing to buffer more than
 * `maxBytes` (checked against Content-Length up front and while streaming).
 */
export const readTextCapped = async (
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes: number,
): Promise<string> => {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(`response of ${declared} bytes exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return '';

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

/** Combine a caller's cancellation signal with a timeout. */
export const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

/** Default headers for every request this package makes. */
export const baseHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  return { 'user-agent': USER_AGENT, ...extra };
};

/**
 * Turn a thrown fetch/abort error into a BugSecureError, unless the *caller*
 * cancelled — cancellation propagates unchanged.
 */
export const mapNetworkError = (
  error: unknown,
  callerSignal: AbortSignal | undefined,
  what: string,
): never => {
  if (callerSignal?.aborted) throw error;
  if (error instanceof BugSecureError) throw error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    throw new BugSecureError('UPSTREAM_UNAVAILABLE', `${what} timed out.`, { cause: error });
  }
  if (error instanceof ResponseTooLargeError) {
    throw new BugSecureError('UPSTREAM_ERROR', `${what} returned an unexpectedly large response.`, {
      cause: error,
    });
  }
  throw new BugSecureError('UPSTREAM_UNAVAILABLE', `${what} could not be reached.`, { cause: error });
};

// Printable text only, bounded: for server-provided messages we relay. C0 and
// C1 controls (newlines included: a message is one line), line/paragraph
// separators, and invisible or direction-changing characters are removed, so
// relayed text cannot fake structure or hide anything from a reader.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;
const HIDDEN = /\p{Default_Ignorable_Code_Point}/gu;
export const cleanMessage = (message: string, max = 300): string => {
  const cleaned = message.replace(HIDDEN, '').replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
};
