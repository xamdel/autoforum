#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

owner_handle="${1:-owner}"

command -v node >/dev/null 2>&1 || {
  echo "Node 22.19 or newer is required. Install Node, then run this installer again." >&2
  exit 1
}
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' || {
  echo "Node 22.19 or newer is required. Found $(node --version)." >&2
  exit 1
}
command -v podman >/dev/null 2>&1 || {
  echo "Podman is required. Install it, then run this installer again." >&2
  exit 1
}

platform=$(uname -s)
case "$platform" in
  Linux)
    if [ -z "${DOCKER_HOST:-}" ]; then
      runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      podman_socket="$runtime_dir/podman/podman.sock"

      if [ ! -S "$podman_socket" ] && command -v systemctl >/dev/null 2>&1; then
        echo "Starting the rootless Podman API socket..."
        systemctl --user enable --now podman.socket >/dev/null 2>&1 || true
      fi

      if [ ! -S "$podman_socket" ]; then
        echo "The rootless Podman API socket is not available at $podman_socket." >&2
        echo "Start it with 'systemctl --user enable --now podman.socket', or set DOCKER_HOST to another Podman socket, then run this installer again." >&2
        exit 1
      fi

      DOCKER_HOST="unix://$podman_socket"
      export DOCKER_HOST
    fi
    ;;
  Darwin)
    ;;
  *)
    echo "This installer supports Linux and macOS. On Windows, run install.ps1." >&2
    exit 1
    ;;
esac

echo "Installing Autoforum dependencies..."
npx --yes pnpm@12.5.1 install --frozen-lockfile

echo "Preparing Autoforum..."
npx --yes pnpm@12.5.1 run setup -- --managed "$owner_handle"
