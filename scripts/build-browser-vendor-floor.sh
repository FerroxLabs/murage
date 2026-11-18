#!/usr/bin/env bash
# Builds one (set, target) of the browser vendor engine inside the glibc 2.28 floor image (AlmaLinux 8,
# LINUX_FLOOR_IMAGE in scripts/linux-floor.mjs), so the linux-x64 bytes never link a newer glibc symbol than
# the Linux package floor (GLIBC_FLOOR) allows. The CI host supplies the pinned node, pnpm and
# Rust toolchain as read-only mounts; only the C toolchain comes from the image. Then the result is gated with
# scripts/check-linux-glibc-floor.mjs.
#   bash scripts/build-browser-vendor-floor.sh SET TARGET ABSOLUTE_NEW_OUTPUT_DIRECTORY ABSOLUTE_RUST_TOOLCHAIN_DIRECTORY
# Needs node (24+), pnpm and docker on the PATH of the caller.
set -euo pipefail
set_="${1:?set}"; target="${2:?target}"; output="${3:?output}"; rust="${4:?rust toolchain}"
case "$output$rust" in /*/*/*) ;; *) echo "paths must be absolute"; exit 2;; esac
[ "$target" = linux-x64 ] || { echo "the floor build is for linux-x64 only"; exit 2; }
[ ! -e "$output" ] || { echo "output must be a new directory"; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
image="$(node --input-type=module -e 'import("./scripts/linux-floor.mjs").then(m=>process.stdout.write(m.LINUX_FLOOR_IMAGE))')"
node_prefix="$(dirname "$(dirname "$(command -v node)")")"
mkdir -p "$output"
docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$repo,target=/repo,readonly" \
  --mount "type=bind,source=$node_prefix,target=/toolchain/node,readonly" \
  --mount "type=bind,source=$rust,target=/toolchain/rust,readonly" \
  --mount "type=bind,source=$output,target=/out" \
  --env "BUILD_UID=$(id -u)" --env "BUILD_GID=$(id -g)" --env "SET=$set_" --env "TARGET=$target" \
  "$image" /bin/bash -euo pipefail -c '
    trap "chown -R $BUILD_UID:$BUILD_GID /out" EXIT
    dnf -y --setopt=install_weak_deps=False install gcc make git tar gzip xz perl-interpreter perl-IPC-Cmd >/dev/null
    export PATH=/toolchain/node/bin:/toolchain/rust/toolchain/bin:$PATH RUSTUP_TOOLCHAIN=/toolchain/rust/toolchain
    export HOME=/tmp/home TMPDIR=/tmp; mkdir -p "$HOME"
    cd /repo
    node scripts/build-browser-vendor.mjs --set "$SET" --target "$TARGET" --output /out/asset
    mv /out/asset/* /out/ && rmdir /out/asset
  '
node "$repo/scripts/check-linux-glibc-floor.mjs" "$output"/agent-browser-"$target"-*[0-9]
