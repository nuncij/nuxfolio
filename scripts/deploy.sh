#!/usr/bin/env bash
#
# Deploys Nuxfolio to a Tailscale-reachable host.
#
#   ./scripts/deploy.sh            # build, ship, restart, verify
#   ./scripts/deploy.sh --no-build # ship the existing build (faster re-deploy)
#
# Shape of this, and why:
#
#   * The build happens HERE, never on the target. The target has 3.7 GB of RAM,
#     no swap, and other services already running on it; an out-of-memory kill
#     during a build there could take those down. Only `output: 'standalone'` —
#     a self-contained server plus its traced dependencies — travels.
#   * Everything is ADDITIVE. The target belongs to other projects too, so this
#     installs one user-level systemd unit, binds one loopback port, and adds one
#     `tailscale serve` route. It installs no package, touches no firewall rule,
#     and claims neither port 80 nor 443.
#   * The service is a *user* unit with lingering, matching how the host's other
#     services already run, so nothing here needs sudo.
#
# See docs/DECISIONS.md, ADR-018.

set -euo pipefail

# --- configuration -----------------------------------------------------------

# Tailscale address of the target. Not a secret, but not in the repo either: the
# repo is on GitHub, and a host address is not something to publish.
readonly TARGET="${NUXFOLIO_DEPLOY_TARGET:-}"

# Loopback port the app listens on. Deliberately in the host's existing 18xxx
# range for its internal services, and confirmed unused before it was chosen.
readonly APP_PORT="${NUXFOLIO_APP_PORT:-18800}"

# HTTPS port Tailscale serves it on, inside the tailnet only.
readonly SERVE_PORT="${NUXFOLIO_SERVE_PORT:-9443}"

# Relative to the login home directory on purpose: both `ssh` commands and rsync
# destinations resolve from there, whereas a literal "$HOME" would be expanded by
# the remote shell but taken verbatim by rsync.
readonly REMOTE_ROOT="nuxfolio"
readonly SERVICE="nuxfolio"

# --- helpers -----------------------------------------------------------------

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31mdeploy failed: %s\033[0m\n' "$*" >&2
  exit 1
}

remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" "$@"; }

# --- preflight ---------------------------------------------------------------

[[ -n "$TARGET" ]] || fail "set NUXFOLIO_DEPLOY_TARGET, e.g. NUXFOLIO_DEPLOY_TARGET=user@host $0"
[[ -f next.config.ts ]] || fail "run this from the repository root"

say "Checking the target is reachable"
remote 'echo ok' >/dev/null 2>&1 || fail "cannot reach $TARGET over SSH (is Tailscale up?)"

# A version of node old enough to lack what the build output expects would fail
# at runtime rather than here, which is a much worse place to find out. 24 because
# the snapshot store uses node:sqlite, which older majors do not ship stable.
remote 'node --version' | awk -F. '{ gsub(/v/,"",$1); if ($1 < 24) { print "too old"; exit 1 } }' \
  >/dev/null || fail "target needs Node 24 or newer (node:sqlite)"

# --- build -------------------------------------------------------------------

if [[ "${1:-}" != "--no-build" ]]; then
  say "Verifying before shipping"
  # Refusing to deploy code that does not pass its own checks is the whole point
  # of having them.
  pnpm verify

  say "Building"
  pnpm build
fi

[[ -d .next/standalone ]] || fail "no standalone build; is output:'standalone' set in next.config.ts?"

# --- assemble ----------------------------------------------------------------

# Shared with the publish step in CI, so a build shipped from here and a build
# shipped by the self-updater are assembled identically.
say "Assembling the bundle"
readonly STAGE=".next/deploy-bundle"
bash scripts/assemble-bundle.sh "$STAGE"

# --- ship --------------------------------------------------------------------

say "Shipping to $TARGET"

# The self-update timer must not fire while rsync is mid-copy: it moves the very
# directory rsync is writing into (round 10, F-04). Stopped here, restarted by the
# timer-install section below — and by this trap if the deploy dies in between,
# because a failed deploy that also silently disabled auto-updates would be two
# problems disguised as one.
remote "systemctl --user stop $SERVICE-update.timer 2>/dev/null || true"
TIMER_STOPPED=1
trap '[[ -n "${TIMER_STOPPED:-}" ]] && remote "systemctl --user start '"$SERVICE"'-update.timer 2>/dev/null || true"' EXIT

