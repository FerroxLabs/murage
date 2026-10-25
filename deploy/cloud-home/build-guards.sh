#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Guards and the seal helper that build-image.sh sources (kept in their own file so qualify/build-guards-test.sh can run them
# without a builder). Functions only; sourcing this file does nothing.

# Minimum builder RAM in MB for `tsc -b`: cx33 and cax21 (both 8 GB, about 7.7 GB visible) build; cx23 and cax11 (4 GB) are
# OOM-killed (measured 2026-10-25).
MURAGE_MIN_BUILD_RAM_MB=7400

# require_builder_ram RAM_MB: fail early and clearly, before any package is installed.
require_builder_ram() {
    local ram_mb=${1:?RAM in MB}
    [[ $ram_mb =~ ^[0-9]+$ && $ram_mb -ge $MURAGE_MIN_BUILD_RAM_MB ]] || {
        echo "build-image: only ${ram_mb} MB of RAM; the build needs at least ${MURAGE_MIN_BUILD_RAM_MB} MB. Use a build host cx33 (x86_64) or cax21 (arm64) builder or larger; cx23 and cax11 are OOM-killed by tsc." >&2
        return 1
    }
}

# require_fresh_builder RELEASES_DIR OPT_LINK: stage 1 is not re-runnable (its links and tree are created, not replaced). A releases
# directory holding anything, or an /opt/murage link, means an earlier run was aborted or finished; refuse at the start.
require_fresh_builder() {
    local releases=${1:?releases dir} link=${2:?opt link}
    if [[ -L $link || -e $link ]] || { [[ -d $releases ]] && [[ -n $(ls -A "$releases") ]]; }; then
        echo "build-image: fresh builder required: an earlier stage 1 run left $releases or $link on this host; stage 1 never reruns, start from a fresh server" >&2
        return 1
    fi
}

# seal_tree DIR...: FS_IMMUTABLE_FL on DIR and on every regular file and directory beneath it. Symlinks are skipped: chattr cannot
# read or set flags on a link (it fails with "Operation not supported" and ends the build under set -e), and the home's seal walk
# (murage-commands seal_walk_digest) takes a link by its target text, not by a flag.
seal_tree() {
    local dir
    for dir in "$@"; do
        find "$dir" ! -type l -exec chattr +i {} +
    done
}
