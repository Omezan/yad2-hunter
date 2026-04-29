#!/usr/bin/env bash
# Persist the contents of $STATE_DIR (default: ./state) to the repo's
# `state` branch.
#
# IMPORTANT: this script is race-safe. Multiple workflows (the looping
# scan, the manual scan-once, the health check) can call it concurrently.
# Without protection a naive force-push would let the slower writer wipe
# the faster writer's commit. Instead we:
#   1. Clone the current `state` branch.
#   2. Merge our local changes on top — preserving keys in seen-ads.json
#      that exist remotely but not locally (i.e. that another workflow
#      added since we checked state out).
#   3. Push with --force-with-lease so a remote that advanced again under
#      us forces a re-pull and re-merge. We retry up to 5 times.
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

# Resolve absolute path before changing directories.
STATE_DIR_ABS="$(cd "$STATE_DIR" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MERGE_SCRIPT="${SCRIPT_DIR}/merge-state.js"

if [ ! -f "$MERGE_SCRIPT" ]; then
  echo "[persist-state] missing merge helper at $MERGE_SCRIPT" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

cd "$WORK_DIR"
git init -q
git remote add origin "$REMOTE_URL"
git config user.name  "$AUTHOR_NAME"
git config user.email "$AUTHOR_EMAIL"

write_static_files() {
  # Drop the Vercel guard so Vercel doesn't try to build the state branch.
  cat > vercel.json <<'JSON'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": {
      "state": false
    }
  },
  "ignoreCommand": "exit 0"
}
JSON
  cat > .vercelignore <<'IGNORE'
*
IGNORE
}

attempt_push() {
  # Step 1: try to fetch the existing state branch (may not exist).
  if git fetch -q --depth=1 origin state 2>/dev/null; then
    git checkout -q -B state FETCH_HEAD
    echo "[persist-state] fetched origin/state"
  else
    git checkout -q --orphan state
    git rm -rfq . 2>/dev/null || true
    echo "[persist-state] state branch did not exist; creating fresh"
  fi

  # Step 2: merge our local snapshot on top of whatever's there.
  # We hand off to merge-state.js so seen-ads.json + runs.json can be
  # combined record-by-record instead of replaced wholesale.
  node "$MERGE_SCRIPT" "$STATE_DIR_ABS" "$WORK_DIR"

  write_static_files

  git add .
  if git diff --cached --quiet; then
    echo "[persist-state] no state changes to push"
    return 0
  fi

  git commit -q -m "Update Yad2 state ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

  # --force-with-lease: only succeed if origin/state is still what we
  # last fetched. If another workflow advanced it under us, the push
  # fails and we retry.
  if git push -q --force-with-lease origin state; then
    echo "[persist-state] pushed state branch"
    return 0
  fi
  return 1
}

MAX_ATTEMPTS=5
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  if attempt_push; then
    exit 0
  fi
  echo "[persist-state] push rejected (attempt $attempt/$MAX_ATTEMPTS); refetching and retrying"
  # Reset the working tree so the next iteration starts fresh.
  cd "$WORK_DIR"
  git reset -q --hard
  git clean -fdq
  # Small jittered backoff so two workflows don't lock-step.
  sleep $(( (RANDOM % 4) + 1 ))
done

echo "[persist-state] failed to push after $MAX_ATTEMPTS attempts" >&2
exit 1