remote "mkdir -p $REMOTE_ROOT/app"

# --delete so a file removed from the build is removed on the target too;
# otherwise a stale chunk can be served for as long as the machine lives.
rsync -az --delete \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' \
  "$STAGE/" "$TARGET:$REMOTE_ROOT/app/"

# The one path the app's unit may write. Created by whoever ships the app, so the
# unit's mount rule never points at nothing.
remote "mkdir -p $REMOTE_ROOT/app/.next/cache"

# --- service -----------------------------------------------------------------

say "Installing the service"
remote 'mkdir -p "$HOME/.config/systemd/user"'

# Written every deploy so the unit and this script cannot drift apart.
remote "cat > \"\$HOME/.config/systemd/user/$SERVICE.service\"" <<UNIT
[Unit]
Description=Nuxfolio (read-only crypto portfolio tracker)
Documentation=https://github.com/nuncij/nuxfolio
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/nuxfolio/app
# Loopback only. Reaching it from the tailnet goes through \`tailscale serve\`,
# so the app itself is never bound to a routable interface.
Environment=HOSTNAME=127.0.0.1
Environment=PORT=$APP_PORT
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
# History lives beside the app, never inside it: this script rsyncs \`--delete\` into
# \`app/\`, so a database there would be removed by the next deploy (M4 review, F-1).
Environment=NUXFOLIO_DATA_DIR=%h/nuxfolio/data
# Optional runtime configuration — API keys, RPC endpoints. Absent by default,
# and never written by this script, so a deploy cannot clobber it.
EnvironmentFile=-%h/nuxfolio/env
ExecStart=/usr/bin/env node server.js
Restart=on-failure
RestartSec=3

# This host runs other people's services. A ceiling means a leak here gets this
# service killed rather than the machine swapping — which it cannot do, having
# no swap configured.
MemoryHigh=512M
MemoryMax=768M

# The app can write to its runtime cache and nowhere else. It used to have the
# whole of ~/nuxfolio writable, which meant the internet-facing process could
# rewrite the self-updater and read the updater's credential — a sandbox escape
# waiting for any app compromise (review round 10, F-01). The updater's token
# lives in ~/nuxfolio/updater-env, which this unit does not load and can no
# longer write. The \`-\` prefix keeps a missing cache directory from failing the
# mount; both shippers create it.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=-%h/nuxfolio/app/.next/cache
# The snapshot database. A second writable path rather than widening the first:
# \`data/\` is a sibling of \`app/\`, so this grants nothing over the code or the
# updater's credential in \`updater-env\`.
ReadWritePaths=-%h/nuxfolio/data

[Install]
WantedBy=default.target
UNIT

# 700, because the box hosts other people's services and the default umask would
# leave the database listing the tracked wallets readable to every one of them.
remote "mkdir -p \"\$HOME/nuxfolio/data\" && chmod 700 \"\$HOME/nuxfolio/data\""
remote "systemctl --user daemon-reload && systemctl --user enable --now $SERVICE && systemctl --user restart $SERVICE"

# --- daily snapshot timer ----------------------------------------------------
#
# The history job runs from the host, not from a timer inside the app: a redeploy
# restarts the process and would silently lose an in-process schedule. Missing or
# repeating a run costs nothing, because the store is keyed on the UTC day.
#
# The key reaches curl through a config file on stdin rather than an argument.
# This host runs other people's services, and an argument is visible in /proc to
# anyone who can read it.
remote "cat > \"\$HOME/.config/systemd/user/$SERVICE-snapshot.service\"" <<SNAPUNIT
[Unit]
Description=Nuxfolio daily portfolio snapshot
After=$SERVICE.service

[Service]
Type=oneshot
EnvironmentFile=-%h/nuxfolio/env
# No \`%\` anywhere in this line: systemd reads \`%\` as a unit specifier, so a
# \`printf "%s"\` here would fail to load rather than fail to run.
ExecStart=/bin/sh -c 'test -n "\$NUXFOLIO_SNAPSHOT_KEY" || exit 0; echo "header = \\"x-snapshot-key: \$NUXFOLIO_SNAPSHOT_KEY\\"" | exec curl -sS --fail --retry 5 --retry-connrefused --retry-delay 2 --max-time 900 -K - -X POST http://127.0.0.1:$APP_PORT/api/snapshot'
SNAPUNIT

