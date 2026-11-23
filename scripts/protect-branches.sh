#!/bin/sh
# Applies the rulesets in .github/rulesets/ to the repository of the current checkout (or $REPO=owner/name): dev and
# prod get no force push or deletion, and changes only through pull requests with a green CI check. Repository
# admins can still bypass them (actor 5). Needs `gh` signed in with admin rights.
# Re-running it creates duplicates: delete the old rulesets first (gh api repos/<repo>/rulesets).
set -eu

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
DIR="$(dirname "$0")/../.github/rulesets"

for file in "$DIR"/*.json; do
  echo "→ $(basename "$file") on $REPO"
  gh api --method POST "repos/$REPO/rulesets" --input "$file" --jq '"  ruleset " + (.id|tostring) + ": " + .name'
done
