#!/usr/bin/env bash
# Persist the contents of $STATE_DIR (default: ./state) to the repo's
# `state` branch via force-push. Intended to be invoked between scan
# iterations so we don't lose progress if the runner is killed.
#
# Required env vars when run in GitHub Actions:
#   GITHUB_TOKEN, GITHUB_REPOSITORY
# Optional:
#   STATE_DIR (defaults to ./state)
#   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL

set -euo pipefail

STATE_DIR="${STATE_DIR:-state}"
AUTHOR_NAME="${GIT_AUTHOR_NAME:-github-actions[bot]}"
AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

if [ ! -d "$STATE_DIR" ] || [ -z "$(ls -A "$STATE_DIR" 2>/dev/null || true)" ]; then
  echo "[persist-state] no state to persist (STATE_DIR=$STATE_DIR is missing or empty)"
  exit 0
fi

if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "[persist-state] missing GITHUB_TOKEN or GITHUB_REPOSITORY; skipping push" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cp -R "$STATE_DIR/." "$WORK_DIR/"
cd "$WORK_DIR"

git init -q -b state
git config user.name  "$AUTHOR_NAME"
git config user.email "$AUTHOR_EMAIL"
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git add .

if git diff --cached --quiet; then
  echo "[persist-state] no state changes to push"
  exit 0
fi

git commit -q -m "Update Yad2 state ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git push -f -q origin state
echo "[persist-state] pushed state branch"
