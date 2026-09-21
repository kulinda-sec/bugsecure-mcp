# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor
versions may contain breaking changes. The "Unreleased" section below is the
hand-written entry for the first release, 0.1.0; from 0.2.0 on, release sections
are generated from the commit history by [cocogitto](https://docs.cocogitto.io)
(`cog bump`), newest first, above the separator below, and this file is no
longer edited by hand.

- - -

## [Unreleased]

### Added

- MCP server for BugSecure implementing MCP specification revision **2026-07-28**
  (also serves 2025-era clients), on the official TypeScript SDK v2.
- **Local mode** (stdio): `login` (OAuth 2.1 authorization code + PKCE S256 via a
  127.0.0.1 loopback redirect, `state` and RFC 9207 `iss` validation; the read
  scopes and `reports:write` by default, other write scopes opt-in), `logout` (RFC 7009 revocation), `whoami`; tokens in the OS keychain
  with a 0600-file fallback, refused when stored for a different API; refresh-token
  rotation, login and logout serialised across processes by a heartbeat file lock.
- **Hosted mode** (`serve --http`): stateless Streamable HTTP, OAuth 2.1 protected
  resource with RFC 9728 metadata (read scopes and `reports:write` advertised;
  other writes by `insufficient_scope` step-up naming granted plus missing scopes), local JWT
  validation (RFC 9068, maximum token age) against the authorization server's JWKS,
  RFC 8693 token exchange (no token passthrough), Host/Origin allowlists checked
  before any body is read, body-size limits, request deadlines, and per-user,
  per-client rate limiting of tool calls. Distroless container image.
- **User approval of every write** through MCP elicitation (form mode, multi
  round-trip requests), bound to the user, the exact arguments and ten minutes,
  single use; fail-closed for clients without elicitation.
- Tool framework: every tool listed (scopes checked per call), `--read-only`,
  required annotations, zod input/output schemas with `structuredContent` plus the
  same JSON as text, and third-party text fenced in `<untrusted-content-NONCE>`
  blocks with a per-response nonce; every other output string strictly shaped.
- Tools — programmes (`programs:read`): `search_programs` (also the private
  programmes you were invited to), `get_program` (optionally with its published
  disclosures, hall of fame and reward statistics), `get_program_terms` (a
  programme's or the platform's published terms, read-only), `search`,
  `get_leaderboard`, `get_researcher_profile`, `list_badges`, `verify_certificate`
  (returns the signed bytes — rebuilt with BugSecure's canonical JSON, as the API
  returns the document parsed — the detached JWS and the published public key
  that signed it), `get_taxonomy` (the vulnerability taxonomy grades are judged
  against).
- Tools — profile (`profile:read`): `get_my_profile` (optionally with report
  statistics and monthly activity), `list_notifications`, `list_my_certificates`
  (who graded, Critical review outcome, dispute window), `get_my_kyc_status`.
- Tools — researcher reports: `list_my_reports` (with the grade in brief and the
  deadline state), `get_report` (`reports:read`); `submit_report`,
  `add_report_comment`, `raise_appeal` (`reports:write`).
- Tools — your own account: `mark_notifications_read` (`notifications:write`);
  `update_my_profile` (`profile:write`: bio, website, country; never the avatar);
  `save_disclosure_draft` (`disclosures:write`: drafts the public disclosure of
  your own report and never publishes it — publication needs both parties'
  approval on the website; a published disclosure is refused). `get_report`
  returns the draft and its revision when `disclosures:write` is granted.
- Tools — triage, limited to organizations that enabled AI triage access:
  `list_my_organizations` (with each one's AI triage and AI grading consent),
  `list_org_programs` (drafts included), `list_org_reports`, `get_org_report`
  (with the grade in force and appeals), `get_org_report_stats` (with monthly
  payouts), `get_program_stats`, `check_duplicates`, `list_org_certificates`
  (what the organization owes, never settlement details) (`triage:read`);
  `update_report_status`, `add_triage_comment` (internal note unless
  `visibleToResearcher: true`), `assign_report` (to yourself only)
  (`triage:write`). Internal organization notes are never returned to the model.
- Tools — grading as the organization (`grade:write`, organizations that also
  enabled AI grading): `grade_report`, a binding grade that issues the payout
  certificate the organization owes; a Critical grade waits on BugSecure's review.
- **Organization-side safeguards.** Triage and grading writes refuse BugSecure
  staff accounts (roles read through `profile:read`, which those tools require),
  and a grade the API records as BugSecure's is reported as an error. Where one
  token reaches both sides, researcher tools act only on the user's own reports
  and organization tools never on them. Hosted step-up is never used for
  scopes only some accounts can hold, organization-side or researcher-only (the
  tool explains eligibility instead); the researcher-only writes are requested
  on first connection instead; `login` says
  which requested scopes were not granted and why.
- **Approval prompts** show what the ids refer to (programme, report title,
  researcher, the grade appealed), looked up read-only; prefix every value line
  so content cannot fake the dialog's own text; escape control, invisible and
  direction-changing characters and markup openers; state each value's size; and
  refuse payloads over 50,000 characters. Inputs refuse control characters.
  `submit_report` refuses an apparent replay (same title, programme and user
  within the approval lifetime).
- **Bounded, fenced output.** Report comments and status history are paged, long
  report fields are cut inside their fence with a marker (`fullText` for all),
  certificate and badge lists are paged; API error messages are fenced; unknown
  API refusals are relayed (fenced), not reported as internal errors; firewall
  refusals (`REQUEST_BLOCKED`), unaccepted terms (the researcher's own, or the
  organisation's, per `termsKind`), a staff account refused organization-side
  access (`PLATFORM_STAFF_SCOPE_REFUSED`), files still being checked and
  `scopeMatch: any` scope errors each get specific advice. Output schemas are
  published compactly (tools/list about 77 KB for 33 tools).
- **Hosted hardening.** A dedicated approval-sealing key
  (`BUGSECURE_MCP_APPROVAL_KEY`, required outside localhost); exact Origin
  matching (scheme, host and port); no loopback `Host` names by default in
  production; per-user and write-tool rate limits on top of per-client ones;
  a 1 MiB body limit matching the largest approvable write; token exchange
  refuses an empty scope and any broader-than-requested result, and treats
  `invalid_scope` as a dead token. Local mode treats `invalid_scope` on refresh
  as an ended session. Logs carry error names and codes only, never messages.
