#!/usr/bin/env bash
# Apply this repository's GitHub configuration: rulesets, merge settings,
# security features, the `npm` and `production` environments and the release
# workflow's variables. Idempotent: re-run it after changing anything here or
# in .github/rulesets/. Needs `gh` (authenticated as a repository admin) and jq.
#
#   make setup-github                      # or: scripts/setup-github.sh [owner/repo]
#
# Release deploy settings come from the environment (the hosting Terraform's
# outputs); unset ones are skipped with a warning, so a first run can happen
# before the AWS side exists:
#
#   AWS_REGION            region of the ECS service and ECR repository (default eu-west-1)
#   ECR_REPOSITORY        ECR repository name, not URL (<ecr-repository>)
#   ECS_CLUSTER           ECS cluster name (<ecs-cluster>)
#   ECS_SERVICE           ECS service name (<ecs-service>)
#   ECS_TASK_FAMILY       task definition family Terraform registers
#                         (<task-family>)
#   AWS_RELEASE_ROLE_ARN  IAM role the deploy job assumes via OIDC
#                         (…:role/<release-role>). Stored as a
#                         `production` environment SECRET: it contains the
#                         account id, and this repository's logs are public.
#
#   AWS_RELEASE_ROLE_ARN=arn:aws:iam::<account>:role/<release-role> \
#   ECR_REPOSITORY=<ecr-repository> ECS_CLUSTER=<ecs-cluster> \
#   ECS_SERVICE=<ecs-service> ECS_TASK_FAMILY=<task-family> \
#     make setup-github
#
# Nothing secret is printed.
set -euo pipefail

REPO="${1:-${GITHUB_REPOSITORY:-kulinda-sec/bugsecure-mcp}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULESETS_DIR="$ROOT/.github/rulesets"

say() { printf '\033[1m→ %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh > /dev/null || die "gh (GitHub CLI) is not installed"
command -v jq > /dev/null || die "jq is not installed"
gh auth status > /dev/null 2>&1 || die "gh is not authenticated: gh auth login"

[ "$(gh api "repos/$REPO" --jq .permissions.admin 2> /dev/null || echo false)" = true ] \
  || die "$REPO does not exist or you are not an admin of it"

# ── Repository settings ──────────────────────────────────────────────────────
# Squash only, the PR title becomes the commit header on main (and the
# changelog entry), merged branches are deleted.
say "repository settings"
gh api --silent --method PATCH "repos/$REPO" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true \
  -F allow_update_branch=true

say "security features"
gh api --silent --method PUT "repos/$REPO/private-vulnerability-reporting"
gh api --silent --method PUT "repos/$REPO/vulnerability-alerts" # prerequisite of security updates
gh api --silent --method PUT "repos/$REPO/automated-security-fixes"
if [ "$(gh api "repos/$REPO" --jq .visibility)" = public ]; then
  gh api --silent --method PATCH "repos/$REPO" --input - << 'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
else
  warn "repository is not public yet: secret scanning left as is (re-run after going public)"
fi

# CodeQL runs from .github/workflows/codeql.yml (advanced setup). Default
# setup at the same time makes the workflow's uploads fail.
if [ "$(gh api "repos/$REPO/code-scanning/default-setup" --jq .state 2> /dev/null || true)" = configured ]; then
  warn "CodeQL DEFAULT setup is enabled and conflicts with codeql.yml:" \
    "disable it (Settings → Code security → CodeQL analysis → Switch to advanced)"
fi

# ── Rulesets (create or update, matched by name) ────────────────────────────
existing="$(gh api "repos/$REPO/rulesets?includes_parents=false&per_page=100")"
for file in "$RULESETS_DIR"/*.json; do
  name="$(jq -er .name "$file")"
  id="$(jq -r --arg n "$name" '.[] | select(.name == $n) | .id' <<< "$existing" | head -n 1)"
  if [ -n "$id" ]; then
    say "ruleset '$name': update ($id)"
    gh api --silent --method PUT "repos/$REPO/rulesets/$id" --input "$file"
  else
    say "ruleset '$name': create"
    gh api --silent --method POST "repos/$REPO/rulesets" --input "$file"
  fi
done

# ── Environments ─────────────────────────────────────────────────────────────
# Required reviewer: the admin running this. Self-review is allowed (the
# project has one maintainer); the review is a deliberate "ship it" click.
reviewer_id="$(gh api user --jq .id)"
reviewer_login="$(gh api user --jq .login)"

# environment <name> <policy> [<policy>…]; a policy is `tag:<pattern>` or `branch:<pattern>`.
environment() {
  local env="$1"
  shift
  say "environment '$env' (reviewer $reviewer_login; deploys from ${*})"
  jq -n --argjson id "$reviewer_id" '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [{ type: "User", id: $id }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  }' | gh api --silent --method PUT "repos/$REPO/environments/$env" --input -

  local current policy type pattern
  current="$(gh api "repos/$REPO/environments/$env/deployment-branch-policies?per_page=100")"
  for policy in "$@"; do
    type="${policy%%:*}"
    pattern="${policy#*:}"
    if jq -e --arg t "$type" --arg p "$pattern" \
      '.branch_policies[] | select(.name == $p and (.type // "branch") == $t)' <<< "$current" > /dev/null; then
      continue
    fi
    gh api --silent --method POST "repos/$REPO/environments/$env/deployment-branch-policies" \
      -f name="$pattern" -f type="$type"
  done

  # Remove any policy not listed here, so the environment matches this script.
  local wanted stale
  wanted="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  jq -r --argjson w "$wanted" \
    '.branch_policies[] | select((((.type // "branch") + ":" + .name) as $k | $w | index($k)) | not) | .id' \
    <<< "$current" | while read -r stale; do
    say "environment '$env': removing stale deployment policy $stale"
    gh api --silent --method DELETE "repos/$REPO/environments/$env/deployment-branch-policies/$stale"
  done
}

environment npm 'tag:v*'
# Redeploys and rollbacks are dispatched on the tag too (the AWS role trusts
# only refs/tags/v* in this environment).
environment production 'tag:v*'

# ── Release variables (and the role secret) ─────────────────────────────────
set_var() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    warn "$name is not set: skipped"
    return
  fi
  gh variable set "$name" --repo "$REPO" --body "$value"
  say "variable $name = $value"
}
set_var AWS_REGION "${AWS_REGION:-eu-west-1}"
set_var ECR_REPOSITORY "${ECR_REPOSITORY:-}"
set_var ECS_CLUSTER "${ECS_CLUSTER:-}"
set_var ECS_SERVICE "${ECS_SERVICE:-}"
set_var ECS_TASK_FAMILY "${ECS_TASK_FAMILY:-}"

if [ -n "${AWS_RELEASE_ROLE_ARN:-}" ]; then
  case "$AWS_RELEASE_ROLE_ARN" in
    arn:aws:iam::*:role/*) ;;
    *) die "AWS_RELEASE_ROLE_ARN is not an IAM role ARN" ;;
  esac
  printf '%s' "$AWS_RELEASE_ROLE_ARN" | gh secret set AWS_RELEASE_ROLE_ARN --repo "$REPO" --env production
  say "secret AWS_RELEASE_ROLE_ARN set on environment production"
else
  warn "AWS_RELEASE_ROLE_ARN is not set: skipped"
fi

cat << EOF

Done. Not settable through the API, check by hand once:
  - Settings → Environments → npm, production: untick "Allow administrators
    to bypass configured protection rules", so a release always waits for the
    review.
  - npmjs.com → @kulinda-sec/bugsecure-mcp → Trusted publishing: repository
    $REPO, workflow release.yml, environment npm.
EOF
