# BugSecure MCP

[![CI](https://github.com/kulinda-sec/bugsecure-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kulinda-sec/bugsecure-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kulinda-sec/bugsecure-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/kulinda-sec/bugsecure-mcp/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/kulinda-sec/bugsecure-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/kulinda-sec/bugsecure-mcp)
[![npm](https://img.shields.io/npm/v/@kulinda-sec/bugsecure-mcp)](https://www.npmjs.com/package/@kulinda-sec/bugsecure-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[BugSecure](https://bugsecure.senintel.sn), the bug bounty platform. It lets an
AI assistant — Claude, Cursor, VS Code Copilot, or any MCP client — browse
programmes, work on your reports and help triage, **acting as you, with only the
permissions you approve**.

- Implements MCP specification **2026-07-28** (and serves 2025-era clients), on
  the official TypeScript SDK v2.
- OAuth 2.1 end to end: PKCE, audience-bound tokens, least-privilege scopes, no
  token passthrough.
- Third-party text (reports, comments, programme descriptions) is fenced as
  untrusted data before any model sees it.
- Nothing is ever written without **your explicit approval** of the exact
  content, asked by BugSecure in your MCP client ([details](#write-tools-and-approvals)).
- Small dependency tree; releases are built in CI with npm provenance.

> [!IMPORTANT]
> **Where your data goes.** When your assistant uses these tools, the results —
> which can include vulnerability report contents, comments and programme
> details — are sent to _your AI client's model provider_ as part of the
> conversation. Only connect BugSecure to AI services your organization's policy
> allows for that data. Organizations additionally control whether AI tools may
> access their triage data at all (see [Scopes](#scopes)).

## Two ways to connect

|               | **Local** (stdio)                                    | **Hosted** (remote)                                                                                                                         |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs          | On your machine, launched by your MCP client (`npx`) | At `https://bugsecure-mcp.senintel.sn/mcp`                                                                                                  |
| Sign-in       | `bugsecure-mcp login` once, in a terminal            | Your MCP client's built-in OAuth flow                                                                                                       |
| Tokens stored | OS keychain on your machine                          | By your MCP client                                                                                                                          |
| Needs         | Node.js ≥ 22.12                                      | A client that supports MCP OAuth with Client ID Metadata Documents or Dynamic Client Registration; see [writes](#write-tools-and-approvals) |

## Quick start — local

1. Sign in (opens your browser; approve the permissions you want):

   ```sh
   npx -y @kulinda-sec/bugsecure-mcp login
   ```

   By default this requests the read scopes and `reports:write` (submit a
   report, comment on or appeal one of yours; each still needs your approval).
   Other write scopes are opt-in: list everything you want (a new login
   replaces the previous one, so keep what you already use):

   ```sh
   npx -y @kulinda-sec/bugsecure-mcp login --scopes "programs:read profile:read reports:read reports:write notifications:write profile:write disclosures:write"
   ```

   If the assistant later calls a tool your login does not cover, the tool
   tells you the exact `login --scopes …` command to run.

2. Add the server to your client:

   <details open>
   <summary><b>Claude Code</b></summary>

   ```sh
   claude mcp add bugsecure -- npx -y @kulinda-sec/bugsecure-mcp
   ```

   </details>

   <details>
   <summary><b>Claude Desktop</b></summary>

   Settings → Developer → Edit Config (`claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "bugsecure": { "command": "npx", "args": ["-y", "@kulinda-sec/bugsecure-mcp"] }
     }
   }
   ```

   </details>

   <details>
   <summary><b>Cursor</b></summary>

   `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

   ```json
   {
     "mcpServers": {
       "bugsecure": { "command": "npx", "args": ["-y", "@kulinda-sec/bugsecure-mcp"] }
     }
   }
   ```

   </details>

   <details>
   <summary><b>VS Code</b></summary>

   `.vscode/mcp.json` (or "MCP: Add Server…" from the command palette):

   ```json
   {
     "servers": {
       "bugsecure": { "type": "stdio", "command": "npx", "args": ["-y", "@kulinda-sec/bugsecure-mcp"] }
     }
   }
   ```

   </details>

   Add `"--read-only"` to `args` to guarantee the assistant can never change
   anything, whatever you granted at login.

3. Restart the client. Check the login any time with
   `npx -y @kulinda-sec/bugsecure-mcp whoami`; sign out (and revoke access) with
   `npx -y @kulinda-sec/bugsecure-mcp logout`.

## Quick start — hosted

Point your client at `https://bugsecure-mcp.senintel.sn/mcp`. It discovers the
authorization server, opens the BugSecure consent screen, and lets you choose
exactly which permissions to grant (you can untick any of them). The first
connection asks for the read scopes, `reports:write`, and the researcher-only
`profile:write` and `disclosures:write` (left out automatically if your account
is not a researcher's). When you use a tool that needs more (for example marking
notifications read), the server answers with an OAuth step-up challenge and your
client asks you to approve the extra permission, keeping the ones you already
granted.

Your client must support MCP authorization with
[Client ID Metadata Documents](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
(or the older Dynamic Client Registration); the clients below do.

<details open>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add --transport http bugsecure https://bugsecure-mcp.senintel.sn/mcp
```

then run `/mcp` in Claude Code to sign in.

</details>

<details>
<summary><b>Claude Desktop / claude.ai</b></summary>

Settings → Connectors → Add custom connector → URL
`https://bugsecure-mcp.senintel.sn/mcp` → Connect.

</details>

<details>
<summary><b>Cursor</b></summary>

```json
{ "mcpServers": { "bugsecure": { "url": "https://bugsecure-mcp.senintel.sn/mcp" } } }
```

</details>

<details>
<summary><b>VS Code</b></summary>

```json
{ "servers": { "bugsecure": { "type": "http", "url": "https://bugsecure-mcp.senintel.sn/mcp" } } }
```

</details>

Review and revoke connected apps at any time in your BugSecure account settings.

## Tools

Every tool is listed whatever you granted, so you can see what more access would
enable; calling one without its scope changes nothing and explains how to grant
it. Write tools are hidden entirely in read-only mode.

| Tool                      | Scope                 | Changes data | Description                                                                                                                                     |
| ------------------------- | --------------------- | :----------: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_programs`         | `programs:read`       |      –       | Search the public catalogue of active programmes, or (`invited`) the private ones you were invited to                                           |
| `get_program`             | `programs:read`       |      –       | A programme's description, rules, scope and current reward grid; with `activity`, its published disclosures, hall of fame and reward statistics |
| `get_program_terms`       | `programs:read`       |      –       | Published terms, a programme's or BugSecure's: every version, and one in full (read-only)                                                       |
| `search`                  | `programs:read`       |      –       | Full-text search over programmes, public researcher profiles, and reports your scopes reach                                                     |
| `get_leaderboard`         | `programs:read`       |      –       | Top researchers, all-time or for the last month/quarter                                                                                         |
| `get_researcher_profile`  | `programs:read`       |      –       | A researcher's public profile                                                                                                                   |
| `list_badges`             | `programs:read`       |      –       | The badge catalogue, with your progress (paginated)                                                                                             |
| `verify_certificate`      | `programs:read`       |      –       | Fetch a payout certificate, its exact signed bytes, detached signature and BugSecure's public key, for verification                             |
| `get_taxonomy`            | `programs:read`       |      –       | The vulnerability taxonomy grades are judged against (node ids for `grade_report`)                                                              |
| `get_my_profile`          | `profile:read`        |      –       | Your account and researcher profile (never contact details); with `stats`, report statistics and monthly activity                               |
| `list_notifications`      | `profile:read`        |      –       | Your notifications (does not mark them read)                                                                                                    |
| `list_my_certificates`    | `profile:read`        |      –       | Your payout certificates: amounts owed, who graded, appeal window, due date (never settlement details); paged                                   |
| `get_my_kyc_status`       | `profile:read`        |      –       | Whether your identity verification is complete (never documents)                                                                                |
| `list_my_reports`         | `reports:read`        |      –       | Reports you submitted, with their grade in brief and deadline state                                                                             |
| `get_report`              | `reports:read`        |      –       | One of your reports with comments and status history (paged), the grade in force and appeals; with `disclosures:write`, its disclosure draft    |
| `submit_report`           | `reports:write`       |      ✅      | Submit one report (no attachments) to a programme, after you approve its exact text                                                             |
| `add_report_comment`      | `reports:write`       |      ✅      | Comment on one of your reports                                                                                                                  |
| `raise_appeal`            | `reports:write`       |      ✅      | Appeal the grade of one of your reports; BugSecure re-examines it                                                                               |
| `mark_notifications_read` | `notifications:write` |      ✅      | Mark some of your notifications, or all, as read                                                                                                |
| `update_my_profile`       | `profile:write`       |      ✅      | Change the bio, website or country on your public researcher profile (never the avatar); researchers only                                       |
| `save_disclosure_draft`   | `disclosures:write`   |      ✅      | Write the public disclosure draft of one of your reports. Never publishes: that takes both parties' approval on the website                     |
| `list_my_organizations`   | `triage:read`         |      –       | Your organizations that enabled AI triage access, and whether each enabled AI grading                                                           |
| `list_org_programs`       | `triage:read`         |      –       | Those organizations' programmes, drafts included, with their triage deadline                                                                    |
| `list_org_reports`        | `triage:read`         |      –       | Reports submitted to those organizations' programmes                                                                                            |
| `get_org_report`          | `triage:read`         |      –       | One of those reports with public comments, status history, triage deadline, the grade in force and appeals (no internal notes)                  |
| `get_org_report_stats`    | `triage:read`         |      –       | An organization's report trends, severity mix, monthly payouts and payment standing                                                             |
| `get_program_stats`       | `triage:read`         |      –       | A programme's report counts and time to resolution                                                                                              |
| `check_duplicates`        | `triage:read`         |      –       | Possible duplicates of a finding among a programme's reports                                                                                    |
| `list_org_certificates`   | `triage:read`         |      –       | The payout certificates an organization owes (never settlement details); needs `profile:read`                                                   |
| `update_report_status`    | `triage:write`        |      ✅      | Move a report through triage (some statuses are final); also needs `profile:read`                                                               |
| `add_triage_comment`      | `triage:write`        |      ✅      | Add an organization-only note (default), or a comment the researcher sees; needs `profile:read`                                                 |
| `assign_report`           | `triage:write`        |      ✅      | Assign a report to yourself (assigning someone else stays on the website); needs `profile:read`                                                 |
| `grade_report`            | `grade:write`         |      ✅      | Grade a report as your organization: binding, issues a certificate you owe; needs `profile:read`                                                |

Attachments (a report submitted here cannot carry any: submit on the website
if you need files, and open them there), accepting the platform and programme
terms, approving and publishing a disclosure, your avatar, assigning a report
to someone else, an organization's own appeals and everything on the "never"
list below stay on the BugSecure website.

The organization-side write tools, and `list_org_certificates`, also need
`profile:read`: before them the server checks the account's roles and refuses
BugSecure staff accounts (staff use BugSecure's own admin tools). Where a token holds both
a researcher-side and an organization-side scope, the tools also check whose
report it is: researcher tools act only on your own reports, organization tools
never on them.

### Grading as your organization

Organizations grade their own reports; BugSecure is the neutral third party.
`grade_report` decides a report's severity and reward **for your organization**,
exactly as an Administrator or Triager does on the website, and needs the
`grade:write` scope plus the organization's own **AI grading** consent (an
Administrator of the organization enables it; AI triage access alone is not
enough — without it the tool says so and nothing is sent). Reading the report
first uses the triage tools, so you will usually grant `triage:read` too. Treat
it as signing: the grade is binding and, where the report's reward grid pays for
the severity, immediately issues a signed payout certificate your organization
owes the researcher. It cannot be edited or withdrawn, only appealed (by the
researcher or your organization); BugSecure, as the appointed third party,
re-examines an appealed grade. A **Critical** grade is provisional: no
certificate issues until BugSecure reviews it (within 5 business days; if the
review lapses, your grade stands). The approval dialog shows the full grade,
the report it applies to and says it is binding. `DUPLICATE`, `OUT_OF_SCOPE` and
`NOT_APPLICABLE` are the only statuses that stop the triage deadline (and are
refused once a report is graded); a report left ungraded past its deadline may
be graded by BugSecure instead.

## Write tools and approvals

Every tool that changes something (✅ above) asks **you** — not the model —
before anything is sent. BugSecure shows the exact content in your MCP client's
approval dialog (MCP [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
form mode): what will be sent, who will see it (for example _"VISIBLE TO THE
RESEARCHER"_ or _"Internal note: only your organization sees it"_) and whether it
can be undone. Nothing is sent unless you tick **Send exactly this** and accept.
Declining, dismissing the dialog, or a model changing the content after you saw
it all send nothing.

What you read is what is sent. Every line of every value starts with `│ `, so
text inside a value cannot pass for the dialog's own lines (a fake "end of
payload" or "approve only if…"); each value states its length in characters
and lines. Invisible, direction-changing and control characters (carriage
return, escape sequences, line separators…) are shown as `\u{…}` escapes, a `<`
that could open HTML or a Markdown comment is shown as `\<`, and long runs of
empty lines are collapsed into one marked line. Above the payload, and marked as
not sent, the dialog names what the ids refer to — the programme, the report's
title, the researcher, the grade you appeal — as looked up read-only on
BugSecure; if a lookup is not possible it says so and shows the id only.

An approval can carry at most 50,000 characters in total: more than that cannot
be reviewed in a dialog, so such a report is refused before you are asked, and
belongs on the website. Tool inputs refuse control characters other than tab
and new line outright.

This is fail-closed: a client that cannot show approval dialogs gets an error
from every write tool, and read tools keep working. Support as of September 2026:

| Client                     | Approval dialogs (elicitation)                                                        | Writes with the local server | Writes with the hosted server                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- | :--------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code                | Yes ([docs](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests)) |              ✅              | ✅ with its v2 MCP runtime, which speaks protocol 2026-07-28 to HTTP servers ([docs](https://code.claude.com/docs/en/mcp#mcp-client-runtimes)); the older runtime cannot receive approval requests over HTTP |
| Claude Desktop / claude.ai | Not yet ([feature request](https://github.com/anthropics/claude-ai-mcp/issues/153))   |              –               | –                                                                                                                                                                                                            |
| VS Code (Copilot)          | Yes, since 1.102 ([release notes](https://code.visualstudio.com/updates/v1_102))      |              ✅              | Only once it speaks protocol 2026-07-28 (not announced yet): use the local server for writes                                                                                                                 |
| Cursor                     | Yes ([docs](https://cursor.com/docs/context/mcp))                                     |              ✅              | Only if it speaks protocol 2026-07-28 (not documented): use the local server for writes                                                                                                                      |

Why the hosted column differs: the hosted server is stateless, so it can only ask
for approval with the 2026-07-28 protocol, which carries the request inside the
tool result ([multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)).
Clients still on the 2025 protocol can only be asked over a live connection,
which the local (stdio) server has.

> [!WARNING]
> Some clients can answer approval dialogs automatically (Claude Code's
> `Elicitation` hook, for example). Do not configure that for BugSecure: it
> would approve whatever the model proposes.

## Scopes

Scopes only narrow what a connected app may do: your own role, organization
membership and per-report permissions still apply on top. A write scope does not
imply the matching read scope.

| Scope                 | Write | Grants                                                                                                                                                                                         |
| --------------------- | :---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `programs:read`       |   –   | Programmes, scope and reward grids, published terms, leaderboard, badges, public researcher profiles, search, certificate verification                                                         |
| `profile:read`        |   –   | Your profile and stats, your notifications, your certificates, your KYC _status_ (never documents)                                                                                             |
| `reports:read`        |   –   | Your reports, report details, comments, status history, adjudication and appeals on your reports                                                                                               |
| `reports:write`       |  ✅   | Submit a report, comment on your report, raise an appeal                                                                                                                                       |
| `triage:read`         |   –   | Programmes, reports, grades and appeals, stats, trends, payouts, certificates owed and duplicate checks for organizations you belong to — **only organizations that enabled AI triage access** |
| `triage:write`        |  ✅   | Update report status, comment on and assign your organizations' reports — same opt-in                                                                                                          |
| `grade:write`         |  ✅   | Grade your organizations' reports as the organization (severity and reward) — **only organizations that enabled AI grading**                                                                   |
| `notifications:write` |  ✅   | Mark your notifications read (only those a connected app can read)                                                                                                                             |
| `profile:write`       |  ✅   | Edit the bio, website and country of your public researcher profile — **researcher accounts only**; never the avatar, email, sign-in or payout details                                         |
| `disclosures:write`   |  ✅   | Read and save the public disclosure draft of your own reports — **researcher accounts only**; never approve, publish or withdraw one                                                           |

Never available to connected apps, whatever the scopes: sign-in and account
settings, two-factor and passkeys, KYC documents, payout methods and payments,
appeal _decisions_ and BugSecure's review of Critical grades, grading as
BugSecure, programme and organization management, administration, and
connected-app management itself. This server offers no tool
for anything reserved to BugSecure's own staff (assessment, KYC review, account
and platform administration), and a test keeps it that way.

## Security model

- **Least privilege by construction.** Every tool declares the scopes it needs
  and refuses to run without them. Logins and first connections ask for the read
  scopes and `reports:write`; other write scopes are added when you need them (hosted: an
  `insufficient_scope` step-up naming the scopes you already have plus the
  missing ones; local: the exact `login --scopes` command). `--read-only`
  removes every tool that could change anything.
- **You approve every write.** See [Write tools and approvals](#write-tools-and-approvals).
  The approval is bound to your identity, to the exact arguments (a SHA-256
  digest, HMAC-sealed in the request state) and to ten minutes, and can be used
  once per server instance (see [Self-hosting](#self-hosting-the-remote-server)
  for what that means with several instances).
- **OAuth 2.1 in both modes.**
  - _Local:_ the CLI is a public OAuth client. Login uses the authorization code
    flow with PKCE (S256), a random `state` compared in constant time, and
    RFC 9207 issuer validation; the redirect is received on an ephemeral port
    bound to `127.0.0.1` only, with the `Host` header checked. Tokens are
    audience-bound to the BugSecure API (RFC 8707), refused if the server is
    pointed at a different API, and stored in the OS keychain (or, if none
    exists, a `0600` file with a warning). Refresh tokens rotate on every use;
    refreshes, `login` and `logout` are serialised across processes by a lock
    file (owner token, heartbeat), so a reused refresh token — which revokes
    the whole grant — cannot happen by accident. An access token the API
    rejects is refreshed and the call retried once. `logout` revokes the grant
    (RFC 7009).
  - _Hosted:_ the server is an OAuth 2.1 protected resource. It publishes RFC 9728
    metadata, answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"`,
    and `403 insufficient_scope` for step-up. Inbound JWTs are verified locally
    (RS256 only, `typ: at+jwt`, issuer, **audience = this server**, expiry,
    maximum age). It never forwards your token: it exchanges it (RFC 8693) for a
    short-lived API token with the same or fewer scopes; one the API rejects is
    re-exchanged once, and a token the authorization server refuses to
    exchange is answered with `401 invalid_token` so your client refreshes it.
    Tool calls are rate-limited per user and client, per user across all of
    their clients, and more tightly for write tools. Step-up is never used for
    scopes only some accounts can hold: the organization-side `triage:*` and
    `grade:write`, and the researcher-only `profile:write` and
    `disclosures:write`. The authorization server grants those only to eligible
    accounts, so asking again would loop; the tool explains who is eligible
    instead. The researcher-only pair is requested on first connection, so a
    researcher has them from the start; a connection made before this version
    gets them by reconnecting.
- **Third-party content is data.** Text written by other people is wrapped in
  `<untrusted-content-NONCE source="…">` blocks whose random nonce changes with
  every response (so stored text cannot forge the closing tag), with look-alike
  delimiters neutralised, invisible Unicode characters removed and
  direction-changing ones made visible, and the server instructions tell the
  model never to follow instructions inside them. Every string a tool returns is
  either fenced like this or strictly shaped (ids, enums, dates, and a fixed
  list of named formats such as CVSS vectors); error messages the API sends back
  are fenced too. Very long report fields are cut (inside the fence, with a
  marker) unless you ask for the full text, and comments and history come a page
  at a time. This
  reduces, but cannot eliminate, prompt-injection risk: keep write scopes off
  unless you need them, and read approval dialogs before accepting.
- **Hardened HTTP surface.** Host and Origin allowlists (DNS rebinding), no CORS
  wildcard on the MCP endpoint, POST only, credentials checked from the headers
  before any request body is read, request body limits, per-request deadlines,
  stateless (no sessions to hijack), distroless non-root container.
- **Quiet by design.** Logs go to stderr as JSON and never contain tokens,
  authorization codes, secrets, report contents or error messages (only error
  names and machine codes).
- **Firewall refusals are explained.** The web application firewall in front of
  BugSecure may refuse text that looks like an attack payload (a report quoting
  an exploit, for instance). The tools say so (`REQUEST_BLOCKED`) instead of
  reporting an internal error: rephrase — put payloads in a fenced code block,
  or describe them rather than quote them — or submit on the website.

Found a problem? See [SECURITY.md](SECURITY.md) — this project is in scope for
the BugSecure bug bounty programme.

## Configuration

Flags override environment variables.

| Variable / flag                                                  | Mode   | Default                                 | Meaning                                                                                                                                             |
| ---------------------------------------------------------------- | ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUGSECURE_API_URL` / `--api-url`                                | both   | `https://bugsecure-api.senintel.sn`     | API and OAuth issuer URL; https only (http allowed for localhost)                                                                                   |
| `BUGSECURE_READ_ONLY=1` / `--read-only`                          | both   | off                                     | Never expose write tools                                                                                                                            |
| `BUGSECURE_LOG_LEVEL` / `--log-level`                            | both   | `info`                                  | `debug`, `info`, `warn`, `error`, `silent` (stderr)                                                                                                 |
| `BUGSECURE_CREDENTIAL_STORE`                                     | local  | `auto`                                  | `auto` (keychain, else file), `keychain`, `file`                                                                                                    |
| `BUGSECURE_CONFIG_DIR`                                           | local  | platform config dir                     | Location of the fallback credentials file and refresh lock                                                                                          |
| `BUGSECURE_MCP_RESOURCE`                                         | hosted | `https://bugsecure-mcp.senintel.sn/mcp` | This server's canonical URL (the token audience)                                                                                                    |
| `BUGSECURE_CLIENT_SECRET_FILE` / `BUGSECURE_CLIENT_SECRET`       | hosted | –                                       | Confidential client secret for token exchange (prefer the file)                                                                                     |
| `BUGSECURE_MCP_APPROVAL_KEY_FILE` / `BUGSECURE_MCP_APPROVAL_KEY` | hosted | – (required, except on localhost)       | ≥ 32 random characters sealing approval prompts; shared by all instances                                                                            |
| `BUGSECURE_CLIENT_ID`                                            | hosted | `bugsecure-mcp-hosted`                  | Confidential client id                                                                                                                              |
| `BUGSECURE_ALLOWED_ORIGINS`                                      | hosted | none                                    | Comma-separated browser origins allowed to call `/mcp`: `https://app.example:8443`, or a bare hostname for `https://` on port 443; compared exactly |
| `BUGSECURE_ALLOWED_HOSTS`                                        | hosted | resource host (+ loopback on localhost) | Comma-separated `Host` header allowlist                                                                                                             |
| `HOST` / `--host`, `PORT` / `--port`                             | hosted | `127.0.0.1`, `8944`                     | Listen address (the container sets `0.0.0.0`)                                                                                                       |
| `BUGSECURE_MAX_BODY_BYTES`                                       | hosted | `1048576`                               | Request body limit (fits the largest approvable write)                                                                                              |
| `BUGSECURE_RATE_LIMIT_PER_MINUTE`                                | hosted | `60`                                    | Tool calls per minute per user and client (sustained); per user across clients: twice this                                                          |
| `BUGSECURE_RATE_LIMIT_BURST`                                     | hosted | `20`                                    | Tool calls allowed in a burst (per user: twice this)                                                                                                |
| `BUGSECURE_RATE_LIMIT_WRITES_PER_MINUTE`                         | hosted | `12`                                    | Write-tool calls per minute per user (an approved write is two calls)                                                                               |
| `BUGSECURE_RATE_LIMIT_WRITE_BURST`                               | hosted | `6`                                     | Write-tool calls allowed in a burst per user                                                                                                        |
| `BUGSECURE_RATE_LIMIT_MAX_KEYS`                                  | hosted | `10000`                                 | Most keys each limiter tracks at once (bounds memory)                                                                                               |

### Self-hosting the remote server

```sh
docker build -t bugsecure-mcp .
docker run --rm -p 8944:8944 \
  -e BUGSECURE_MCP_RESOURCE=https://mcp.example.com/mcp \
  -e BUGSECURE_CLIENT_SECRET_FILE=/run/secrets/client_secret \
  -e BUGSECURE_MCP_APPROVAL_KEY_FILE=/run/secrets/approval_key \
  -v "$PWD/client_secret:/run/secrets/client_secret:ro" \
  -v "$PWD/approval_key:/run/secrets/approval_key:ro" \
  bugsecure-mcp
```

Terminate TLS in front of it; the resource URL must be the public `https` URL
clients use, and your BugSecure authorization server must know both that
resource and the confidential client. Approval prompts are sealed with the
dedicated approval key (`openssl rand -base64 32`; the server refuses to start
without one unless its resource is on localhost), so every instance behind a
load balancer must share it; rotating it only invalidates approvals in flight.
Each instance remembers used approvals for ten minutes: a replay of an approved
call landing on another instance within that window is not detected by that
memory. It still needs the same user, client and exact arguments; for
`submit_report` the server also refuses a report whose exact title was filed on
the same programme by the same user within those ten minutes (when it can read
your reports), and the other writes are refused by the API when repeated
(one grade per report, status moves that are already done) or are comments. See
[SECURITY.md](SECURITY.md#known-limitations).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), including [Adding a tool](CONTRIBUTING.md#adding-a-tool).

## License

[Apache License 2.0](LICENSE). Copyright 2026 KLDS.