remote "cat > \"\$HOME/.config/systemd/user/$SERVICE-snapshot.timer\"" <<SNAPTIMER
[Unit]
Description=Take a Nuxfolio snapshot once a day

[Timer]
# UTC, matching the day the rows are keyed on. A local-time schedule would drift
# across daylight saving and put two runs or none into one UTC bucket.
OnCalendar=*-*-* 04:17:00 UTC
# A box that was off at 04:17 still gets its reading.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
SNAPTIMER

remote "systemctl --user daemon-reload && systemctl --user enable --now $SERVICE-snapshot.timer"

# One run now, not just at 04:17: a wallet added to the tracked list should get its
# first row the day it joins, and a deploy is when the list can have changed. The store
# is keyed on the UTC day, so on every other deploy this rewrites today's rows and adds
# none. --no-block, because a deploy should not fail over one flaky provider read —
# curl in the unit retries a refused connection while the app is still starting.
remote "systemctl --user start --no-block $SERVICE-snapshot.service"

# --- self-update timer -------------------------------------------------------
#
# Installed from here so the manual path bootstraps the automatic one: whoever can
# deploy by hand has, by doing so, also installed the thing that makes deploying by
# hand unnecessary. Written every deploy, like the service unit, so the script on
# the target cannot drift from the one in the repository.
say "Installing the self-update timer"
remote "mkdir -p $REMOTE_ROOT/bin"
rsync -az -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' \
  scripts/self-update.sh "$TARGET:$REMOTE_ROOT/bin/self-update.sh"
remote "chmod +x $REMOTE_ROOT/bin/self-update.sh"

remote "cat > \"\$HOME/.config/systemd/user/$SERVICE-update.service\"" <<UNIT
[Unit]
Description=Nuxfolio self-update (pull the build CI published)
Documentation=https://github.com/nuncij/nuxfolio

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash %h/nuxfolio/bin/self-update.sh
# Ceilings here too: this unpacks an archive on a box with no swap and other
# people's services on it. The runtime cap matters doubly — oneshot units have no
# start timeout by default, so without it one hung download would hold the update
# lock forever and silently end all future updates (round 10, F-11).
MemoryMax=256M
RuntimeMaxSec=600
Nice=10
UNIT

remote "cat > \"\$HOME/.config/systemd/user/$SERVICE-update.timer\"" <<UNIT
[Unit]
Description=Check for a new Nuxfolio build

[Timer]
# Every 15 minutes. The check is one request for a 90-byte checksum, so the
# common case — nothing published — costs nothing worth measuring. No
# Persistent=true: it only affects OnCalendar timers, and missed runs do not
# matter anyway — only the newest build does, and OnBootSec covers a reboot.
OnBootSec=3min
OnUnitActiveSec=15min
# So several machines on a timer do not all hit the API on the same second.
RandomizedDelaySec=90

[Install]
WantedBy=timers.target
UNIT

remote "systemctl --user daemon-reload && systemctl --user enable --now $SERVICE-update.timer"
# The timer is running again; the trap set before rsync no longer needs to.
TIMER_STOPPED=

# Forget which build the timer thinks is running, because this deploy just replaced
# the app directory underneath it. The timer is authoritative afterwards, and that
# has a consequence worth being loud about rather than clever with:
#
#   **A hand-shipped build is temporary.** Within fifteen minutes the timer pulls
#   whatever CI published for `main` and swaps it in. That is right for a box that
#   keeps itself current, but it means `deploy.sh` is no longer how you pin
#   something — to try a branch on the target, stop the timer first:
#   `systemctl --user stop nuxfolio-update.timer`.
#
# Reconciling instead — recording the published checksum when it matches what was
# just shipped — would need this script to fetch the release asset, and would leave
# a hand-deployed branch running with no sign that it diverged from `main`. Losing
# the pin is the better failure.
remote "rm -f $REMOTE_ROOT/.deployed-sha256"

