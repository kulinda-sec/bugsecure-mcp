/**
 * Idempotency keys for writes (`clientRequestId` on every BugSecure mutation
 * this server sends).
 *
 * The API runs each write at most once per (user, operation, key): the same
 * key with the same arguments gets back what the first request wrote, as it
 * stands now, instead of writing again; with other arguments it is refused
 * (`IDEMPOTENCY_KEY_REUSED`), and while the first is still running a
 * duplicate is refused (`IDEMPOTENCY_KEY_IN_PROGRESS`). Every mutation this
 * server sends is one of those writes (SECURITY.md § Requirements). The API
 * hashes the arguments as sent, `null` kept and an omitted field dropped, so
 * every attempt under one key must send the same variable shape; the one
 * resend and a replayed approval do, since both reuse the first call's
 * variables.
 *
 * An approved write's key is the approval's single-use nonce (../approval.ts),
 * which is sealed in the request state together with the tool and a digest of
 * the exact arguments. A replay of that approval, on this instance or any
 * other, therefore carries the same key and the same arguments, and gets the
 * first result back. The one resend of a write whose answer was lost
 * (./write-retry.ts) reuses the key the same way. A write that did not go
 * through an approval gets a fresh key per call.
 */
import { randomToken } from '../../crypto.js';

/** What the API accepts as a key. */
export const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * What to do when a write may already have been made (its outcome is unknown,
 * or its approval was already used): check before a new approval, which would
 * be a new key and so a second write. Shared by the resend and the approval
 * gate so the two say the same thing.
 */
export const CHECK_BEFORE_REAPPROVING =
  'first check whether it was made with the matching read tool (get_report or list_my_reports for ' +
  'your reports and comments, get_org_report for an organisation’s report, get_my_profile for the profile, ' +
  'list_notifications for notifications), and tell the user what you found. Only if it was not made, and ' +
  'the user still wants it, do they approve it again.';

/** A fresh key: 16 random bytes, base64url (22 characters). */
export const newClientRequestId = (): string => randomToken(16);

/**
 * The key for the `index`-th mutation of one call that sends several (each
 * mutation needs its own key: the same key with other arguments is refused).
 * Deterministic, so a replay derives the same keys for the same items.
 */
export const partRequestId = (base: string, index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('index must be a non-negative integer');
  const key = `${base}-${String(index)}`;
  if (!CLIENT_REQUEST_ID.test(key)) throw new RangeError('request id does not fit the API’s key format');
  return key;
};
