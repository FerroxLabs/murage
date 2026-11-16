#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SIGN: the one step of the Cloud home release that holds the Ed25519 release private key (LANE-G r3 sec. 2, Grok ruling d). It runs on
# the signing Mac (macOS bash 3.2, BSD tools, Homebrew OpenSSL 3) and needs nothing else: no Linux, no GNU tools, no python, no tree, no
# archive. The key NEVER leaves that machine and is never an argument of this script.
#
# Usage: MURAGE_RELEASE_SIGNING_KEY=/path/to/ed25519.pem [MURAGE_OPENSSL=/opt/homebrew/bin/openssl] [MURAGE_RELEASE_PUBLIC_KEY=pub.pem] \
#          cloud-home-sign.sh MANIFEST REVISION ARCH SEQUENCE
#   MANIFEST   the unsigned <arch>/manifest.json that `cloud-home-release.sh prepare` wrote on the builder (copied here)
#   REVISION   the full 40-hex commit the operator intends to release (typed here, not read from the manifest)
#   ARCH       x86_64 or aarch64
#   SEQUENCE   the release sequence the operator intends
#   MURAGE_RELEASE_SIGNING_KEY (environment)  path of the Ed25519 private key (PEM); the only way the key reaches this script. It is
#              handed to openssl as -inkey (a path, never the key's bytes) and nothing is ever written that contains it.
#   MURAGE_OPENSSL  an OpenSSL 3 binary (default `openssl`; macOS's /usr/bin/openssl is LibreSSL and cannot sign raw Ed25519)
#   MURAGE_RELEASE_PUBLIC_KEY (optional)  the public key the images bake in; when set, the key's own public half must be exactly it
# Output: MANIFEST.sig next to MANIFEST: the 64 raw Ed25519 signature bytes over exactly the bytes of MANIFEST
# (`openssl pkeyutl -sign -rawin`), which is what murage-commands verify_signature and build-image.sh stage 2 read.
# Before signing, the manifest must be byte for byte the canonical v3 line the producer prints, for exactly this revision, arch and
# sequence, with its archive named for that sequence. After signing, the signature is verified with the key's public half.
set -euo pipefail
umask 077
export LC_ALL=C

manifest=${1:?Usage: MURAGE_RELEASE_SIGNING_KEY=KEY cloud-home-sign.sh MANIFEST REVISION ARCH SEQUENCE}
revision=${2:?REVISION is required}
arch=${3:?ARCH is required}
sequence=${4:?SEQUENCE is required}
key=${MURAGE_RELEASE_SIGNING_KEY:?MURAGE_RELEASE_SIGNING_KEY (path of the Ed25519 private key) is required}
unset MURAGE_RELEASE_SIGNING_KEY
expected_public=${MURAGE_RELEASE_PUBLIC_KEY:-}
openssl_bin=${MURAGE_OPENSSL:-openssl}

[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'REVISION must be a full 40-hex commit'; exit 1; }
[[ $arch = x86_64 || $arch = aarch64 ]] || { echo "ARCH must be x86_64 or aarch64, not '$arch'"; exit 1; }
[[ $sequence =~ ^[1-9][0-9]{0,8}$ ]] || { echo 'SEQUENCE must be a positive integer'; exit 1; }
[[ -f $manifest && ! -L $manifest && -f $key ]] || { echo 'MANIFEST must be a regular file and the signing key a file'; exit 1; }
[[ $("$openssl_bin" version 2>/dev/null) =~ ^OpenSSL\ [3-9]\. ]] || { echo "MURAGE_OPENSSL must be OpenSSL 3 or newer (got: $("$openssl_bin" version 2>&1 | head -n 1))"; exit 1; }

# The manifest: the exact bytes, no trailing newline, in the producer's one canonical shape.
size=$(wc -c < "$manifest" | tr -d ' ')
[[ $size -ge 1 && $size -le 4096 ]] || { echo 'MANIFEST has an impossible size'; exit 1; }
raw=$(cat "$manifest")
[[ ${#raw} -eq $size ]] || { echo 'MANIFEST must be one line of plain bytes with no trailing newline'; exit 1; }
shape='^\{"format":"murage-cloud-home-release-v3","sequence":([1-9][0-9]{0,8}),"revision":"([0-9a-f]{40})","arch":"(x86_64|aarch64)","archive":"murage-cloud-home-([1-9][0-9]{0,8})\.tar\.gz","bytes":([1-9][0-9]{0,9}),"sha256":"([0-9a-f]{64})","treeSha256":"([0-9a-f]{64})","launcherAbi":"([A-Za-z0-9][A-Za-z0-9._-]{0,63})"\}$'
[[ $raw =~ $shape ]] || { echo 'MANIFEST is not a well-formed murage-cloud-home-release-v3 manifest'; exit 1; }
m_sequence=${BASH_REMATCH[1]} m_revision=${BASH_REMATCH[2]} m_arch=${BASH_REMATCH[3]} m_archive_sequence=${BASH_REMATCH[4]} m_bytes=${BASH_REMATCH[5]}
[[ $m_sequence = "$sequence" && $m_archive_sequence = "$sequence" ]] || { echo "MANIFEST sequence is not $sequence"; exit 1; }
[[ $m_revision = "$revision" ]] || { echo 'MANIFEST is for another revision'; exit 1; }
[[ $m_arch = "$arch" ]] || { echo 'MANIFEST is for another architecture'; exit 1; }
(( m_bytes <= 4294967296 )) || { echo 'MANIFEST archive size is out of bounds'; exit 1; }

"$openssl_bin" pkey -in "$key" -noout -text | grep '^ED25519 Private-Key' >/dev/null || { echo 'The signing key must be an Ed25519 private key'; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/murage-sign.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
"$openssl_bin" pkey -in "$key" -pubout -out "$work/public.pem"
if [[ -n $expected_public ]]; then
    [[ -f $expected_public ]] && cmp -s "$work/public.pem" <("$openssl_bin" pkey -pubin -in "$expected_public" -pubout) \
      || { echo 'The signing key is not the one whose public half MURAGE_RELEASE_PUBLIC_KEY names'; exit 1; }
fi

"$openssl_bin" pkeyutl -sign -inkey "$key" -rawin -in "$manifest" -out "$work/manifest.json.sig"
[[ $(wc -c < "$work/manifest.json.sig" | tr -d ' ') -eq 64 ]] || { echo 'Signature is not 64 raw Ed25519 bytes'; exit 1; }
# Verified exactly as the home verifies it (and over the bytes now on disk, which must still be the ones that were checked above).
[[ $(cat "$manifest") = "$raw" ]] || { echo 'MANIFEST changed while it was being signed'; exit 1; }
"$openssl_bin" pkeyutl -verify -pubin -inkey "$work/public.pem" -rawin -in "$manifest" -sigfile "$work/manifest.json.sig" 2>&1 | grep 'Signature Verified Successfully' >/dev/null \
  || { echo 'The new signature does not verify'; exit 1; }
cp "$work/manifest.json.sig" "$manifest.sig.tmp$$"
chmod 0644 "$manifest.sig.tmp$$"
mv -f "$manifest.sig.tmp$$" "$manifest.sig"
echo "Signed $manifest: release $sequence, $revision, $arch -> $manifest.sig (64 bytes, verified with the key's public half)"
