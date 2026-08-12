#!/usr/bin/env bash
#
# Pull the snapshot backups off the box. The machine running this is the
# off-box copy — the box's own backup directory shares a disk with the
# database it protects.
#
# No --delete, deliberately: the box prunes itself to 14 dated files, but a
# backup host has no reason to mirror deletions. At ~12 KB a file, keeping
# every day ever pulled costs a few megabytes a year and is the deeper
# history.
#
# Runs two ways: at the end of every deploy (scripts/deploy.sh), and from a
# daily user timer on the workstation with Persistent=true, so days the
# machine was off are taken on next boot.

set -euo pipefail

TARGET="${NUXFOLIO_DEPLOY_TARGET:-}"
[ -n "$TARGET" ] || {
  echo "set NUXFOLIO_DEPLOY_TARGET, e.g. NUXFOLIO_DEPLOY_TARGET=user@host $0" >&2
  exit 1
}

# Outside any git repository: these files are the owner's wallet history and
# must never ride a push to a public remote.
DEST="${NUXFOLIO_BACKUP_DIR:-$HOME/GIT/CRYPTO/nuxfolio-backups}"

umask 077
mkdir -p "$DEST"

rsync -az -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' "$TARGET:nuxfolio/backup/" "$DEST/"

echo "backup-pull: $(ls -1 "$DEST" | wc -l) file(s) in $DEST, newest: $(ls -1 "$DEST" | sort | tail -1)"
