#!/bin/bash
# Tests for image-release-check.sh against fake image roots. Run as a normal user (permission tests need it).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/../../image-release-check.sh
tmp=$(mktemp -d)
trap 'chmod -R u+rwx "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
no() { failed=$((failed + 1)); echo "  FAIL $1"; }

h() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }
chan_url() { echo "https://chan-$1.example/cloud-home"; }
chan_json() { printf '{"channelUrl": "%s", "minimumSequence": 7, "imageRevision": "%s", "launcherAbi": "murage-launchers-1"}' "$1" "0123456789abcdef0123456789abcdef01234567"; }
# a copy of the script whose pins are the fixtures' values (the real file ships the staging pins and empty prod pins)
pinned=$tmp/check.sh
sed -e "s|^CONTROL_KEY_SHA256_staging=\"[^\"]*\"|CONTROL_KEY_SHA256_staging=\"$(h ctl-staging)\"|" \
    -e "s|^CONTROL_KEY_SHA256_prod=\"[^\"]*\"|CONTROL_KEY_SHA256_prod=\"$(h ctl-prod)\"|" \
    -e "s|^RELEASE_KEY_SHA256_staging=\"[^\"]*\"|RELEASE_KEY_SHA256_staging=\"$(h rel-staging)\"|" \
    -e "s|^RELEASE_KEY_SHA256_prod=\"[^\"]*\"|RELEASE_KEY_SHA256_prod=\"$(h rel-prod)\"|" \
    -e "s|^RELEASE_CHANNEL_URL_staging=\"[^\"]*\"|RELEASE_CHANNEL_URL_staging=\"$(chan_url staging)\"|" \
    -e "s|^RELEASE_CHANNEL_URL_prod=\"[^\"]*\"|RELEASE_CHANNEL_URL_prod=\"$(chan_url prod)\"|" "$script" > "$pinned"
[[ $(grep -c '_SHA256_\(staging\|prod\)="[0-9a-f]\{64\}"' "$pinned") == 4 && $(grep -c '^RELEASE_CHANNEL_URL_\(staging\|prod\)="https://chan-' "$pinned") == 2 ]] || { echo "pin substitution failed"; exit 1; }

mkroot() { # mkroot NAME ENV
    local r=$tmp/$1
    mkdir -p "$r/var/lib/dpkg" "$r/etc/murage-home" "$r/usr/lib/murage-home/trust" "$r/usr/lib/systemd/system"
    printf 'Package: bash\nStatus: install ok installed\n\nPackage: curl\nStatus: install ok installed\n' > "$r/var/lib/dpkg/status"
    printf '%s' "ctl-$2" > "$r/etc/murage-home/control-plane-public-key.json"
    printf '%s' "rel-$2" > "$r/usr/lib/murage-home/trust/release-public-key.pem"
    chan_json "$(chan_url "$2")" > "$r/usr/lib/murage-home/trust/release.json"
    echo "$r"
}
expect_ok() { # name root env [script]
    local out rc=0
    out=$(bash "${4:-$pinned}" "$2" 4242 "$3" 2>&1) || rc=$?
    if (( rc == 0 )) && [[ $(echo "$out" | tail -n 1) == "image-release-check: ok image=4242 env=$3 "* ]]; then ok "$1"; else no "$1: $out"; fi
}
expect_fail() { # name root env pattern [script]
    local out rc=0
    out=$(bash "${5:-$pinned}" "$2" 4242 "$3" 2>&1) || rc=$?
    if (( rc != 0 )) && [[ $out == *"$4"* ]] && [[ $out != *"image-release-check: ok"* ]]; then ok "$1"; else no "$1 (rc=$rc): $out"; fi
}

