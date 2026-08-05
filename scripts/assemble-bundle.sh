#!/usr/bin/env bash
#
# Assembles the deployable bundle from an existing `next build` output.
#
#   ./scripts/assemble-bundle.sh [destination]      # default: .next/deploy-bundle
#
# Extracted so the two things that ship a build — `deploy.sh` from a developer
# machine and the publish step in CI — assemble it through one implementation.
# They used to have a copy each, which is the kind of duplication that stays
# correct right up until one of them is edited.
#
# `next build` deliberately leaves static assets *out* of the standalone
# directory, so a bundle that is merely copied serves HTML with no CSS. That is
# the mistake this file exists to make impossible.

set -euo pipefail

readonly DEST="${1:-.next/deploy-bundle}"

[[ -f next.config.ts ]] || {
  printf 'assemble-bundle: run this from the repository root\n' >&2
  exit 1
}
[[ -d .next/standalone ]] || {
  printf "assemble-bundle: no standalone build; is output:'standalone' set in next.config.ts?\n" >&2
  exit 1
}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r .next/standalone/. "$DEST/"
mkdir -p "$DEST/.next"
cp -r .next/static "$DEST/.next/static"
[[ -d public ]] && cp -r public "$DEST/public"

# The full SHA, not the short one: the self-updater reports it back to GitHub by
# moving a tag, and the git refs API takes nothing else.
git rev-parse HEAD > "$DEST/DEPLOYED_COMMIT"

printf '  bundle: %s across %s files (%s)\n' \
  "$(du -sh "$DEST" | cut -f1)" \
  "$(find "$DEST" -type f | wc -l)" \
  "$(git rev-parse --short HEAD)"
