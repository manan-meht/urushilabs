#!/usr/bin/env bash
#
# Pushes this directory to the Pi. Use this instead of a hand-written rsync.
#
# The excludes are not cosmetic. `venv/` and `.env` live only on the Pi and are
# absent from the repo, so a --delete sync without them wipes the virtualenv's
# bin/ and the device's credentials — a ~5 minute rebuild over the Pi's flaky
# wifi, for a one-line code change. Learned the hard way.
#
# Usage: ./scripts/sync-to-pi.sh [ssh-host]   (default host: urushi-room)

set -euo pipefail

HOST="${1:-urushi-room}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/"

rsync -az --delete \
  --exclude 'venv/' \
  --exclude '.env' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude '*.pyc' \
  "$SRC" "$HOST:~/urushi-pi-client/"

echo "Synced to $HOST:~/urushi-pi-client/"
