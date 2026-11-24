#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

service=autoforum.service
health_url=http://127.0.0.1:3000/health

[ "$(id -u)" -ne 0 ] || { echo "Run this as the unprivileged Autoforum user, not root." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "The Autoforum checkout has uncommitted tracked changes. Commit or stash them before updating." >&2
  exit 1
fi

restart_on_exit=false
restart_after_failure() {
  status=$?
  trap - EXIT
  if [ "$restart_on_exit" = true ]; then
    echo "Update failed; attempting to start the Autoforum service again." >&2
    systemctl --user start "$service" || true
  fi
  exit "$status"
}
trap restart_after_failure EXIT

echo "Stopping Autoforum..."
systemctl --user stop "$service"
restart_on_exit=true

echo "Updating source..."
git pull --ff-only

echo "Installing locked dependencies..."
npx --yes pnpm@12.5.1 install --frozen-lockfile

echo "Building the web application..."
npm run build

echo "Building the sandbox image..."
npm run sandbox:build

echo "Starting Autoforum..."
systemctl --user start "$service"
restart_on_exit=false
trap - EXIT

echo "Waiting for Autoforum to become healthy..."
attempt=0
while [ "$attempt" -lt 60 ]; do
  if response=$(curl --fail --silent --show-error "$health_url" 2>/dev/null); then
    echo "$response"
    echo "Autoforum update complete."
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Autoforum did not become healthy at $health_url." >&2
echo "Recent service log:" >&2
journalctl --user --unit "$service" --lines 30 --no-pager >&2 || true
exit 1
