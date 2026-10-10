#!/usr/bin/env bash
# Deploys a release on the VPS and rolls back image and compose file if health checks fail.
# Usage, as deploy in /srv/scintille: ./deploy.sh <git sha>, with releases/<sha>/compose.yaml uploaded.
set -euo pipefail
cd "$(dirname "$0")"

new=${1:?usage: deploy.sh <git sha>}
previous=$(cat .deployed 2>/dev/null || true)
timeout=${DEPLOY_WAIT_TIMEOUT:-180}

compose() {
	local tag=$1
	shift
	SCINTILLE_TAG=$tag docker compose -f "releases/$tag/compose.yaml" --project-directory . "$@"
}

up() {
	compose "$1" up -d --no-build --remove-orphans --wait --wait-timeout "$timeout"
}

test -f "releases/$new/compose.yaml" || { echo "releases/$new/compose.yaml is missing" >&2; exit 1; }
compose "$new" pull --quiet
if up "$new"; then
	echo "$new" > .deployed
	cp "releases/$new/compose.yaml" compose.yaml
	# shellcheck disable=SC2012
	ls -1t releases | tail -n +6 | while read -r old; do
		[ "$old" = "$new" ] || rm -rf "releases/$old"
	done
	echo "deployed $new"
	exit 0
fi

echo "deploy of $new failed its health checks" >&2
if [ -n "$previous" ] && up "$previous"; then
	echo "rolled back to $previous" >&2
fi
exit 1
