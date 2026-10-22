abi <abi/4.0>,
include <tunables/global>

# Ubuntu 23.10 and later let a program create unprivileged user namespaces
# only under an AppArmor profile that allows it. Both Murage and the Chrome
# its bot browser runs need them for Chromium's sandbox. Like the profiles
# Ubuntu ships for Chrome and Electron apps, these allow everything else and
# only name the program. electron-builder copies this file to
# resources/apparmor-profile; build/linux-after-install.sh installs it as
# /etc/apparmor.d/murage and its default after-remove unloads and deletes it.

profile murage /opt/Murage/murage flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/murage>
}

profile murage-browser /opt/Murage/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/murage-browser>
}
