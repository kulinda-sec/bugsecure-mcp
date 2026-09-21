# Maintainer façade — every target delegates to pnpm or scripts/* (the same
# code humans and CI run). Deploys are not here: they happen in the Release
# workflow when a release tag is pushed.
#
#   make help            list these targets
#   make check           the full gate CI runs (pnpm run check)
#   make release-dry     print the next version cog would release; changes nothing
#   make release         cut a release: guards, cog bump, push commit + signed tag
#   make setup-github    apply rulesets, settings and environments (scripts/setup-github.sh)

.PHONY: help check release release-dry setup-github
.DEFAULT_GOAL := help

help:
	@sed -n 's/^#   make /make /p' $(firstword $(MAKEFILE_LIST))

check:
	pnpm run check

release-dry:
	scripts/release.sh --dry-run

# Refuses unless on a clean main equal to origin/main, with cog installed and
# commit + tag signing configured; before any tag exists it prints the v0.1.0
# baseline steps instead. cog makes a lightweight tag (re-created signed by
# post_bump_hooks) and --follow-tags skips non-annotated tags, so the script
# pushes main and the tag separately.
release:
	scripts/release.sh

setup-github:
	scripts/setup-github.sh
