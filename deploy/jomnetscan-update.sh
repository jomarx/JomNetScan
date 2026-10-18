#!/usr/bin/env bash
# Pull the latest JomNetScan and restart the service, if and only if the remote
# is ahead. Run by jomnetscan-update.timer every hour; safe to run by hand.
#
# This runs as root (the timer's unit has no User=), because the service itself
# is deliberately unprivileged and its checkout is root-owned and read-only to
# it - so the service cannot update itself, and this is the piece that can.
#
# It only ever fast-forwards. If someone has made local commits, or the history
# diverged, it stops rather than rewriting anything, and the running service is
# left exactly as it was.
set -euo pipefail

REPO="${JOMNETSCAN_REPO:-/opt/jomnetscan}"
SERVICE="${JOMNETSCAN_SERVICE:-jomnetscan}"

cd "$REPO"

# Track whatever branch is checked out, so this keeps working across a move
# from web-server to main without being re-edited.
BRANCH="${JOMNETSCAN_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date at ${LOCAL:0:7} on ${BRANCH}."
  exit 0
fi

echo "Updating ${LOCAL:0:7} -> ${REMOTE:0:7} on ${BRANCH}."

# --ff-only is the safety: a non-fast-forward (local commits, a rebased remote)
# exits non-zero here and the restart below never runs.
git merge --ff-only "origin/${BRANCH}"

# Dependencies may have changed. --omit=dev keeps it to runtime, and a no-op is
# cheap when nothing changed.
npm install --omit=dev --no-audit --no-fund

systemctl restart "$SERVICE"
echo "Updated to ${REMOTE:0:7} and restarted ${SERVICE}."
