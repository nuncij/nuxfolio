#!/usr/bin/env bash
#
# Runs ON THE TARGET, on a timer. Pulls the build CI published and swaps it in.
#
# This exists because the weekly token-list refresh reaches `main` and not the
# running app: the lists are compiled into the build, and until now shipping them
# meant a human running `deploy.sh` from a machine on the tailnet.
#
# The three shapes that were considered, and why this one:
#
#   * **Deploy from CI** would need a Tailscale auth key stored as a GitHub secret
#     — a credential reaching into a private network, held by a third party, to
#     save one command. Rejected.
#   * **Build here** turned out to be *feasible* — measured 950 MB peak against
#     2,579 MB available, so the "it would be OOM-killed" claim in ADR-018 was
#     overstated — but it needs a checkout, a package manager and a toolchain on a
#     box that runs other people's services, and it competes for 2 vCPUs.
#   * **Pull a build made elsewhere**, which is this. The box needs no toolchain:
#     `output: 'standalone'` is self-contained. It reaches *out* to GitHub over
#     HTTPS, so nothing needs to reach *in*.
#
# **The credential lives in ~/nuxfolio/updater-env — NOT in ~/nuxfolio/env.** The
# app's unit loads `env`, so anything in it is readable by the internet-facing
# process; review round 10 (F-01) pointed out that parking a repository-write token
# there hands it to whoever ever compromises the app, along with the ability to
# rewrite this very script and escape the app's sandbox on the next timer run. The
# updater's file is loaded by nobody but this script, and the app's unit now has no
# write access to ~/nuxfolio outside its own runtime cache. The token is
# fine-grained, this repository only, Contents read and write — write solely to
# move the `deployed` tag, which is what lets the weekly refresh notice if this
# timer ever stops running.
#
# Nobody watches this. So it assumes it will fail: prune what a crash left behind,
# check disk before downloading, verify before unpacking, health-check after
# swapping, roll back if the new build does not answer, and quarantine a build
# that keeps failing instead of retrying it every 15 minutes forever.

set -euo pipefail

readonly REPO="${NUXFOLIO_REPO:-nuncij/nuxfolio}"
readonly RELEASE_TAG="${NUXFOLIO_BUILD_TAG:-build}"
readonly ROOT="$HOME/nuxfolio"
readonly APP="$ROOT/app"
readonly SERVICE="nuxfolio"
readonly APP_PORT="${NUXFOLIO_APP_PORT:-18800}"

readonly BUNDLE_ASSET="nuxfolio-bundle.tar.gz"
readonly SUM_ASSET="nuxfolio-bundle.sha256"

# The bundle is ~13 MB compressed, ~45 MB unpacked. An asset wildly past that is
# not a build, whatever its checksum says, and unpacking it unexamined is how a
# disk fills on a box other people's services live on (round 10, F-08).
readonly MAX_BUNDLE_BYTES=$((200 * 1024 * 1024))
readonly MIN_FREE_KB=$((500 * 1024))

log() { printf '%s self-update: %s\n' "$(date -uIs)" "$*"; }
fail() {
  printf '%s self-update FAILED: %s\n' "$(date -uIs)" "$*" >&2
  exit 1
}

# One at a time. A timer that fires while a swap is half-done would be the one way
# this breaks the site rather than protecting it. deploy.sh stops the timer
# outright while it works, for the same reason from the other side.
exec 9>"$ROOT/.self-update.lock"
flock -n 9 || {
  log 'another run holds the lock; leaving it to that one'
  exit 0
}

# A SIGKILL or power loss mid-run leaves a work directory the EXIT trap never got
# to remove. Under the lock, anything old enough not to be a live run is debris.
find "$ROOT" -maxdepth 1 -name '.self-update.*' -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# shellcheck disable=SC1091
[[ -f "$ROOT/updater-env" ]] && set -a && . "$ROOT/updater-env" && set +a
[[ -n "${GH_TOKEN:-}" ]] || fail "no GH_TOKEN in $ROOT/updater-env — see docs/DECISIONS.md, ADR-018"
export GH_TOKEN

