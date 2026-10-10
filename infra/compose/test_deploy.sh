#!/usr/bin/env bash
# A release that changes a command and fails its health check is rolled back with the previous compose file.
set -euo pipefail
dir=$(mktemp -d)
trap 'docker compose -p deploy-test down -t 0 >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
cp "$(dirname "$0")/deploy.sh" "$dir/"

release() {
	mkdir -p "$dir/releases/$1"
	cat > "$dir/releases/$1/compose.yaml" <<YAML
name: deploy-test
services:
  app:
    image: mirror.gcr.io/library/busybox:1.37
    command: ["sh", "-c", "$2"]
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ok"]
      interval: 1s
      retries: 3
      start_period: 0s
YAML
}

release good "touch /tmp/ok && sleep 600"
release bad "sleep 600"
export DEPLOY_WAIT_TIMEOUT=30
"$dir/deploy.sh" good
if "$dir/deploy.sh" bad; then
	echo "bad release was not rejected" >&2
	exit 1
fi
test "$(cat "$dir/.deployed")" = good
cmd=$(docker inspect --format '{{json .Config.Cmd}}' "$(docker compose -p deploy-test ps -q app)")
grep -q "touch /tmp/ok" <<< "$cmd" || { echo "running $cmd" >&2; exit 1; }
echo "rollback restored the previous compose file"
