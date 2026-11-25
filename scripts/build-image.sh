#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source runtime/versions.env
if [ "${1:-}" = "--help" ]; then
  echo 'build-image.sh [docker build arguments, e.g. --tag jobs-dashboard-ci]'
  exit 0
fi
docker build --platform linux/amd64 --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "CLAUDE_CLI_VERSION=$CLAUDE_CLI_VERSION" "$@" .
