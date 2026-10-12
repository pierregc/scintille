#!/usr/bin/env bash
# Local version of the web `preview` job: deploys the current branch as the Preview of its PR.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root/web"

test -z "$(git status --porcelain)" || { echo "working tree is not clean" >&2; exit 1; }
sha=$(git rev-parse HEAD)
git fetch -q origin "$(git rev-parse --abbrev-ref HEAD)"
test "$sha" = "$(git rev-parse '@{upstream}')" || { echo "push the branch first" >&2; exit 1; }
pr=${PR:-$(gh pr view --json number -q .number)}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

pnpm install --frozen-lockfile
SCINTILLE_COMMIT=$sha SCINTILLE_PR=$pr pnpm build
printf '\n/*\n  X-Robots-Tag: noindex\n' >> dist/client/_headers

output=$(mktemp)
trap 'rm -f "$output"' EXIT
WRANGLER_OUTPUT_FILE_PATH=$output pnpm exec wrangler preview --name "pr-$pr" --ignore-base-config
url=$(jq -r 'select(.type == "preview") | .preview_urls[0] // empty' "$output")
test -n "$url"
curl -fsSI --retry 5 --retry-all-errors "$url" | grep -qi '^x-robots-tag: noindex'

marker='<!-- web-preview -->'
body=$(printf '%s\nPreview: %s (commit %s, bound to scintille-live-preview, noindex)' "$marker" "$url" "$sha")
id=$(gh api "repos/$repo/issues/$pr/comments" --paginate \
	--jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n 1)
if [ -n "$id" ]; then
	gh api -X PATCH "repos/$repo/issues/comments/$id" -f body="$body" > /dev/null
else
	gh api "repos/$repo/issues/$pr/comments" -f body="$body" > /dev/null
fi
echo "$url"
