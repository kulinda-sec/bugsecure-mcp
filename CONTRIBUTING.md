# Contributing to bugsecure-mcp

Thanks for helping. This project handles people's credentials and unpublished
vulnerability reports, so the bar for correctness and security is high — but the
code base is small and the conventions are few. Please read
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), never in an issue or pull request.

## Development setup

Requirements: Node.js ≥ 22.18 (24 recommended, see `.nvmrc`) — the maintenance
scripts in `scripts/` are TypeScript run directly by Node's type stripping,
unflagged from 22.18 — and pnpm (the version pinned, with its hash, in
`package.json#packageManager`; `corepack enable` or install it with your package
manager). The published package itself runs on Node.js ≥ 22.12.

```sh
pnpm install
pnpm run check      # everything CI runs: format, hygiene, codegen drift, lint, typecheck, build, tests + coverage
```

`pnpm install` also installs git hooks ([husky](https://typicode.github.io/husky/), in `.husky/`):

| Hook         | Runs                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| `pre-commit` | Prettier (check only) on staged files, and `pnpm hygiene`. `pnpm format` fixes formatting. |
| `commit-msg` | Conventional Commits header check (`scripts/check-commit-msg.ts`).                         |
| `pre-push`   | `pnpm run check`, the same gate CI runs.                                                   |

Skip them for a single command with `git commit --no-verify` / `git push --no-verify`; CI runs the same checks either way.

Individual steps:

| Command                            | What it does                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:watch`    | Vitest: unit, in-process MCP integration, and end-to-end over the built binary (run `pnpm build` first: without `dist/` the end-to-end suite fails) |
| `pnpm test:coverage`               | Tests with coverage thresholds (85% lines/functions/statements, 80% branches)                                                                       |
| `pnpm lint` / `pnpm lint:fix`      | ESLint, `typescript-eslint` strict-type-checked; arrow functions only (`const f = (): T => …`, no `function`)                                       |
| `pnpm typecheck`                   | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)                                                                   |
| `pnpm format`                      | Prettier                                                                                                                                            |
| `pnpm hygiene`                     | No invisible/bidi Unicode in tracked files (`hygiene:release` also rejects unfilled maintainer placeholders in public docs; runs before publishing) |
| `pnpm build`                       | Compile to `dist/` with `tsc`                                                                                                                       |
| `pnpm codegen`                     | Regenerate `src/graphql/generated.ts` from the operations and the vendored schema                                                                   |
| `pnpm prune-schema <full.graphql>` | Maintainers: regenerate `schema/bugsecure.graphql` from the full API schema                                                                         |
| `pnpm schema:check <full.graphql>` | Maintainers: fail if `schema/bugsecure.graphql` drifted from the API's schema (or an operation no longer validates against it); no network          |

Working in Claude Code? The repo's [`.mcp.json`](.mcp.json) defines two
servers, which Claude Code asks you to approve the first time:

- `bugsecure-dev` runs your local build (`dist/cli.js`) over stdio against
  `http://localhost:8943`, or `$BUGSECURE_API_URL` if set. Run `pnpm build` and
  `node dist/cli.js login --api-url http://localhost:8943` first (add
  `--scopes` for write tools, see below).
- `bugsecure` is the hosted production server; Claude Code runs the OAuth
  sign-in when you first use it (`/mcp`).

Try it against a local API:

```sh
pnpm build
node dist/cli.js login --api-url http://localhost:8943   # read scopes + reports:write (the default)
# To try the other write tools, ask for their scopes too. A new login replaces
# the old one, so keep the read scopes in the list:
node dist/cli.js login --api-url http://localhost:8943 \
  --scopes "programs:read,profile:read,reports:read,triage:read,reports:write,triage:write,grade:write,notifications:write,profile:write,disclosures:write"
node dist/cli.js whoami --api-url http://localhost:8943  # check the granted scopes
node dist/cli.js --api-url http://localhost:8943        # stdio server
# MCP Inspector (needs Node ≥ 22.19): the server command comes first, then the
# Inspector's own options. Pass settings as environment variables (-e), which the
# Inspector forwards; every flag has one (see README § Configuration).
npx @modelcontextprotocol/inspector node dist/cli.js -e BUGSECURE_API_URL=http://localhost:8943
npx @modelcontextprotocol/inspector --cli node dist/cli.js -e BUGSECURE_API_URL=http://localhost:8943 --method tools/list
```

Write tools need their scope (`reports:write`, `triage:write`, `grade:write`, `notifications:write`, `profile:write`, `disclosures:write`)
in the login above, and ask for approval through elicitation on every call: the
Inspector shows the approval form; answer it there. Triage tools also need an
account that belongs to an organization with AI assistant access enabled, and
`grade_report` one whose organization also enabled AI grading. `profile:write`
and `disclosures:write` are granted to researcher accounts only.

## Project layout

```
src/
  cli.ts, cli/            bugsecure-mcp binary: argument parsing and commands
  config.ts               zod-validated environment + flags
  server.ts               builds the McpServer for one session
  instructions.ts         server `instructions` sent to the model
  tools/
    define-tool.ts        the tool framework (defineTool, selection, scope checks, invocation)
    approval.ts           user approval of write tools (elicitation, multi round-trip)
    index.ts              the registry: every tool, listed once
    <tool-name>.ts        one file per tool, with <tool-name>.test.ts next to it
    shared/               output schemas and mappers shared by several tools
  graphql/
    operations/           one .graphql file per tool (+ fragments/)
    generated.ts          GENERATED typed documents — never edit
    client.ts, errors.ts  fetch-based client and API error mapping
  auth/
    oauth.ts              AS metadata discovery, token/revocation requests
    stdio/                local mode: login (PKCE + loopback), keychain storage, refresh
    hosted/               hosted mode: JWT validation, token exchange, RFC 9728 metadata
  transports/             stdio, and streamable HTTP (app + Node adapter)
  untrusted.ts            fencing of third-party text
  rate-limit.ts, lru.ts   hosted tool-call rate limiting; bounded expiring map
schema/bugsecure.graphql  GENERATED pruned API schema (codegen input; not shipped)
scripts/                  prune-schema.ts, codegen.ts, check-hygiene.ts, check-commit-msg.ts (run directly by Node)
test/helpers/             test harness, fakes
```

## Adding a tool

Every tool is one file, one registry entry, one operation file and one test
file. `search_programs` and `get_program` are complete examples to copy (and
`get_report` for a tool that bundles several root fields into one request).
Building blocks shared by many tools — id arguments, limit/offset pagination,
fenced-text output fields, report mappers — live in `src/tools/shared/`.

### 1. Write the GraphQL operation

Create `src/graphql/operations/<tool-name>.graphql`. Select only the fields the
tool returns — every field you select becomes part of the vendored schema and a
dependency on the API:

```graphql
# Tool: get_leaderboard (programs:read)
query GetLeaderboard($limit: Int!) {
  leaderboard(limit: $limit) {
    rank
    username
    profile {
      userId
      reputation
    }
  }
}
```

Then regenerate the types:

```sh
pnpm prune-schema <path/to/full/schema.graphql>   # only when the operation uses types/fields not yet in schema/bugsecure.graphql
pnpm codegen
```

The full API schema is not public. If you are an external contributor and your
operation needs something that is not in `schema/bugsecure.graphql` yet, open the
pull request anyway and a maintainer will regenerate the schema.

Maintainers: whenever the API changes, check for drift with
`pnpm schema:check <path/to/the API's schema.gql>` (it fails when the vendored
schema no longer matches what the API serves for our operations, or when an
operation no longer validates), then refresh with `pnpm prune-schema` and
`pnpm codegen`, and check the allowed lists in `src/tools/api-surface.test.ts`
and `src/tools/api-surface.fields.json` against the API's OAuth scope and field
rules.
CI does not run it: the full schema is not public.

### 2. Define the tool

Create `src/tools/<tool-name>.ts`:

```ts
import * as z from 'zod';

import { GetLeaderboardDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { id, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

export const getLeaderboard = defineTool({
  name: 'get_leaderboard', // snake_case, stable: it is public API
  title: 'Get the researcher leaderboard', // shown in client UIs
  description: 'Top researchers on BugSecure by reputation. Use to …', // the model reads this; say when to use it
  requiredScopes: ['programs:read'], // the token must carry ALL of these
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20).describe('How many researchers to return.'),
  }),
  output: z.object({
    // Every output string is fenced (`wrapped`) or strictly shaped (`id`, `slug`, `timestamp`, `code`, enums).
    researchers: z.array(z.object({ rank: z.number().int(), userId: id(), username: wrapped('Username') })),
  }),
  async handler(input, { graphql, signal }) {
    const { leaderboard } = await graphql.request(GetLeaderboardDocument, { limit: input.limit }, { signal });
    return {
      data: {
        researchers: leaderboard.map((r) => ({
          rank: r.rank,
          userId: r.profile.userId,
          username: untrusted(`user:${r.profile.userId}:username`, r.username), // chosen by another user
        })),
      },
    };
    // The framework returns `data` as structuredContent AND as the JSON text block.
  },
});
```

### 3. Register it

Append it to `ALL_TOOLS` in `src/tools/index.ts` (grouped by scope).

### 4. Test it

Create `src/tools/<tool-name>.test.ts`. The harness runs your tool through a
real MCP client and server in process, with a fake API:

```ts
import { afterEach, expect, it } from 'vitest';
import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';

let h: Harness | undefined;
afterEach(async () => h?.close());

it('returns the leaderboard', async () => {
  const graphql = fakeGraphQL({
    GetLeaderboard: () => ({
      leaderboard: [{ rank: 1, username: 'ada', profile: { userId: 'u1', reputation: 9 } }],
    }),
  });
  h = await connectTools({ graphql, grantedScopes: ['programs:read'] });
  const result = await h.call('get_leaderboard', { limit: 1 });
  expect(graphql.calls[0]?.variables).toEqual({ limit: 1 });
  expect(result.structuredContent).toMatchObject({ researchers: [{ rank: 1 }] });
});
```

Cover at least: the happy path (variables sent, structured output), invalid
input (rejected before any API call) and an API error (`BugSecureError`) mapped
to an actionable message. `src/tools/registry.test.ts` checks every registered
tool for you: listing (and `--read-only`), refusal without its scopes,
annotations, and that no output string escapes fencing or a strict shape.
`src/tools/approval.test.ts` checks every write tool's approval prompt (add sample
arguments for a new tool to `test/helpers/sample-args.ts`).

### 5. Document it

Add a row to the tools table in `README.md`. Until v0.1.0 is tagged, also add
it to the hand-written "Unreleased" section of `CHANGELOG.md`; from then on the
changelog is generated from your commit header (`feat(tools): add …`) at release
time and is never edited by hand.

### Tool rules (enforced by review, and partly by `defineTool`)

- **Organization side only, never platform staff.** Tools act for researchers
  and for organization members; nothing reserved to BugSecure's own staff
  (appeal decisions, Critical reviews, the escalation queue, KYC review,
  administration) belongs here. Grading a report as the organization
  (`grade:write`) is an organization member's act, not a staff one.
  `src/tools/api-surface.test.ts` fails on any operation that references a
  root field or selects a nested field not on its allowed lists, and checks
  each tool's `requiredScopes` against the fields it calls. When the API opens
  a new field to OAuth, add it to the allowed list in the same change.
- **Least privilege.** Declare the narrowest scopes. A tool needing a write scope
  (any `*:write`) is a write tool: `readOnlyHint: false`, and it
  disappears under `--read-only`. `defineTool` rejects inconsistent annotations.
- **Write tools describe their payload.** A write tool must define
  `approval(input)`: the action, who will see it, whether it is irreversible and
  every value that will be sent. The framework shows it to the user (MCP
  elicitation) and only runs the handler once they approve; `defineTool`
  refuses a write tool without it. Never add a "confirmed" argument: the model
  fills arguments, the user answers approvals.
- **Honest annotations.** `destructiveHint: true` when the change cannot be
  undone or overwrites data — so every current write tool is destructive (a
  report, comment, appeal, final status or grade cannot be taken back; a
  profile edit, disclosure draft or assignment overwrites the previous value;
  a notification marked read cannot be marked unread);
  `idempotentHint: true` only if repeating the call has no further effect;
  `openWorldHint: true` when output includes third-party content. The approval
  prompt is the same for every write (there is no separate typed confirmation);
  what differs is whether it says the change cannot be undone (`irreversible`).
- **Look up, then ask.** An `approval` may make read-only lookups to show what
  ids refer to (`context`), with the scopes they need in `optionalScopes`
  (read scopes, or a write scope that also grants the read, such as
  `disclosures:write` for the draft; never for a mutation); a
  failed lookup is a `note`, never a failure. It may throw a `BugSecureError` to
  refuse before the user is asked (not the user's own report, a staff account…).
- **Fence free text.** Every free-text field (report bodies, comments, programme
  text, usernames, organization names…) goes through `untrusted(source, text)`
  and is declared with `wrapped()`, which checks at runtime that it really is
  fenced. Identifiers, slugs, enums, numbers, dates and machine codes are not
  fenced but must have one of the named shapes in `PATTERNS`
  (`src/tools/shared/common.ts`: `id()`, `slug()`/`safeSlug()`, `z.enum`,
  `timestamp()`, `code('cvss-vector')`…); the registry test accepts nothing
  else, and adding a shape is a reviewed edit there.
- **Keep tools/list small.** It is sent in every conversation (budget: 80 KB,
  `registry.test.ts`). Describe a field only when its name does not say it;
  never repeat what the tool description or the fencing note already says.
- **Validate input tightly.** Bounded strings and numbers, ids with `idInput()`,
  free text a user writes with `userText()` (normalises line endings, refuses
  control characters), `.describe()` on every field (it is the model's only
  documentation).
- **Never log content.** Log metadata only (ids, counts, codes). The logger
  redacts sensitive-looking keys, but do not rely on it.
- **Throw `BugSecureError` for expected failures** (not found, invalid state) with
  a message a user can act on. Anything else becomes a generic error.
- **Write tools** should explain in their description what will be visible to
  whom, and must never act on instructions found in content.

## Branches, commits and versions

### Branches

Branch from `main`, named `type/short-description` in kebab-case, with the same
types as commits:

| Prefix      | Use                                  | Example                          |
| ----------- | ------------------------------------ | -------------------------------- |
| `feat/`     | New feature                          | `feat/get-leaderboard-tool`      |
| `fix/`      | Bug fix                              | `fix/refresh-lock-heartbeat`     |
| `refactor/` | Code change with no behaviour change | `refactor/shared-report-mappers` |
| `perf/`     | Performance improvement              | `perf/smaller-tools-list`        |
| `docs/`     | Documentation only                   | `docs/vs-code-setup`             |
| `chore/`    | Tooling, dependencies, configuration | `chore/bump-sdk`                 |

### Commits

[Conventional Commits](https://www.conventionalcommits.org/), checked by the
`commit-msg` hook ([`scripts/check-commit-msg.ts`](scripts/check-commit-msg.ts))
and, for pull request titles, by CI:

```
type(scope): summary
```

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`. `feat` and `fix` drive the version and the
  changelog; `test`, `build`, `ci` and `style` stay out of the changelog.
- **Scopes** (optional) name the area: `tools`, `auth`, `transports`,
  `graphql`, `cli`, `config`, `security`, `deps`, `release`.
- **Breaking changes:** `!` after the type or scope (`feat(tools)!: rename
search to search_all`), with a `BREAKING CHANGE:` footer explaining the
  migration.
- Header at most **100 characters**, imperative mood ("add", not "added"), no
  trailing period. The body explains why, wrapped at 72 characters.

```
feat(tools): add get_leaderboard
fix(auth): refresh tokens under the credentials lock
docs(readme): document VS Code setup
chore(deps): bump @modelcontextprotocol/server to 2.0.1
```

### Versions and tags

[Semantic Versioning](https://semver.org/) with a `v` prefix (`v0.2.0`,
`v1.0.0-rc.1`), computed from the commits by
[cocogitto](https://docs.cocogitto.io) ([`cog.toml`](cog.toml)). Before 1.0.0 a
minor version may contain breaking changes. The tool names, their inputs and
outputs, the CLI and the configuration variables are the public API.

## Pull requests

- Keep changes focused; one feature or fix per PR.
- PRs are **squash-merged**: the PR title becomes the commit on `main` and the
  changelog entry, so it must be a Conventional Commits header (CI checks it).
- `pnpm run check` must pass. CI also runs CodeQL, dependency review and the
  OpenSSF Scorecard.
- New dependencies need a strong justification: this package runs with access to
  people's credentials, so every dependency is attack surface. Prefer the Node.js
  standard library.
- Runtime dependencies are pinned to exact versions. `npx` users never see our
  lockfile, so a caret range would let a freshly published (possibly
  compromised) release of a direct dependency run with their credentials before
  anyone reviewed it; exact pins mean every version they run went through a
  Dependabot pull request, CI and review. (An `npm-shrinkwrap.json` would also
  pin the transitive tree, but it cannot be produced by pnpm and would be a
  second lockfile to keep in sync.)

## Releasing (maintainers)

Needs [cocogitto](https://docs.cocogitto.io/guide/installation.html) (`cog`)
and git signing: an SSH key (`gpg.format ssh`, `user.signingkey`,
`commit.gpgSign true`, `tag.gpgSign true`) registered on GitHub as a signing
key. `main` is protected, so releasing needs a repository admin (the only role
that may push the version commit and create `v*` tags).

```sh
make release-dry    # prints the next version; changes nothing
make release
```

`make release` ([`scripts/release.sh`](scripts/release.sh)) refuses unless you
are on a clean `main` identical to `origin/main`, with `cog` installed and
signing configured. It then runs `cog bump --auto`, which runs `pnpm run check`,
sets `package.json#version`, prepends the generated section to `CHANGELOG.md`,
commits `chore(version): vX.Y.Z` and creates the signed tag `vX.Y.Z`, and
pushes the commit and the tag separately (`--follow-tags` skips tags that are
not annotated, so it is not relied on).

The tag starts the `Release` workflow:

1. **verify**: the tag is a signed annotated tag on `main`, equals
   `package.json#version`, and `hygiene:release` (fails while any maintainer
   placeholder remains in a public document) and `pnpm run check` pass.
2. **publish** (environment `npm`, needs your approval): npm trusted publishing
   with provenance. There is no npm token.
3. **deploy** (environment `production`, needs your approval, in parallel with
   publish): builds the ARM64 image from the tag, pushes it to ECR as
   `vX.Y.Z` (tags are immutable), attests its provenance, rolls the ECS
   service onto it by digest, and smoke-tests the public endpoint. A failed
   rollout or smoke test rolls the service back to its previous task
   definition. AWS access is keyless (OIDC).
4. **github-release**: the release page, after publish.

To redeploy a release (retry a rolled-back deploy) or **roll back** to an
earlier one, run the workflow on that tag:
`gh workflow run release.yml --ref vX.Y.Z` (for a rollback, the previous tag).
It re-runs verify and deploys the image already in ECR for that tag; npm and
the release page are skipped. It must run on the tag ref: the AWS role trusts
only `v*` tags in the `production` environment.

The first release, v0.1.0, is the baseline: `make release` detects that no
tag exists and prints these steps instead of bumping. Its `CHANGELOG.md` entry
is written by hand (rename "Unreleased" to `[0.1.0] - <date>` and merge that),
then, on the up-to-date `main`, `git tag -s v0.1.0 -m "Release 0.1.0"` and
`git push origin v0.1.0`. `cog bump` only reads commits after the latest tag.

## Repository settings (maintainers)

The GitHub configuration lives in the repository and is applied with
`make setup-github` ([`scripts/setup-github.sh`](scripts/setup-github.sh),
idempotent, needs `gh` as a repository admin):

- Rulesets in [`.github/rulesets/`](.github/rulesets): `main` requires a pull
  request (squash only, conversations resolved, no approval count since the
  project has one maintainer), signed commits, linear history and the checks
  `CI passed`, `Conventional Commits title`, `Analyze (javascript-typescript)`
  and `Analyze (actions)`; it forbids force-pushes and deletion. Only
  repository admins may create `v*` tags, and nobody may move or delete one.
  Renaming a required job means updating `main.json` in the same change.
- Merge settings (squash only, PR title as the commit header, branches deleted
  on merge), private vulnerability reporting, Dependabot security updates.
- Environments `npm` and `production`: the admin running the script is the
  required reviewer; deployments only from `v*` tags.
- The deploy settings, from the hosting infrastructure's outputs:
  repository variables `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`,
  `ECS_SERVICE`, `ECS_TASK_FAMILY`, and the `production` environment secret
  `AWS_RELEASE_ROLE_ARN` (a secret because it contains the AWS account id,
  which must not appear in public logs). Pass them as environment variables;
  see the script header.

CodeQL runs from `.github/workflows/codeql.yml`; the script warns if CodeQL
default setup is enabled, which conflicts with it.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
