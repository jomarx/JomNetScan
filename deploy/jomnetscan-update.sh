#!/usr/bin/env bash
# Pull the latest JomNetScan and restart the service, if and only if the remote
# is ahead and the service isn't in the middle of something. Normally started
# by jomnetscan-update.path when someone clicks "Update now" in the UI (or, if
# you opted into it, hourly by jomnetscan-update.timer); safe to run by hand.
#
# This runs as root (the update unit has no User=), because the service itself
# is deliberately unprivileged and its checkout is root-owned and read-only to
# it - so the service cannot update itself, and this is the piece that can.
#
# It only ever fast-forwards. If someone has made local commits, or the history
# diverged, it stops rather than rewriting anything, and the running service is
# left exactly as it was.
#
# It never restarts mid-task. The service keeps a flag file in its state
# directory while a scan, port scan, ping graph or vendor download is running;
# this waits for the flag to clear, and if it doesn't clear in time, gives up
# rather than cutting anything short.
#
# The state directory belongs to the unprivileged service, so everything in it
# is treated as hostile: this only tests files for existence, never follows a
# symlink to read one, and writes its result through a fresh mktemp file
# renamed into place, so a planted link can't redirect a root write.
set -Eeuo pipefail

REPO="${JOMNETSCAN_REPO:-/opt/jomnetscan}"
SERVICE="${JOMNETSCAN_SERVICE:-jomnetscan}"
DATA="${JOMNETSCAN_DATA:-/var/lib/jomnetscan}"
BUSY_FILE="${DATA}/busy"
REQUEST="${DATA}/update-requested"
RESULT="${DATA}/update-result.json"
# How long to wait for the service to go idle before giving up.
WAIT_SECS="${JOMNETSCAN_UPDATE_WAIT:-900}"
# Code pulled but not yet restarted onto. On /run so a reboot - which starts the
# service on the new code anyway - clears it.
PENDING="${JOMNETSCAN_UPDATE_PENDING:-/run/jomnetscan-update.pending}"

# Consume the click before anything else can fail. The path unit re-triggers
# for as long as this file exists, so leaving it behind would loop.
REQUESTED=false
if [ -e "$REQUEST" ] || [ -L "$REQUEST" ]; then
  REQUESTED=true
  rm -f "$REQUEST"
fi

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//[$'\n\r\t']/ }
  printf '"%s"' "$s"
}

# Tell the UI how a click turned out. Only for clicks: a timer run has nobody
# watching, and the journal has it.
report() {
  [ "$REQUESTED" = true ] && [ -d "$DATA" ] || return 0
  local tmp
  tmp="$(mktemp "${DATA}/.update-result.XXXXXX")" || return 0
  printf '{"status":%s,"message":%s,"requested":true,"finishedAt":%s}\n' \
    "$(json_str "$1")" "$(json_str "$2")" "$(date +%s%3N)" > "$tmp"
  # Readable by the service, which owns the directory.
  chown --reference="$DATA" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$RESULT"
}

on_error() {
  local code=$? cmd=$BASH_COMMAND
  trap - ERR
  echo "Failed (exit ${code}) at: ${cmd}" >&2
  report failed "Update failed at \`${cmd}\` (exit ${code}). See journalctl -u jomnetscan-update." || true
  exit "$code"
}
trap on_error ERR
# The unit's TimeoutStartSec, or someone stopping it by hand.
trap 'trap - ERR; report failed "Stopped before it finished. See journalctl -u jomnetscan-update." || true; exit 143' TERM

# What the service says it's busy with, for the log. Only from a regular file -
# a symlink here could otherwise point root at anything on the box - and only
# the characters the service ever writes.
busy_reason() {
  if [ -f "$BUSY_FILE" ] && [ ! -L "$BUSY_FILE" ]; then
    head -c 80 "$BUSY_FILE" | tr -cd 'a-z ,'
  fi
}

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
      echo "Service is busy ($(busy_reason)); waiting up to ${WAIT_SECS}s."
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
WAIT_MIN=$(( (WAIT_SECS + 59) / 60 ))
if [ "$WAIT_MIN" -eq 1 ]; then WAIT_FOR="1 minute"; else WAIT_FOR="${WAIT_MIN} minutes"; fi

if [ "$LOCAL" != "$REMOTE" ]; then
  if ! git merge-base --is-ancestor HEAD "origin/${BRANCH}"; then
    echo "origin/${BRANCH} is not a fast-forward of ${LOCAL:0:7}; leaving it alone."
    report failed "origin/${BRANCH} isn't a fast-forward of ${LOCAL:0:7} (local commits, or the remote was rewritten). Nothing changed."
    exit 1
  fi

  # Wait before touching the checkout too: the service serves its UI files
  # straight from it, so a pull under a running scan is already a change.
  if ! wait_for_idle; then
    echo "Still busy after ${WAIT_SECS}s; leaving ${LOCAL:0:7} in place."
    report busy "Something was still running after ${WAIT_FOR}, so nothing changed. Try again when it's quiet."
    exit 0
  fi

  echo "Updating ${LOCAL:0:7} -> ${REMOTE:0:7} on ${BRANCH}."
  git merge --ff-only "origin/${BRANCH}"

  # Dependencies may have changed. --omit=dev keeps it to runtime, and a no-op
  # is cheap when nothing changed.
  npm install --omit=dev --no-audit --no-fund

  touch "$PENDING"
  DONE="Updated ${LOCAL:0:7} → ${REMOTE:0:7}."
elif [ -e "$PENDING" ] || [ "$REQUESTED" = true ]; then
  # Nothing new to fetch, but a restart is owed: an earlier run pulled and then
  # timed out waiting, or the checkout was pulled by hand. The service only
  # offers the button when it's behind or running older code than is on disk.
  DONE="Restarted onto ${LOCAL:0:7}."
else
  echo "Already up to date at ${LOCAL:0:7} on ${BRANCH}."
  report current "Already up to date at ${LOCAL:0:7}."
  exit 0
fi

# Second check: a scheduled scan could have started during the install. The
# pending marker means a timeout here isn't lost - the next run sees the code
# is current but still owes a restart.
if ! wait_for_idle; then
  echo "Service stayed busy for ${WAIT_SECS}s; not restarting."
  report pending "$(git rev-parse --short HEAD) is installed, but something was still running after ${WAIT_FOR} so the service wasn't restarted. Use Restart now when it's quiet."
  exit 0
fi

# Written before the restart, so the new process finds it waiting.
report updated "$DONE"

# try-restart, not restart: if the service was stopped on purpose, an update
# is no reason to start it again.
systemctl try-restart "$SERVICE"
rm -f "$PENDING"
echo "Running $(git rev-parse --short HEAD) on ${BRANCH}; restarted ${SERVICE} if it was running."
