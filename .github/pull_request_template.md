## What and why

<!-- A short description of the change and the motivation. Link issues with "Fixes #123". -->

## Checklist

- [ ] `pnpm run check` passes locally (format, codegen, lint, typecheck, tests with coverage, build)
- [ ] Tests cover the change (new tools: success, invalid input, API error, scope filtering)
- [ ] New tool? Least-privilege `requiredScopes`, honest annotations, third-party text wrapped with `untrusted()`, README tools table updated
- [ ] No tokens, secrets, report bodies or other user content can reach logs or error messages
- [ ] The PR title is a Conventional Commits header (`feat(tools): …`); it becomes the squash commit and the changelog entry
