# Security policy

bugsecure-mcp connects AI assistants to people's BugSecure accounts, including
unpublished vulnerability reports. We take its security seriously and welcome
research on it.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a
vulnerability.**

Report privately through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/kulinda-sec/bugsecure-mcp/security/advisories/new)**
(Security tab → "Report a vulnerability").

Please include:

- the affected version (`bugsecure-mcp --version`) and mode (local stdio or hosted);
- a description of the issue and its impact;
- step-by-step reproduction, ideally a minimal proof of concept;
- any suggested fix.

Use test accounts and your own data only. Do not include real tokens or other
people's report contents in your submission.

### This project is in scope for the BugSecure programme

bugsecure-mcp — this repository, the published npm package and the hosted
endpoint `https://bugsecure-mcp.senintel.sn/mcp` — is in scope for the BugSecure
bug bounty programme:
**<https://bugsecure.senintel.sn/programs/klds-web-api>**. You may report through the programme instead of
GitHub if you want your finding to be eligible for a reward; reporting here does
not make it ineligible, just mention it.

## What we consider a vulnerability

Examples of what we want to hear about:

- getting a tool to act beyond the OAuth scopes the user granted, or outside
  `--read-only`;
- accepting tokens not issued for this server, or forwarding a client's token to
  the BugSecure API (token passthrough);
- flaws in the login flow (PKCE, `state`, issuer validation, the loopback
  receiver), token storage, refresh or revocation;
- bypassing the Host/Origin checks, body limits or authentication of the hosted
  endpoint;
- third-party content escaping the `<untrusted-content>` fencing, or reaching
  logs;
- secrets, tokens or report contents leaking through logs, errors or files;
- supply-chain issues in how this project is built and released.

Generally out of scope:

- an AI model choosing to follow instructions found in third-party content that
  was correctly fenced (report that to the model or client vendor; we are still
  interested in ideas for stronger fencing);
- issues in the BugSecure platform itself that do not involve this project
  (report those through the BugSecure programme);
- findings requiring a compromised local machine or MCP client;
- missing hardening without a demonstrable impact, and volumetric DoS.

## Requirements

Write tools need a **BugSecure API that stores idempotency keys on every write
(September 2026)**: every mutation this server sends carries a
`clientRequestId`. Against an older API those calls are refused before anything
runs (the argument is unknown to it), the tool reports that the API does not
accept idempotency keys yet, and nothing is written; read tools are unaffected.

How the key closes approval replay across hosted instances: an approval is
single use per server instance, for ten minutes, and instances do not share
that memory. But the approval's single-use nonce, sealed in the request state
with the tool name and a digest of the exact arguments, is also the write's
idempotency key. The API performs each write at most once per user, operation
and key: the same key with the same arguments gets back what the first request
wrote, as it stands now, instead of writing again; the same key with other
arguments is refused (`IDEMPOTENCY_KEY_REUSED`), and a duplicate that arrives
while the first is still running is refused (`IDEMPOTENCY_KEY_IN_PROGRESS`). A
captured approved retry replayed to another instance therefore makes no second
change. This relies on the API remembering keys for at least the ten minutes an
approval is valid (it keeps them for 24 hours). A write that sends several
mutations (marking several notifications read) derives one key per mutation
from the nonce, so a replay sends each of them with the key of its first use.
A replayed approval that reaches the same instance is refused before anything
is sent, and the refusal says the change was already sent and which read tool
to check, since asking the user to approve again would be a new key.

A write whose answer is lost (a timeout, a dropped connection, a 5xx, or an
internal error after the API may have committed) is resent **once**, with the
same key: the API reserves the key as the first statement of the write's own
transaction, so either it committed and answers the resend with what it wrote,
or it rolled back with the key and the resend is the first attempt that
counts. While the API reports the first request still running, that resend
waits briefly and asks again. If the resend gets no confirmation either, the
tool does not report a plain failure: it says the change may already have been
made and must be checked with a read tool before the user is asked to approve
it again, since a new approval is a new key. A resend the API rate limits is
treated the same way: its rate limiter runs before it looks the key up, so the
first request may well have committed.

## Known limitations

Documented trade-offs, so they are not reported as new findings (better
mitigations are welcome):

- **Certificate bytes are rebuilt.** The API returns a certificate's signed
  document as parsed JSON, not the exact bytes it signed, so
  `verify_certificate` re-serialises it with the same canonical JSON BugSecure
  signs with. A document that does not survive a JSON round trip (a number
  beyond 2^53, for example) would fail to verify: a false negative, never a
  false positive.
- **Identifying the user.** To tell your own reports from your organisations'
  when a token reaches both, the server reads the user id from the access
  token (`sub`). In local mode that token is decoded, not verified, by this
  process — it is the token the process obtained itself, and the API verifies
  it on every call.

## What to expect

- Acknowledgement within **3 business days**.
- An initial assessment within **10 business days**.
- Fixes for confirmed issues are released as soon as practical; we coordinate
  the disclosure date with you and credit you in the advisory unless you prefer
  otherwise. We aim to disclose within 90 days of the report.

## Supported versions

| Version            | Supported           |
| ------------------ | ------------------- |
| latest `0.x` minor | ✅                  |
| older              | ❌ — please upgrade |

After 1.0, the latest minor of the current major will be supported, and the
previous major for six months after a new major is released.

## Safe harbour

We will not pursue or support legal action against you for security research on
this project that is conducted in good faith and in line with this policy, which
means you:

- make a good-faith effort to avoid privacy violations, data destruction and
  service disruption;
- only interact with accounts you own or have explicit permission to use, and
  stop and report as soon as you encounter anyone else's data;
- do not exploit a finding beyond what is needed to demonstrate it;
- give us reasonable time to fix the issue before any disclosure.

If in doubt about whether an activity is authorised, ask us first through a
private report. If a third party takes legal action against you for research
that complied with this policy, we will make it known that your actions were
authorised.

## Verifying releases

Every npm release is published from GitHub Actions with npm trusted publishing
and carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).
Verify with:

```sh
npm audit signatures
```
