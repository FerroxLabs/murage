#!/bin/bash
# Run only in an authorized Ubuntu image builder. Does not provision a VM.
# Base: Ubuntu 24.04 LTS amd64 or arm64 (aarch64, build host CAX), Ubuntu serial 20260926.
# One script builds either architecture; every download is pinned per architecture below.
set -euo pipefail
# Never let a python helper write __pycache__ into the source checkout (it dirties it and the stage 2 clean-checkout test refuses).
export PYTHONDONTWRITEBYTECODE=1
# Two-stage build (LANE-G r3 sec. 2, Grok ruling d, conditions 4 and 5). The manifest can only be signed from the finished tree, so
# the build is split at the signed-slot block and each stage is explicit; there is no default and no one-pass mode:
#   MURAGE_IMAGE_STAGE=tree  everything up to the signed-slot block (the pnpm build runs here, once); leaves the final tree
#                            unsealed in /opt/murage-releases/A and writes the stage 1 marker, then stops.
#   MURAGE_IMAGE_STAGE=seal  only the signed-slot block and what follows (verify the manifest and signature, check treeSha256, install
#                            the trust root, seal, enable units). Refuses without the marker of a stage 1 on this host at this revision.
image_stage=${MURAGE_IMAGE_STAGE:-}
case $image_stage in
  tree|seal) ;;
  *) echo 'MURAGE_IMAGE_STAGE must be "tree" (build the tree) or "seal" (install the signed manifest and seal); there is no one-pass build'; exit 1 ;;
esac
stage_marker=/var/lib/murage-image-build/stage1.json
machine=$(uname -m)
[[ $(id -u) = 0 && ( $machine = x86_64 || $machine = aarch64 ) ]] || { echo 'An x86_64 or aarch64 root image builder is required'; exit 1; }
# Per-architecture names: node/caddy/cloudflared/docker/Claude/Codex/Grok/Kimi/OpenCode release names, the
# browser staging target and Chrome for Testing's directory name.
case $machine in
  x86_64)  node_arch=x64 caddy_arch=amd64 cloudflared_arch=amd64 docker_arch=x86_64 claude_platform=linux-x64 codex_triple=x86_64-unknown-linux-musl grok_platform=linux-x86_64 agy_dir=linux-x64 agy_file=cli_linux_x64.tar.gz kimi_target=linux-x64 opencode_package=opencode-linux-x64-baseline browser_target=linux-x64 chrome_dir=chrome-headless-shell-linux64 ;;
  aarch64) node_arch=arm64 caddy_arch=arm64 cloudflared_arch=arm64 docker_arch=aarch64 claude_platform=linux-arm64 codex_triple=aarch64-unknown-linux-musl grok_platform=linux-aarch64 agy_dir=linux-arm agy_file=cli_linux_arm64.tar.gz kimi_target=linux-arm64 opencode_package=opencode-linux-arm64 browser_target=linux-arm64 chrome_dir=chrome-headless-shell-linux-arm64 ;;
