param([string]$OwnerHandle = "owner")

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node 22.19 or newer is required. Install Node, then run this script again."
}
if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
  throw "Podman Desktop is required. Install it, start its machine, then run this script again."
}
& node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
  throw "Node 22.19 or newer is required. Upgrade Node, then run this script again."
}

& npx --yes pnpm@12.5.1 install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --experimental-strip-types --env-file-if-exists=.env scripts/setup.ts --managed $OwnerHandle
exit $LASTEXITCODE