# The token lives in updater-env, NOT env: the app's unit loads env, and a
# repository credential must never be readable by the internet-facing process
# (round 10, F-01). Checked by *using* it rather than by grepping for it — a
# revoked or expired token looks exactly like a present one until it is exercised,
# and a fine-grained token that was given a 30-day default lifetime dies silently
# (round 10, F-15).
if remote "grep -q '^GH_TOKEN=' $REMOTE_ROOT/updater-env 2>/dev/null"; then
  if remote "cd $REMOTE_ROOT && set -a && . ./updater-env && set +a && gh release view build --repo \${NUXFOLIO_REPO:-nuncij/nuxfolio} --json tagName -q .tagName" >/dev/null 2>&1; then
    printf '  timer enabled, token present and working\n'
    printf '  \033[33mnote: this build is temporary — within 15 min the timer pulls what CI published for main\033[0m\n'
    printf '  \033[33mto pin it, run: systemctl --user stop nuxfolio-update.timer\033[0m\n'
  else
    printf '  \033[33mtimer enabled, token present but NOT WORKING (expired? wrong scope?) — updates will fail\033[0m\n'
  fi
else
  printf '  \033[33mtimer enabled but there is no GH_TOKEN in %s/updater-env — it will fail\033[0m\n' "$REMOTE_ROOT"
  printf '  \033[33mcreate a fine-grained token (this repo only, Contents: read and write),\033[0m\n'
  printf '  \033[33mset a long expiry on purpose, and put it there with mode 600\033[0m\n'
fi

# --- expose ------------------------------------------------------------------

say "Publishing on the tailnet"
# Backing up first: this host's serve configuration carries other projects'
# routes, and `tailscale serve` edits shared state.
remote 'tailscale serve status --json > "$HOME/tailscale-serve-backup.$(date +%s).json" 2>/dev/null || true'
# `tailscale serve` needs root unless the tailnet operator has been set for this
# user. Elevating for this one command is the smaller change: setting
# `--operator` would permanently grant this account control over the host's whole
# Tailscale configuration, and that configuration carries other projects' routes.
remote "sudo -n tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:$APP_PORT" >/dev/null

# --- verify ------------------------------------------------------------------

say "Verifying"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$APP_PORT/" || echo 000)
  [[ "$code" == "200" ]] && break
  [[ "$attempt" == "10" ]] && {
    remote "systemctl --user status $SERVICE --no-pager -l | tail -20" || true
    fail "the service did not answer on 127.0.0.1:$APP_PORT"
  }
  sleep 2
done

readonly HOSTNAME_TS=$(remote "tailscale status --json | grep -m1 -oE '\"DNSName\":\"[^\"]+\"' | cut -d'\"' -f4 | sed 's/\.$//'")

# --- record what is now live -------------------------------------------------
#
# The weekly token-list refresh runs on GitHub, which cannot reach this target and
# must not build on it, so a refresh landing on `main` changes nothing a browser
# sees until a deploy happens. Recording the deployed commit is what lets that
# refresh say how far behind the running app has drifted instead of leaving it to
# be noticed. See scripts/deployLag.mjs.
#
# A force-moved tag, not a committed file: it marks a commit without creating one,
# so a deploy leaves no diff. Everything here is best-effort — a deploy that
# worked must not be reported as failed because GitHub was unreachable afterwards.
say "Recording the deployed commit"
if git tag -f deployed HEAD >/dev/null 2>&1 &&
  git push --force --quiet origin refs/tags/deployed 2>/dev/null; then
  printf '  tagged and pushed as the deployed commit\n'

  # Close the "live site is behind" issue the refresh opens, if one is open. Done
  # here rather than by the next weekly run so the issue disappears when the work
  # is done, not up to seven days later.
  if command -v gh >/dev/null 2>&1; then
    issue=$(gh issue list --state open --search 'in:title "Live site is behind"' \
      --json number --jq '.[0].number // empty' 2>/dev/null || true)
    if [[ -n "${issue:-}" ]]; then
      gh issue close "$issue" --comment "Deployed $(git rev-parse --short HEAD). The live site is serving the current lists." >/dev/null 2>&1 &&
        printf '  closed #%s\n' "$issue"
    fi
  fi
else
  printf '  \033[33mcould not push the tag; the refresh job will not see this deploy\033[0m\n'
fi

printf '\n\033[32mDeployed.\033[0m  commit %s\n' "$(git rev-parse --short HEAD)"
printf '  local on target : http://127.0.0.1:%s\n' "$APP_PORT"
printf '  from your devices: https://%s:%s\n\n' "$HOSTNAME_TS" "$SERVE_PORT"