readonly WORK="$(mktemp -d "$ROOT/.self-update.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- report a deploy the last run could not -----------------------------------
#
# Moving the `deployed` tag is deliberately non-fatal — a deploy that worked must
# not be reported as failed because GitHub hiccuped afterwards. But the fast path
# below exits early when nothing changed, so without this retry a single hiccup
# would leave the tag stale until the *next* build, quietly undermining the
# 30-day liveness check it feeds (round 10, F-12).
report_deployed() {
  local sha="$1"
  gh api --method PATCH "/repos/$REPO/git/refs/tags/deployed" \
    -f "sha=$sha" -F force=true >/dev/null 2>&1 ||
    gh api --method POST "/repos/$REPO/git/refs" \
      -f "ref=refs/tags/deployed" -f "sha=$sha" >/dev/null 2>&1
}

if [[ -f "$ROOT/.pending-tag" ]]; then
  if report_deployed "$(cat "$ROOT/.pending-tag")"; then
    rm -f "$ROOT/.pending-tag"
    log 'caught up the deployed tag from a previous run'
  fi
fi

# --- is there anything new? ----------------------------------------------------
#
# The checksum asset is a few dozen bytes and the bundle is 13 MB, so the common
# case — nothing changed — costs one tiny request.

gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$SUM_ASSET" \
  --dir "$WORK" --clobber >/dev/null 2>&1 ||
  fail "could not fetch $SUM_ASSET from $REPO (token scope? release missing?)"

readonly PUBLISHED_SUM="$(cut -d' ' -f1 < "$WORK/$SUM_ASSET")"
readonly CURRENT_SUM="$(cat "$ROOT/.deployed-sha256" 2>/dev/null || echo none)"

if [[ "$PUBLISHED_SUM" == "$CURRENT_SUM" ]]; then
  log "already running the published build (${PUBLISHED_SUM:0:12}); nothing to do"
  exit 0
fi

# A build that failed its health check once will fail it every 15 minutes, and
# each attempt costs a restart of the working copy. Once burned, skip it until
# the published checksum changes (round 10, F-07).
if [[ "$PUBLISHED_SUM" == "$(cat "$ROOT/.rejected-sha256" 2>/dev/null || echo none)" ]]; then
  log "published build ${PUBLISHED_SUM:0:12} already failed its health check here; waiting for a new one"
  exit 0
fi
rm -f "$ROOT/.rejected-sha256"

log "new build published (${PUBLISHED_SUM:0:12}, running ${CURRENT_SUM:0:12})"

# --- fetch and verify ----------------------------------------------------------

free_kb="$(df --output=avail -k "$ROOT" | tail -1 | tr -d ' ')"
[[ "$free_kb" -ge "$MIN_FREE_KB" ]] ||
  fail "only ${free_kb} kB free on $ROOT; not downloading (need ${MIN_FREE_KB})"

gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$BUNDLE_ASSET" \
  --dir "$WORK" --clobber >/dev/null 2>&1 || fail "could not download $BUNDLE_ASSET"

bundle_bytes="$(stat -c%s "$WORK/$BUNDLE_ASSET")"
[[ "$bundle_bytes" -le "$MAX_BUNDLE_BYTES" ]] ||
  fail "bundle is $bundle_bytes bytes, past the $MAX_BUNDLE_BYTES sanity bound; refusing it"

# Verified before anything is unpacked. A truncated download is the most likely
# fault here, and it would otherwise become a half-extracted application. What the
# checksum does NOT do is authenticate the publisher — it is uploaded by the same
# workflow as the bundle. The trust root is `main` itself; see ADR-018.
( cd "$WORK" && sha256sum --check --status "$SUM_ASSET" ) ||
  fail "checksum mismatch — refusing to unpack (an interrupted publish heals on the next push)"

mkdir -p "$WORK/new"
tar -xzf "$WORK/$BUNDLE_ASSET" -C "$WORK/new"
[[ -f "$WORK/new/server.js" ]] || fail "bundle has no server.js; not going further"
[[ -d "$WORK/new/.next/static" ]] || fail "bundle has no static assets; it would serve unstyled HTML"

