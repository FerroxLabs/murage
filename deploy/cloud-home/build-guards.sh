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

# wait_for_package_manager: a fresh build host builder is still running cloud-init and unattended-upgrades for a while after ssh comes
# up, and either one holds the dpkg frontend lock ("Unable to acquire the dpkg frontend lock" failed an x86 build on 2026-10-27).
# Wait for cloud-init, then for every package lock to be free, for at most MURAGE_PKG_WAIT_SECONDS (default 600) in total.
wait_for_package_manager() {
    local limit=${MURAGE_PKG_WAIT_SECONDS:-600} poll=${MURAGE_PKG_POLL_SECONDS:-5} started=$SECONDS rc=0
    local locks=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock)
    command -v fuser >/dev/null || { echo "build-image: fuser (psmisc) is missing, so the package locks cannot be checked" >&2; return 1; }
    if command -v cloud-init >/dev/null; then
        timeout "$limit" cloud-init status --wait >/dev/null 2>&1 || rc=$?
        # A cloud-init that finished with an error is not ours to judge; one that never finished is.
        if (( rc == 124 )); then echo "build-image: cloud-init did not finish within ${limit}s" >&2; return 1; fi
    fi
    while fuser "${locks[@]}" >/dev/null 2>&1; do
        if (( SECONDS - started >= limit )); then
            echo "build-image: the dpkg or apt lock is still held after ${limit}s (unattended-upgrades or cloud-init?); not starting apt" >&2
            return 1
        fi
        sleep "$poll"
    done
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

# assert_slot_readable DIR: the home runs as an unprivileged user that walks every directory and reads every file of the slot
# (assertImmutableCode in server/cloud-home/supervisor.ts), so refuse any directory without other r+x and any file without
# other r. A symlink must resolve (the supervisor calls realpathSync, which throws on a dangling link) to a path inside the
# slot (it refuses an escape). The whole scan must succeed: a find that fails is a refusal, never a pass. No path in a slot is
# private; image-disk-check.sh repeats this test on the finished disk.
assert_slot_readable() {
    local dir=${1:?slot dir} real tmp bad="" link target resolved
    real=$(realpath -e -- "$dir") || { echo "build-image: the release slot $dir cannot be resolved" >&2; return 1; }
    # The releases directory above the slot must be searchable too (root scans a 0700 directory without noticing).
    [[ -n $(find -P "$(dirname -- "$real")" -maxdepth 0 -perm -o=x) ]] || { echo "build-image: $(dirname -- "$real") is not searchable by the service user" >&2; return 1; }
    tmp=$(mktemp) || return 1
    if ! find -P "$dir" ! -type l \( \( -type d ! -perm -o=rx \) -o \( ! -type d ! -perm -o=r \) \) -print > "$tmp"; then
        rm -f "$tmp"; echo "build-image: the scan of the release slot failed; it cannot be judged" >&2; return 1
    fi
    bad=$(head -n 5 "$tmp")
    if ! find -P "$dir" -type l -print0 > "$tmp"; then
        rm -f "$tmp"; echo "build-image: the link scan of the release slot failed; it cannot be judged" >&2; return 1
    fi
    while IFS= read -r -d '' link; do
        resolved=$(realpath -e -- "$link" 2>/dev/null) || { bad="$bad"$'\n'"dangling link $link"; continue; }
        [[ $resolved == "$real"/* ]] || bad="$bad"$'\n'"link leaves the slot $link"
    done < "$tmp"
    rm -f "$tmp"
    if [[ -n $bad ]]; then
        echo "build-image: the release slot has paths the service user cannot read or links the supervisor refuses; fix at the source:" >&2
        echo "$bad" | head -n 5 >&2
        return 1
    fi
}
