#!/usr/bin/env bash
# Cut a release: cog bump on an up-to-date, clean, signed-commit main, then
# push the version commit and the signed tag. The tag push starts the Release
# workflow (npm publish + hosted deploy, both behind protected environments).
#
#   scripts/release.sh            # make release
#   scripts/release.sh --dry-run  # make release-dry: print the next version, change nothing
#
# See CONTRIBUTING.md § Releasing.
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

refuse() { printf '\033[31mrefusing to release: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

command -v cog > /dev/null || refuse "cocogitto (cog) is not installed: https://docs.cocogitto.io/guide/installation.html"

# v0.1.0 is the hand-made baseline (its CHANGELOG entry is written by hand);
# cog bump only reads commits after the latest tag.
if ! git describe --tags --abbrev=0 --match 'v[0-9]*' > /dev/null 2>&1; then
  cat >&2 << 'EOF'
No release tag yet: the first release, v0.1.0, is the manual baseline
(CONTRIBUTING.md § Releasing):

  1. In CHANGELOG.md rename "Unreleased" to "[0.1.0] - <YYYY-MM-DD>", open a
     PR titled "chore(release): v0.1.0" and squash-merge it.
  2. On the up-to-date main:
       git tag -s v0.1.0 -m "Release 0.1.0"
       git push origin v0.1.0

After that, every release is `make release`.
EOF
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  exec cog bump --auto --dry-run
fi

branch="$(git symbolic-ref --quiet --short HEAD)" || refuse "HEAD is detached; check out main"
[ "$branch" = main ] || refuse "on '$branch'; releases are cut from main"
[ -z "$(git status --porcelain)" ] || refuse "the working tree is not clean"

git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || refuse "local main ($(git rev-parse --short HEAD)) differs from origin/main ($(git rev-parse --short origin/main)); pull or push first"

# Required signatures on main (ruleset) and the signed-tag check in the
# Release workflow: both commit and tag must be signed.
[ "$(git config --type=bool --get commit.gpgSign || true)" = true ] || refuse "git config commit.gpgSign is not true"
[ "$(git config --type=bool --get tag.gpgSign || true)" = true ] || refuse "git config tag.gpgSign is not true"
[ -n "$(git config --get user.signingkey || true)" ] || refuse "git config user.signingkey is not set"

# pre_bump_hooks run `pnpm run check` and set package.json#version;
# post_bump_hooks re-create the tag signed (cog.toml).
cog bump --auto

version="$(node -p 'require("./package.json").version')"
tag="v$version"
git cat-file tag "refs/tags/$tag" 2> /dev/null | grep -Eq -- '-----BEGIN (SSH|PGP) SIGNATURE-----' \
  || refuse "$tag is missing or unsigned after cog bump; fix it before pushing (nothing was pushed)"

# Push the commit, then the tag, as two explicit pushes: cog's own tag is
# lightweight, and although post_bump re-creates it annotated, --follow-tags
# only pushes annotated tags reachable from what is pushed and silently skips
# anything else — a release tag must never quietly stay on this machine.
# --no-verify: the pre-push hook would re-run `pnpm run check`, which
# pre_bump_hooks just ran on this exact tree (and CI runs again).
git push --no-verify origin main
git push --no-verify origin "refs/tags/$tag"

printf '\033[1m✔ pushed %s: approve the npm and production deployments in the Release workflow\033[0m\n' "$tag"
