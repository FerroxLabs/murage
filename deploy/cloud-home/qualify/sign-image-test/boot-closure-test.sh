#!/bin/bash
# Tests for the boot closure judge in image-disk-check.sh against the REAL staging allowlist (the hashes read from image 447987145):
# the allowlist itself, as an observed listing, passes; each kind of drift from it is refused with the file named. No mounts needed.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/../../image-disk-check.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
no() { failed=$((failed + 1)); echo "  FAIL $1"; }
zeros() { printf '%064d' "$1"; }

# The staging pins as the script embeds them.
sed -n '/^closure_staging() {/,/^}/p' "$script" > "$T/fn.sh"
( source "$T/fn.sh"; closure_staging ) > "$T/real.txt"
OUT="" JRC=0
judge() { # judge ENV LISTING: run the judge only, over a saved listing
    OUT=$(MURAGE_DISKCHECK_JUDGE=$2 bash "$script" mount-image "$1" 2>&1); JRC=$?
}
expect_pass() { judge staging "$T/obs.txt"; if (( JRC == 0 )) && [[ $OUT == *"closure ok"* ]]; then ok "$1"; else no "$1: $OUT"; fi; }
refuse() { # refuse NAME PATTERN: the listing in obs.txt must be refused, naming PATTERN
    judge staging "$T/obs.txt"
    if (( JRC != 0 )) && [[ $OUT == *"$2"* ]]; then ok "$1: refused ($2)"; else no "$1: wanted '$2', got rc=$JRC '$OUT'"; fi
}

echo "boot closure judge, real staging allowlist"
for a in bios mbr efi grub gen gent; do
    if grep -q "^$a " "$T/real.txt"; then ok "the allowlist has $a entries"; else no "the allowlist has $a entries"; fi
done
if grep -qx 'efi f d1136fd2d32a930b69bcfaf974e970691488d050300e9df07349a5efeaf5851f EFI/BOOT/BOOTX64.EFI' "$T/real.txt" \
   && grep -qx 'bios f f78422c2c5780917b77f99e450875eea3e54b4104781bad005c9cd5786318608 sda14' "$T/real.txt"; then ok "BOOTX64.EFI and the sda14 core image are pinned by hash"; else no "loaders pinned by hash"; fi
if awk '{print $4}' "$T/real.txt" | grep -Eq '^/|(^|/)\.\.(/|$)|^$'; then no "pin paths are relative and plain"; else ok "pin paths are relative and plain"; fi
nmod=$(grep -c '^grub f [0-9a-f]\{64\} .*\.mod$' "$T/real.txt"); if (( nmod == 545 )); then ok "545 GRUB modules are pinned"; else no "545 GRUB modules are pinned (got $nmod)"; fi
if (( $(wc -l < "$T/real.txt") == 593 )); then ok "593 closure entries are pinned"; else no "593 closure entries ($(wc -l < "$T/real.txt"))"; fi
cp "$T/real.txt" "$T/obs.txt"; expect_pass "the real listing passes"
judge prod "$T/real.txt"
if (( JRC != 0 )) && [[ $OUT == *"no boot closure pin for prod"* ]]; then ok "prod refuses the same listing (its list is empty)"; else no "prod refuses: $OUT"; fi

gline=$(grep -m1 '^grub f' "$T/real.txt"); gpath=${gline##* }
{ cat "$T/real.txt"; echo "grub f $(zeros 7) x86_64-efi/evil.mod"; } > "$T/obs.txt";                  refuse "an extra GRUB module" "x86_64-efi/evil.mod (grub) is not in the boot closure allowlist"
sed "s#^grub f [0-9a-f]\{64\} $gpath\$#grub f $(zeros 9) $gpath#" "$T/real.txt" > "$T/obs.txt";         refuse "a GRUB file with another hash" "$gpath (grub) does not match its pinned hash"
grep -v " $gpath\$" "$T/real.txt" > "$T/obs.txt";                                                      refuse "a missing GRUB file" "$gpath (grub) is pinned in the boot closure but missing"
grep -v '^efi ' "$T/real.txt" > "$T/obs.txt";                                                          refuse "a missing EFI loader" "EFI/BOOT/BOOTX64.EFI (efi) is pinned in the boot closure but missing"
sed "s#^efi f [0-9a-f]\{64\}#efi f $(zeros 3)#" "$T/real.txt" > "$T/obs.txt";                          refuse "a replaced EFI loader" "EFI/BOOT/BOOTX64.EFI (efi) does not match its pinned hash"
grep -v '^bios ' "$T/real.txt" > "$T/obs.txt";                                                         refuse "a missing BIOS core image" "sda14 (bios) is pinned in the boot closure but missing"
sed "s#^bios f [0-9a-f]\{64\}#bios f $(zeros 5)#" "$T/real.txt" > "$T/obs.txt";                        refuse "a replaced BIOS core image" "sda14 (bios) does not match its pinned hash"
{ cat "$T/real.txt"; echo "gen f $(zeros 1) usr/lib/systemd/system-generators/evil"; } > "$T/obs.txt";    refuse "an extra generator" "system-generators/evil (gen) is not in the boot closure allowlist"
{ cat "$T/real.txt"; echo "gen l /tmp/evil etc/systemd/system-generators/evil"; } > "$T/obs.txt";        refuse "an extra generator link" "etc/systemd/system-generators/evil (gen) is not in the boot closure allowlist"
{ cat "$T/real.txt"; echo "grub l grub.cfg alias"; } > "$T/obs.txt";                                   refuse "a symlink in /boot/grub" "alias (grub) is not in the boot closure allowlist"
{ cat "$T/real.txt"; echo "grub x special-file fifo"; } > "$T/obs.txt";                                refuse "a special file in /boot/grub" "fifo (grub) is a special-file"
{ grep -v 'system-generators/systemd-fstab-generator$' "$T/real.txt"; echo "gen l /bin/sh usr/lib/systemd/system-generators/systemd-fstab-generator"; } > "$T/obs.txt"
refuse "a generator turned into a link" "systemd-fstab-generator (gen) does not match its pinned"
{ cat "$T/real.txt"; echo "efi f $(zeros 1) EFI/BOOT/fbx64.efi"; } > "$T/obs.txt";                    refuse "an extra ESP file" "EFI/BOOT/fbx64.efi (efi) is not in the boot closure allowlist"
sed "s#^mbr f [0-9a-f]\{64\}#mbr f $(zeros 4)#" "$T/real.txt" > "$T/obs.txt";                         refuse "a replaced MBR boot code" "sda0-439 (mbr) does not match its pinned hash"
grep -v '^mbr ' "$T/real.txt" > "$T/obs.txt";                                                          refuse "a missing MBR pin" "sda0-439 (mbr) is pinned in the boot closure but missing"
sed "s#^gent f [0-9a-f]\{64\}#gent f $(zeros 6)#" "$T/real.txt" > "$T/obs.txt";                      refuse "a changed generator link target file" "usr/libexec/netplan/generate (gent) does not match its pinned hash"
: > "$T/obs.txt";                                                                                      refuse "an empty listing" "is pinned in the boot closure but missing"
echo "boot-closure: $pass passed, $failed failed"
(( failed == 0 ))
