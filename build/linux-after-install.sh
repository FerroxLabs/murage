#!/bin/sh
set -eu

# dpkg preserves an existing directory's mode during an in-place upgrade.
# OpenMausBot 0.1.7 installed the application ancestors as 0775, which makes
# the bundled Cua Driver correctly reject its own executable path. A configured
# DEB also needs Electron's Chromium sandbox to be root-owned and setuid. Repair
# only the exact package-owned paths; never weaken a runtime validator and never
# ask an end user to run chmod manually.
if [ -n "${MURAGE_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$MURAGE_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) APP_ROOT=$TEST_ROOT ;;
    *)
      echo "OpenMausBot test install root must stay under /tmp" >&2
      exit 1
      ;;
  esac
  EXPECTED_OWNER="$(id -un):$(id -gn)"
  TEST_MODE=1
else
  APP_ROOT=/opt/Murage
  EXPECTED_OWNER=root:root
  TEST_MODE=0
fi

repair_directory() {
  target=$1
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    echo "OpenMausBot package directory is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "OpenMausBot could not secure package directory: $target ($actual)" >&2
    exit 1
  fi
}

repair_executable() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "OpenMausBot package executable is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "OpenMausBot could not secure package executable: $target ($actual)" >&2
    exit 1
  fi
}

repair_chromium_sandbox() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "OpenMausBot Chromium sandbox is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 4755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:4755" ]; then
    echo "OpenMausBot could not secure Chromium sandbox: $target ($actual)" >&2
    exit 1
  fi
}

# Ubuntu 24.04 lets a program create user namespaces only under its own
# AppArmor profile. A restarted Murage (Back up now, returning from a backup)
# runs with no_new_privs, where the setuid sandbox cannot help, so without the
# profile it crashes and no window comes back. electron-builder ships the
# profile in resources/ and its default hook installs it; this hook replaces
# that default, so it installs the profile here the same way. An AppArmor that
# cannot parse the profile (older than 4.0) needs none: the package still
# installs without it.
install_apparmor_profile() {
  source=$APP_ROOT/resources/apparmor-profile
  if [ "$TEST_MODE" -eq 1 ]; then
    directory=$APP_ROOT/apparmor.d
    parser=$APP_ROOT/apparmor_parser
    if [ ! -d "$directory" ] || [ ! -x "$parser" ]; then return 0; fi
  else
    directory=/etc/apparmor.d
    parser=apparmor_parser
    if ! apparmor_status --enabled > /dev/null 2>&1; then return 0; fi
    if ! command -v "$parser" > /dev/null 2>&1 || [ ! -d "$directory" ]; then return 0; fi
  fi
  if [ -L "$source" ] || [ ! -f "$source" ]; then
    echo "Murage AppArmor profile is missing; restarting Murage may not work on this system" >&2
    return 0
  fi
  if ! "$parser" --skip-kernel-load --debug "$source" > /dev/null 2>&1; then
    echo "Skipping the Murage AppArmor profile: this AppArmor does not support it"
    return 0
  fi
  target=$directory/murage
  # Never write through a link someone left in the profile directory.
  if [ -L "$target" ]; then rm -f -- "$target"; fi
  cp -f -- "$source" "$target"
  chmod 0644 -- "$target"
  # Loading into the running kernel means nothing inside a chroot.
  if [ "$TEST_MODE" -eq 0 ] && [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then return 0; fi
  if ! "$parser" --replace --write-cache --skip-read-cache "$target" > /dev/null 2>&1; then
    echo "Murage could not load its AppArmor profile now; it loads at the next restart" >&2
  fi
}

CUA_ROOT=$APP_ROOT/resources/cua-linux-x64
repair_directory "$APP_ROOT"
repair_directory "$APP_ROOT/resources"
repair_directory "$CUA_ROOT"
repair_executable "$CUA_ROOT/cua-driver"
repair_executable "$CUA_ROOT/cua-cursor-theme"
repair_chromium_sandbox "$APP_ROOT/chrome-sandbox"
install_apparmor_profile