esac
# SHA-256 pins per architecture. Each equals the vendor's own published checksum
# (nodejs.org SHASUMS256.txt, Caddy checksums.txt [sha512 there], GitHub release asset
# digests, Anthropic's signed manifest.json, Kimi Code's release manifest.json, the npm
# registry integrity for OpenCode) except Docker and Grok, which publish none: Docker's
# pins are hashes of download.docker.com over TLS, and Grok's are hashes of x.ai/cli over
# TLS that equal the md5 Google Cloud Storage publishes for the same object.
declare -A node_sha256=([x86_64]=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 [aarch64]=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2)
declare -A caddy_sha256=([x86_64]=527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9 [aarch64]=52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904)
declare -A cloudflared_sha256_by_arch=([x86_64]=fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2 [aarch64]=7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790)
declare -A docker_sha256_by_arch=([x86_64]=4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640 [aarch64]=e6b53725a73763ab3f988c73f8772eaed429754c1a579db5ff11f21990fd1817)
declare -A claude_sha256_by_arch=([x86_64]=a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3 [aarch64]=24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0)
declare -A codex_sha256_by_arch=([x86_64]=86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057 [aarch64]=bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1)
declare -A grok_sha256_by_arch=([x86_64]=1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11 [aarch64]=fc32410b6883c15a39b9f33ec04a6bfb7d070b383e5dbad7efbc48c787e5050d)
# Antigravity CLI 1.4.4: the vendor publishes SHA-512 (not SHA-256) in its auto-updater manifests,
# https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json,
# the ones antigravity.google/cli/install.sh reads. The pin is that published digest.
declare -A agy_sha512_by_arch=([x86_64]=7ce149d350344c1046c7b59b6659bcc5d659f351bf3a07c6c085887d93427ceb89d927752e4ccd0844b53ffb91d33d6a49f72835ceb276c7cffdd13cfb8023b8 [aarch64]=7bfc4f7e5e2dda4cd0c536c72cf9725c2918a038028ad11fa4f7f5e57db77e9ff7d6b9beca05cd85618b77dd3e77de64b63629d33e5779f29111390dc53c7aaf)
declare -A kimi_sha256_by_arch=([x86_64]=8ee7405d82958f0a50a3aab0773aba9e01057978bad93ba379eaf89e5b6111af [aarch64]=db89c9999efcd5cce0ddd87d8857c41028a50b9fa3c1297d31559b1557c14e85)
declare -A opencode_sha256_by_arch=([x86_64]=6bdf946045ebfa5773811d0037c1ca8c8a3831880434289b9e4a40c2f1fe8432 [aarch64]=8481102c5d475013302d2f4766cea02b7390e76e74c146408a8cebe2b7f6778f)
source /etc/os-release
[[ $ID = ubuntu && $VERSION_ID = 24.04 ]] || { echo 'Ubuntu 24.04 LTS is required'; exit 1; }
# The reviewed lane commit is an explicit immutable build input, never a branch.
revision=${1:?Usage: build-image.sh FULL_MURAGE_COMMIT SOURCE_CHECKOUT}
source_dir=${2:?Source checkout is required}
# Optional Cloud packaging requires an independently supplied public trust key.
# Without this input the root transport remains unconfigured and admission closed.
control_public_key=${3:-}
if [[ -n $control_public_key ]]; then
    [[ $control_public_key = /* ]] || { echo 'Public trust input must be an absolute file path'; exit 1; }
    python3 -I -B - "$control_public_key" <<'PY'
import base64, json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    key = json.load(stream)
assert isinstance(key, dict) and key.get("kty") == "EC" and key.get("crv") == "P-256"
assert set(key) <= {"kty", "crv", "x", "y", "kid", "use", "alg", "key_ops", "ext"} and "d" not in key
for name in ("x", "y"):
    value = key[name]
    assert isinstance(value, str) and len(value) == 43
    decoded = base64.urlsafe_b64decode(value + "=")
    assert len(decoded) == 32 and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == value
PY
fi
[[ $revision =~ ^[a-f0-9]{40}$ && $(git -C "$source_dir" rev-parse HEAD) = "$revision" ]] || exit 1
[[ -z $(git -C "$source_dir" status --porcelain) ]] || { echo 'Source checkout must be clean'; exit 1; }
source "$source_dir/deploy/cloud-home/build-guards.sh"
if [[ $image_stage = tree ]]; then
[[ ! -e $stage_marker ]] || { echo 'Stage 1 already completed on this host (marker exists); stage 1 never reruns'; exit 1; }
# An aborted earlier run leaves slot A and the links behind and the next `ln -s` dies with "File exists": refuse here instead.
require_fresh_builder /opt/murage-releases /opt/murage
build_ram_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
require_builder_ram "$build_ram_mb"
export DEBIAN_FRONTEND=noninteractive
# snapshot.ubuntu.com answers intermittent 5xx during outages (2026-10-14). Retry each
# fetch with backoff instead of failing the build; the pins are unchanged. Build-only:
# the file is removed below before the snapshot is taken.
printf 'Acquire::Retries "30";\nAcquire::Retries::Delay::Maximum "20";\n' > /etc/apt/apt.conf.d/99murage-build-retries
# A failed snapshot fetch only warns and exits 0, so any W:/E: line fails the build.
# Provider images point apt at their own mirrors (mirror.hetzner.com), which
# apt snapshots cannot pin; use the official archive so -S resolves.
install -d -m 0755 /etc/apt/murage-provider-sources
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ -f $f ]] && mv "$f" /etc/apt/murage-provider-sources/
done
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
if [[ $machine = aarch64 ]]; then
# arm64 is not on archive.ubuntu.com (ports.ubuntu.com serves it, and is NOT snapshotted), and
# `apt -S` also fetches the plain archive index, which 404s for arm64. snapshot.ubuntu.com/ubuntu
# carries the arm64 indexes, so the same pinned timestamp is written into the sources and the
# `-S <ts>` option is dropped (the calls below stay identical on both architectures).
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/20260930T000000Z/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
apt-get() {
    local args=()
    while (( $# )); do
        if [[ $1 = -S ]]; then shift 2; else args+=("$1"); shift; fi
    done
    command apt-get "${args[@]}"
}
fi
apt_update_log=$(apt-get -S 20260930T000000Z update 2>&1) || { printf '%s\n' "$apt_update_log"; echo 'apt-get update failed'; exit 1; }
printf '%s\n' "$apt_update_log"
# grep reads all input (no -q): under pipefail an early exit SIGPIPEs the writer,
# which would turn this refusal into a silent pass.
if printf '%s\n' "$apt_update_log" | grep -E '^[WE]:' >/dev/null; then echo 'apt-get update reported W:/E: lines; refusing to build from unpinned lists'; exit 1; fi
apt-get -S 20260930T000000Z install -y ca-certificates curl xz-utils unzip python3 sudo bubblewrap passt libseccomp-dev apparmor apparmor-utils nftables build-essential git libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libdrm2 libcups2 libxkbcommon0 libxfixes3
apt-get -S 20260930T000000Z install -y cryptsetup e2fsprogs util-linux
# ssh client for the owner's own server (docker -H ssh://...); client only, no daemon.
apt-get -S 20260930T000000Z install -y openssh-client
apt-get -S 20260930T000000Z install -y restic
# Self-service export (murage-commands): zstd + age.
apt-get -S 20260930T000000Z install -y zstd age
# Every package at the pinned snapshot, including the kernel and openssl
# (audit: the image carried 160+ fixed High CVEs from the unupgraded base).
# snapd is not used by a home and carried its own fixed Criticals: removed.
apt-get -S 20260930T000000Z -o Dpkg::Options::=--force-confold full-upgrade -y
apt-get purge -y --auto-remove snapd
# No sshd on a customer image (purged by finalize-customer-image.sh, last): nobody at Ferrox or the provider logs in over ssh.
# The base image ships openssh-server; only openssh-client stays (above). Staging reaches a home through the tunnel, not ssh.
# The ONE exception is STAGING_OPS_SSH=1: a staging-only image keeps sshd for operator login and carries the visible marker
# /etc/murage-image-kind = staging-ops-ssh. The control plane refuses that image for any non-staging home, and
# image-release-check.sh fails a release image that has sshd or the marker. A staging home with sshd is never a customer home.
if [[ ${STAGING_OPS_SSH:-} = 1 ]]; then
image_kind=staging-ops-ssh
printf 'staging-ops-ssh\n' > /etc/murage-image-kind
else
image_kind=customer
rm -f /etc/murage-image-kind
# openssh-server is still installed here ON PURPOSE: hz-live ssh's into this builder after this script for its cleanup and
# checks. For a customer image the purge is finalize-customer-image.sh, the last command of the last ssh session.
fi
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd
if ! dpkg-query -W -f='${Status}' iproute2 2>/dev/null | grep 'install ok installed' >/dev/null; then
    apt-get -S 20260930T000000Z install -y iproute2
fi
iproute_version=$(dpkg-query -W -f='${Version}' iproute2)
dpkg --compare-versions "$iproute_version" ge 6.1.0
dpkg -L iproute2 | grep -E '^/(usr/)?s?bin/ip$' >/dev/null
stage=$(mktemp -d /tmp/murage-image.XXXXXXXX)
trap '[[ $stage == /tmp/murage-image.* ]] && rm -r -- "$stage"' EXIT
curl -fsSL "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-$node_arch.tar.xz" -o "$stage/node.tar.xz"
printf '%s  %s\n' "${node_sha256[$machine]}" "$stage/node.tar.xz" | sha256sum -c -
tar -xJf "$stage/node.tar.xz" -C /usr/local --strip-components=1
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_$caddy_arch.tar.gz" -o "$stage/caddy.tar.gz"
printf '%s  %s\n' "${caddy_sha256[$machine]}" "$stage/caddy.tar.gz" | sha256sum -c -
tar -xzf "$stage/caddy.tar.gz" -C "$stage" caddy
install -o root -g root -m 0755 "$stage/caddy" /usr/local/bin/caddy
install -d /usr/local/share/licenses/caddy
curl -fsSL https://raw.githubusercontent.com/caddyserver/caddy/v2.11.4/LICENSE -o /usr/local/share/licenses/caddy/LICENSE
# cloudflared 2026.8.2: the SAME version and digest the desktop app pins in
# scripts/prepare-cloudflared.mjs and third_party/cloudflared/README.md (Linux x64
# release asset, which is the executable itself). A mismatch is fatal (set -e).
# The home dials out with it; no inbound port is ever opened.
cloudflared_version=2026.8.2
cloudflared_sha256=${cloudflared_sha256_by_arch[$machine]}
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$cloudflared_version/cloudflared-linux-$cloudflared_arch" -o "$stage/cloudflared"
printf '%s  %s\n' "$cloudflared_sha256" "$stage/cloudflared" | sha256sum -c -
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$stage/cloudflared" /usr/local/libexec/murage-cloudflared
# Docker CLI 27.5.1 (static client only; the daemon and runc/containerd are not
# installed). The home drives a container on the owner's own server with it
# over ssh. Pinned digest; a mismatch is fatal (set -e).
docker_version=27.5.1
docker_sha256=${docker_sha256_by_arch[$machine]}
curl -fsSL "https://download.docker.com/linux/static/stable/$docker_arch/docker-$docker_version.tgz" -o "$stage/docker.tgz"
printf '%s  %s\n' "$docker_sha256" "$stage/docker.tgz" | sha256sum -c -
tar -xzf "$stage/docker.tgz" -C "$stage" docker/docker
install -o root -g root -m 0755 "$stage/docker/docker" /usr/local/bin/docker
install -d /usr/local/share/licenses/cloudflared
curl -fsSL "https://raw.githubusercontent.com/cloudflare/cloudflared/$cloudflared_version/LICENSE" -o /usr/local/share/licenses/cloudflared/LICENSE
getent passwd murage >/dev/null || useradd --system --create-home --home-dir /data/server-home --shell /usr/sbin/nologin murage
getent passwd murage-turn >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-turn
getent passwd murage-browser >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-browser
getent passwd murage-proxy >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-proxy
getent passwd murage-egress >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-egress
getent passwd murage-dns >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-dns
getent passwd murage-tunnel >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-tunnel
usermod -aG murage-turn murage
# Only turns may execute /usr/bin/bwrap (not murage, murage-proxy, murage-browser).
getent group murage-sandbox >/dev/null || groupadd --system murage-sandbox
usermod -aG murage-sandbox murage-turn
# Browsers get their own bwrap copy and AppArmor pair (browser-bwrap.apparmor):
# Chromium's sandbox needs capabilities inside its own user namespace, which
# Ubuntu's unpriv_bwrap denies. Only murage-browser may execute the copy.
getent group murage-browser-sandbox >/dev/null || groupadd --system murage-browser-sandbox
usermod -aG murage-browser-sandbox murage-browser
dpkg-statoverride --list /usr/bin/bwrap >/dev/null || dpkg-statoverride --update --add root murage-sandbox 0750 /usr/bin/bwrap
chown root:murage-sandbox /usr/bin/bwrap; chmod 0750 /usr/bin/bwrap
install -D -o root -g murage-browser-sandbox -m 0750 /usr/bin/bwrap /usr/local/libexec/murage-browser-bwrap
# One system group per cloud engine (names mirror CLOUD_ENGINES / ENGINES). No
# service user is a member; murage-turn-launch adds exactly one inside a turn.
engines=(claudeAgent codex pi antigravity grokAgent geminiAgent kimiAgent droidAgent cursorAgent customAcp fuigoAgent hermesAgent opencodeGo qwenAgent)
engine_gids=
for engine in "${engines[@]}"; do
  getent group "murage-eng-$engine" >/dev/null || groupadd --system "murage-eng-$engine"
  engine_gids+="${engine_gids:+,}\"$engine\":$(getent group "murage-eng-$engine" | cut -d: -f3)"
done
# Two release slots and one atomic link (LANE-G r2 sec. 2, r3): the image's release is slot A; `current` is the only link
# update_software ever moves; /opt/murage resolves through it so every path in the tree stays valid.
install -d -o root -g root -m 0755 /opt/murage-releases /opt/murage-releases/A /etc/murage-home /usr/local/libexec
ln -s A /opt/murage-releases/current
ln -s murage-releases/current /opt/murage
# Copy the exact commit, including its lockfile and third-party notices.
git -C "$source_dir" archive "$revision" | tar -x -C /opt/murage-releases/A
# The archive drops every export-ignore path in .gitattributes (maintainer notes,
# agent records, the mobile app). Every customer home gets this tree, so the
# build stops if any check-repository-custody rule (private path or private
# content) still matches under it. Runs before install: only the archive is read.
node /opt/murage/scripts/check-repository-custody.mjs --tree /opt/murage
cd /opt/murage
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
# `tsc -b` (the first step of `pnpm build`) outgrows node's default heap (about 2 GB) and dies with
# "JavaScript heap out of memory" on the documented 8 GB builder (vc2-4c-8gb; measured 2026-10-16). The
# heap is sized to the build machine: three quarters of RAM, at least 6144 MB (what built the image on
# 8 GB), at most 12288 MB; MURAGE_BUILD_HEAP_MB overrides. It is set on the build commands only, never
# exported into the image or the services. A caller that already set --max-old-space-size in NODE_OPTIONS
# keeps its value; qualify/hz-live.py sets none, so the builder's RAM decides.
build_heap_mb=${MURAGE_BUILD_HEAP_MB:-$((build_ram_mb * 3 / 4))}
[ "$build_heap_mb" -ge 6144 ] || build_heap_mb=6144
[ "$build_heap_mb" -le 12288 ] || build_heap_mb=12288
build_node_options=${NODE_OPTIONS:-}
[[ $build_node_options == *max-old-space-size* ]] || build_node_options="${build_node_options:+$build_node_options }--max-old-space-size=$build_heap_mb"
NODE_OPTIONS="$build_node_options" pnpm build
# The home serves this directory (MURAGE_STATIC_DIR); an image without it would have no UI.
test -f dist/index.html && test -f dist/.vite/manifest.json
NODE_OPTIONS="$build_node_options" pnpm build:server
pnpm exec esbuild server/cloud-home/supervisor.ts --bundle --platform=node --target=node24 --format=esm --packages=external --outfile=dist-server/cloud-home-supervisor.js
# Home-only pins: Chromium 154.0.8037.92 and agent-browser 0.38.1.
MURAGE_CLOUD_ROLE=home node scripts/prepare-browser.mjs --target "$browser_target"
node scripts/prepare-fuigo.mjs --target "$browser_target"
install -d resources bin
cp -a "dist-native/browser/$browser_target" resources/browser-engine
# Fuigo is the redistributable engine currently confirmed by this repository.
cp "dist-native/fuigo/$browser_target/fuigo" bin/fuigo
chmod 0755 bin/fuigo
# Sean's five Cloud engines, each a single native ELF (the launcher's manifest rule),
# pinned to an exact version with a SHA-256 per architecture (verified 2026-10-15):
#   Claude Code 2.1.292: official native binary from downloads.claude.ai; SHA-256 equals
#     platforms.<platform>.checksum in the release manifest.json, which Anthropic signs
#     with GPG key 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE.
#   Codex 0.162.1: official musl release; SHA-256 equals the GitHub release asset digest.
#   Grok Build 1.0.52 (the `stable` channel of x.ai/cli/install.sh): the bare static
#     binary the installer downloads; no checksum is published, so the pin is the TLS
#     origin hash, cross-checked against the GCS fallback object's md5.
#   Kimi Code 2.2.0 (code.kimi.com/kimi-code/install.sh): the bare binary; SHA-256 equals
#     platforms.<target>.checksum in binaries/2.2.0/manifest.json.
#   OpenCode 1.19.0 (opencode-ai's per-platform npm package): the package tarball; its
#     sha512 equals the npm registry dist.integrity. Only package/bin/opencode is used.
#     x86_64 takes the official "baseline" glibc package (opencode-linux-x64-baseline, an
#     optionalDependency of opencode-ai 1.19.0), which runs on every x86-64 CPU, not
#     only those with AVX2; checked with --version under qemu -cpu Nehalem.
# A mismatch is fatal (set -e); no CLI is ever signed in or configured here.
claude_version=2.1.292
claude_sha256=${claude_sha256_by_arch[$machine]}
codex_version=0.162.1
codex_sha256=${codex_sha256_by_arch[$machine]}
grok_version=1.0.52
grok_sha256=${grok_sha256_by_arch[$machine]}
agy_version=1.4.4
agy_build=1.4.4-4783783166214144
agy_sha512=${agy_sha512_by_arch[$machine]}
kimi_version=2.2.0
kimi_sha256=${kimi_sha256_by_arch[$machine]}
opencode_version=1.19.0
opencode_sha256=${opencode_sha256_by_arch[$machine]}
curl -fsSL "https://downloads.claude.ai/claude-code-releases/$claude_version/$claude_platform/claude" -o "$stage/claude"
printf '%s  %s\n' "$claude_sha256" "$stage/claude" | sha256sum -c -
install -o root -g root -m 0755 "$stage/claude" bin/claude
curl -fsSL "https://github.com/openai/codex/releases/download/rust-v$codex_version/codex-$codex_triple.tar.gz" -o "$stage/codex.tar.gz"
printf '%s  %s\n' "$codex_sha256" "$stage/codex.tar.gz" | sha256sum -c -
tar -xzf "$stage/codex.tar.gz" -C "$stage" "codex-$codex_triple"
install -o root -g root -m 0755 "$stage/codex-$codex_triple" bin/codex
curl -fsSL "https://x.ai/cli/grok-$grok_version-$grok_platform" -o "$stage/grok"
printf '%s  %s\n' "$grok_sha256" "$stage/grok" | sha256sum -c -
install -o root -g root -m 0755 "$stage/grok" bin/grok
curl -fsSL "https://storage.googleapis.com/antigravity-public/antigravity-cli/$agy_build/$agy_dir/$agy_file" -o "$stage/agy.tar.gz"
printf '%s  %s\n' "$agy_sha512" "$stage/agy.tar.gz" | sha512sum -c -
install -d "$stage/agy"
tar -xzf "$stage/agy.tar.gz" -C "$stage/agy" antigravity
install -o root -g root -m 0755 "$stage/agy/antigravity" bin/agy
curl -fsSL "https://code.kimi.com/kimi-code/binaries/$kimi_version/kimi-code-$kimi_target" -o "$stage/kimi"
printf '%s  %s\n' "$kimi_sha256" "$stage/kimi" | sha256sum -c -
install -o root -g root -m 0755 "$stage/kimi" bin/kimi
curl -fsSL "https://registry.npmjs.org/$opencode_package/-/$opencode_package-$opencode_version.tgz" -o "$stage/opencode.tgz"
printf '%s  %s\n' "$opencode_sha256" "$stage/opencode.tgz" | sha256sum -c -
install -d "$stage/opencode"
tar -xzf "$stage/opencode.tgz" -C "$stage/opencode" package/bin/opencode
install -o root -g root -m 0755 "$stage/opencode/package/bin/opencode" bin/opencode
# OpenCode installs a provider SDK from npm on first use unless the binary embeds it, and
# registry.npmjs.org is never on the engine allowlist. Every SDK the Go and Zen catalogues
# name is embedded in 1.19.0 (its provider table maps each to a bundled chunk); fail the
# build if a pinned binary stops embedding one, rather than ship a turn that needs npm.
for sdk in @ai-sdk/openai-compatible @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/mistral; do
  grep -aqF "\"$sdk\":()=>import(" bin/opencode || { echo "OpenCode $opencode_version does not embed $sdk" >&2; exit 1; }
done
chrome_dir=$chrome_dir python3 -B - <<'PY'
import hashlib, json, os
chrome_dir = os.environ["chrome_dir"]
manifest = {}
# Each entry is a single native executable (no interpreter or script), pinned by digest above.
for engine, path in [("fuigoAgent", "/opt/murage/bin/fuigo"), ("claudeAgent", "/opt/murage/bin/claude"), ("codex", "/opt/murage/bin/codex"), ("grokAgent", "/opt/murage/bin/grok"), ("antigravity", "/opt/murage/bin/agy"), ("kimiAgent", "/opt/murage/bin/kimi"), ("opencodeGo", "/opt/murage/bin/opencode")]:
    with open(path, "rb") as stream:
        manifest[engine] = [{"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}]
# The MCP proxies a Cloud turn's rendered config may start (the launcher's MCP_PROXIES):
# node plus one of these bundled scripts, each pinned by digest like an engine binary.
manifest["mcpProxies"] = []
for relative in ["permission-proxy", "drivers/agents-proxy", "drivers/memory-proxy", "drivers/phone-proxy", "drivers/unified-browser-proxy", "computer-proxy",
                 "drivers/host-computer-proxy", "drivers/dweb-proxy", "connector-proxy", "drivers/remote-mcp-proxy", "cloud-home/vps-relay-mcp"]:
    path = "/opt/murage/dist-server/" + relative + ".js"
    with open(path, "rb") as stream:
        manifest["mcpProxies"].append({"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
# The saved-browser-session step the launcher runs as the browser user (browser-restore modes): node plus
# this one bundled script, pinned by digest like a proxy.
path = "/opt/murage/dist-server/browser-restore-cli.js"
with open(path, "rb") as stream:
    manifest["browserRestore"] = [{"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}]
manifest["browser"] = []
for path in ["/opt/murage/resources/browser-engine/agent-browser", "/opt/murage/resources/browser-engine/chrome/%s/chrome-headless-shell" % chrome_dir]:
    with open(path, "rb") as stream:
        manifest["browser"].append({"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
path = "/opt/murage/engine-manifest.json"
with open(path, "w", encoding="utf-8") as stream:
    json.dump(manifest, stream, sort_keys=True)
os.chown(path, 0, 0)
os.chmod(path, 0o644)
PY
printf '%s\n' "$revision" > /etc/murage-home/source-commit
printf '{"uid":%s,"gid":%s,"turnGid":%s,"proxyUid":%s,"proxyGid":%s,"engineGids":{%s}}\n' "$(id -u murage)" "$(id -g murage)" "$(id -g murage-turn)" "$(id -u murage-proxy)" "$(id -g murage-proxy)" "$engine_gids" > /etc/murage-home/identity.json
chmod 0600 /etc/murage-home/identity.json
# The root launchers outside the release slots (deploy/cloud-home/launchers.txt) are image-pinned regular files (LANE-G r3 sec. 1.1):
# installed once here through the shared step (which update_software keeps for the release's launcher list and ABI check), made
# immutable below, and never changed by an update; a release that needs other launchers is refused and the home is re-imaged.
install -o root -g root -m 0755 deploy/cloud-home/install-launchers.py /usr/local/libexec/murage-install-launchers
/usr/bin/python3 -I -B /usr/local/libexec/murage-install-launchers deploy/cloud-home /usr/local/libexec
[[ $(/usr/bin/python3 -I -B -c 'import importlib.machinery,importlib.util,sys;l=importlib.machinery.SourceFileLoader("il",sys.argv[1]);s=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(s);l.exec_module(m);print(m.abi(sys.argv[2]))' /usr/local/libexec/murage-install-launchers deploy/cloud-home) = "$(cat deploy/cloud-home/launcher-abi)" ]] || { echo 'launchers.txt abi and deploy/cloud-home/launcher-abi disagree'; exit 1; }
# The home's root launcher (LANE-G r3 sec. 1): the only uid-0 step of a home start; binds the volume, verifies the live slot and the
# update journal, asks the updater's gate during an update, drops to the service user, execs the slot supervisor through the verified
# descriptor. Image code, never from a release.
install -o root -g root -m 0755 deploy/cloud-home/murage-home-launch.py /usr/local/libexec/murage-home-launch
# The launcher sources inside slot A carry their manifest modes, as an updater-installed slot does after safe_extract + apply_modes and
# as the release producer's tree does: one tree digest for the image build, the producer and the home.
/usr/bin/python3 -I -B -c 'import importlib.machinery,importlib.util,os,sys;l=importlib.machinery.SourceFileLoader("il",sys.argv[1]);s=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(s);l.exec_module(m);m.apply_modes(sys.argv[2],m.plan(os.path.join(sys.argv[2],"deploy","cloud-home")))' /usr/local/libexec/murage-install-launchers /opt/murage-releases/A
# Per-engine outbound allowlist for turns (SNI proxy); the allowlist is root-owned
# and read-only to the proxy, and a malformed file keeps the proxy from starting.
install -o root -g root -m 0755 deploy/cloud-home/murage-egress-proxy.py /usr/local/libexec/murage-egress-proxy
install -o root -g root -m 0755 deploy/cloud-home/murage-miner-watch.py /usr/local/libexec/murage-miner-watch
install -o root -g root -m 0755 deploy/cloud-home/murage-backup-authorize /usr/local/libexec/murage-backup-authorize
install -o root -g root -m 0755 deploy/cloud-home/murage-scrub-userdata /usr/local/libexec/murage-scrub-userdata
install -m 0644 deploy/cloud-home/murage-backup-authorize.service /etc/systemd/system/murage-backup-authorize.service
install -m 0644 deploy/cloud-home/murage-scrub-userdata.path /etc/systemd/system/
install -m 0644 deploy/cloud-home/murage-scrub-userdata.service /etc/systemd/system/murage-scrub-userdata.service
install -d -o root -g root -m 0755 /etc/murage
install -o root -g root -m 0644 deploy/cloud-home/egress-allow.json /etc/murage/egress-allow.json
printf '%s\n' "$iproute_version" > /etc/murage-home/iproute2-version
chmod 0644 /etc/murage-home/iproute2-version
install -m 0440 deploy/cloud-home/murage-turn.sudoers /etc/sudoers.d/murage-turn
visudo -cf /etc/sudoers.d/murage-turn
cc -std=c11 -O2 -Wall -Wextra -Werror deploy/cloud-home/murage-seccomp.c -lseccomp -o "$stage/murage-seccomp"
"$stage/murage-seccomp" "$stage/murage-seccomp.bpf"
install -o root -g root -m 0644 "$stage/murage-seccomp.bpf" /usr/local/libexec/murage-seccomp.bpf
# Chromium's user namespace now comes from the murage-browser profile pair
# (browser-bwrap.apparmor); a path-attached chromium profile would deny it network.
rm -f /etc/apparmor.d/murage-chromium
# Replaces Ubuntu's stock profile of the same name; no second /usr/bin/bwrap attachment.
rm -f /etc/apparmor.d/murage-bwrap
install -m 0644 deploy/cloud-home/bwrap.apparmor /etc/apparmor.d/bwrap-userns-restrict
apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
install -m 0644 deploy/cloud-home/browser-bwrap.apparmor /etc/apparmor.d/murage-browser-bwrap
apparmor_parser -r /etc/apparmor.d/murage-browser-bwrap
# Noble confines /usr/bin/passt only; pasta gets its own profile built on
# Ubuntu's abstractions/pasta (turns attach pasta to their netns).
test -f /etc/apparmor.d/abstractions/pasta
install -m 0644 deploy/cloud-home/pasta.apparmor /etc/apparmor.d/murage-pasta
apparmor_parser -r /etc/apparmor.d/murage-pasta
install -m 0644 deploy/cloud-home/Caddyfile /etc/murage-home/Caddyfile
install -m 0644 deploy/cloud-home/murage-home.service /etc/systemd/system/murage-home.service
install -m 0644 deploy/cloud-home/murage-turns.slice /etc/systemd/system/murage-turns.slice
install -m 0644 deploy/cloud-home/murage-browsers.slice /etc/systemd/system/murage-browsers.slice
install -m 0644 deploy/cloud-home/murage-proxy.service /etc/systemd/system/murage-proxy.service
install -m 0644 deploy/cloud-home/murage-egress-proxy.service /etc/systemd/system/murage-egress-proxy.service
install -m 0644 deploy/cloud-home/murage-egress-dns.service /etc/systemd/system/murage-egress-dns.service
install -m 0644 deploy/cloud-home/murage-miner-watch.service /etc/systemd/system/murage-miner-watch.service
install -m 0644 deploy/cloud-home/murage-tunnel.service /etc/systemd/system/murage-tunnel.service
install -m 0644 deploy/cloud-home/murage-tunnel-token.service /etc/systemd/system/murage-tunnel-token.service
install -m 0644 deploy/cloud-home/murage-egress.nft /etc/murage-home/murage-egress.nft
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 deploy/cloud-home/murage-journald.conf /etc/systemd/journald.conf.d/murage.conf
# Apply now, so the rest of the build (and its shutdown) never writes /var/log/journal.
systemctl restart systemd-journald
# rsyslog would still copy kernel messages (nft logs) to /var/log on the
# unencrypted root disk; masked rather than purged so no metapackage goes.
systemctl disable rsyslog.service syslog.socket >/dev/null 2>&1 || true
systemctl mask rsyslog.service >/dev/null 2>&1 || true
# Browser veth pairs are network hotplug events; cloud-init's hotplug hook then
# runs, fails ("Failed to detect ... in updated metadata") and leaves a failed
# unit. A home never hot-plugs a real NIC, so the hook is off.
systemctl mask cloud-init-hotplugd.socket cloud-init-hotplugd.service >/dev/null 2>&1 || true
# Ubuntu's daily unattended upgrade runs needrestart, which restarts every service
# using an upgraded library. On a soak home that restarted murage-control (and the
# soak) seven times in three minutes. Security updates stay automatic; Murage's own
# units are never restarted by it (they pick the update up on the next planned
# restart), and needrestart only lists what it would have done.
install -d -m 0755 /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/50-murage.conf <<'NEEDRESTART'
$nrconf{restart} = 'l';
$nrconf{override_rc}{qr(^murage-)} = 0;
$nrconf{override_rc}{qr(^mcq-)} = 0;
$nrconf{override_rc}{qr(^cloudflared)} = 0;
NEEDRESTART
chmod 0644 /etc/needrestart/conf.d/50-murage.conf
rm -rf /var/log/journal/* /var/log/syslog* /var/log/kern.log* /var/log/auth.log* 2>/dev/null || true
install -m 0644 deploy/cloud-home/murage-egress.service /etc/systemd/system/murage-egress.service
install -m 0644 deploy/cloud-home/data.mount /etc/systemd/system/data.mount
install -m 0644 deploy/cloud-home/murage-volume.service /etc/systemd/system/murage-volume.service
install -m 0644 deploy/cloud-home/murage-home-recover.service /etc/systemd/system/murage-home-recover.service
install -m 0644 deploy/cloud-home/murage-home-recover.timer /etc/systemd/system/murage-home-recover.timer
install -m 0755 deploy/cloud-home/murage-backup /usr/local/libexec/murage-backup
install -m 0644 deploy/cloud-home/backup-excludes.txt /etc/murage-home/backup-excludes.txt
install -m 0644 deploy/cloud-home/murage-backup.service /etc/systemd/system/murage-backup.service
install -m 0644 deploy/cloud-home/murage-backup.timer /etc/systemd/system/murage-backup.timer
install -m 0755 deploy/cloud-home/start-home.sh /usr/local/libexec/murage-home-start
install -m 0755 deploy/cloud-home/murage-enroll /usr/local/libexec/murage-enroll
cc -std=c11 -O2 -Wall -Wextra -Werror deploy/cloud-home/murage-clock.c -o "$stage/murage-clock"
install -o root -g root -m 0755 "$stage/murage-clock" /usr/local/libexec/murage-clock
install -o root -g root -m 0755 deploy/cloud-home/murage-control /usr/local/libexec/murage-control
install -m 0644 deploy/cloud-home/murage-control.service /etc/systemd/system/murage-control.service
install -o root -g root -m 0755 deploy/cloud-home/murage-commands /usr/local/libexec/murage-commands
install -m 0644 deploy/cloud-home/murage-commands.service /etc/systemd/system/murage-commands.service
install -d -o root -g root -m 0700 /var/cache/restic
if [[ -n $control_public_key ]]; then
    install -o root -g root -m 0644 "$control_public_key" /etc/murage-home/control-plane-public-key.json
fi
# The signed release channel for "Update my Cloud" (murage-commands update_software) is mandatory (LANE-G r3 sec. 2, Astra C, Q4):
# the channel URL, the Ed25519 public key (PEM), and the signed manifest + signature scripts/cloud-home-release.sh and
# scripts/cloud-home-sign.sh produced for THIS revision's tree (the private key never touches the image build). All four, or the
# build fails; staging builds use the staging key. They are required and checked by stage 2 (MURAGE_IMAGE_STAGE=seal) below.
# Stage 1 (MURAGE_IMAGE_STAGE=tree, this part of the script) never sees them.
install -d -o root -g root -m 0755 /etc/claude-code /etc/codex /etc/grok /etc/fuigo
install -o root -g root -m 0644 deploy/cloud-home/managed/claude-settings.json /etc/claude-code/managed-settings.json
install -o root -g root -m 0644 deploy/cloud-home/managed/codex-requirements.toml /etc/codex/requirements.toml
install -o root -g root -m 0644 deploy/cloud-home/managed/grok-requirements.toml /etc/grok/requirements.toml
# Fuigo's root-owned system tiers (highest authority): plugin discovery, the leader and the
# Claude import are off whatever a writable tier says (CLOUD-ENGINES-DESIGN.md r2 R2/R3).
install -o root -g root -m 0644 deploy/cloud-home/managed/fuigo-requirements.toml /etc/fuigo/requirements.toml
install -o root -g root -m 0644 deploy/cloud-home/managed/fuigo-managed_config.toml /etc/fuigo/managed_config.toml
# SPDX metadata belongs to our source file, not the vendor settings schema.
python3 -B - <<'PY'
import json
path = "/etc/claude-code/managed-settings.json"
with open(path, encoding="utf-8") as stream:
    settings = json.load(stream)
settings.pop("_license", None)
with open(path, "w", encoding="utf-8") as stream:
    json.dump(settings, stream, sort_keys=True)
PY
printf 'kernel.yama.ptrace_scope = 2\n' > /etc/sysctl.d/60-murage-home.conf
# inotify limits are per uid and every turn runs as murage-turn, so concurrent
# engines (file watchers, dev servers, language servers) share one budget. The
# kernel defaults (128 instances, ~8k-65k watches) starve them. 2048 instances
# and 524288 watches cost at most ~270 MB of unswappable kernel memory (about
# 540 bytes per watch), far below a home's RAM, and cover 14 engines at once.
install -d -m 0755 /etc/sysctl.d
printf 'fs.inotify.max_user_instances = 2048\nfs.inotify.max_user_watches = 524288\n' > /etc/sysctl.d/61-murage-inotify.conf
# A VM image, not a container. proc restrictions apply to all service processes.
if ! grep -q '^proc /proc proc .*hidepid=2' /etc/fstab; then printf 'proc /proc proc defaults,hidepid=2 0 0\n' >> /etc/fstab; fi
# GNU -R does not traverse a symlink argument: the real tree is the target.
chown -R root:root /opt/murage-releases
chmod -R go-w /opt/murage-releases
test "$(stat -c %U /opt/murage/dist)" = root && test -f /opt/murage/dist/index.html
# Stage 1 ends here: the tree is final and unsealed. The marker records its digest, the revision and this host, so stage 2 can refuse a
# tree that changed, another revision or another builder. Pack the tree (scripts/cloud-home-release.sh prepare) from
# /opt/murage-releases/A, have the manifest signed off-box, then run stage 2 on this same host.
python3 -I -B "$source_dir/deploy/cloud-home/image-stage.py" mark "$source_dir/deploy/cloud-home/murage-commands" /opt/murage-releases/A "$revision" "$stage_marker" /etc/machine-id
echo 'build-image: stage 1 (tree) complete; sign the manifest, then run MURAGE_IMAGE_STAGE=seal on this host'
exit 0
fi
# ===== Stage 2 (MURAGE_IMAGE_STAGE=seal): only the signed-slot block and everything after it. No package build, no download, no tree change.
# The marker is checked before anything else; the signature checks below are the final authority (condition 6).
python3 -I -B "$source_dir/deploy/cloud-home/image-stage.py" check "$source_dir/deploy/cloud-home/murage-commands" /opt/murage-releases/A "$revision" "$stage_marker" /etc/machine-id
cd /opt/murage
[[ -n ${MURAGE_RELEASE_CHANNEL_URL:-} && -n ${MURAGE_RELEASE_PUBLIC_KEY:-} && -n ${MURAGE_RELEASE_MANIFEST:-} && -n ${MURAGE_RELEASE_MANIFEST_SIG:-} ]] \
  || { echo 'MURAGE_RELEASE_CHANNEL_URL, MURAGE_RELEASE_PUBLIC_KEY, MURAGE_RELEASE_MANIFEST and MURAGE_RELEASE_MANIFEST_SIG are required (signed slot A)'; exit 1; }
[[ $MURAGE_RELEASE_CHANNEL_URL =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ && $MURAGE_RELEASE_PUBLIC_KEY = /* && $MURAGE_RELEASE_MANIFEST = /* && $MURAGE_RELEASE_MANIFEST_SIG = /* ]] \
  || { echo 'Release channel needs an https URL and absolute paths for the key, the manifest and its signature'; exit 1; }
openssl pkey -pubin -in "$MURAGE_RELEASE_PUBLIC_KEY" -noout -text | grep '^ED25519 Public-Key' >/dev/null || { echo 'Release key must be an Ed25519 public key'; exit 1; }
# Slot A is signed (LANE-G r3 sec. 2): the release manifest must be this revision's, carry this image's launcher ABI and name exactly the
# tree digest of /opt/murage-releases/A (the checkout's trusted murage-commands computes it and verifies the signature). It is installed
# in the trust root and beside the update journal; the journal (state.json v3) names slot A with the manifest's sequence.
python3 -I -B - "$source_dir/deploy/cloud-home/murage-commands" "$MURAGE_RELEASE_MANIFEST" "$MURAGE_RELEASE_MANIFEST_SIG" "$MURAGE_RELEASE_PUBLIC_KEY" "$revision" "$(cat deploy/cloud-home/launcher-abi)" "$MURAGE_RELEASE_CHANNEL_URL" <<'PY'
import importlib.machinery, importlib.util, json, os, shutil, sys
commands, manifest_path, sig_path, key, revision, abi, channel = sys.argv[1:8]
loader = importlib.machinery.SourceFileLoader("mc", commands)
spec = importlib.util.spec_from_loader(loader.name, loader)
home = importlib.util.module_from_spec(spec)
loader.exec_module(home)
with open(manifest_path, "rb") as stream:
    raw = stream.read(65537)
with open(sig_path, "rb") as stream:
    signature = stream.read(129)
manifest = home.verify_manifest({"verify": home.verify_signature}, raw, signature, key)
if manifest["revision"] != revision:
    sys.exit("release manifest is for another revision")
if manifest["launcherAbi"] != abi:
    sys.exit("release manifest launcher ABI differs from this image's")
fd = os.open("/opt/murage-releases/A", home.SLOT_OPEN)
try:
    digest = home.seal_walk_digest(fd, False)
finally:
    os.close(fd)
if digest != manifest["treeSha256"]:
    sys.exit("release manifest treeSha256 is not this image's slot A (%s)" % digest)
trust, update = "/usr/lib/murage-home/trust", "/var/lib/murage-update"
for directory in (trust, trust + "/manifests", update, update + "/manifests"):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
for target, data in ((trust + "/manifests/A.json", raw), (trust + "/manifests/A.sig", signature), (update + "/manifests/A.json", raw), (update + "/manifests/A.sig", signature)):
    home.write_bytes_private(target, data)
    os.chmod(target, 0o600)
shutil.copyfile(key, trust + "/release-public-key.pem")
with open(trust + "/release.json", "w", encoding="utf-8") as stream:
    json.dump({"channelUrl": channel, "minimumSequence": manifest["sequence"], "imageRevision": revision, "launcherAbi": abi}, stream)
with open(trust + "/launcher-abi", "w", encoding="utf-8") as stream:
    stream.write(abi + "\n")
for name in ("release-public-key.pem", "release.json", "launcher-abi"):
    os.chmod(trust + "/" + name, 0o600)
home.write_private(update + "/state.json", {"format": home.UPDATE_STATE_FORMAT, "installed": {"slot": "A", "sequence": manifest["sequence"], "revision": revision},
                                           "inflight": None, "lastResult": None})
os.chmod(update + "/state.json", 0o600)
PY
# Seals (LANE-G r3 sec. 1.4, 2): every inode of slot A, the releases directory, the journal and the trust root, and the four root
# launchers with their directory. Only image code (murage-commands, on the idle slot and around its own writes) ever lifts a flag.
# Regular files and directories only: the dependency tree holds about 3000 symlinks, which chattr cannot flag (build-guards.sh).
seal_tree /opt/murage-releases/A
chattr +i /opt/murage-releases
seal_tree /var/lib/murage-update /usr/lib/murage-home/trust
chattr +i /usr/local/libexec/murage-turn-launch /usr/local/libexec/murage-browser-namespace /usr/local/libexec/murage-browser-network /usr/local/libexec/murage-home-launch /usr/local/libexec
for launcher in murage-turn-launch murage-browser-namespace murage-browser-network murage-home-launch; do
    [[ -f /usr/local/libexec/$launcher && ! -L /usr/local/libexec/$launcher && $(lsattr -d "/usr/local/libexec/$launcher" | cut -d' ' -f1) == *i* ]] \
      || { echo "launcher $launcher is not an immutable regular file"; exit 1; }
done
test -d /usr/lib/murage-home/trust && test -f /usr/lib/murage-home/trust/manifests/A.sig && test -f /var/lib/murage-update/state.json
systemctl daemon-reload
systemctl enable data.mount murage-egress.service
systemctl enable murage-volume.service
# Enabled so every boot after enrollment brings the home back by itself (a real
# CX23/CPX home rebooted with egress, home and proxy all inactive). The gate is
# the dependency chain: home/proxy Require data.mount, which Requires
# murage-volume, which unlocks only for an enrolled machine. Before enrollment
# they fail on that dependency and nothing listens.
systemctl enable murage-home.service murage-proxy.service murage-egress-proxy.service murage-egress-dns.service
# A transient volume-unlock failure (CP 5xx, network not up) fails the oneshot and
# strands home/proxy; the timer restarts them, except after terminal exit 78.
systemctl enable murage-home-recover.timer
# Abuse control: alerts and flags sustained CPU on processes outside our engine list. Never kills.
systemctl enable murage-miner-watch.service
# Nightly encrypted backup of /data (restic over SFTP). Inert until /etc/murage-home/backup.json exists.
systemctl enable murage-backup.timer
systemctl enable murage-commands.service
# First boot: install the backup public key on the Storage Box, then destroy every on-disk copy of the cloud-init
# user-data (it carried the enrollment token and backup credentials; the metadata service is also root-only in nft).
systemctl enable murage-backup-authorize.service murage-scrub-userdata.path
# The tunnel is the home's only way to the internet's users. The token service
# fetches the connector token every boot and starts murage-tunnel.service; the
# tunnel unit itself is deliberately not enabled (it must not start without one).
systemctl enable murage-tunnel-token.service
# >>> boot ordering gate (server/cloud-home/unit-order.test.ts runs this block)
# A cycle makes systemd delete one job of it at boot, a different one on different boots (a cycle through
# cloud-final.service once dropped cloud-init runcmd). verify enqueues each unit's start job like boot does. Its exit 1
# also covers unrelated unit warnings, so only its cycle lines fail the build; any other non-zero exit (126/127: not
# runnable, 128+: killed) means it did not verify and fails the build too.
order_rc=0
order_log=$(systemd-analyze verify --man=no default.target multi-user.target cloud-final.service $(cd /etc/systemd/system && ls murage-*.service murage-*.timer murage-*.path data.mount) 2>&1) || order_rc=$?
if [ "$order_rc" -gt 1 ]; then printf '%s\n' "$order_log"; echo "systemd-analyze verify did not run (exit $order_rc); refusing to build"; exit 1; fi
if printf '%s\n' "$order_log" | grep -Ei 'ordering cycle|order is cyclic|break ordering'; then echo 'systemd ordering cycle in the image units; refusing to build'; exit 1; fi
# verify runs without generators, so it never sees the multi-user.target.wants/cloud-init.target link that cloud-init's
# generator makes at boot, and cannot see a cycle through cloud-final.service. unit-order-check.py emulates that
# generator and models the same ordering rules: it is the gate that fails on such a cycle. Any non-zero exit fails,
# including 2 (load error) and 127 (no python3).
python3 -I -B deploy/cloud-home/qualify/unit-order-check.py --root / || { echo 'boot ordering cycle in the image units; refusing to build'; exit 1; }
# <<< boot ordering gate
# The stage 1 marker is builder state, not image content: it is gone before the image is snapshotted.
rm -rf /var/lib/murage-image-build
if [[ $machine = aarch64 ]]; then
# The pinned snapshot was only for building. A running home keeps receiving security
# updates from the live arm64 archive, as the x86 image does from archive.ubuntu.com.
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SOURCES'
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
fi
rm -f /etc/apt/apt.conf.d/99murage-build-retries
# The customer release gate (sshd purge, then image-release-check.sh) is NOT here: it must be the last step on the
# disk that becomes the snapshot, so hz-live runs deploy/cloud-home/finalize-customer-image.sh as its final remote command.
