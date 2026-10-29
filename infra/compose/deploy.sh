#!/usr/bin/env bash
# Deploys a release on the VPS and rolls back image and compose file if health checks fail.
# Keeps only the image tags of the running and the previous release, so the disk does not fill up.
# Usage, as deploy in /srv/scintille: ./deploy.sh <git sha>, with releases/<sha>/compose.yaml uploaded.
set -euo pipefail
cd "$(dirname "$0")"

new=${1:?usage: deploy.sh <git sha>}
previous=$(cat .deployed 2>/dev/null || true)
# shellcheck disable=SC2010,SC2012
[ -n "$previous" ] || previous=$(ls -1t releases 2>/dev/null | grep -vxF "$new" | head -n 1 || true)
timeout=${DEPLOY_WAIT_TIMEOUT:-180}

compose() {
	local tag=$1
	shift
	SCINTILLE_TAG=$tag docker compose -f "releases/$tag/compose.yaml" --project-directory . "$@"
}

up() {
	compose "$1" up -d --no-build --remove-orphans --wait --wait-timeout "$timeout"
}

# Removes the other tags of the repositories the given releases use; images of running containers stay.
prune() {
	local keep repo
	keep=$(for tag in "$@"; do compose "$tag" config --images; done | sort -u)
	for repo in $(printf '%s\n' "$keep" | sed 's/:[^:/]*$//' | sort -u); do
		docker image ls --format '{{.Repository}}:{{.Tag}}' "$repo" | grep -v '<none>' | sort -u |
			comm -23 - <(printf '%s\n' "$keep") | xargs -r docker image rm >/dev/null 2>&1 || true
	done
}

test -f "releases/$new/compose.yaml" || { echo "releases/$new/compose.yaml is missing" >&2; exit 1; }
if [ -n "$previous" ] && [ -f "releases/$previous/compose.yaml" ]; then prune "$previous"; fi
compose "$new" pull --quiet
if up "$new"; then
	echo "$new" > .deployed.tmp && mv .deployed.tmp .deployed
	cp "releases/$new/compose.yaml" compose.yaml
	# shellcheck disable=SC2012
	ls -1t releases | tail -n +6 | while read -r old; do
		[ "$old" = "$new" ] || rm -rf "releases/$old"
	done
	if [ -n "$previous" ] && [ -f "releases/$previous/compose.yaml" ]; then prune "$new" "$previous"; else prune "$new"; fi
	echo "deployed $new"
	exit 0
fi

echo "deploy of $new failed its health checks" >&2
if [ -n "$previous" ] && up "$previous"; then
	echo "rolled back to $previous" >&2
fi
exit 1
