# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.
Human-facing detail lives in [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md); this file is the short list of what to know before
changing code.

## What this is

`@kulinda-sec/bugsecure-mcp`: a Model Context Protocol server (spec revision
**2026-07-28**, SDK `@modelcontextprotocol/server` v2) that lets AI agents use
the BugSecure bug bounty platform on behalf of a signed-in user. Two modes, one
code base:

- **Local** (`bugsecure-mcp`, stdio): the process is an OAuth public client;
  `login` runs PKCE through a 127.0.0.1 loopback redirect and stores tokens in
  the OS keychain.
- **Hosted** (`bugsecure-mcp serve --http`): a stateless Streamable HTTP server
  acting as an OAuth protected resource. It validates inbound JWTs locally
  (JWKS) and exchanges them (RFC 8693) for API tokens — never passes them through.

It handles people's credentials and unpublished vulnerability reports.
Security and correctness come before convenience in every change.

## Commands

```sh
pnpm install          # also installs the git hooks (.husky/)
pnpm run check        # the full gate CI runs — run it before declaring anything done
pnpm test             # vitest (the e2e suite needs `pnpm build` first)
pnpm lint:fix
pnpm codegen          # after editing src/graphql/operations/*.graphql
node dist/cli.js --help
```

The published package runs on Node ≥ 22.12 (`package.json#engines`);
developing needs Node ≥ 22.18 (scripts in `scripts/` run through Node's type
stripping), and `.nvmrc` pins 24, which CI and the container use. pnpm only,
never npm or yarn.

## Architecture

- `src/tools/<name>.ts` — one tool per file, registered once in
  `src/tools/index.ts`, built with `defineTool` (`src/tools/define-tool.ts`),
  which rejects inconsistent definitions at import time.
- `src/graphql/operations/<name>.graphql` — one operation per tool;
  `src/graphql/generated.ts` and `schema/bugsecure.graphql` are GENERATED.
- `src/auth/stdio/` (login, keychain, refresh lock) and `src/auth/hosted/`
  (JWT validation, token exchange, RFC 9728 metadata).
- `src/transports/` — stdio, and the HTTP app plus its Node adapter.
- `src/untrusted.ts` — fencing of third-party text; `src/tools/approval.ts` —
  human approval of writes via elicitation.

## Rules

- **The model never sees unfenced third-party text.** Anything another person
  wrote (report and comment bodies, titles, names, bios, programme text) goes
  through `untrusted()` / `wrapped()`. Every other output string needs a strict
  pattern, enum or format; a registry test fails on any unconstrained string.
- **Writes need a human.** Tools holding a write scope (any `*:write`) must
  define `approval`; they run only after the user accepts an elicitation
  showing the exact payload. Never add a model-filled "confirmed" argument
  instead. `approval` may look things up read-only (declare the extra read
  scopes in `optionalScopes`) and refuse before asking by throwing a
  `BugSecureError`. `optionalScopes` hold read scopes only, except a write
  scope that also grants a read (`WRITE_SCOPES_WITH_READS`: `disclosures:write`
  reads the draft) for that read alone; every mutation a tool sends must be
  covered by its `requiredScopes` (`api-surface.test.ts`).
- **Know which side you act on.** One token can hold researcher and
  organisation scopes, and the API serves both sides through the same fields:
  researcher tools act only on the caller's own reports, organisation tools
  never on them (`src/tools/shared/report.ts`), and organisation-side writes
  refuse BugSecure staff (`src/tools/shared/viewer.ts`).
- **Never a platform-staff operation.** No tool may call anything reserved to
  BugSecure's own staff (assessors, administrators); `triage:*` and
  `grade:write` mean an organization's own members (grading as the
  organization is theirs; appeal decisions and Critical reviews are staff).
  `src/tools/api-surface.test.ts` enforces it with allowed lists only (root
  fields open to OAuth, and the nested fields in `api-surface.fields.json`);
  never list what the API refuses or reserves to staff in this public repo.
- **Least privilege.** `requiredScopes` must match what the API enforces for the
  operations the tool calls; select only the GraphQL fields the tool returns.
- **stdout is the stdio protocol channel.** No `console`; log through
  `src/logger.ts` (stderr). Never log tokens, codes, secrets or user content.
- **No new runtime dependencies** without a strong reason; runtime deps are
  pinned exactly. Prefer the Node standard library.
- **Never hand-edit generated files**, and never vendor the full API schema:
  `schema/bugsecure.graphql` is pruned to what the operations use.

## Conventions

- Arrow functions only (`const f = (): T => …`), enforced by ESLint. Converting a
  declaration to a `const` loses hoisting: define before any import-time use.
- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`;
  no `any`, no non-null assertions outside tests.
- Tests next to the code (`*.test.ts`), through a real SDK client
  (`test/helpers`); cover success, invalid input, API error and scope checks.
- Conventional Commits (`feat(tools): …`), checked by the commit-msg hook and on
  PR titles. `main` is protected (ruleset in `.github/rulesets/`): changes land
  through squash-merged PRs with the `CI passed` check green; never push to
  main or create `v*` tags yourself. Releases are cut by a maintainer with
  `make release` (cog bump + signed tag), which also deploys the hosted server
  — see CONTRIBUTING § Releasing.
- Keep the README tools table accurate. `CHANGELOG.md`: until v0.1.0 is tagged,
  its "Unreleased" section is the hand-written baseline and is edited by hand;
  after that, never edit it by hand — `cog bump` generates it from the commits.
- Keep `tools/list` under its 80 KB budget (`registry.test.ts`): describe a
  field only when its name does not say it, and never repeat the fencing rule
  per field (the output schema root states it once).