echo "image-release-check.sh"
r=$(mkroot clean prod);                                   expect_ok "clean prod root passes" "$r" prod
r=$(mkroot cleanstg staging);                             expect_ok "clean staging root passes" "$r" staging
expect_fail "staging pins refuse a prod root" "$r" prod "does not match the prod pin"
r=$(mkroot c prod);                                       expect_fail "ENV argument missing" "$r" "" "ENV must be staging or prod"
expect_fail "ENV argument invalid" "$r" production "ENV must be staging or prod"
r=$(mkroot unpinned prod);                                expect_fail "empty prod pins refuse (real script)" "$r" prod "no pin for" "$script"
r=$(mkroot realstg staging);                              expect_fail "the real staging pins refuse a fixture root" "$r" staging "does not match the staging pin" "$script"
r=$(mkroot ssh1 prod); printf '\nPackage: openssh-server\nStatus: install ok installed\n' >> "$r/var/lib/dpkg/status"
expect_fail "openssh-server installed" "$r" prod "openssh-server package is present"
r=$(mkroot ssh2 prod); printf '\nPackage: openssh-server\nStatus: deinstall ok config-files\n' >> "$r/var/lib/dpkg/status"
expect_fail "openssh-server removed but configured" "$r" prod "openssh-server package is present"
r=$(mkroot ssh3 prod); printf '\nPackage: openssh-server\nStatus: install ok installed\nVersion: 1:9.6p1\n\nPackage: zlib\nStatus: install ok installed\n' >> "$r/var/lib/dpkg/status"
expect_fail "openssh-server mid-file with later fields" "$r" prod "openssh-server package is present"
r=$(mkroot ssh4 prod); printf '\nPackage: openssh-server-extra\nStatus: install ok installed\n' >> "$r/var/lib/dpkg/status"
expect_ok "a package whose name only starts with openssh-server is not the daemon" "$r" prod
r=$(mkroot sshd prod); mkdir -p "$r/usr/sbin"; touch "$r/usr/sbin/sshd"
expect_fail "sshd binary" "$r" prod "usr/sbin/sshd exists"
r=$(mkroot hk prod); mkdir -p "$r/etc/ssh"; touch "$r/etc/ssh/ssh_host_ed25519_key"
expect_fail "ssh host key" "$r" prod "ssh host key exists"
r=$(mkroot hksub prod); mkdir -p "$r/etc/ssh/keys/deep"; touch "$r/etc/ssh/keys/deep/ssh_host_rsa_key"
expect_fail "ssh host key in a subdirectory" "$r" prod "ssh host key exists"
r=$(mkroot sshdirlink prod); mkdir -p "$r/var/hidden"; touch "$r/var/hidden/ssh_host_ed25519_key"; ln -s ../var/hidden "$r/etc/ssh"
expect_fail "symlinked /etc/ssh" "$r" prod "/etc/ssh is a symlink"
r=$(mkroot sshdirlinkout prod); mkdir -p "$tmp/elsewhere"; ln -s "$tmp/elsewhere" "$r/etc/ssh"
expect_fail "/etc/ssh symlinked out of the root" "$r" prod "/etc/ssh is a symlink"
r=$(mkroot sysdlink prod); rm -r "$r/usr/lib/systemd"; mkdir -p "$r/var/units"; touch "$r/var/units/ssh.service"; ln -s ../../var/units "$r/usr/lib/systemd"
expect_fail "symlinked usr/lib/systemd" "$r" prod "/usr/lib/systemd is a symlink"
r=$(mkroot sysdsyslink prod); mkdir -p "$r/var/units"; touch "$r/var/units/ssh.service"; rm -r "$r/usr/lib/systemd/system"; ln -s ../../../var/units "$r/usr/lib/systemd/system"
expect_fail "symlinked usr/lib/systemd/system" "$r" prod "/usr/lib/systemd/system is a symlink"
r=$(mkroot etcsysdlink prod); mkdir -p "$r/var/units"; touch "$r/var/units/sshd.service"; ln -s ../var/units "$r/etc/systemd"
expect_fail "symlinked etc/systemd" "$r" prod "/etc/systemd is a symlink"
r=$(mkroot libsysdlink prod); ln -s usr/lib "$r/lib"
expect_ok "a usr-merged /lib symlink is not refused" "$r" prod
r=$(mkroot wantslink prod); mkdir -p "$r/var/hidden"; touch "$r/var/hidden/ssh.service"; ln -s ../../../../var/hidden "$r/usr/lib/systemd/system/multi-user.target.wants"
expect_fail "a directory symlink inside the systemd tree" "$r" prod "directory symlink under /usr/lib/systemd"
r=$(mkroot sshsublink prod); mkdir -p "$r/etc/ssh" "$r/var/hidden"; touch "$r/var/hidden/ssh_host_rsa_key"; ln -s ../../var/hidden "$r/etc/ssh/keys"
expect_fail "a directory symlink inside /etc/ssh" "$r" prod "directory symlink under /etc/ssh"
r=$(mkroot filelink prod); mkdir -p "$r/etc/systemd/system"; ln -s /dev/null "$r/etc/systemd/system/foo.service"
expect_ok "a file symlink inside the systemd tree is fine" "$r" prod
r=$(mkroot abswants prod); mkdir -p "$r/var/hidden"; touch "$r/var/hidden/ssh.service"; ln -s /var/hidden "$r/usr/lib/systemd/system/multi-user.target.wants"
expect_fail "an absolute directory symlink is judged inside the image, not on this host" "$r" prod "directory symlink under /usr/lib/systemd"
r=$(mkroot absssh prod); mkdir -p "$r/etc/ssh" "$r/var/hidden"; touch "$r/var/hidden/ssh_host_rsa_key"; ln -s /var/hidden "$r/etc/ssh/keys"
expect_fail "an absolute directory symlink under /etc/ssh" "$r" prod "directory symlink under /etc/ssh"
r=$(mkroot masklink prod); mkdir -p "$r/etc/systemd/system"; ln -s /dev/null "$r/etc/systemd/system/foo.service"
expect_ok "a /dev/null mask is not a directory link" "$r" prod
r=$(mkroot locallib prod); mkdir -p "$r/usr/local/lib/systemd/system"; touch "$r/usr/local/lib/systemd/system/ssh.service"
expect_fail "ssh unit under usr/local/lib/systemd" "$r" prod "ssh daemon unit present under /usr/local/lib/systemd"
r=$(mkroot locallink prod); mkdir -p "$r/usr/local/lib" "$r/var/units"; touch "$r/var/units/ssh.service"; ln -s /var/units "$r/usr/local/lib/systemd"
expect_fail "symlinked usr/local/lib/systemd" "$r" prod "/usr/local/lib/systemd is a symlink"
r=$(mkroot unitsub prod); mkdir -p "$r/usr/lib/systemd/system/multi-user.target.wants"; touch "$r/usr/lib/systemd/system/multi-user.target.wants/ssh.service"
expect_fail "ssh unit in a nested directory" "$r" prod "ssh daemon unit present"
r=$(mkroot unit prod); touch "$r/usr/lib/systemd/system/ssh.service"
expect_fail "ssh unit" "$r" prod "ssh daemon unit present"
r=$(mkroot rootssh prod); mkdir -p "$r/root/.ssh"
expect_fail "root/.ssh" "$r" prod "root/.ssh exists"
r=$(mkroot marker prod); touch "$r/etc/murage-image-kind"
expect_fail "staging marker file" "$r" prod "marker /etc/murage-image-kind is present"
r=$(mkroot markerlink prod); ln -s /etc/hostname "$r/etc/murage-image-kind"
expect_fail "marker symlink to an absolute path" "$r" prod "etc/murage-image-kind"
r=$(mkroot sshlink prod); mkdir -p "$tmp/outside"; ln -s "$tmp/outside" "$r/root/.ssh" 2>/dev/null || { mkdir -p "$r/root"; ln -s "$tmp/outside" "$r/root/.ssh"; }
expect_fail "root/.ssh symlink out of the root" "$r" prod "root/.ssh"
r=$(mkroot sshdlink prod); mkdir -p "$r/usr/sbin"; ln -s ../../../../../../bin/true "$r/usr/sbin/sshd"
expect_fail "sshd climbing symlink" "$r" prod "sshd"
r=$(mkroot nodpkg prod); rm "$r/var/lib/dpkg/status"
expect_fail "no dpkg status" "$r" prod "no dpkg status"
r=$(mkroot dpkgdir prod); rm "$r/var/lib/dpkg/status"; mkdir "$r/var/lib/dpkg/status"
expect_fail "dpkg status that is a directory is refused" "$r" prod "no dpkg status"
r=$(mkroot ctl prod); printf 'other' > "$r/etc/murage-home/control-plane-public-key.json"
expect_fail "control key differs from pin" "$r" prod "control-plane-public-key.json does not match"
r=$(mkroot rel prod); rm "$r/usr/lib/murage-home/trust/release-public-key.pem"
expect_fail "release key missing" "$r" prod "release-public-key.pem is missing"
r=$(mkroot chan prod); rm "$r/usr/lib/murage-home/trust/release.json"; ln -s /etc/hostname "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file is a symlink" "$r" prod "release channel file"
r=$(mkroot chanurl prod); chan_json "https://other.example/cloud-home" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel names another URL" "$r" prod "does not name the prod channel"
r=$(mkroot chanextra prod); printf '{"channelUrl": "%s", "minimumSequence": 7, "imageRevision": "0123456789abcdef0123456789abcdef01234567", "launcherAbi": "murage-launchers-1", "extra": 1}' "$(chan_url prod)" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with an extra field" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot chanrev prod); printf '{"channelUrl": "%s", "minimumSequence": 7, "imageRevision": "abc", "launcherAbi": "murage-launchers-1"}' "$(chan_url prod)" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with a short revision" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot chanseq prod); printf '{"channelUrl": "%s", "minimumSequence": 0, "imageRevision": "0123456789abcdef0123456789abcdef01234567", "launcherAbi": "murage-launchers-1"}' "$(chan_url prod)" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with sequence 0" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot chanbig prod); { chan_json "$(chan_url prod)"; head -c 5000 /dev/zero | tr '\0' ' '; } > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file over 4096 bytes" "$r" prod "larger than the home's reader accepts"
r=$(mkroot channl prod); { chan_json "$(chan_url prod)"; printf '\n'; } > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with a trailing newline" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot channul prod); { chan_json "$(chan_url prod)"; printf '\0'; } > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with a trailing NUL" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot chanabi prod); printf '{"channelUrl": "%s", "minimumSequence": 7, "imageRevision": "0123456789abcdef0123456789abcdef01234567", "launcherAbi": "."}' "$(chan_url prod)" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with launcherAbi '.'" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot chanabilong prod); printf '{"channelUrl": "%s", "minimumSequence": 7, "imageRevision": "0123456789abcdef0123456789abcdef01234567", "launcherAbi": "a%s"}' "$(chan_url prod)" "$(printf 'b%.0s' {1..64})" > "$r/usr/lib/murage-home/trust/release.json"
expect_fail "release channel file with a 65-character launcherAbi" "$r" prod "is not the file build-image.sh writes"
r=$(mkroot oldlayout prod); mv "$r/usr/lib/murage-home/trust/release.json" "$r/etc/murage-home/release.json"
expect_fail "release.json only under /etc is not the trust root" "$r" prod "release channel file is missing"
r=$(mkroot decoy prod); printf '%s' "hostile-key" > "$r/etc/murage-home/release-public-key.pem"; chan_json "https://evil.example/cloud-home" > "$r/etc/murage-home/release.json"
expect_fail "a valid trust root plus a hostile /etc pair is refused" "$r" prod "etc/murage-home/release-public-key.pem is present"
expect_fail "the hostile /etc release.json is named too" "$r" prod "etc/murage-home/release.json is present"
r=$(mkroot perm prod); mkdir -p "$r/etc/systemd/system/sub"; touch "$r/etc/systemd/system/sub/x"; chmod 000 "$r/etc/systemd/system/sub"
if [[ $(id -u) == 0 ]]; then echo "  skip unreadable directory (running as root)"; else expect_fail "unreadable directory is a failure, not a pass" "$r" prod "errored"; fi

echo "image-release-check: $pass passed, $failed failed"
(( failed == 0 ))
