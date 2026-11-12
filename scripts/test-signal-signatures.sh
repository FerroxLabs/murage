#!/usr/bin/env bash
# Only public pinned tooling, and a throwaway local certificate. No credentials.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/scripts/safe-wipe.sh"
work=$(mktemp -d)
trap 'safe_wipe "${work:?}"' EXIT
node "$root/scripts/fetch-build-input.mjs" D062 "$work/rcodesign.tar.gz"
printf '%s  %s\n' dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 "$work/rcodesign.tar.gz" | sha256sum -c -
tar -xzf "$work/rcodesign.tar.gz" -C "$work"
node "$root/scripts/fetch-build-input.mjs" D063 "$work/osslsigncode.deb"
printf '%s  %s\n' f3e32b717f34f074cd3ae3ed93cc3c9edbc09d8ef8eb2b897fd0437bdd2f9cf2 "$work/osslsigncode.deb" | sha256sum -c -
dpkg-deb -x "$work/osslsigncode.deb" "$work/ossl"
python3 "$root/scripts/signal-signing-fixtures.py" "$work/fixtures"
rcodesign=$(find "$work" -type f -name rcodesign)
"$rcodesign" sign --team-name SYNTHETIC1 "$work/fixtures/original.macho" "$work/fixtures/signed.macho"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 1 -subj '/CN=Murage synthetic signature test' > "$work/cert.log" 2>&1
"$work/ossl/usr/bin/osslsigncode" sign -certs "$work/cert.pem" -key "$work/key.pem" -in "$work/fixtures/original.exe" -out "$work/fixtures/signed.exe"
SIGNAL_SIGNING_FIXTURES="$work/fixtures" pnpm exec vitest run --config "$root/scripts/signal-s3.test-config.mjs" scripts/signal-runtime.test.mjs -t "T-NORMALIZER|T-INTEGRITY-RESIGNED|I18 exact|T-JDEPS-SUBSET|T-INVENTORY-RESIGNED"
# The certificate/key and all downloaded tools are deleted with the temp dir.
