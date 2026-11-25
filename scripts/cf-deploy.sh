#!/usr/bin/env bash
# Workers Builds deploy command for main: `bash scripts/cf-deploy.sh`.
# Tags the Worker version with the short commit, so /data/version.json and
# the site footer can show (and link) which commit is live. Without a commit
# (a manual deploy) it deploys untagged and the footer shows the deploy time.
set -euo pipefail
sha="${WORKERS_CI_COMMIT_SHA:-}"
if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  exec npx wrangler deploy --tag "${sha:0:7}" --message "commit ${sha}"
fi
exec npx wrangler deploy