# The app's unit may only write here — created before the swap so the mount rule
# never points at a missing directory.
mkdir -p "$WORK/new/.next/cache"

readonly NEW_COMMIT="$(cat "$WORK/new/DEPLOYED_COMMIT" 2>/dev/null || echo unknown)"

# --- swap ------------------------------------------------------------------------
#
# Two renames on one filesystem: milliseconds, but not atomic as a pair. If power
# dies between them the service is down until the next timer run — which then
# finds `.deployed-sha256` still holding the old sum, re-downloads, sees no app
# directory to preserve, and installs cleanly. The window self-heals; it is
# accepted rather than engineered away (round 10, F-03).

log "swapping in ${NEW_COMMIT:0:7}"
rm -rf "$ROOT/app.prev"
[[ -d "$APP" ]] && mv "$APP" "$ROOT/app.prev"
mv "$WORK/new" "$APP"

systemctl --user restart "$SERVICE" || log 'restart reported failure; the health check decides'

# --- health check, and roll back if it fails -------------------------------------
#
# A 200 on / is necessary but nothing like sufficient: a bundle can serve its
# landing page while its stylesheets 404 (the page renders unstyled and no error
# is raised anywhere) or its API route is broken. Each probe below is a distinct
# failure that has either happened or been shown to be silent (round 10, F-10).

probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$APP_PORT$1" 2>/dev/null || echo 000; }

healthy=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  [[ "$(probe /)" == "200" ]] || continue

  # The landing page always links a stylesheet; serving the HTML without it is
  # the "worst kind of broken" the extract-time assertion also guards against.
  css="$(curl -s --max-time 5 "http://127.0.0.1:$APP_PORT/" 2>/dev/null | grep -oE '/_next/static/[^"]+\.css' | head -1 || true)"
  [[ -n "$css" && "$(probe "$css")" == "200" ]] || continue

  # A malformed address must come back 400 — that proves the API route exists and
  # validates, without spending a single upstream RPC or price call.
  [[ "$(probe '/api/portfolio?address=not-an-address')" == "400" ]] || continue

  healthy=true
  break
done

if [[ "$healthy" != true ]]; then
  log 'the new build did not pass its health checks; rolling back'
  # Every step here tolerates its own failure: `set -e` aborting a half-done
  # rollback would be strictly worse than finishing it best-effort.
  rm -rf "$ROOT/app.failed"
  [[ -d "$APP" ]] && mv "$APP" "$ROOT/app.failed" 2>/dev/null || true
  if [[ -d "$ROOT/app.prev" ]]; then
    mv "$ROOT/app.prev" "$APP" 2>/dev/null || true
    systemctl --user restart "$SERVICE" 2>/dev/null || true
    if [[ "$(probe /)" == "200" ]]; then
      log "rolled back; the failed bundle is kept at $ROOT/app.failed"
    else
      log 'rolled back but the previous build is not answering either — needs a human'
    fi
  else
    log 'nothing to roll back to — the service is down'
  fi
  printf '%s\n' "$PUBLISHED_SUM" > "$ROOT/.rejected-sha256"
  fail "build ${NEW_COMMIT:0:7} failed its health check; quarantined until a new build is published"
fi

printf '%s\n' "$PUBLISHED_SUM" > "$ROOT/.deployed-sha256"
log "live on ${NEW_COMMIT:0:7}"

# --- report back ------------------------------------------------------------------
#
# With this timer running, the weekly refresh's 30-day check stops being a nudge to
# deploy and becomes a liveness check for the timer itself: if this stops moving
# the tag, the refresh says so. Through the API because there is no checkout here.
if [[ "$NEW_COMMIT" != unknown ]]; then
  if report_deployed "$NEW_COMMIT"; then
    rm -f "$ROOT/.pending-tag"
    log 'moved the deployed tag'
  else
    printf '%s\n' "$NEW_COMMIT" > "$ROOT/.pending-tag"
    log 'could not move the deployed tag; will retry next run'
  fi
fi
