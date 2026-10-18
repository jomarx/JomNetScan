#!/usr/bin/env bash
# Pull the latest JomNetScan and restart the service, if and only if the remote
# is ahead and the service isn't in the middle of something. Run by
# jomnetscan-update.timer every hour; safe to run by hand.
#
# This runs as root (the timer's unit has no User=), because the service itself
# is deliberately unprivileged and its checkout is root-owned and read-only to
# it - so the service cannot update itself, and this is the piece that can.
#
# It only ever fast-forwards. If someone has made local commits, or the history
# diverged, it stops rather than rewriting anything, and the running service is
# left exactly as it was.
#
# It never restarts mid-task. The service keeps a flag file in its state
# directory while a scan, port scan, ping graph or vendor download is running;
# this waits for the flag to clear, and if it doesn't clear in time, tries
# again next hour rather than cutting anything short.
set -euo pipefail

REPO="${JOMNETSCAN_REPO:-/opt/jomnetscan}"
SERVICE="${JOMNETSCAN_SERVICE:-jomnetscan}"
DATA="${JOMNETSCAN_DATA:-/var/lib/jomnetscan}"
BUSY_FILE="${DATA}/busy"
# How long to wait for the service to go idle before giving up until next run.
WAIT_SECS="${JOMNETSCAN_UPDATE_WAIT:-900}"
# Code pulled but not yet restarted onto. On /run so a reboot - which starts the
# service on the new code anyway - clears it.
PENDING="${JOMNETSCAN_UPDATE_PENDING:-/run/jomnetscan-update.pending}"

# A flag only means something while the service is running; one left over from
# a stopped service must not block updates forever.
busy() {
  systemctl is-active --quiet "$SERVICE" && [ -e "$BUSY_FILE" ]
}

wait_for_idle() {
  local waited=0
  while busy; do
    if [ "$waited" -ge "$WAIT_SECS" ]; then
      return 1
    fi
    if [ "$waited" -eq 0 ]; then
      echo "Service is busy ($(cat "$BUSY_FILE" 2>/dev/null || echo '?')); waiting up to ${WAIT_SECS}s."
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

cd "$REPO"

# Track whatever branch is checked out, so this keeps working across a move
# from web-server to main without being re-edited.
BRANCH="${JOMNETSCAN_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "$LOCAL" != "$REMOTE" ]; then
  # Wait before touching the checkout too: the service serves its UI files
  # straight from it, so a pull under a running scan is already a change.
  if ! wait_for_idle; then
    echo "Still busy after ${WAIT_SECS}s; leaving ${LOCAL:0:7} in place until the next run."
    exit 0
  fi

  echo "Updating ${LOCAL:0:7} -> ${REMOTE:0:7} on ${BRANCH}."

  # --ff-only is the safety: a non-fast-forward (local commits, a rebased
  # remote) exits non-zero here and the restart below never runs.
  git merge --ff-only "origin/${BRANCH}"

  # Dependencies may have changed. --omit=dev keeps it to runtime, and a no-op
  # is cheap when nothing changed.
  npm install --omit=dev --no-audit --no-fund

  touch "$PENDING"
elif [ ! -e "$PENDING" ]; then
  echo "Already up to date at ${LOCAL:0:7} on ${BRANCH}."
  exit 0
fi

# Second check: a scheduled scan could have started during the install. The
# pending marker means a timeout here isn't lost - the next run sees the code
# is current but still owes a restart.
if ! wait_for_idle; then
  echo "Updated the code but the service stayed busy for ${WAIT_SECS}s; restarting on the next run."
  exit 0
fi

# try-restart, not restart: if the service was stopped on purpose, an update
# is no reason to start it again.
systemctl try-restart "$SERVICE"
rm -f "$PENDING"
echo "Running $(git rev-parse --short HEAD) on ${BRANCH}; restarted ${SERVICE} if it was running."
