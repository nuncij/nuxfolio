#!/usr/bin/env bash
#
# A dated copy of the snapshot database, taken after every successful reading.
#
# Runs on the box as ExecStartPost of the snapshot service, so a backup exists
# exactly when there is something new to lose. The WAL is folded into the main
# file first, so the copy is complete on its own — a raw cp of a WAL-mode
# database can miss everything since the last checkpoint.
#
# Keeps the newest 14 here. The box copy only has to survive until the
# workstation pulls (scripts/backup-pull.sh), and the pull never deletes, so
# deep history accumulates off-box where it belongs.

set -euo pipefail

DATA="$HOME/nuxfolio/data/snapshots.db"
DIR="$HOME/nuxfolio/backup"

[ -f "$DATA" ] || exit 0

umask 077
mkdir -p "$DIR"

node -e "new (require('node:sqlite').DatabaseSync)(process.env.HOME + '/nuxfolio/data/snapshots.db').exec('PRAGMA wal_checkpoint(TRUNCATE)')" 2>/dev/null

cp "$DATA" "$DIR/snapshots-$(date -u +%F).db"

ls -1 "$DIR"/snapshots-*.db 2>/dev/null | sort | head -n -14 | xargs -r rm --
