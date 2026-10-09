#!/usr/bin/env bash
# Deploys an image tag on the VPS and rolls back if health checks fail.
# Usage, as deploy in /srv/scintille: ./deploy.sh <git sha>
set -euo pipefail
cd "$(dirname "$0")"

new=${1:?usage: deploy.sh <git sha>}
previous=$(cat .deployed 2>/dev/null || true)

up() {
	SCINTILLE_TAG=$1 docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180
}

SCINTILLE_TAG=$new docker compose pull --quiet
if up "$new"; then
	echo "$new" > .deployed
	echo "deployed $new"
	exit 0
fi

echo "deploy of $new failed its health checks" >&2
if [ -n "$previous" ] && up "$previous"; then
	echo "rolled back to $previous" >&2
fi
exit 1
