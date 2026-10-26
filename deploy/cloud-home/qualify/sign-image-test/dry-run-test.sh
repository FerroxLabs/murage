#!/bin/bash
# Dry-run tests for sign-image.sh: mocked curl/aws/ssh/ssh-keygen/console-type on PATH, no network, no real service.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dir=$here/../..
sign=$dir/sign-image.sh
mocks=$here/mocks
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
no() { failed=$((failed + 1)); echo "  FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

export HOME=$T/home; mkdir -p "$HOME"
FAKE_TOKEN="FAKE-PROVIDER-TOKEN-9f3a1c"
printf '%s' "$FAKE_TOKEN" > "$T/token"; chmod 600 "$T/token"
export MURAGE_HZ_TOKEN_FILE=$T/token
printf '%s' "FAKE-PROD-TOKEN-1b7d" > "$T/token-prod"; chmod 600 "$T/token-prod"
printf '%s' "FAKE-STAGING-TOKEN-5e2a" > "$T/token-staging"; chmod 600 "$T/token-staging"
CFG=$T/provider.env
write_cfg() { # write_cfg: the neutral provider config the signer reads from outside the repo
    printf 'API_URL=https://api.provider.test/v1\nCONSOLE_HOST=console.provider.test\nTOKEN_FILE_PRODUCTION=%s\nTOKEN_FILE_STAGING=%s\n' "$T/token-prod" "$T/token-staging" > "$CFG"
    chmod 600 "$CFG"
}
write_cfg
export MURAGE_SIGNER_CONFIG=$CFG
mkdir -p "$HOME/.config/murage"
VENV=$HOME/.config/murage/verifier.env
printf 'AWS_ACCESS_KEY_ID=FAKE-AWS-KEY-ID-7c2e\nAWS_SECRET_ACCESS_KEY=FAKE-AWS-SECRET-4d81\nAWS_REGION_FROM_FILE=from-file\n' > "$VENV"; chmod 600 "$VENV"
export MURAGE_SIGN_EVIDENCE=$T/evidence
export MURAGE_NOW=20261022T080000Z
export MURAGE_DRYRUN_BIN=$mocks
export MOCK_LOG=$T/calls.log MOCK_STATE=$T/state
export MOCK_KEY_PEM=$T/key.pem MOCK_IMAGE_JSON=$T/image.json MOCK_IMAGE_JSON_CHANGED=$T/image2.json MOCK_TYPES_JSON=$T/types.json

node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto"; import { writeFileSync } from "node:fs";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
writeFileSync(process.env.MOCK_KEY_PEM, privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(process.env.MOCK_KEY_PEM + ".spki", publicKey.export({ type: "spki", format: "der" }).toString("base64"));
const im = (size) => JSON.stringify({ image: { id: 123456789, type: "snapshot", status: "available", deleted: null, description: "mcq-home-abcdef012345", created: "2026-10-22T07:40:28+00:00", image_size: size, disk_size: 40, architecture: "x86", labels: { "murage/role": "image", "murage/env": "prod" } } });
writeFileSync(process.env.MOCK_IMAGE_JSON, im(2.04)); writeFileSync(process.env.MOCK_IMAGE_JSON_CHANGED, im(2.05));
writeFileSync(process.env.MOCK_TYPES_JSON, JSON.stringify({ server_types: [{ name: "cx23", architecture: "x86", disk: 40, deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.005" } }] }] }));
'
MURAGE_DRYRUN_SPKI_B64=$(cat "$MOCK_KEY_PEM.spki"); export MURAGE_DRYRUN_SPKI_B64

fresh() { rm -rf "$MOCK_STATE" "$MOCK_LOG" "$MURAGE_SIGN_EVIDENCE"; mkdir -p "$MOCK_STATE"; : > "$MOCK_LOG"; }
runsign() { OUT=$T/out.txt; "$sign" "$@" > "$OUT" 2>&1; RC=$?; }
seq_ok() { # every pattern appears in the log, in this order
    local pos=0 p line
    for p in "$@"; do
        line=$(awk -v s="$pos" -v pat="$p" 'NR>s && index($0, pat) { print NR; exit }' "$MOCK_LOG")
        [[ -n $line ]] || { echo "    missing in order: $p (after line $pos)"; return 1; }
        pos=$line
    done
}

echo "sign-image.sh --dry-run"
echo " success path"
fresh; runsign --dry-run 123456789 prod
assert "exit 0" "[[ $RC == 0 ]]"
if [[ $RC != 0 ]]; then sed 's/^/    | /' "$OUT" | head -30; fi
seq_ok "curl GET /images/123456789" "ssh-keygen" "curl GET /server_types" "curl POST /servers" "curl POST /servers/4242/actions/enable_rescue" \
    "curl POST /servers/4242/actions/poweron" "curl POST /servers/4242/actions/request_console" "console-type" "ssh true" "ssh bash -s -- mount-image" "ssh bash -s -- /mnt/img 123456789 prod" \
    "curl GET /images/123456789" "aws --region eu-west-1 kms sign --key-id alias/murage-image-verify" "curl DELETE /servers/4242" "curl GET /servers?label_selector=purpose" \
    ; if (( $? == 0 )); then ok "call sequence"; else no "call sequence"; fi
assert "credentials reached the aws child only" "[[ -e $MOCK_STATE/aws.sawkey && ! -e $MOCK_STATE/leak ]]"
assert "no AWS secret in output, log or console command" "! grep -rq 'FAKE-AWS' $OUT $MOCK_LOG $MOCK_STATE/typed.cmd"
assert "no profile used" "! grep -q -- '--profile' $MOCK_LOG"
assert "second image read happens before signing" "[[ \$(grep -n 'GET /images/' \"$MOCK_LOG\" | cut -d: -f1 | tr '\n' ' ') != '' && \$(grep -c 'curl GET /images/' \"$MOCK_LOG\") == 2 ]]"
assert "server deleted by exact id" "[[ -e $MOCK_STATE/deleted ]] && grep -q 'curl DELETE /servers/4242' $MOCK_LOG"
assert "no stray servers reported" "grep -q 'no stray verify servers' $OUT"
assert "disk check script was piped and passed" "cmp -s $dir/image-disk-check.sh $MOCK_STATE/disk.stdin && grep -q 'image-disk-check: ok' $OUT"
assert "check script was piped" "cmp -s $dir/image-release-check.sh $MOCK_STATE/check.stdin"
assert "console command carries both keys, no token" "[[ -s $MOCK_STATE/typed.cmd ]] && ! grep -q '$FAKE_TOKEN' $MOCK_STATE/typed.cmd"
ENTRY=$MURAGE_SIGN_EVIDENCE/123456789/imagekind-123456789.json
assert "entry file written" "[[ -s $ENTRY ]]"
assert "entry printed" "grep -q '^\"123456789\": {\"kind\":\"customer\"' $OUT"
assert "'signed image' line" "grep -q '^signed image 123456789 -> ' $OUT"
node --input-type=module -e '
import { readFileSync } from "node:fs"; import { createPublicKey, verify, createHash } from "node:crypto";
const dir = process.argv[1]; const W = await import(dir + "/image-sig.mjs");
const e = JSON.parse(readFileSync(process.argv[2], "utf8")); const payload = readFileSync(process.argv[3]);
const check = createHash("sha256").update(readFileSync(dir + "/image-release-check.sh")).digest("hex");
const expected = W.buildPayload({ imageId: "123456789", createdAt: "2026-10-22T07:40:28+00:00", imageSize: "2.04", env: "prod", checkSha256: check, verdict: "pass", verifiedAt: "20261022T080000Z" });
const fail = (m) => { console.error(m); process.exit(1); };
if (payload.toString() !== expected) fail("signed bytes differ from the Worker payload");
if (!W.parseCustomerEntry(e).ok) fail("entry rejected by the Worker parser");
if (e.checkSha256 !== check || e.env !== "prod" || e.verifiedAt !== "20261022T080000Z") fail("entry fields");
const pub = createPublicKey({ key: Buffer.from(process.env.MURAGE_DRYRUN_SPKI_B64, "base64"), format: "der", type: "spki" });
if (!verify("sha256", payload, { key: pub, dsaEncoding: "ieee-p1363" }, W.decodeStoredSig(e.sig))) fail("signature does not verify");
' "$dir" "$ENTRY" "$MOCK_STATE/signed.payload" ; if (( $? == 0 )); then ok "signed bytes equal the Worker's payload; entry parses and verifies"; else no "signed bytes / entry check"; fi
assert "token never printed or stored" "! grep -rq '$FAKE_TOKEN' $OUT $MOCK_LOG $MURAGE_SIGN_EVIDENCE"
assert "workspace removed" "! ls -d \${TMPDIR:-/tmp}/sign-image.* >/dev/null 2>&1"

echo " failed check: server still deleted, nothing signed"
fresh; MOCK_CHECK_FAIL=1 runsign --dry-run 123456789 prod
assert "exit non-zero" "[[ $RC != 0 ]]"
assert "DELETE issued by exact id" "[[ -e $MOCK_STATE/deleted ]] && grep -q 'curl DELETE /servers/4242' $MOCK_LOG"
assert "no kms sign call" "! grep -q 'kms sign' $MOCK_LOG"
assert "no entry written" "[[ ! -e $ENTRY ]]"
assert "stray list ran after delete" "seq_ok 'curl DELETE /servers/4242' 'curl GET /servers?label_selector=purpose'"

echo " image changed between reads: nothing signed, server deleted"
fresh; MOCK_IMAGE_CHANGE=1 runsign --dry-run 123456789 prod
assert "exit non-zero" "[[ $RC != 0 ]]"
assert "refusal says the image changed" "grep -q 'image changed' $OUT"
assert "no kms sign call, server deleted" "! grep -q 'kms sign' $MOCK_LOG && [[ -e $MOCK_STATE/deleted ]]"

echo " lost create answer: found by run label and deleted by id"
fresh; MOCK_LOST_CREATE_ANSWER=1 runsign --dry-run 123456789 prod
assert "exit non-zero" "[[ $RC != 0 ]]"
assert "label search then DELETE" "seq_ok 'curl POST /servers' 'curl GET /servers?label_selector=murage%2Fverify-run' 'curl DELETE /servers/4242'"
assert "server deleted" "[[ -e $MOCK_STATE/deleted ]]"

echo " interrupted: TERM still deletes"
fresh
(
  set -m
  MOCK_HANG_SSH=1 "$sign" --dry-run 123456789 prod > "$T/out.txt" 2>&1 &
  pid=$!
  for _ in $(seq 1 100); do grep -q 'ssh true' "$MOCK_LOG" 2>/dev/null && break; sleep 0.1; done
  kill -TERM -- "-$pid" 2>/dev/null
  wait "$pid"; echo $? > "$T/term.rc"
)
assert "exit 143" "[[ \$(cat $T/term.rc) == 143 ]]"
assert "server deleted after TERM" "[[ -e $MOCK_STATE/deleted ]] && grep -q 'curl DELETE /servers/4242' $MOCK_LOG"
assert "no kms sign call" "! grep -q 'kms sign' $MOCK_LOG"

echo " disk layout: refused before the check, nothing signed (server still deleted)"
disk_refused() { # disk_refused SCENARIO PATTERN
    fresh; MOCK_DISK=$1 runsign --dry-run 123456789 prod
    assert "$1: refused ($2)" "[[ $RC != 0 ]] && grep -q -- '$2' $OUT && ! grep -q 'bash -s -- /mnt/img' $MOCK_LOG && ! grep -q 'kms sign' $MOCK_LOG && [[ ! -e $MURAGE_SIGN_EVIDENCE/123456789 && -e $MOCK_STATE/deleted ]]"
    grep -q -- "$2" "$OUT" || grep -a -m3 'image-disk-check' "$OUT" | sed 's/^/    | /'
}
disk_ok() { # disk_ok SCENARIO
    fresh; MOCK_DISK=$1 runsign --dry-run 123456789 prod
    assert "$1: the layout is accepted and signed" "[[ $RC == 0 ]] && grep -q 'image-disk-check: ok' $OUT && grep -q 'kms sign' $MOCK_LOG"
}
disk_ok good_label
disk_ok real_x86_cfg
disk_refused hwmatch_other 'hwmatch other than'
disk_refused hwmatch_extra_arg 'hwmatch other than'
echo " arm64 (the rescue server's uname -m names the loader and the closure list)"
export MOCK_ARCH=aarch64
disk_ok good
disk_ok real_arm64_cfg
disk_refused esp_x64_on_arm 'unexpected files on the ESP'
export MOCK_ARCH=riscv64
disk_refused good 'unsupported architecture'
unset MOCK_ARCH
disk_refused needs_recovery 'needs_recovery'
disk_refused not_clean 'not cleanly unmounted'
disk_refused second_root 'more than one root'
disk_refused extra_partition 'unexpected partition'
disk_refused extra_xfs 'unexpected partition'
disk_refused second_esp 'more than one EFI'
disk_refused second_disk 'unexpected disk'
disk_refused good_boot 'unexpected partition'
disk_refused boot_needs_recovery 'unexpected partition'
disk_refused grub_uuid_mismatch 'not the checked filesystem'
disk_refused second_entry_mismatch 'not the checked filesystem'
disk_refused custom_cfg_mismatch 'forbidden kernel argument\|not the checked filesystem'
disk_refused esp_grub_mismatch 'unexpected files on the ESP'
disk_refused esp_extra_file 'unexpected files on the ESP'
disk_refused esp_wrong_prefix 'other than /boot/grub on the checked root'
disk_refused mbr_changed 'sda0-439 (mbr) does not match its pinned hash'
disk_refused esp_evil_path 'other than /boot/grub on the checked root'
disk_refused esp_nul_tail 'other than /boot/grub on the checked root'
disk_refused esp_no_prefix 'does not match its pinned hash'
disk_refused bios_evil_path 'other than /boot/grub on the checked root'
disk_refused sym_in_grub 'a symlink under'
disk_refused grubenv_prefix 'grubenv sets a variable'
disk_refused grub_dir_link 'missing or a symlink'
disk_refused nested_dir_link 'a symlink under'
disk_refused set_quoted_cfgdir 'not a literal name=value'
disk_refused set_var_name 'not a literal name=value'
disk_refused unset_prefix 'command not allowed'
disk_refused load_env_arg 'load_env with arguments'
disk_refused search_file 'search option not allowed'
disk_refused init_override 'forbidden kernel argument .init='
disk_refused search_mismatch 'search line does not name'
disk_refused chainload 'chainloader'
disk_refused quoted_init 'quoting or expansion'
disk_refused escaped_init 'quoting or expansion'
disk_refused var_init 'quoting or expansion'
disk_refused semicolon_chain 'chainloader'
disk_refused brace_chain 'chainloader'
disk_refused source_other 'source of something other'
disk_refused var_command 'quoting or expansion'
disk_refused other_disk_kernel 'another device'
disk_refused set_prefix 'moves where GRUB reads'
disk_refused bad_arg_break "forbidden kernel argument .break="
disk_refused bad_arg_run "forbidden kernel argument .systemd.run="
disk_refused initrd_second 'another device'
disk_refused initrd_var 'quoting or expansion'
disk_refused kernel_missing 'not a plain file'
disk_refused kernel_on_esp 'not a plain file'
disk_refused legacy_cfg 'command not allowed'
disk_refused insmod_path 'insmod of a path'
disk_refused function_override 'redefines the command'
disk_refused search_set_prefix 'search option not allowed'
disk_refused bios_other_part 'other than /boot/grub on the checked root'
disk_refused set_root_other 'another disk'
disk_refused assign_root_other 'another disk'
echo " boot closure allowlist: GRUB modules, EFI and BIOS loaders, systemd generators"
disk_refused extra_module 'x86_64-efi/evil.mod (grub) is not in the boot closure allowlist'
disk_refused extra_lst 'x86_64-efi/command.lst (grub) is not in the boot closure allowlist'
disk_refused extra_grub_dotfile '.hidden (grub) is not in the boot closure allowlist'
disk_refused wrong_hash_module 'x86_64-efi/normal.mod (grub) does not match its pinned hash'
disk_refused missing_module 'x86_64-efi/ext2.mod (grub) is pinned in the boot closure but missing'
disk_refused missing_loader 'unexpected files on the ESP'
disk_refused no_bios 'sda14 (bios) is pinned in the boot closure but missing'
disk_refused extra_generator 'evil-generator (gen) is not in the boot closure allowlist'
disk_refused extra_etc_generator 'etc/systemd/system-generators/zz (gen) is not in the boot closure allowlist'
disk_refused run_generator 'run/systemd/system-generators/evil (gen) is not in the boot closure allowlist'
disk_refused lib_not_link 'lib/systemd/system-generators/evil (gen) is not in the boot closure allowlist'
disk_refused wrong_hash_generator 'systemd-fstab-generator (gen) does not match its pinned hash'
disk_refused wrong_link_target_file 'usr/libexec/netplan/generate (gent) does not match its pinned hash'
disk_refused generator_link_changed 'netplan (gen) does not match its pinned link target'
disk_refused generator_link_newline 'an unusual link target at usr/lib/systemd/system-generators/netplan'
disk_refused lib_link_newline 'through a symlink'
disk_refused generator_link_outside 'points at a missing file'
disk_refused generator_dir_link 'through a symlink'
disk_refused esp_evil_path 'other than /boot/grub on the checked root'
echo " prod has no boot closure pins: the real script refuses every prod image"
MOCK_NO_CLOSURE=1 disk_refused good 'no boot closure pin for prod'
disk_ok good_custom
disk_ok ubuntu_stock
disk_refused grub_symlink 'a symlink under'
cp -r "$dir" "$T/copy3"; rm "$T/copy3/image-disk-check.sh"; fresh; OUT=$T/out.txt; "$T/copy3/sign-image.sh" --dry-run 123456789 prod > "$OUT" 2>&1; RC=$?
assert "missing disk check script refused" "[[ $RC != 0 ]] && grep -q 'image-disk-check.sh is missing' $OUT && ! grep -q 'kms sign' $MOCK_LOG"

echo " refusals before any server exists"
fresh; runsign --dry-run 12x45 prod;           assert "bad image id" "[[ $RC != 0 ]] && [[ ! -s $MOCK_LOG ]]"
fresh; runsign --dry-run 123456789 production; assert "bad env" "[[ $RC != 0 ]] && [[ ! -s $MOCK_LOG ]]"
fresh; chmod 644 "$T/token"; runsign --dry-run 123456789 prod; chmod 600 "$T/token"
assert "token file with loose mode" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'mode 600' $OUT"
fresh; MURAGE_HZ_TOKEN_FILE=$T/nope runsign --dry-run 123456789 prod; assert "missing token file" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG"
fresh; MURAGE_DRYRUN_BIN="" runsign --dry-run 123456789 prod; assert "--dry-run without mocks refuses" "[[ $RC != 0 ]] && grep -q 'MURAGE_DRYRUN_BIN' $OUT"
cp -r "$dir" "$T/copy"; echo '# edited' >> "$T/copy/image-release-check.sh"
fresh; OUT=$T/out.txt; "$T/copy/sign-image.sh" --dry-run 123456789 prod > "$OUT" 2>&1; RC=$?
assert "modified check script refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'not the reviewed one' $OUT"
cp -r "$dir" "$T/copy4"; echo '# edited' >> "$T/copy4/image-disk-check.sh"
fresh; "$T/copy4/sign-image.sh" --dry-run 123456789 prod > "$OUT" 2>&1; RC=$?
assert "modified disk check script refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'image-disk-check.sh is not the reviewed one' $OUT"
cp -r "$dir" "$T/copy2"; echo '// edited' >> "$T/copy2/image-sig.mjs"
fresh; "$T/copy2/sign-image.sh" --dry-run 123456789 prod > "$OUT" 2>&1; RC=$?
assert "modified Worker module copy refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'pinned copy' $OUT"
fresh; MURAGE_VERIFIER_AWS_PROFILE=other runsign --dry-run 123456789 prod; assert "unknown AWS profile refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG"
fresh; chmod 644 "$VENV"; runsign --dry-run 123456789 prod; chmod 600 "$VENV"
assert "verifier file with loose mode refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'must be mode 600' $OUT && ! grep -q 'FAKE-AWS' $OUT"
fresh; mv "$VENV" "$VENV.gone"; runsign --dry-run 123456789 prod; mv "$VENV.gone" "$VENV"
assert "missing verifier file refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'credentials file not found' $OUT"
echo " profile override"
fresh; MURAGE_VERIFIER_AWS_PROFILE=murage-image-verifier runsign --dry-run 123456789 prod
assert "profile override signs" "[[ $RC == 0 ]] && grep -q 'aws --profile murage-image-verifier --region eu-west-1 kms sign' $MOCK_LOG && grep -q 'aws configure list-profiles' $MOCK_LOG"

echo " static"
assert "script never reads key files or cats secrets" "! grep -nE '\\.pem|cat .*(key|token|verifier)' $sign | grep -v '^[0-9]*:#' | grep -q ."
assert "verifier env is sourced once, indented inside the subshell, and aws is exec'd" "[[ \$(grep -c '^        { \\. ' $sign) == 1 ]] && grep -q 'exec aws --region' $sign"
assert "no xtrace" "! grep -nE '^\\s*set -[a-z]*x|set -o xtrace' $sign | grep -q ."
assert "token file comes from the provider config, no provider path in the script" "grep -q 'TOKEN_FILE=\$TOKEN_FILE_PRODUCTION' $sign && ! grep -q '/.config/murage-prod' $sign"
echo " provider config"
fresh; (unset MURAGE_HZ_TOKEN_FILE; runsign --dry-run 123456789 prod; echo "$RC" > "$T/rc"); RC=$(cat "$T/rc")
assert "prod run takes its token file from the config" "[[ $RC == 0 ]] && grep -q 'curl' $MOCK_LOG"
fresh; (unset MURAGE_HZ_TOKEN_FILE; mv "$T/token-prod" "$T/token-prod.moved"; runsign --dry-run 123456789 prod; echo "$RC" > "$T/rc"; mv "$T/token-prod.moved" "$T/token-prod"); RC=$(cat "$T/rc")
assert "the config's prod token path is the one checked" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'token file not found: $T/token-prod' $OUT"
fresh; (unset MURAGE_HZ_TOKEN_FILE; mv "$T/token-staging" "$T/token-staging.moved"; runsign --dry-run 123456789 staging; echo "$RC" > "$T/rc"; mv "$T/token-staging.moved" "$T/token-staging"); RC=$(cat "$T/rc")
assert "the config's staging token path is the one checked" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'token file not found: $T/token-staging' $OUT"
fresh; MURAGE_SIGNER_CONFIG=$T/absent.env runsign --dry-run 123456789 prod
assert "missing provider config refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'provider config not found' $OUT"
write_cfg; chmod 664 "$CFG"; fresh; runsign --dry-run 123456789 prod; write_cfg
assert "group-writable provider config refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'writable' $OUT"
for k in API_URL CONSOLE_HOST TOKEN_FILE_PRODUCTION TOKEN_FILE_STAGING; do
    grep -v "^$k=" "$CFG" > "$T/cfg.part"; cp "$T/cfg.part" "$CFG"; chmod 600 "$CFG"
    fresh; runsign --dry-run 123456789 prod
    assert "provider config missing $k refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'missing key $k' $OUT"
    write_cfg
done
bad_cfg() { # bad_cfg NAME 'extra or replaced line' PATTERN
    write_cfg; printf '%b\n' "$2" >> "$CFG"; fresh; runsign --dry-run 123456789 prod
    assert "$1" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q '$3' $OUT"; write_cfg
}
bad_cfg "unknown config key refused" 'EXTRA=1' 'unknown key'
bad_cfg "repeated config key refused" 'API_URL=https://other.provider.test/v1' 'repeats key'
bad_cfg "config line that is not KEY=VALUE refused" 'echo pwned' 'not KEY=VALUE'
sed -i.bak 's#^API_URL=.*#API_URL=http://api.provider.test/v1#' "$CFG"; fresh; runsign --dry-run 123456789 prod; write_cfg
assert "plain http API_URL refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'API_URL must be an https' $OUT"
sed -i.bak 's#^CONSOLE_HOST=.*#CONSOLE_HOST=wss://console.provider.test/x#' "$CFG"; fresh; runsign --dry-run 123456789 prod; write_cfg
assert "CONSOLE_HOST that is not a bare hostname refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'bare hostname' $OUT"
sed -i.bak 's#^TOKEN_FILE_STAGING=.*#TOKEN_FILE_STAGING=relative/../x#' "$CFG"; fresh; runsign --dry-run 123456789 prod; write_cfg
assert "relative token path refused" "[[ $RC != 0 ]] && ! grep -q 'curl' $MOCK_LOG && grep -q 'absolute path' $OUT"
sed -i.bak 's#^API_URL=.*#API_URL=https://api.provider.test/v1$(touch '"$T"'/pwned)#' "$CFG"; fresh; runsign --dry-run 123456789 prod; write_cfg
assert "command substitution in a config value is refused, not run" "[[ $RC != 0 ]] && [[ ! -e $T/pwned ]]"

echo "dry-run: $pass passed, $failed failed"
(( failed == 0 ))
