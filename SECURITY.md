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

## Known limitations

Documented trade-offs, so they are not reported as new findings (better
mitigations are welcome):

- **Approval replay across hosted instances.** An approval is single use per
  server instance, for ten minutes; instances do not share that memory. A
  captured approved retry (same user, same client, byte-identical arguments)
  replayed to another instance within ten minutes would be executed there. The
  BugSecure API has no idempotency key for these writes. Mitigations: the
  replay needs the user's own access token; `submit_report` refuses a report
  whose exact title was filed on the same programme by the same user in the
  last ten minutes (when the connection holds `reports:read`); grading is one
  grade per report and status moves cannot repeat, so those are refused by the
  API; a replayed comment or appeal would be a duplicate the user can see.
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
